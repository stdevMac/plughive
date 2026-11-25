// src/core/tools/builtin/artifacts.ts
//
// list_artifacts and import_artifact: the two core tools over the artifact
// library.
//
// import_artifact copies a local file into the library. It only reads inside
// the directories the user configured (PLUGHIVE_IMPORT_ROOTS): the path is
// resolved through symlinks first and must then lie inside the resolved root,
// so neither `..` nor a symlink leads out. The file is then OPENED without
// following a symlink, the open descriptor is checked to be that same regular
// file inside the root, and the copy reads from the descriptor, so swapping a
// path component after the check changes nothing. It takes a path only, never
// a URL, so it cannot be used to make the daemon fetch anything.
//
// Nothing here reports an absolute path: a library row is known to clients by
// its id, its URL and its file name.
import { realpathSync, statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import type { Artifact, ArtifactKind, ArtifactRef } from "../../../types.js";
import { openInside } from "../../fs/safe-path.js";
import { ARTIFACT_KINDS } from "../../pack-api.js";
import type { RegisteredTool } from "../registry.js";
import { coreTool } from "./define.js";

export interface ArtifactToolDeps {
  library: {
    list(filter: Record<string, unknown>, limit?: number, offset?: number): Artifact[];
    /** Copies from the open descriptor, stopping past `maxBytes`. */
    importHandle(
      input: {
        kind: ArtifactKind;
        mime: string;
        tool: string;
        meta?: Record<string, unknown> | null;
      },
      source: FileHandle,
      maxBytes: number,
    ): Promise<ArtifactRef>;
  };
  /** Directories import_artifact may read from. Empty: importing is off. */
  importRoots: readonly string[];
  /** Download URL of an artifact (signed when the daemon needs an access key). */
  urlFor(id: string): string;
}

export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

const IMPORT_TYPES: Record<string, { kind: "image" | "video" | "audio" | "pdf"; mime: string }> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".flac": { kind: "audio", mime: "audio/flac" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".opus": { kind: "audio", mime: "audio/opus" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".pdf": { kind: "pdf", mime: "application/pdf" },
};

/** One library row as tools and the API report it. */
export function artifactView(a: Artifact, urlFor: (id: string) => string) {
  return {
    id: a.id,
    url: urlFor(a.id),
    // The file name only: where the library lives is nobody's business.
    name: basename(a.path),
    kind: a.kind,
    mime: a.mime,
    bytes: a.bytes,
    tool: a.tool,
    model: a.model,
    prompt: a.prompt,
    cost_usd: a.costUsd,
    meta: a.meta,
    createdAt: a.createdAt,
  };
}

const ListInput = z
  .object({
    tool: z.string().max(128).optional().describe("Only artifacts made by this tool"),
    kind: z.enum(ARTIFACT_KINDS as [ArtifactKind, ...ArtifactKind[]]).optional(),
    model: z.string().max(256).optional(),
    since: z
      .string()
      .max(40)
      .optional()
      .describe("ISO time: only artifacts created at or after it"),
    prompt_contains: z.string().max(256).optional(),
    chain_id: z.string().max(128).optional(),
    scene_id: z.string().max(128).optional(),
    role: z.string().max(64).optional(),
    orientation: z.string().max(32).optional(),
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

const ImportInput = z
  .object({
    source_path: z.string().min(1).max(4096).describe("Absolute path of a local file"),
    kind: z.enum(["image", "video", "audio", "pdf", "other"]),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** True when `path` is `root` or lies inside it (both already resolved). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."));
}

/**
 * The real path of `sourcePath` when it is a regular file inside one of
 * `roots`. Throws a message that names no directory.
 */
export function resolveImportSource(sourcePath: string, roots: readonly string[]): string {
  return locateImportSource(sourcePath, roots).real;
}

function locateImportSource(
  sourcePath: string,
  roots: readonly string[],
): { real: string; root: string } {
  if (roots.length === 0) {
    throw new Error(
      "importing is off: set PLUGHIVE_IMPORT_ROOTS to the folders files may be imported from",
    );
  }
  if (!isAbsolute(sourcePath) || sourcePath.includes("\0")) {
    throw new Error("source_path must be an absolute path");
  }
  let real: string;
  let size: number;
  try {
    real = realpathSync(sourcePath);
    const st = statSync(real);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    throw new Error("source_path must resolve to an existing regular file");
  }
  let inside: string | null = null;
  for (const root of roots) {
    try {
      const rootReal = realpathSync(root);
      if (isInside(rootReal, real)) {
        inside = rootReal;
        break;
      }
    } catch {
      // an unusable root allows nothing
    }
  }
  if (inside === null) throw new Error("source_path is outside the configured import roots");
  if (size > MAX_IMPORT_BYTES) throw new Error("the file is larger than the 1 GiB import limit");
  return { real, root: inside };
}

/**
 * Open the import source for reading. The returned descriptor IS the file
 * that was checked: opened without following a symlink, a regular file, and
 * still inside the root when looked up again after opening. The caller closes it.
 */
export async function openImportSource(
  sourcePath: string,
  roots: readonly string[],
  /** Test seam: runs between the path check and the open. */
  beforeOpen?: () => void,
): Promise<{ handle: FileHandle; real: string }> {
  const { real, root } = locateImportSource(sourcePath, roots);
  beforeOpen?.();
  let handle: FileHandle;
  try {
    handle = await openInside(root, relative(root, real), { rejectHardLinks: false });
  } catch {
    throw new Error("source_path must resolve to an existing regular file inside the import roots");
  }
  try {
    const info = await handle.stat();
    if (info.size > MAX_IMPORT_BYTES) {
      throw new Error("the file is larger than the 1 GiB import limit");
    }
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
  return { handle, real };
}

export function artifactTools(deps: ArtifactToolDeps): RegisteredTool[] {
  return [
    coreTool({
      name: "list_artifacts",
      description:
        "List files in the artifact library (images, video, audio, documents), newest first. Filter by tool, kind, model, time or prompt text.",
      input: ListInput,
      tags: ["library"],
      run: ({ limit, ...filter }) => {
        const artifacts = deps.library.list(filter, limit).map((a) => artifactView(a, deps.urlFor));
        return { artifacts, count: artifacts.length };
      },
    }),
    coreTool({
      name: "import_artifact",
      description:
        "Copy a local image, video, audio file or PDF into the artifact library. The file must be inside a folder listed in PLUGHIVE_IMPORT_ROOTS.",
      input: ImportInput,
      tags: ["library"],
      run: async ({ source_path, kind, meta }) => {
        // Open once and take the extension from the opened file's real path,
        // so the type check and the copy cannot see two different files.
        const { handle, real } = await openImportSource(source_path, deps.importRoots);
        try {
          const type = IMPORT_TYPES[extname(real).toLowerCase()];
          if (!type) {
            throw new Error(
              `unsupported file type: ${Object.keys(IMPORT_TYPES)
                .map((e) => e.slice(1))
                .join(", ")} can be imported`,
            );
          }
          if (kind !== "other" && kind !== type.kind) {
            const what = (k: string) =>
              ({ image: "an image", video: "a video", audio: "audio", pdf: "a PDF" })[k] ??
              "another kind of file";
            throw new Error(`the file is ${what(type.kind)}, not ${what(kind)}`);
          }
          const { path, ...ref } = await deps.library.importHandle(
            {
              kind: kind === "other" ? "other" : type.kind,
              mime: type.mime,
              tool: "import_artifact",
              meta: meta ?? null,
            },
            handle,
            MAX_IMPORT_BYTES,
          );
          return { artifact: { ...ref, name: basename(path), url: deps.urlFor(ref.id) } };
        } finally {
          await handle.close().catch(() => undefined);
        }
      },
    }),
  ];
}
