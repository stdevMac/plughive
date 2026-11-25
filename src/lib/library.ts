import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
// src/lib/library.ts
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { openPrivateDb } from "./private-db.js";

const ulid = monotonicFactory();
import type { Artifact, ArtifactKind, ArtifactRef } from "../types.js";

const PREFIX: Record<ArtifactKind, string> = {
  image: "img",
  video: "vid",
  audio: "aud",
  pdf: "pdf",
  document: "doc",
  data: "dat",
  other: "art",
};
const EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/pcm": "pcm",
  "audio/opus": "opus",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/basic": "ulaw",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/vtt": "vtt",
  "application/x-subrip": "srt",
  "application/json": "json",
};

/**
 * The ids this library hands out: a kind prefix and a ULID. Anything else is
 * not an artifact of this library (used where an id drives a write).
 */
export const ARTIFACT_ID_PATTERN = /^(?:img|vid|aud|pdf|doc|dat|art)_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The file extension the library uses for a media type ("bin" when unknown). */
export function extensionForMime(mime: string): string {
  const type = (mime.split(";", 1)[0] ?? "").trim().toLowerCase();
  return Object.hasOwn(EXT, type) ? (EXT[type] as string) : "bin";
}

/** What Library.remove did. */
export interface RemoveResult {
  /**
   * True when the file was unlinked. False when it was already gone, or when
   * the stored path does not lie inside the artifacts folder (then the file is
   * left alone and only the row goes).
   */
  fileRemoved: boolean;
}

/** True when `path` lies strictly inside `root` (both absolute). */
function strictlyInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && !rel.startsWith("..");
}

/** Thrown by importHandle when the source passes the byte cap. */
export class ArtifactTooLargeError extends RangeError {
  constructor(maxBytes: number) {
    super(`library: artifact is larger than ${maxBytes} bytes`);
    this.name = "ArtifactTooLargeError";
  }
}

export interface LibraryOpts {
  root: string;
  baseUrl: string;
}

export interface SaveInput {
  kind: ArtifactKind;
  mime: string;
  bytes: Buffer;
  tool: string;
  model?: string | null;
  prompt?: string | null;
  meta?: Record<string, unknown> | null;
  costUsd?: number | null;
}

export interface ImportInput {
  sourcePath: string;
  kind: ArtifactKind;
  mime: string;
  tool: string;
  model?: string | null;
  prompt?: string | null;
  meta?: Record<string, unknown> | null;
  costUsd?: number | null;
}

function ownerOnly(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort: a read-only or foreign-owned path keeps its mode.
  }
}

export class Library {
  private db: Database.Database;
  private root: string;
  private baseUrl: string;

