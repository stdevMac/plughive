// src/core/installer/installer.ts
//
// Installs the catalog's software for the user, without sudo, as a job:
//
//   archive  download (safe fetch, GitHub release hosts only) → sha256 check
//            against the catalog → unpack into tools/<id>/<version>/ → shim in
//            tools/bin → lock entry (sha256 of every program) → probe
//   uv       `uv tool install <pkg==ver>` with the tool and bin folders inside
//            tools/<id>/<version>/ (the catalog's own uv is installed first when
//            none is around) → shim → lock entry → probe
//   brew / winget   the OS package manager, user scope, only after the user
//            approved it on the dashboard → probe
//   apt / link      never run: the command or the official page is shown
//   model    a pinned Hugging Face file → sha256 check → saved into the pack's
//            data folder (pack-data/<pack>/<dir>/<file>) → lock entry
//
// A gated entry, one over APPROVAL_SIZE_MB, or a package-manager install asked
// for from an agent returns "approval_required" with a dashboard link instead
// of starting; the dashboard's install button is the user's approval.
//
// The spawn layer trusts tools/bin through `trustedTools()`: a command found
// there runs only when its real path is the one in lock.json and its sha256
// still matches.
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, realpathSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ulid } from "ulid";
import { type JobExecution, type JobQueue, JobTerminalError } from "../../lib/jobs.js";
import { loadExeca } from "../../lib/lazy-execa.js";
import { isWindows, joinPath, systemChildEnv, userHome } from "../../lib/platform.js";
import { createSafeFetch } from "../net/safe-fetch.js";
import type { HostLogger, HostTrustedTools } from "../packs/context.js";
import {
  APPROVAL_SIZE_MB,
  type Catalog,
  type CatalogItem,
  DOWNLOAD_HOSTS,
  type InstallMethod,
  MODEL_HOSTS,
  MODEL_REDIRECT_HOSTS,
  type ModelSource,
  type PlatformKey,
  loadCatalog,
  pickMethod,
  platformKey,
} from "./catalog.js";
import {
  type DetectResult,
  type HttpProbe,
  type ProbeRunner,
  detect,
  findProgram,
  searchDirs,
} from "./detect.js";
import { ExtractError, extractArchive, isInside } from "./extract.js";
import { type LockFile, type LockedItem, hashFile, readLock, updateLock } from "./lockfile.js";

export const INSTALL_JOB_TOOL = "system.install_software";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 60 * 60_000;
const STATUS_TTL_MS = 5 * 60_000;
const DETECT_CONCURRENCY = 6;

