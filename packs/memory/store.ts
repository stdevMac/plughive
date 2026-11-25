// packs/memory/store.ts
//
// SQLite storage for the memory pack. One database file per pack data
// directory. Every memory keeps its embedding as a float32 BLOB in the
// `memories` table: that column is the source of truth.
//
// Search has two modes:
//  - "sqlite-vec": the sqlite-vec extension is loaded. Each collection gets a
//    vec0 virtual table `vec_<collection id>` (cosine distance) used as a KNN
//    index; filtered searches (tags) use vec_distance_cosine over the BLOBs.
//  - "js": the extension could not be loaded (unsupported platform, missing
//    optional package, a SQLite build without extension loading). Search is
//    brute-force cosine similarity in JS over the same BLOBs.
//
// A database written in "js" mode stays usable in "sqlite-vec" mode: writes
// in "js" mode mark the collection's index dirty, and the next open with the
// extension rebuilds dirty or missing vec0 tables from the BLOBs and drops
// vec0 tables left behind by deleted collections.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type SearchMode = "sqlite-vec" | "js";

/** Loads a SQLite extension into `db`, or throws. */
export type VectorExtensionLoader = (db: Database.Database) => void | Promise<void>;

export const DB_FILE = "memory.db";

export interface EmbeddingPin {
  provider: string;
  model: string;
  dimensions: number;
  /** The `dimensions` the collection was created with, passed on each embed call; null: model default. */
  requestedDimensions: number | null;
}

export interface CollectionInfo extends EmbeddingPin {
  name: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory {
  id: string;
  text: string;
  tags: readonly string[];
  metadata: Record<string, unknown> | null;
  embedding: readonly number[];
}

export interface MemoryRecord {
  id: string;
  text: string;
  tags: string[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScoredMemory extends MemoryRecord {
  /** Cosine similarity, -1 to 1 (higher is closer). */
  score: number;
}

/** The embedding a caller has does not match the collection's pinned model. */
export class EmbeddingMismatchError extends Error {
  override readonly name = "EmbeddingMismatchError";
}

interface CollectionRow {
  id: number;
  name: string;
  provider: string;
  model: string;
  dimensions: number;
  requested_dimensions: number | null;
  index_dirty: number;
  created_at: string;
  updated_at: string;
  count?: number;
}

interface MemoryRow {
  seq: number;
  id: string;
  text: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  requested_dimensions INTEGER,
  index_dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  metadata TEXT,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (collection_id, id)
);
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_seq INTEGER NOT NULL REFERENCES memories(seq) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_seq, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_tags_by_tag ON memory_tags(tag, memory_seq);
`;

const VEC_TABLE = /^vec_(\d+)$/;

export function toBlob(vec: readonly number[]): Buffer {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy: the Buffer may not be 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function now(): string {
  return new Date().toISOString();
}

/** SQL fragment keeping memories that carry every tag in `tags`. */
function tagClause(tags: readonly string[]): { sql: string; params: string[] } {
  if (tags.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND m.seq IN (SELECT memory_seq FROM memory_tags WHERE tag IN (${tags
      .map(() => "?")
      .join(", ")}) GROUP BY memory_seq HAVING count(*) = ${tags.length})`,
    params: [...tags],
  };
}

export class MemoryStore {
  private constructor(
    private readonly db: Database.Database,
    readonly mode: SearchMode,
    readonly vecVersion: string | null,
    readonly fallbackReason: string | null,
    readonly path: string,
  ) {}

