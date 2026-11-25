// src/core/installer/catalog.ts
//
// The pinned catalog of software plughive can install or detect. Every
// download URL is https on a GitHub release host and carries the sha256 the
// file was checked against when the entry was written; an entry without a
// verified download is installed through the OS package manager or only
// detected, with a link to the official install page.
//
// How an entry is installed on this machine, in order:
//   1. archive   a pinned file for this OS/arch (sha256 checked before use)
//   2. uv        `uv tool install <package==version>` into the tools folder
//   3. pkgmgr    brew / brew cask (macOS) or winget (Windows), never sudo;
//                apt is only shown as a command for the user to run
//   4. link      detect only: the official install page
//
// A `model` entry is a data file, not a program: a pinned Hugging Face file
// (sha256 checked) saved into a pack's data folder, where that pack looks for
// models (whisper.cpp's ggml models go to pack-data/local/models).
import { z } from "zod";
import raw from "./catalog.json" with { type: "json" };

/** Hosts a catalog download may come from (and redirect to). */
export const DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

/** Hosts a model file may come from; downloads redirect to the Hugging Face CDN. */
export const MODEL_HOSTS = ["huggingface.co"] as const;
export const MODEL_REDIRECT_HOSTS = ["*.hf.co", "*.huggingface.co"] as const;

/** An install over this size needs the user's approval, like a gated one. */
export const APPROVAL_SIZE_MB = 200;

export const PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** brew formula / cask, winget id, apt package: no spaces, no option-looking names. */
const PKG = /^[A-Za-z0-9][A-Za-z0-9.+_@/-]{0,99}$/;
/** `name==version` or `name[extra,extra]==version`: always pinned. */
const UV_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9_,-]+\])?==[A-Za-z0-9.+_-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "must be https");

const relPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === ".." || s === ""),
    "must be a plain relative path",
  );