export type Fetcher = (url: string, init: { signal?: AbortSignal }) => Promise<Response>;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  file: string,
  args: readonly string[],
  opts: { env: Record<string, string>; cwd?: string; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface InstallerOptions {
  /** $PLUGHIVE_HOME; tools live in <home>/tools. */
  home: string;
  logger: HostLogger;
  jobs?: JobQueue;
  catalog?: Catalog;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Downloads (tests). Default: createSafeFetch limited to DOWNLOAD_HOSTS. */
  fetch?: Fetcher;
  /** uv / brew / winget (tests). */
  runCommand?: CommandRunner;
  /** Probe runner and HTTP probe (tests). */
  probeRun?: ProbeRunner;
  probeHttp?: HttpProbe;
  /** Folders searched after tools/bin (tests). Default: searchDirs(). */
  searchDirs?: readonly string[];
  /** Is brew / winget / apt there (tests). Default: looked up. */
  packageManagers?: { hasBrew: boolean; hasWinget: boolean; hasApt: boolean };
}

export interface SoftwareView {
  id: string;
  name: string;
  summary: string;
  version: string;
  license: string;
  size_mb: number;
  gated: boolean;
  homepage: string;
  install_url?: string;
  tags: string[];
  bins: string[];
  /** How it installs here: archive, uv, brew, winget, apt (command shown), link (detect only), unsupported. */
  method: InstallMethod["kind"];
  /** `brew install x` / `sudo apt install x`: what runs, or what the user runs. */
  command?: string;
  /** Starting it needs the user's approval on the dashboard. */
  needs_approval: boolean;
  installed: boolean;
  /** Installed by plughive into tools/. */
  managed: boolean;
  path: string | null;
  detected_version: string | null;
  running?: boolean;
  /** An install job that is still going. */
  job_id?: string;
}

export type InstallStart =
  | { status: "started"; id: string; job_id: string; wait_with: "wait_for_job" }
  | { status: "already_installed"; id: string; path: string | null; version: string | null }
  | {
      status: "approval_required";
      id: string;
      approval_path: string;
      message: string;
      size_mb: number;
      license: string;
    }
  | { status: "manual"; id: string; message: string; url?: string; command?: string }
  | { status: "unsupported"; id: string; message: string };

export class InstallError extends Error {
  constructor(
    readonly code: "not_found" | "not_installed" | "busy" | "no_jobs",
    message: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

function methodCommand(m: InstallMethod): string | undefined {
  switch (m.kind) {
    case "brew":
      return `brew install ${m.cask ? "--cask " : ""}${m.package}`;
    case "winget":
      return `winget install --id ${m.package} --exact --scope user`;
    case "apt":
      return m.command;
    case "uv":
      return `uv tool install ${m.with.map((w) => `--with ${w} `).join("")}${m.package}`;
    default:
      return undefined;
  }
}

const defaultRunCommand: CommandRunner = async (file, args, opts) => {
  const { execa } = await loadExeca();
  const r = await execa(file, [...args], {
    shell: false,
    reject: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    extendEnv: false,
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.signal ? { cancelSignal: opts.signal } : {}),
    stdin: "ignore",
  });
  return {
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
};

/** Last lines of a command's output, for an error message. */
function tail(s: string, n = 400): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

export class Installer {
  readonly home: string;
  readonly toolsRoot: string;
  readonly binDir: string;
  readonly catalog: Catalog;
  readonly key: PlatformKey | null;
  private readonly platform: NodeJS.Platform;
  private readonly logger: HostLogger;
  private readonly jobs: JobQueue | undefined;
  private readonly fetcher: Fetcher | undefined;
  private readonly runCommand: CommandRunner;
  private readonly probeRun: ProbeRunner | undefined;
  private readonly probeHttp: HttpProbe | undefined;
  private readonly dirs: readonly string[] | undefined;
  private pmOverride: InstallerOptions["packageManagers"];
  private listeners = new Set<() => void>();
  private active = new Map<string, string>();
  private statusCache: { at: number; views: Promise<SoftwareView[]> } | null = null;

  constructor(opts: InstallerOptions) {
    this.home = opts.home;
    this.toolsRoot = join(opts.home, "tools");
    this.binDir = join(this.toolsRoot, "bin");
    this.catalog = opts.catalog ?? loadCatalog();
    this.platform = opts.platform ?? process.platform;
    this.key = platformKey(this.platform, opts.arch ?? process.arch);
    this.logger = opts.logger;
    this.jobs = opts.jobs;
    this.fetcher = opts.fetch;
    this.runCommand = opts.runCommand ?? defaultRunCommand;
    this.probeRun = opts.probeRun;
    this.probeHttp = opts.probeHttp;
    this.dirs = opts.searchDirs;
    this.pmOverride = opts.packageManagers;
    this.jobs?.register(INSTALL_JOB_TOOL, (input, exec) => this.runJob(input, exec));
  }

  // ---------------------------------------------------------------- events

  /** Called after anything under tools/ changed (install, uninstall). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.statusCache = null;
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        this.logger.warn({ err: (e as Error).message }, "installer listener failed");
      }
    }
  }

  // ---------------------------------------------------------------- lookup

  item(id: string): CatalogItem {
    const item = this.catalog.items.find((i) => i.id === id);
    if (!item) throw new InstallError("not_found", `no software called ${id} in the catalog`);
    return item;
  }

  private searchDirs(): readonly string[] {
    return this.dirs ?? searchDirs();
  }

  private packageManagers(): { hasBrew: boolean; hasWinget: boolean; hasApt: boolean } {
    if (this.pmOverride) return this.pmOverride;
    return {
      hasBrew: this.platform === "darwin" && this.brewPath() !== null,
      hasWinget: this.platform === "win32" && findProgram("winget", this.searchDirs()) !== null,
      hasApt: this.platform === "linux" && findProgram("apt-get", ["/usr/bin", "/bin"]) !== null,
    };
  }

  private brewPath(): string | null {
    return findProgram("brew", ["/opt/homebrew/bin", "/usr/local/bin", ...this.searchDirs()]);
  }

  method(item: CatalogItem): InstallMethod {
    return pickMethod(item, this.key, this.packageManagers());
  }

  /** Starting `item` with `method` needs the user's approval when asked for by an agent. */
  needsApproval(item: CatalogItem, method: InstallMethod = this.method(item)): boolean {
    return (
      item.gated ||
      item.size_mb > APPROVAL_SIZE_MB ||
      method.kind === "brew" ||
      method.kind === "winget"
    );
  }

  /** Where a model entry's file goes: <home>/pack-data/<pack>/<dir>/<file>. */
  modelPath(model: ModelSource): string {
    return join(this.home, "pack-data", model.pack, model.dir, model.file);
  }

  /** Is `id` installed: tools/bin first, then the PATH (a model: its file is there). */
  detect(item: CatalogItem): Promise<DetectResult> {
    if (item.model) {
      const path = this.modelPath(item.model);
      let present = false;
      try {
        present = statSync(path).isFile();
      } catch {
        /* absent */
      }
      const managed = present && readLock(this.toolsRoot).items[item.id] !== undefined;
      return Promise.resolve({
        installed: present,
        managed,
        path: present ? path : null,
        version: managed ? item.version : null,
      });
    }
    return detect(item, {
      managedBin: this.binDir,
      dirs: this.searchDirs(),
      platform: this.platform,
      ...(this.probeRun ? { run: this.probeRun } : {}),
      ...(this.probeHttp ? { http: this.probeHttp } : {}),
    });
  }

  private activeJob(id: string): string | undefined {
    const jobId = this.active.get(id);
    if (!jobId) return undefined;
    const job = this.jobs?.get(jobId);
    if (
      !job ||
      ["succeeded", "failed", "cancelled", "expired", "submission_unknown"].includes(job.status)
    ) {
      this.active.delete(id);
      return undefined;
    }
    return jobId;
  }

  private async view(item: CatalogItem): Promise<SoftwareView> {
    const method = this.method(item);
    const found = await this.detect(item);
    const command = methodCommand(method);
    const job = this.activeJob(item.id);
    return {
      id: item.id,
      name: item.name,
      summary: item.summary,
      version: item.version,
      license: item.license,
      size_mb: item.size_mb,
      gated: item.gated,
      homepage: item.homepage,
      ...(item.install_url ? { install_url: item.install_url } : {}),
      tags: item.tags,
      bins: item.bins,
      method: method.kind,
      ...(command ? { command } : {}),
      needs_approval: this.needsApproval(item, method),
      installed: found.installed,
      managed: found.managed,
      path: found.path,
      detected_version: found.version,
      ...(found.running !== undefined ? { running: found.running } : {}),
      ...(job ? { job_id: job } : {}),
    };
  }

  /** The catalog for this machine, with what is installed. Probes are cached for 5 minutes (installs and removals here clear it). */
  async status(opts: { fresh?: boolean } = {}): Promise<SoftwareView[]> {
    const now = Date.now();
    if (!opts.fresh && this.statusCache && now - this.statusCache.at < STATUS_TTL_MS) {
      return this.statusCache.views;
    }
    const items = this.offered();
    const views = (async () => {
      const out: SoftwareView[] = new Array(items.length);
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          const item = items[i] as CatalogItem;
          out[i] = await this.view(item);
        }
      };
      await Promise.all(Array.from({ length: Math.min(DETECT_CONCURRENCY, items.length) }, worker));
      return out;
    })();
    this.statusCache = { at: now, views };
    views.catch(() => {
      this.statusCache = null;
    });
    return views;
  }

  /** One entry, probed now. */
  async statusOf(id: string): Promise<SoftwareView> {
    return this.view(this.item(id));
  }

  /** Catalog entries offered on this platform. */
  offered(): CatalogItem[] {
    return this.catalog.items.filter(
      (i) => !this.key || !i.platforms || i.platforms.includes(this.key),
    );
  }

  // ---------------------------------------------------------------- install

  /**
   * Start installing `id`. `approved` is true only for the dashboard's install
   * button (the user's own click); an agent's call gets "approval_required"
   * for a gated, large or package-manager install.
   */
  async startInstall(
    id: string,
    opts: { approved?: boolean; force?: boolean; profile?: string } = {},
  ): Promise<InstallStart> {
    const item = this.item(id);
    const method = this.method(item);
    const running = this.activeJob(id);
    if (running) return { status: "started", id, job_id: running, wait_with: "wait_for_job" };
    if (!opts.force) {
      const found = await this.detect(item);
      if (found.installed) {
        return { status: "already_installed", id, path: found.path, version: found.version };
      }
    }
    switch (method.kind) {
      case "unsupported":
        return { status: "unsupported", id, message: `${item.name} is ${method.reason}` };
      case "link":
        return {
          status: "manual",
          id,
          url: method.url,
          message: `${item.name} is not installed by plughive; install it from ${method.url}`,
        };
      case "apt":
        return {
          status: "manual",
          id,
          command: method.command,
          message: `Install ${item.name} with the system package manager: ${method.command}`,
        };
      default:
        break;
    }
    if (!opts.approved && this.needsApproval(item, method)) {
      const why = item.gated
        ? "its license or download needs your OK"
        : item.size_mb > APPROVAL_SIZE_MB
          ? `it is about ${item.size_mb} MB`
          : `it is installed with ${method.kind === "brew" ? "Homebrew" : "winget"}`;
      return {
        status: "approval_required",
        id,
        approval_path: `/software?install=${encodeURIComponent(id)}`,
        size_mb: item.size_mb,
        license: item.license,
        message: `Installing ${item.name} (${item.license}, about ${item.size_mb} MB) needs your approval because ${why}. Open the plughive dashboard to approve it.`,
      };
    }
    if (!this.jobs) throw new InstallError("no_jobs", "installs need the job queue");
    const jobId = this.jobs.enqueue(
      INSTALL_JOB_TOOL,
      { id },
      opts.profile ? { profile: opts.profile } : {},
    );
    this.active.set(id, jobId);
    this.logger.info({ software: id, job: jobId, method: method.kind }, "software install started");
    return { status: "started", id, job_id: jobId, wait_with: "wait_for_job" };
  }

  private async runJob(input: Record<string, unknown>, exec: JobExecution): Promise<unknown> {
    const id = typeof input.id === "string" ? input.id : "";
    let item: CatalogItem;
    try {
      item = this.item(id);
    } catch (e) {
      throw new JobTerminalError("failed", (e as Error).message);
    }
    const say = (message: string, progress: number | null = null) => {
      exec.mergeCheckpoint({ progress_message: message });
      exec.setProgress(progress);
    };
    try {
      const result = await this.install(item, say, exec.setPhase.bind(exec), exec.signal);
      this.logger.info({ software: id, version: result.version }, "software installed");
      return result;
    } catch (e) {
      if (e instanceof JobTerminalError) throw e;
      if (exec.signal?.aborted) throw new JobTerminalError("cancelled", "install cancelled");
      throw new JobTerminalError("failed", (e as Error).message.slice(0, 500));
    } finally {
      this.active.delete(id);
      this.changed();
    }
  }

  /** Run the install for `item` now (the job body). Exported for the live check and tests. */
  async install(
    item: CatalogItem,
    say: (message: string, progress?: number | null) => void = () => undefined,
    setPhase: JobExecution["setPhase"] = () => undefined,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    version: string | null;
    path: string | null;
    method: string;
    managed: boolean;
  }> {
    const method = this.method(item);
    switch (method.kind) {
      case "archive":
        await this.installArchive(item, method.archive, method.extra, say, setPhase, signal);
        break;
      case "uv":
        await this.installUv(
          item,
          method.package,
          method.python,
          method.with,
          say,
          setPhase,
          signal,
        );
        break;
      case "model":
        await this.installModel(item, method.model, say, setPhase, signal);
        break;
      case "brew":
      case "winget":
        await this.installPkg(item, method, say, setPhase, signal);
        break;
      default:
        throw new JobTerminalError(
          "failed",
          `${item.name} cannot be installed here (${method.kind})`,
        );
    }
    setPhase("running");
    say("Checking that it runs");
    this.statusCache = null;
    const found = await this.detect(item);
    if (!found.installed) {
      throw new JobTerminalError(
        "failed",
        `${item.name} was installed but its check did not pass${found.error ? `: ${found.error}` : ""}`,
      );
    }
    say(`Installed ${item.name}${found.version ? ` ${found.version}` : ""}`, 1);
    return {
      id: item.id,
      version: found.version,
      path: found.path,
      method: method.kind,
      managed: found.managed,
    };
  }

  private itemDir(item: CatalogItem): string {
    return join(this.toolsRoot, item.id, item.version);
  }

  private newStaging(): string {
    const dir = join(this.toolsRoot, ".staging", ulid());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async download(
    url: string,
    dest: string,
    say: (m: string, p?: number | null) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const safe = this.fetcher
      ? null
      : createSafeFetch({
          allowHosts: [...DOWNLOAD_HOSTS, ...MODEL_HOSTS, ...MODEL_REDIRECT_HOSTS],
          maxResponseBytes: MAX_DOWNLOAD_BYTES,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        });
    const fetcher: Fetcher =
      this.fetcher ?? ((u, init) => (safe as NonNullable<typeof safe>)(u, init));
    try {
      const res = await fetcher(url, signal ? { signal } : {});
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      const hash = createHash("sha256");
      let seen = 0;
      let lastShown = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > MAX_DOWNLOAD_BYTES) {
            cb(new Error("download is larger than allowed"));
            return;
          }
          hash.update(chunk);
          if (total > 0 && seen - lastShown > 1024 * 1024) {
            lastShown = seen;
            say(
              `Downloading (${Math.round(seen / 1048576)} of ${Math.round(total / 1048576)} MB)`,
              (seen / total) * 0.8,
            );
          }
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeReadableStream),
        meter,
        createWriteStream(dest, { mode: 0o600 }),
        ...(signal ? [{ signal }] : []),
      );
      return hash.digest("hex");
    } finally {
      await safe?.close().catch(() => undefined);
    }
  }

  private async installArchive(
    item: CatalogItem,
    archive: Extract<InstallMethod, { kind: "archive" }>["archive"],
    extra: Extract<InstallMethod, { kind: "archive" }>["extra"],
    say: (m: string, p?: number | null) => void,
    setPhase: JobExecution["setPhase"],
    signal?: AbortSignal,
  ): Promise<void> {
    const staging = this.newStaging();
    try {
      setPhase("downloading");
      say(`Downloading ${item.name} ${item.version}`, 0);
      const dlDir = join(staging, "download");
      mkdirSync(dlDir, { mode: 0o700 });
      const out = join(staging, "out");
      mkdirSync(out, { mode: 0o700 });
      // The extra raw files first, each checked against its own sha256, so the
      // main file's progress is the last one shown.
      for (const [i, part] of extra.entries()) {
        const partFile = join(
          dlDir,
          `extra-${i}-${basename(new URL(part.url).pathname) || "file"}`,
        );
        const partSha = await this.download(part.url, partFile, say, signal);
        this.checkSha(item, part.sha256, partSha);
        await copyFile(partFile, join(out, Object.values(part.bin)[0] as string));
      }
      const file = join(dlDir, basename(new URL(archive.url).pathname) || "download");
      const sha = await this.download(archive.url, file, say, signal);
      setPhase("running");
      say("Verifying the download", 0.82);
      this.checkSha(item, archive.sha256, sha);
      say("Unpacking", 0.86);
      if (archive.format === "raw") {
        await copyFile(file, join(out, Object.values(archive.bin)[0] as string));
      } else {
        try {
          await extractArchive(file, archive.format, out);
        } catch (e) {
          if (e instanceof ExtractError) throw new JobTerminalError("failed", e.message);
          throw e;
        }
      }
      const allBins = Object.assign({}, ...extra.map((p) => p.bin), archive.bin) as Record<
        string,
        string
      >;
      // Each declared program must be a regular file inside the unpacked folder.
      for (const [name, rel] of Object.entries(allBins)) {
        const p = join(out, ...rel.split("/"));
        let real: string;
        try {
          real = realpathSync.native(p);
        } catch {
          throw new JobTerminalError("failed", `the archive has no ${rel} for ${name}`);
        }
        if (!isInside(realpathSync.native(out), real) || !statSync(real).isFile()) {
          throw new JobTerminalError("failed", `${rel} in the archive is not a program file`);
        }
        if (!isWindows(this.platform)) await chmod(real, 0o755);
      }
      if (signal?.aborted) throw new JobTerminalError("cancelled", "install cancelled");
      say("Placing the program", 0.9);
      const final = this.itemDir(item);
      await rm(final, { recursive: true, force: true });
      mkdirSync(join(final, ".."), { recursive: true, mode: 0o700 });
      await rename(out, final);
      const bins: Record<string, string> = {};
      for (const [name, rel] of Object.entries(allBins))
        bins[name] = join(final, ...rel.split("/"));
      await this.lockAndShim(item, "archive", bins, sha);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Download a pinned model file, check it, move it into the pack's data folder. */
  private async installModel(
    item: CatalogItem,
    model: ModelSource,
    say: (m: string, p?: number | null) => void,
    setPhase: JobExecution["setPhase"],
    signal?: AbortSignal,
  ): Promise<void> {
    const staging = this.newStaging();
    try {
      setPhase("downloading");
      say(`Downloading ${item.name}`, 0);
      const file = join(staging, model.file);
      const sha = await this.download(model.url, file, say, signal);
      setPhase("running");
      say("Verifying the download", 0.85);
      this.checkSha(item, model.sha256, sha);
      if (signal?.aborted) throw new JobTerminalError("cancelled", "install cancelled");
      const dest = this.modelPath(model);
      await mkdir(join(dest, ".."), { recursive: true, mode: 0o700 });
      say("Placing the model", 0.95);
      try {
        await rename(file, dest);
      } catch (err) {
        // Staging and the pack folder on different volumes: copy instead.
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await copyFile(file, dest);
      }
      await updateLock(this.toolsRoot, (lock) => {
        lock.items[item.id] = {
          version: item.version,
          method: "model",
          installed_at: new Date().toISOString(),
          source_sha256: sha,
          bins: {},
          file: relative(this.home, dest).split(sep).join("/"),
        };
      });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private checkSha(item: CatalogItem, expected: string, got: string): void {
    if (got === expected) return;
    throw new JobTerminalError(
      "failed",
      `the download of ${item.name} did not match its pinned sha256 (got ${got.slice(0, 12)}…, expected ${expected.slice(0, 12)}…); nothing was installed`,
    );
  }

  /** A uv to run: the managed one, the one on PATH, or the catalog's uv installed now. */
  private async uvBinary(
    say: (m: string, p?: number | null) => void,
    setPhase: JobExecution["setPhase"],
    signal?: AbortSignal,
  ): Promise<string> {
    const managed = findProgram("uv", [this.binDir]);
    if (managed && (await this.verifyShim("uv"))) return realpathSync.native(managed);
    const onPath = findProgram("uv", this.searchDirs());
    if (onPath) return onPath;
    const uvItem = this.catalog.items.find((i) => i.id === "uv");
    const m = uvItem ? this.method(uvItem) : null;
    if (!uvItem || m?.kind !== "archive")
      throw new JobTerminalError("failed", "uv is needed and cannot be installed here");
    say("Installing uv first");
    await this.installArchive(uvItem, m.archive, m.extra, say, setPhase, signal);
    const after = findProgram("uv", [this.binDir]);
    if (!after) throw new JobTerminalError("failed", "uv did not install");
    return realpathSync.native(after);
  }

  private async installUv(
    item: CatalogItem,
    pkg: string,
    python: string,
    extra: readonly string[],
    say: (m: string, p?: number | null) => void,
    setPhase: JobExecution["setPhase"],
    signal?: AbortSignal,
  ): Promise<void> {
    const uv = await this.uvBinary(say, setPhase, signal);
    setPhase("running");
    say(`Installing ${item.name} ${item.version} with uv (Python ${python})`, 0.1);
    const final = this.itemDir(item);
    await rm(final, { recursive: true, force: true });
    mkdirSync(final, { recursive: true, mode: 0o700 });
    const binOut = join(final, "bin");
    const env: Record<string, string> = {
      ...systemChildEnv(this.platform),
      PATH: joinPath(isWindows(this.platform) ? [] : ["/usr/bin", "/bin"], this.platform),
      HOME: userHome(),
      UV_TOOL_DIR: join(final, "venvs"),
      UV_TOOL_BIN_DIR: binOut,
      UV_PYTHON_INSTALL_DIR: join(this.toolsRoot, "python"),
      UV_CACHE_DIR: join(this.toolsRoot, ".cache", "uv"),
      UV_NO_CONFIG: "1",
      UV_PYTHON_PREFERENCE: "only-managed",
      NO_COLOR: "1",
    };
    if (isWindows(this.platform)) {
      for (const k of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
    } else if (process.env.TMPDIR) {
      env.TMPDIR = process.env.TMPDIR;
    }
    const r = await this.runCommand(
      uv,
      [
        "tool",
        "install",
        "--python",
        python,
        "--force",
        // No --require-hashes: the catalog pins the exact package version but
        // carries no per-wheel hashes to pass, and uv fetches over TLS from
        // PyPI itself.
        ...extra.flatMap((w) => ["--with", w]),
        pkg,
      ],
      {
        env,
        ...(signal ? { signal } : {}),
      },
    );
    if (r.exitCode !== 0) {
      await rm(final, { recursive: true, force: true }).catch(() => undefined);
      throw new JobTerminalError(
        "failed",
        `uv could not install ${item.name}: ${tail(r.stderr || r.stdout)}`,
      );
    }
    const bins: Record<string, string> = {};
    for (const name of item.bins) {
      const found = findProgram(name, [binOut]);
      if (!found)
        throw new JobTerminalError("failed", `uv installed ${item.name} without a ${name} program`);
      bins[name] = found;
    }
    await this.lockAndShim(item, "uv", bins);
  }

  private async installPkg(
    item: CatalogItem,
    method: Extract<InstallMethod, { kind: "brew" | "winget" }>,
    say: (m: string, p?: number | null) => void,
    setPhase: JobExecution["setPhase"],
    signal?: AbortSignal,
  ): Promise<void> {
    setPhase("running");
    let file: string | null;
    let args: string[];
    const env: Record<string, string> = { ...systemChildEnv(this.platform) };
    if (method.kind === "brew") {
      file = this.brewPath();
      args = ["install", ...(method.cask ? ["--cask"] : []), method.package];
      Object.assign(env, {
        HOME: userHome(),
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOMEBREW_NO_AUTO_UPDATE: "1",
        HOMEBREW_NO_ENV_HINTS: "1",
        NONINTERACTIVE: "1",
      });
    } else {
      file = findProgram("winget", this.searchDirs());
      args = [
        "install",
        "--id",
        method.package,
        "--exact",
        "--scope",
        "user",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ];
      for (const k of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH", "Path"]) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
    }
    if (!file) throw new JobTerminalError("failed", `${method.kind} is not available`);
    say(`Running ${methodCommand(method)}`, 0.1);
    const r = await this.runCommand(file, args, { env, ...(signal ? { signal } : {}) });
    if (r.exitCode !== 0) {
      throw new JobTerminalError(
        "failed",
        `${methodCommand(method)} failed: ${tail(r.stderr || r.stdout)}`,
      );
    }
  }

  /** Hash every program, point tools/bin at it, record both in lock.json. */
  private async lockAndShim(
    item: CatalogItem,
    method: LockedItem["method"],
    bins: Record<string, string>,
    sourceSha?: string,
  ): Promise<void> {
    await mkdir(this.binDir, { recursive: true, mode: 0o700 });
    // The whole read-modify-write runs under the lock file's mutex, so a
    // concurrent install cannot lose this entry (or its shim clean-up).
    await updateLock(this.toolsRoot, async (lock) => {
      const entry: LockedItem = {
        version: item.version,
        method,
        installed_at: new Date().toISOString(),
        ...(sourceSha ? { source_sha256: sourceSha } : {}),
        bins: {},
      };
      for (const [name, p] of Object.entries(bins)) {
        const real = realpathSync.native(p);
        if (!isInside(realpathSync.native(this.toolsRoot), real)) {
          throw new JobTerminalError("failed", `${name} resolves outside the tools folder`);
        }
        const rel = relative(realpathSync.native(this.toolsRoot), real).split(sep).join("/");
        entry.bins[name] = { target: rel, sha256: await hashFile(real) };
        // Another item's shim of the same name is replaced; its lock entry loses the name.
        for (const [otherId, other] of Object.entries(lock.items)) {
          if (otherId !== item.id && other.bins[name]) delete other.bins[name];
        }
        await this.placeShim(name, real);
      }
      lock.items[item.id] = entry;
    });
  }

  private shimPath(name: string, target: string): string {
    const ext = isWindows(this.platform) ? (target.match(/\.[A-Za-z0-9]+$/)?.[0] ?? ".exe") : "";
    return join(this.binDir, `${name}${ext}`);
  }

  private async placeShim(name: string, target: string): Promise<void> {
    const shim = this.shimPath(name, target);
    await unlink(shim).catch(() => undefined);
    if (isWindows(this.platform)) {
      // No symlink rights for a normal user on Windows: a copy, hashed like the target.
      await copyFile(target, shim);
      return;
    }
    try {
      await symlink(target, shim);
    } catch (err) {
      // A filesystem without symlinks (FAT, some mounts): a copy, hashed like the target.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EACCES")
        throw err;
      await copyFile(target, shim);
      await chmod(shim, 0o755);
    }
  }

  // ---------------------------------------------------------------- uninstall

  /** Remove what plughive installed for `id`: its folder, shims and lock entry. */
  async uninstall(
    id: string,
  ): Promise<{ status: "removed" | "manual"; id: string; message: string }> {
    const item = this.item(id);
    if (this.activeJob(id)) throw new InstallError("busy", `${item.name} is being installed`);
    const lock = readLock(this.toolsRoot);
    const entry = lock.items[id];
    if (!entry) {
      const found = await this.detect(item);
      if (!found.installed)
        throw new InstallError("not_installed", `${item.name} is not installed`);
      if (item.model) {
        return {
          status: "manual",
          id,
          message: `${item.name} was not downloaded by plughive; delete ${found.path} to remove it.`,
        };
      }
      const m = this.method(item);
      const how =
        m.kind === "brew"
          ? `brew uninstall ${m.cask ? "--cask " : ""}${m.package}`
          : m.kind === "winget"
            ? `winget uninstall --id ${m.package}`
            : "the way it was installed";
      return {
        status: "manual",
        id,
        message: `${item.name} was not installed by plughive${found.path ? ` (${found.path})` : ""}; remove it with ${how}.`,
      };
    }
    if (entry.method === "model" && item.model) {
      // Only the catalog's own path is removed, never a path read from the lock.
      await rm(this.modelPath(item.model), { force: true });
      await updateLock(this.toolsRoot, (lock) => {
        delete lock.items[id];
      });
      this.logger.info({ software: id }, "model removed");
      this.changed();
      return { status: "removed", id, message: `Removed ${item.name}` };
    }
    const itemRoot = join(realpathSync.native(this.toolsRoot), id);
    for (const [name, bin] of Object.entries(entry.bins)) {
      const target = join(this.toolsRoot, ...bin.target.split("/"));
      const shim = this.shimPath(name, target);
      try {
        const st = await lstat(shim);
        // A symlink is removed only when it still points into this item's folder.
        if (!st.isSymbolicLink() || isInside(itemRoot, await readlink(shim))) await unlink(shim);
      } catch {
        /* gone */
      }
    }
    await rm(join(this.toolsRoot, id), { recursive: true, force: true });
    await updateLock(this.toolsRoot, (lock) => {
      delete lock.items[id];
    });
    this.logger.info({ software: id }, "software uninstalled");
    this.changed();
    return { status: "removed", id, message: `Removed ${item.name}` };
  }

  // ---------------------------------------------------------------- trust

  /** Absolute path tools/bin/<name> must resolve to, from lock.json (read now). */
  lockedTarget(name: string, lock: LockFile = readLock(this.toolsRoot)): string | null {
    for (const item of Object.values(lock.items)) {
      const bin = item.bins[name];
      if (bin) {
        try {
          return join(realpathSync.native(this.toolsRoot), ...bin.target.split("/"));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * `realPath` is the locked program for `name` (or, on Windows, its copy in
   * tools/bin) and its sha256 still matches lock.json.
   */
  async verify(name: string, realPath: string): Promise<boolean> {
    const lock = readLock(this.toolsRoot);
    const target = this.lockedTarget(name, lock);
    if (!target) return false;
    const copy = this.isShimCopy(name, target, realPath);
    if (target !== realPath && !copy) return false;
    const want = Object.values(lock.items).find((i) => i.bins[name])?.bins[name]?.sha256;
    if (!want) return false;
    try {
      return (await hashFile(realPath)) === want;
    } catch {
      return false;
    }
  }

  /** `realPath` is the copy of the program in tools/bin (Windows, or no symlinks). */
  private isShimCopy(name: string, target: string, realPath: string): boolean {
    const shim = this.shimPath(name, target);
    if (realPath === shim) return true;
    try {
      return realPath === realpathSync.native(shim);
    } catch {
      return false;
    }
  }

  private async verifyShim(name: string): Promise<boolean> {
    const shim = findProgram(name, [this.binDir]);
    if (!shim) return false;
    try {
      return await this.verify(name, realpathSync.native(shim));
    } catch {
      return false;
    }
  }

  /** What the spawn layer needs to trust tools/bin. */
  trustedTools(): HostTrustedTools {
    return {
      binDir: this.binDir,
      lockedTarget: (name) => this.lockedTarget(name),
      verify: (name, realPath) => this.verify(name, realPath),
      subscribe: (listener) => this.subscribe(listener),
    };
  }
}
