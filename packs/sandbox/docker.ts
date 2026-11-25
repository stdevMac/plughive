// packs/sandbox/docker.ts
//
// One-shot local containers through the docker CLI (only when docker is on
// the daemon's PATH; otherwise ctx.spawn throws SpawnError "not_installed").
// Each run gets a fresh temp folder inside the pack's dataDir mounted at
// /work and nothing else from the host; the network is off unless the user
// turned on the allowNetwork setting; memory, CPU and process count are capped,
// all capabilities dropped, privilege escalation blocked and the container
// runs as the daemon's own user. Files the command leaves in /work are read
// back through openInside, so a symlink planted in /work cannot make the
// daemon read a host file.
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type PackContext, UnsafePathError, openInside, readFileCapped } from "plughive/pack";
import { noControl } from "./http.js";
import { type CommandResult, MAX_FILE_BYTES, capText } from "./shared.js";

export const DEFAULT_IMAGES = ["python:3.12-slim", "node:22-slim", "alpine:3.20"];

export interface DockerRunInput {
  image: string;
  command: string;
  files?: Record<string, string>;
  network: boolean;
  timeoutS: number;
  collect?: string[];
}

export interface DockerRunOutput extends CommandResult {
  files: { path: string; bytes: Uint8Array }[];
}

function allowedImages(ctx: PackContext): string[] {
  const v = ctx.settings.allowedImages;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  return DEFAULT_IMAGES;
}

/** A relative path inside /work: no absolute paths, no "..", no control characters. */
export function workPath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= 512 &&
    noControl(p) &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.split("/").some((seg) => seg === ".." || seg === "")
  );
}

function inside(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep)) throw new Error(`path escapes the work folder: ${rel}`);
  return full;
}

/**
 * Read one collected file out of the work folder. The command inside the
 * container ran as an untrusted user and may have left symlinks behind, so
 * the path is opened through openInside (realpath containment, every
 * symlink segment rejected, O_NOFOLLOW on the leaf, fstat regular-file and
 * same-file checks) and read through that descriptor with the byte cap.
 */
async function collectFile(work: string, rel: string): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await openInside(work, rel);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      if (err.reason === "not_found" || err.reason === "not_regular_file") {
        throw new Error(`no file ${rel} in /work after the run`);
      }
      throw new Error(`refusing to collect ${rel} from /work: ${err.message}`);
    }
    throw err;
  }
  try {
    return new Uint8Array(await readFileCapped(handle, { maxBytes: MAX_FILE_BYTES }));
  } catch (err) {
    if (err instanceof UnsafePathError && err.reason === "too_large") {
      throw new Error(`${rel} is over the 100 MB limit`);
    }
    if (err instanceof UnsafePathError) {
      throw new Error(`refusing to collect ${rel} from /work: ${err.message}`);
    }
    throw err;
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function dockerRun(ctx: PackContext, input: DockerRunInput): Promise<DockerRunOutput> {
  if (!allowedImages(ctx).includes(input.image)) {
    throw new Error(
      `image ${input.image} is not in this pack's allowedImages setting; the user can add it there`,
    );
  }
  if (input.network && ctx.settings.allowNetwork !== true) {
    throw new Error(
      "network access is off: the user must turn on this pack's allowNetwork setting",
    );
  }
  const runs = join(ctx.pack.dataDir, "runs");
  await mkdir(runs, { recursive: true });
  const work = await mkdtemp(join(runs, "run-"));
  const name = `mcp-sandbox-${randomUUID().slice(0, 12)}`;
  const env: Record<string, string> = {};
  const host = ctx.settings.dockerHost;
  if (typeof host === "string" && host.trim() !== "") env.DOCKER_HOST = host.trim();
  try {
    // Writing the input files: the work folder is fresh (mkdtemp) and empty,
    // so no symlink can exist in it yet; `inside` still refuses any path
    // that resolves outside it.
    for (const [rel, content] of Object.entries(input.files ?? {})) {
      if (!workPath(rel)) throw new Error(`not a relative path inside /work: ${rel}`);
      const full = inside(work, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, { mode: 0o644 });
    }
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      input.network ? "bridge" : "none",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      // Run as the daemon's own user, not root: files the command leaves in
      // /work stay owned by the daemon, which can then delete the run folder.
      // That user has no home in the image, so HOME is /tmp (writable for
      // everyone): pip falls back to a user install there and npm keeps its
      // cache there. (No --read-only: commands may still write elsewhere.)
      ...(typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`, "--env", "HOME=/tmp"]
        : []),
      "-v",
      `${work}:/work`,
      "-w",
      "/work",
      "--entrypoint",
      "sh",
      input.image,
      "-c",
      input.command,
    ];
    let r: Awaited<ReturnType<PackContext["spawn"]>>;
    try {
      r = await ctx.spawn("docker", args, {
        env,
        timeoutMs: input.timeoutS * 1000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
    } catch (err) {
      if ((err as { code?: string }).code === "not_installed") {
        throw new Error("docker is not installed on this machine (not found on the daemon's PATH)");
      }
      throw err;
    }
    if (r.timedOut) {
      await ctx.spawn("docker", ["kill", name], { env, timeoutMs: 15_000 }).catch(() => {});
    }
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const rel of input.collect ?? []) {
      files.push({ path: rel, bytes: await collectFile(work, rel) });
    }
    return {
      exit_code: r.exitCode,
      stdout: capText(r.stdout),
      stderr: capText(r.stderr),
      ...(r.timedOut ? { timed_out: true } : {}),
      ...(r.truncated ? { truncated: true } : {}),
      files,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