  constructor(opts: LibraryOpts) {
    this.root = opts.root;
    this.baseUrl = opts.baseUrl;
    // Prompts, metadata and the files themselves are the user's: the folder
    // is 0700 and the database and artifacts 0600, also when they already
    // existed with looser modes. Older artifact files keep their mode; the
    // 0700 folder above them is what keeps other local users out.
    const artifactsDir = join(this.root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    ownerOnly(artifactsDir, 0o700);
    this.db = openPrivateDb(join(this.root, "library.db"));
    this.db.pragma("journal_mode = WAL");
    this.protectFiles();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL,
        path TEXT NOT NULL, bytes INTEGER NOT NULL, tool TEXT NOT NULL,
        model TEXT, prompt TEXT, meta_json TEXT, cost_usd REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at DESC);
      CREATE INDEX IF NOT EXISTS artifacts_kind    ON artifacts(kind);
    `);
  }

  /** The database and its sidecar files are readable by the owner only. */
  private protectFiles(): void {
    const file = join(this.root, "library.db");
    for (const path of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      if (existsSync(path)) ownerOnly(path, 0o600);
    }
  }

  save(input: SaveInput): ArtifactRef {
    const target = this.allocate(input.kind, input.mime);
    writeFileSync(target.path, input.bytes, { mode: 0o600 });
    return this.insert({ ...target, ...input, bytes: input.bytes.length });
  }

  importFile(input: ImportInput): ArtifactRef {
    const target = this.allocate(input.kind, input.mime);
    copyFileSync(input.sourcePath, target.path);
    // The copy takes the mode of its source.
    chmodSync(target.path, 0o600);
    return this.insert({ ...target, ...input, bytes: statSync(target.path).size });
  }

  /**
   * Stream an open file into a new artifact without buffering it. The target
   * is created fresh (O_EXCL, never through a symlink); past `maxBytes` the
   * copy stops, the partial file is removed and ArtifactTooLargeError is
   * thrown. The caller keeps ownership of `source`.
   */
  async importHandle(
    input: Omit<SaveInput, "bytes">,
    source: FileHandle,
    maxBytes: number,
  ): Promise<ArtifactRef> {
    const target = this.allocate(input.kind, input.mime);
    const out = await open(
      target.path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    // Plain positional reads and writes on the two descriptors. A stream made
    // with autoClose:false keeps a reference on its handle, and close() then
    // waits for a release that never comes.
    let total = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        if (total + bytesRead > maxBytes) throw new ArtifactTooLargeError(maxBytes);
        let written = 0;
        while (written < bytesRead) {
          const res = await out.write(buffer, written, bytesRead - written, total + written);
          written += res.bytesWritten;
        }
        total += bytesRead;
      }
      await out.close();
    } catch (err) {
      await out.close().catch(() => undefined);
      await rm(target.path, { force: true }).catch(() => undefined);
      throw err;
    }
    return this.insert({ ...target, ...input, bytes: total });
  }

  get(id: string): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      mime: row.mime,
      path: row.path,
      bytes: row.bytes,
      tool: row.tool,
      model: row.model,
      prompt: row.prompt,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
    };
  }

  /**
   * Delete one artifact: its file, then its row. The file path comes from the
   * row only and is unlinked only when it lies inside this library's
   * artifacts folder, both as written and with symlinks resolved. A file that
   * is already gone is not an error. Returns null for an unknown id.
   */
  remove(id: string): RemoveResult | null {
    const row = this.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(id) as
      | { path: unknown }
      | undefined;
    if (!row) return null;
    const fileRemoved = typeof row.path === "string" ? this.unlinkInside(row.path) : false;
    this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    return { fileRemoved };
  }

  /** Unlink `path` when it is a file inside the artifacts folder. Already gone: false. */
  private unlinkInside(path: string): boolean {
    if (!isAbsolute(path) || path.includes("\0")) return false;
    const dir = join(this.root, "artifacts");
    if (!strictlyInside(resolve(dir), resolve(path))) return false;
    try {
      // The folder holding the file, symlinks resolved, must still be inside
      // the real artifacts folder: a swapped-in symlinked folder leads nowhere.
      const realDir = realpathSync(dir);
      const target = join(realpathSync(dirname(path)), basename(path));
      if (!strictlyInside(realDir, target)) return false;
      const info = lstatSync(target);
      // A symlink is removed as a link (its target is untouched); a folder never is.
      if (!info.isFile() && !info.isSymbolicLink()) return false;
      unlinkSync(target);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  listRecent(limit = 50): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as ArtifactRow[];
    return rows.map((r) => rowToArtifact(r));
  }

  list(filter: ListFilter = {}, limit = 50, offset = 0): Artifact[] {
    const cappedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.tool !== undefined) {
      clauses.push("tool = ?");
      params.push(filter.tool);
    }
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.model !== undefined) {
      clauses.push("model = ?");
      params.push(filter.model);
    }
    if (filter.since !== undefined) {
      clauses.push("created_at >= ?");
      params.push(filter.since);
    }
    if (filter.prompt_contains !== undefined) {
      clauses.push("prompt LIKE ?");
      params.push(`%${filter.prompt_contains}%`);
    }
    for (const key of ["chain_id", "scene_id", "role", "orientation"] as const) {
      if (filter[key] !== undefined) {
        clauses.push(`json_extract(meta_json, '$.${key}') = ?`);
        params.push(filter[key]);
      }
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const skip = Math.max(0, Math.floor(offset));
    const sql = `SELECT * FROM artifacts${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, cappedLimit, skip) as ArtifactRow[];
    return rows.map((r) => rowToArtifact(r));
  }

  /** Number of artifacts, optionally of one kind. */
  count(kind?: ArtifactKind): number {
    const row = (
      kind === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()
        : this.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?").get(kind)
    ) as { n: number };
    return row.n;
  }

  get baseUrlValue(): string {
    return this.baseUrl;
  }

  get rootValue(): string {
    return this.root;
  }

  close(): void {
    this.db.close();
  }

  private allocate(
    kind: ArtifactKind,
    mime: string,
  ): { id: string; path: string; createdAt: string } {
    const id = `${PREFIX[kind]}_${ulid()}`;
    const now = new Date();
    const dir = join(
      this.root,
      "artifacts",
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { id, path: join(dir, `${id}.${extensionForMime(mime)}`), createdAt: now.toISOString() };
  }

  private insert(input: {
    id: string;
    path: string;
    bytes: number;
    createdAt: string;
    kind: ArtifactKind;
    mime: string;
    tool: string;
    model?: string | null;
    prompt?: string | null;
    meta?: Record<string, unknown> | null;
    costUsd?: number | null;
  }): ArtifactRef {
    this.db
      .prepare(
        `INSERT INTO artifacts(id,kind,mime,path,bytes,tool,model,prompt,meta_json,cost_usd,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.kind,
        input.mime,
        input.path,
        input.bytes,
        input.tool,
        input.model ?? null,
        input.prompt ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        input.costUsd ?? null,
        input.createdAt,
      );
    return {
      id: input.id,
      path: input.path,
      mime: input.mime,
      bytes: input.bytes,
      model: input.model ?? null,
      prompt: input.prompt ?? null,
      cost_usd: input.costUsd ?? null,
      url: `${this.baseUrl}/artifacts/${input.id}`,
    };
  }
}

export interface ListFilter {
  tool?: string;
  kind?: ArtifactKind;
  model?: string;
  since?: string;
  prompt_contains?: string;
  chain_id?: string;
  scene_id?: string;
  role?: string;
  orientation?: string;
}

/** A row of the artifacts table as SQLite returns it. */
interface ArtifactRow {
  id: Artifact["id"];
  kind: Artifact["kind"];
  mime: Artifact["mime"];
  path: Artifact["path"];
  bytes: Artifact["bytes"];
  tool: Artifact["tool"];
  model: Artifact["model"];
  prompt: Artifact["prompt"];
  meta_json: string | null;
  cost_usd: Artifact["costUsd"];
  created_at: Artifact["createdAt"];
}

function rowToArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    path: r.path,
    bytes: r.bytes,
    tool: r.tool,
    model: r.model,
    prompt: r.prompt,
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
}