  /**
   * Opens (creating if needed) `<dir>/memory.db`. `loader` null skips
   * sqlite-vec and uses the JS search.
   */
  static async open(dir: string, loader: VectorExtensionLoader | null): Promise<MemoryStore> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, DB_FILE);
    const db = new Database(path);
    try {
      // Owner-only before the first write: the -wal and -shm files take this mode.
      if (process.platform !== "win32") chmodSync(path, 0o600);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      db.exec(SCHEMA);
      let mode: SearchMode = "js";
      let vecVersion: string | null = null;
      let fallbackReason: string | null = loader ? null : "sqlite-vec disabled";
      if (loader) {
        try {
          await loader(db);
          const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
          vecVersion = row.v;
          mode = "sqlite-vec";
        } catch (e) {
          fallbackReason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        }
      }
      const store = new MemoryStore(db, mode, vecVersion, fallbackReason, path);
      if (mode === "sqlite-vec") store.syncIndexes();
      return store;
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  // --- collections ----------------------------------------------------------

  private collectionRow(name: string): CollectionRow | undefined {
    return this.db.prepare("SELECT * FROM collections WHERE name = ?").get(name) as
      | CollectionRow
      | undefined;
  }

  private static info(row: CollectionRow): CollectionInfo {
    return {
      name: row.name,
      provider: row.provider,
      model: row.model,
      dimensions: row.dimensions,
      requestedDimensions: row.requested_dimensions,
      count: row.count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getCollection(name: string): CollectionInfo | undefined {
    const row = this.db
      .prepare(
        "SELECT c.*, (SELECT count(*) FROM memories m WHERE m.collection_id = c.id) AS count FROM collections c WHERE c.name = ?",
      )
      .get(name) as CollectionRow | undefined;
    return row ? MemoryStore.info(row) : undefined;
  }

  listCollections(): CollectionInfo[] {
    const rows = this.db
      .prepare(
        "SELECT c.*, (SELECT count(*) FROM memories m WHERE m.collection_id = c.id) AS count FROM collections c ORDER BY c.name",
      )
      .all() as CollectionRow[];
    return rows.map((r) => MemoryStore.info(r));
  }

  // --- vec0 indexes ---------------------------------------------------------

  private vecTables(): Map<number, string> {
    const out = new Map<number, string>();
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec\\_%' ESCAPE '\\'",
      )
      .all() as { name: string }[];
    for (const r of rows) {
      const m = VEC_TABLE.exec(r.name);
      if (m) out.set(Number(m[1]), r.name);
    }
    return out;
  }

  private createVecTable(id: number, dimensions: number): void {
    if (!Number.isInteger(id) || !Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("invalid collection id or dimensions");
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_${id} USING vec0(embedding float[${dimensions}] distance_metric=cosine)`,
    );
  }

  /** Rebuild dirty or missing vec0 tables and drop orphaned ones (sqlite-vec mode only). */
  private syncIndexes(): void {
    const tables = this.vecTables();
    const rows = this.db.prepare("SELECT * FROM collections").all() as CollectionRow[];
    const live = new Set(rows.map((r) => r.id));
    this.db.transaction(() => {
      for (const [id, table] of tables) {
        if (!live.has(id)) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      for (const row of rows) {
        if (tables.has(row.id) && row.index_dirty === 0) continue;
        this.db.exec(`DROP TABLE IF EXISTS vec_${row.id}`);
        this.createVecTable(row.id, row.dimensions);
        this.db
          .prepare(
            `INSERT INTO vec_${row.id}(rowid, embedding) SELECT seq, embedding FROM memories WHERE collection_id = ?`,
          )
          .run(row.id);
        this.db.prepare("UPDATE collections SET index_dirty = 0 WHERE id = ?").run(row.id);
      }
    })();
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Inserts or replaces (same id in the same collection) memories. Creates the
   * collection pinned to `pin` when it does not exist; refuses when it exists
   * with a different provider, model or dimension count.
   */
  upsert(
    collection: string,
    pin: EmbeddingPin,
    items: readonly NewMemory[],
  ): { createdCollection: boolean; results: { id: string; created: boolean }[] } {
    for (const item of items) {
      if (item.embedding.length !== pin.dimensions) {
        throw new EmbeddingMismatchError(
          `embedding for "${item.id}" has ${item.embedding.length} dimensions, expected ${pin.dimensions}`,
        );
      }
    }
    return this.db.transaction(() => {
      const ts = now();
      let row = this.collectionRow(collection);
      let createdCollection = false;
      if (row) {
        assertPinned(row, pin);
      } else {
        const r = this.db
          .prepare(
            "INSERT INTO collections (name, provider, model, dimensions, requested_dimensions, index_dirty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            collection,
            pin.provider,
            pin.model,
            pin.dimensions,
            pin.requestedDimensions,
            this.mode === "sqlite-vec" ? 0 : 1,
            ts,
            ts,
          );
        createdCollection = true;
        row = this.collectionRow(collection) as CollectionRow;
        if (this.mode === "sqlite-vec")
          this.createVecTable(Number(r.lastInsertRowid), pin.dimensions);
      }
      const cid = row.id;
      const find = this.db.prepare("SELECT seq FROM memories WHERE collection_id = ? AND id = ?");
      const insert = this.db.prepare(
        "INSERT INTO memories (collection_id, id, text, metadata, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const update = this.db.prepare(
        "UPDATE memories SET text = ?, metadata = ?, embedding = ?, updated_at = ? WHERE seq = ?",
      );
      const clearTags = this.db.prepare("DELETE FROM memory_tags WHERE memory_seq = ?");
      const addTag = this.db.prepare(
        "INSERT OR IGNORE INTO memory_tags (memory_seq, tag) VALUES (?, ?)",
      );
      const vecDelete =
        this.mode === "sqlite-vec"
          ? this.db.prepare(`DELETE FROM vec_${cid} WHERE rowid = ?`)
          : null;
      const vecInsert =
        this.mode === "sqlite-vec"
          ? this.db.prepare(`INSERT INTO vec_${cid}(rowid, embedding) VALUES (?, ?)`)
          : null;
      const results: { id: string; created: boolean }[] = [];
      for (const item of items) {
        const blob = toBlob(item.embedding);
        const meta = item.metadata === null ? null : JSON.stringify(item.metadata);
        const existing = find.get(cid, item.id) as { seq: number } | undefined;
        let seq: number;
        if (existing) {
          seq = existing.seq;
          update.run(item.text, meta, blob, ts, seq);
          clearTags.run(seq);
          vecDelete?.run(BigInt(seq));
        } else {
          seq = Number(insert.run(cid, item.id, item.text, meta, blob, ts, ts).lastInsertRowid);
        }
        for (const tag of item.tags) addTag.run(seq, tag);
        vecInsert?.run(BigInt(seq), blob);
        results.push({ id: item.id, created: !existing });
      }
      this.db
        .prepare(
          `UPDATE collections SET updated_at = ?${this.mode === "js" ? ", index_dirty = 1" : ""} WHERE id = ?`,
        )
        .run(ts, cid);
      return { createdCollection, results };
    })();
  }

  /** Deletes memories by id. Returns which ids were deleted and which were not found. */
  deleteIds(collection: string, ids: readonly string[]): { deleted: string[]; missing: string[] } {
    return this.db.transaction(() => {
      const row = this.collectionRow(collection);
      if (!row) return { deleted: [], missing: [...ids] };
      const find = this.db.prepare("SELECT seq FROM memories WHERE collection_id = ? AND id = ?");
      const del = this.db.prepare("DELETE FROM memories WHERE seq = ?");
      const vecDelete =
        this.mode === "sqlite-vec"
          ? this.db.prepare(`DELETE FROM vec_${row.id} WHERE rowid = ?`)
          : null;
      const deleted: string[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const hit = find.get(row.id, id) as { seq: number } | undefined;
        if (!hit) {
          missing.push(id);
          continue;
        }
        del.run(hit.seq);
        vecDelete?.run(BigInt(hit.seq));
        deleted.push(id);
      }
      if (deleted.length > 0) {
        this.db
          .prepare(
            `UPDATE collections SET updated_at = ?${this.mode === "js" ? ", index_dirty = 1" : ""} WHERE id = ?`,
          )
          .run(now(), row.id);
      }
      return { deleted, missing };
    })();
  }

  /** Deletes a whole collection. Returns the number of memories removed, or null when it did not exist. */
  dropCollection(collection: string): number | null {
    return this.db.transaction(() => {
      const row = this.collectionRow(collection);
      if (!row) return null;
      const { n } = this.db
        .prepare("SELECT count(*) AS n FROM memories WHERE collection_id = ?")
        .get(row.id) as { n: number };
      this.db.prepare("DELETE FROM memories WHERE collection_id = ?").run(row.id);
      this.db.prepare("DELETE FROM collections WHERE id = ?").run(row.id);
      // Without the extension a vec0 table cannot be dropped; the next
      // sqlite-vec open removes it (collection ids are never reused).
      if (this.mode === "sqlite-vec") this.db.exec(`DROP TABLE IF EXISTS vec_${row.id}`);
      return n;
    })();
  }

  // --- reads ----------------------------------------------------------------

  private tagsFor(seqs: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (seqs.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT memory_seq, tag FROM memory_tags WHERE memory_seq IN (${seqs.map(() => "?").join(", ")}) ORDER BY tag`,
      )
      .all(...seqs) as { memory_seq: number; tag: string }[];
    for (const r of rows) {
      const list = out.get(r.memory_seq) ?? [];
      list.push(r.tag);
      out.set(r.memory_seq, list);
    }
    return out;
  }

  private records<T extends MemoryRow>(rows: readonly T[]): (MemoryRecord & { row: T })[] {
    const tags = this.tagsFor(rows.map((r) => r.seq));
    return rows.map((r) => ({
      row: r,
      id: r.id,
      text: r.text,
      tags: tags.get(r.seq) ?? [],
      metadata: r.metadata === null ? null : (JSON.parse(r.metadata) as Record<string, unknown>),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** The `k` memories closest to `query`, best first. */
  search(
    collection: string,
    query: readonly number[],
    k: number,
    tags: readonly string[] = [],
  ): ScoredMemory[] {
    const row = this.collectionRow(collection);
    if (!row) return [];
    if (query.length !== row.dimensions) {
      throw new EmbeddingMismatchError(
        `query embedding has ${query.length} dimensions, collection "${collection}" has ${row.dimensions}`,
      );
    }
    const blob = toBlob(query);
    const filter = tagClause(tags);
    let scored: { row: MemoryRow; score: number }[];
    if (this.mode === "sqlite-vec" && tags.length === 0) {
      const rows = this.db
        .prepare(
          `WITH knn AS (SELECT rowid, distance FROM vec_${row.id} WHERE embedding MATCH ? AND k = ?)
           SELECT m.seq, m.id, m.text, m.metadata, m.created_at, m.updated_at, knn.distance AS distance
           FROM knn JOIN memories m ON m.seq = knn.rowid ORDER BY knn.distance`,
        )
        .all(blob, k) as (MemoryRow & { distance: number })[];
      scored = rows.map((r) => ({ row: r, score: 1 - r.distance }));
    } else if (this.mode === "sqlite-vec") {
      const rows = this.db
        .prepare(
          `SELECT m.seq, m.id, m.text, m.metadata, m.created_at, m.updated_at,
             vec_distance_cosine(m.embedding, ?) AS distance
           FROM memories m WHERE m.collection_id = ?${filter.sql}
           ORDER BY distance LIMIT ?`,
        )
        .all(blob, row.id, ...filter.params, k) as (MemoryRow & { distance: number })[];
      scored = rows.map((r) => ({ row: r, score: 1 - r.distance }));
    } else {
      const q = Float32Array.from(query);
      const hits: { seq: number; score: number }[] = [];
      const iter = this.db
        .prepare(`SELECT m.seq, m.embedding FROM memories m WHERE m.collection_id = ?${filter.sql}`)
        .iterate(row.id, ...filter.params) as IterableIterator<{ seq: number; embedding: Buffer }>;
      for (const m of iter) hits.push({ seq: m.seq, score: cosine(q, fromBlob(m.embedding)) });
      hits.sort((a, b) => b.score - a.score || a.seq - b.seq);
      const top = hits.slice(0, k);
      const get = this.db.prepare(
        "SELECT seq, id, text, metadata, created_at, updated_at FROM memories WHERE seq = ?",
      );
      scored = top.map((h) => ({ row: get.get(h.seq) as MemoryRow, score: h.score }));
    }
    const recs = this.records(scored.map((s) => s.row));
    return recs.map(({ row: _row, ...rec }, i) => ({
      ...rec,
      score: (scored[i] as { score: number }).score,
    }));
  }

  /** Newest first. `before` is the cursor from the previous page. */
  list(
    collection: string,
    opts: { limit: number; before?: number | undefined; tags?: readonly string[] | undefined },
  ): { memories: MemoryRecord[]; nextCursor: number | null } {
    const row = this.collectionRow(collection);
    if (!row) return { memories: [], nextCursor: null };
    const filter = tagClause(opts.tags ?? []);
    const params: unknown[] = [row.id];
    let cursorSql = "";
    if (opts.before !== undefined) {
      cursorSql = " AND m.seq < ?";
      params.push(opts.before);
    }
    const rows = this.db
      .prepare(
        `SELECT m.seq, m.id, m.text, m.metadata, m.created_at, m.updated_at FROM memories m
         WHERE m.collection_id = ?${cursorSql}${filter.sql} ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(...params, ...filter.params, opts.limit + 1) as MemoryRow[];
    const more = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    const recs = this.records(page);
    return {
      memories: recs.map(({ row: _row, ...rec }) => rec),
      nextCursor: more && page.length > 0 ? (page[page.length - 1] as MemoryRow).seq : null,
    };
  }
}

function assertPinned(row: CollectionRow, pin: EmbeddingPin): void {
  if (
    row.provider !== pin.provider ||
    row.model !== pin.model ||
    row.dimensions !== pin.dimensions
  ) {
    throw new EmbeddingMismatchError(
      `collection "${row.name}" is pinned to ${row.provider}/${row.model} (${row.dimensions} dimensions), but the embedding came from ${pin.provider}/${pin.model} (${pin.dimensions} dimensions). Vectors from different models are not comparable: use another collection, or forget this one and start over.`,
    );
  }
}