const regex = z
  .string()
  .max(200)
  .refine((r) => {
    try {
      new RegExp(r);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid regular expression");

const ArchiveSource = z
  .object({
    url: httpsUrl.refine((u) => {
      const host = new URL(u).hostname;
      return (DOWNLOAD_HOSTS as readonly string[]).includes(host);
    }, "must be a GitHub release URL"),
    sha256: z.string().regex(SHA256),
    format: z.enum(["raw", "tar.gz", "zip"]),
    /** Command name → path of the program inside the extracted archive (or the file name for raw). */
    bin: z.record(z.string().regex(BIN), relPath).refine((b) => Object.keys(b).length > 0),
  })
  .strict();

/**
 * `archive` is the main download; `extra` lists more single files placed next
 * to it (a raw ffprobe beside a raw ffmpeg). Each one carries its own sha256.
 */
const PlatformSource = z
  .object({
    archive: ArchiveSource,
    extra: z
      .array(ArchiveSource.refine((a) => a.format === "raw", "extra files must be raw"))
      .max(4)
      .optional(),
  })
  .strict()
  .superRefine((src, ctx) => {
    const files = [src.archive, ...(src.extra ?? [])];
    const targets = new Set<string>();
    for (const f of files) {
      for (const [name, rel] of Object.entries(f.bin)) {
        if (targets.has(name))
          ctx.addIssue({ code: "custom", message: `bin ${name} is listed twice` });
        targets.add(name);
        if (f.format === "raw" && rel.includes("/")) {
          ctx.addIssue({ code: "custom", message: `raw file ${rel} must be a plain file name` });
        }
      }
      if (f.format === "raw" && Object.keys(f.bin).length !== 1) {
        ctx.addIssue({ code: "custom", message: "a raw file names exactly one program" });
      }
    }
    if ((src.extra?.length ?? 0) > 0 && src.archive.format !== "raw") {
      ctx.addIssue({ code: "custom", message: "extra files go with a raw main file" });
    }
  });

const Probe = z
  .object({
    bin: z.string().regex(BIN).optional(),
    args: z.array(z.string().max(40)).max(4).optional(),
    /** First capture group is the version. */
    version: regex.optional(),
    /** Output must match (case-insensitive) when there is no version to read. */
    expect: regex.optional(),
    /** A local HTTP endpoint that answers when the service runs (127.0.0.1 only). */
    http: z
      .string()
      .url()
      .refine((u) => /^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(u), "must be http://127.0.0.1:<port>/")
      .optional(),
    /** Fixed install locations to check per OS (an app bundle, a program folder). */
    paths: z
      .object({
        darwin: z.array(z.string().max(200)).max(4).optional(),
        win32: z.array(z.string().max(200)).max(4).optional(),
        linux: z.array(z.string().max(200)).max(4).optional(),
      })
      .strict()
      .optional(),
    timeout_ms: z.number().int().min(1000).max(120_000).optional(),
  })
  .strict()
  .refine((p) => p.bin || p.http || p.paths, "a probe needs bin, http or paths");

/** A pinned Hugging Face file: https://huggingface.co/<owner>/<repo>/resolve/<40-hex commit>/<file>. */
const HF_URL =
  /^https:\/\/huggingface\.co\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/resolve\/[0-9a-f]{40}\/[A-Za-z0-9_.-]+$/;
const MODEL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(bin|gguf|onnx|safetensors)$/;
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const ModelSource = z
  .object({
    url: z.string().regex(HF_URL, "must be a huggingface.co /resolve/<commit>/ URL"),
    sha256: z.string().regex(SHA256),
    /** File name it is saved as. */
    file: z.string().regex(MODEL_FILE),
    /** The pack whose data folder it goes into, and the folder inside it. */
    pack: z.string().regex(ID),
    dir: z.string().regex(SEGMENT),
  })
  .strict();
export type ModelSource = z.output<typeof ModelSource>;

const PkgMgr = z
  .object({
    brew: z.string().regex(PKG).optional(),
    brew_cask: z.string().regex(PKG).optional(),
    winget: z.string().regex(PKG).optional(),
    apt: z.string().regex(PKG).optional(),
  })
  .strict();

export const CatalogItem = z
  .object({
    id: z.string().regex(ID),
    name: z.string().min(1).max(60),
    summary: z.string().min(1).max(200),
    version: z.string().min(1).max(40),
    license: z.string().min(1).max(80),
    size_mb: z.number().int().min(0).max(100_000),
    gated: z.boolean(),
    homepage: httpsUrl,
    install_url: httpsUrl.optional(),
    tags: z.array(z.string().max(30)).max(10).default([]),
    /** Only offered on these platforms (default: all). */
    platforms: z.array(z.enum(PLATFORM_KEYS)).optional(),
    bins: z.array(z.string().regex(BIN)).max(8),
    /** How to tell it is installed (every entry except a model file). */
    probe: Probe.optional(),
    model: ModelSource.optional(),
    sources: z.partialRecord(z.enum(PLATFORM_KEYS), PlatformSource).optional(),
    uv: z
      .object({
        package: z.string().regex(UV_PACKAGE, "must be pinned: name==version"),
        python: z.string().regex(/^3\.\d{1,2}$/),
        /** Pinned packages added to the tool's environment (`--with`), for a dependency it forgot. */
        with: z
          .array(z.string().regex(UV_PACKAGE, "must be pinned: name==version"))
          .max(8)
          .optional(),
      })
      .strict()
      .optional(),
    pkgmgr: PkgMgr.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    for (const [key, src] of Object.entries(item.sources ?? {})) {
      for (const name of [src.archive, ...(src.extra ?? [])].flatMap((f) => Object.keys(f.bin))) {
        if (!item.bins.includes(name)) {
          ctx.addIssue({ code: "custom", message: `${key}: bin ${name} is not in bins` });
        }
      }
    }
    if (item.model) {
      if (item.probe || item.sources || item.uv || item.pkgmgr || item.bins.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: "a model entry has only model: no probe, sources, uv, pkgmgr or bins",
        });
      }
    } else if (!item.probe) {
      ctx.addIssue({ code: "custom", message: "a probe is needed" });
    }
    if (item.probe?.bin && item.bins.length > 0 && !item.bins.includes(item.probe.bin)) {
      ctx.addIssue({ code: "custom", message: "probe.bin must be one of bins" });
    }
  });
export type CatalogItem = z.output<typeof CatalogItem>;

export const Catalog = z
  .object({ schema: z.literal(1), items: z.array(CatalogItem).max(200) })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const item of c.items) {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${item.id}` });
      seen.add(item.id);
    }
  });
export type Catalog = z.output<typeof Catalog>;

export function loadCatalog(data: unknown = raw): Catalog {
  return Catalog.parse(data);
}

export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformKey | null {
  const key = `${platform}-${arch}`;
  return (PLATFORM_KEYS as readonly string[]).includes(key) ? (key as PlatformKey) : null;
}

export type InstallMethod =
  | {
      kind: "archive";
      archive: z.output<typeof ArchiveSource>;
      /** More raw files placed beside the main one. */
      extra: z.output<typeof ArchiveSource>[];
    }
  | { kind: "uv"; package: string; python: string; with: string[] }
  /** A data file saved into a pack's data folder. */
  | { kind: "model"; model: ModelSource }
  | { kind: "brew"; package: string; cask: boolean }
  | { kind: "winget"; package: string }
  /** Shown to the user as a command; never run by plughive (it needs sudo). */
  | { kind: "apt"; package: string; command: string }
  | { kind: "link"; url: string }
  | { kind: "unsupported"; reason: string };

/** How `item` installs on this platform. `hasBrew` / `hasWinget`: is the package manager there. */
export function pickMethod(
  item: CatalogItem,
  key: PlatformKey | null,
  env: { hasBrew: boolean; hasWinget: boolean; hasApt: boolean },
): InstallMethod {
  if (key && item.platforms && !item.platforms.includes(key)) {
    return { kind: "unsupported", reason: `not available for ${key}` };
  }
  if (item.model) return { kind: "model", model: item.model };
  const src = key ? item.sources?.[key] : undefined;
  if (src) return { kind: "archive", archive: src.archive, extra: src.extra ?? [] };
  if (item.uv)
    return {
      kind: "uv",
      package: item.uv.package,
      python: item.uv.python,
      with: item.uv.with ?? [],
    };
  const pm = item.pkgmgr ?? {};
  const os = key?.split("-")[0];
  if (os === "darwin" && env.hasBrew) {
    if (pm.brew) return { kind: "brew", package: pm.brew, cask: false };
    if (pm.brew_cask) return { kind: "brew", package: pm.brew_cask, cask: true };
  }
  if (os === "win32" && env.hasWinget && pm.winget) return { kind: "winget", package: pm.winget };
  if (os === "linux" && env.hasApt && pm.apt) {
    return { kind: "apt", package: pm.apt, command: `sudo apt install ${pm.apt}` };
  }
  return { kind: "link", url: item.install_url ?? item.homepage };
}
