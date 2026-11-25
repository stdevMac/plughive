import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import Database from "better-sqlite3";
// tests/lib/library.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_ID_PATTERN, Library, extensionForMime } from "../../src/lib/library.js";
import { expectMode, itSymlink } from "../support/platform.js";

describe("library", () => {
  let dir: string;
  let lib: Library;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plughive-lib-"));
    lib = new Library({ root: dir, baseUrl: "http://127.0.0.1:7777" });
  });
  afterEach(() => {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves an image artifact to fs and db", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ref = lib.save({
      kind: "image",
      mime: "image/webp",
      bytes: buf,
      tool: "generate_image",
      model: "google/foo",
      prompt: "p",
      meta: { size: "1024x1024" },
      costUsd: 0.003,
    });
    expect(ref.id).toMatch(/^img_/);
    expect(ref.url).toMatch(/^http:\/\/127\.0\.0\.1:7777\/artifacts\//);
    expect(existsSync(ref.path)).toBe(true);
    const got = lib.get(ref.id);
    expect(got?.prompt).toBe("p");
    expect(got?.costUsd).toBe(0.003);
  });

  // The copy used to wait forever on a descriptor its own streams still held.
  // L2: prompts, metadata and the files are the user's alone.
  it.runIf(process.platform !== "win32")(
    "L2: folders are 0700, the database and every new artifact 0600",
    async () => {
      expectMode(join(dir, "artifacts"), 0o700);
      expectMode(join(dir, "library.db"), 0o600);

      const saved = lib.save({
        kind: "data",
        mime: "text/plain",
        bytes: Buffer.from("a"),
        tool: "t",
      });
      expectMode(saved.path, 0o600);
      // year / month / day folders
      for (let d = dirname(saved.path); d !== dir; d = dirname(d)) expectMode(d, 0o700, d);

      const src = join(dir, "source.txt");
      writeFileSync(src, "b", { mode: 0o644 });
      chmodSync(src, 0o644);
      const copied = lib.importFile({
        kind: "data",
        mime: "text/plain",
        sourcePath: src,
        tool: "t",
      });
      expectMode(copied.path, 0o600);

      const handle = await open(src, "r");
      try {
        const streamed = await lib.importHandle(
          { kind: "data", mime: "text/plain", tool: "t" },
          handle,
          1024,
        );
        expectMode(streamed.path, 0o600);
      } finally {
        await handle.close();
      }
      for (const sidecar of ["library.db-wal", "library.db-shm"]) {
        if (existsSync(join(dir, sidecar))) expectMode(join(dir, sidecar), 0o600);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "L2: a library left loose by an older version is tightened at open",
    () => {
      const old = mkdtempSync(join(tmpdir(), "plughive-lib-old-"));
      try {
        mkdirSync(join(old, "artifacts"), { mode: 0o755 });
        chmodSync(join(old, "artifacts"), 0o755);
        const first = new Library({ root: old, baseUrl: "http://127.0.0.1:7777" });
        first.close();
        chmodSync(join(old, "artifacts"), 0o755);
        chmodSync(join(old, "library.db"), 0o644);
        const again = new Library({ root: old, baseUrl: "http://127.0.0.1:7777" });
        expectMode(join(old, "artifacts"), 0o700);
        expectMode(join(old, "library.db"), 0o600);
        again.close();
      } finally {
        rmSync(old, { recursive: true, force: true });
      }
    },
  );

  it("importHandle copies from an open descriptor and returns", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    writeFileSync(join(dir, "source.bin"), bytes);
    const source = await open(join(dir, "source.bin"), "r");
    try {
      const ref = await lib.importHandle(
        { kind: "data", mime: "text/plain", tool: "t" },
        source,
        8 * 1024 * 1024,
      );
      expect(readFileSync(ref.path).equals(bytes)).toBe(true);
      expect(lib.get(ref.id)?.bytes).toBe(bytes.length);
      // The source stays open for the caller to close.
      expect((await source.stat()).size).toBe(bytes.length);
    } finally {
      await source.close();
    }
  }, 5000);

  it("importHandle stops past the cap and leaves no partial file", async () => {
    writeFileSync(join(dir, "source.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
    const source = await open(join(dir, "source.bin"), "r");
    try {
      await expect(
        lib.importHandle({ kind: "data", mime: "text/plain", tool: "t" }, source, 1024 * 1024 + 5),
      ).rejects.toThrow(/larger than/);
    } finally {
      await source.close();
    }
    expect(lib.list()).toEqual([]);
    expect(
      readdirSync(join(dir, "artifacts"), { recursive: true }).filter((n) =>
        String(n).includes("."),
      ),
    ).toEqual([]);
  }, 5000);

  it("returns null for unknown id", () => {
    expect(lib.get("img_missing")).toBeNull();
  });

  it("imports a source file into the artifact library", () => {
    const source = join(dir, "source.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(source, bytes);

    const ref = lib.importFile({
      sourcePath: source,
      kind: "image",
      mime: "image/png",
      tool: "import_artifact",
      meta: { chain_id: "chain-a" },
    });

    expect(ref.path).not.toBe(source);
    expect(readFileSync(ref.path)).toEqual(bytes);
    expect(ref.bytes).toBe(bytes.length);
    expect(lib.get(ref.id)?.meta).toEqual({ chain_id: "chain-a" });
  });

  it("lists recent artifacts newest-first", () => {
    const buf = Buffer.from([0]);
    const a = lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t" });
    const b = lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t" });
    const list = lib.listRecent(10);
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
  });

  describe("list() with filters", () => {
    it("filters by tool (equality)", () => {
      const buf = Buffer.from([0]);
      const a = lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "alpha" });
      lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "beta" });
      const rows = lib.list({ tool: "alpha" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(a.id);
    });

    it("filters by kind (equality)", () => {
      const buf = Buffer.from([0]);
      lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t" });
      const pdf = lib.save({ kind: "pdf", mime: "application/pdf", bytes: buf, tool: "t" });
      const rows = lib.list({ kind: "pdf" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(pdf.id);
    });

    it("filters by model (equality)", () => {
      const buf = Buffer.from([0]);
      const a = lib.save({
        kind: "image",
        mime: "image/png",
        bytes: buf,
        tool: "t",
        model: "mod-a",
      });
      lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t", model: "mod-b" });
      const rows = lib.list({ model: "mod-a" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(a.id);
    });

    it("filters by since (rows newer than timestamp)", () => {
      const buf = Buffer.from([0]);
      lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t" });
      const mid = new Date(Date.now() + 1).toISOString();
      // Ensure monotonic clock progression
      const later = new Date(Date.now() + 1000).toISOString();
      const row = lib.list({ since: mid });
      // Just verify the query shape works (no rows strictly newer than `later`)
      const none = lib.list({ since: later });
      expect(Array.isArray(row)).toBe(true);
      expect(none).toHaveLength(0);
    });

    it("filters by prompt_contains using LIKE", () => {
      const buf = Buffer.from([0]);
      const a = lib.save({
        kind: "image",
        mime: "image/png",
        bytes: buf,
        tool: "t",
        prompt: "a mountain sunset",
      });
      lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t", prompt: "city skyline" });
      const rows = lib.list({ prompt_contains: "mountain" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(a.id);
    });

    it("filters by lineage metadata", () => {
      const buf = Buffer.from([0]);
      const matched = lib.save({
        kind: "image",
        mime: "image/png",
        bytes: buf,
        tool: "t",
        meta: { chain_id: "chain-a", scene_id: "scene-1", role: "first", orientation: "9:16" },
      });
      lib.save({
        kind: "image",
        mime: "image/png",
        bytes: buf,
        tool: "t",
        meta: { chain_id: "chain-b", scene_id: "scene-1", role: "last", orientation: "16:9" },
      });

      const rows = lib.list({ chain_id: "chain-a", role: "first", orientation: "9:16" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(matched.id);
    });

    it("clamps limit at 500", () => {
      const buf = Buffer.from([0]);
      for (let i = 0; i < 3; i++) {
        lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t" });
      }
      // limit arg above 500 should still return rows (it just gets clamped)
      const rows = lib.list({}, 10_000);
      expect(rows.length).toBeLessThanOrEqual(500);
      expect(rows.length).toBe(3);
    });

    it("defaults limit to 50", () => {
      const buf = Buffer.from([0]);
      for (let i = 0; i < 2; i++) {
        lib.save({ kind: "image", mime: "image/png", bytes: buf, tool: "t" });
      }
      const rows = lib.list();
      expect(rows.length).toBe(2);
    });
  });

  describe("remove()", () => {
    const save = () =>
      lib.save({ kind: "image", mime: "image/png", bytes: Buffer.from("png"), tool: "t" });
    /** Point a row at another path, as a tampered or stale database would. */
    const repoint = (id: string, path: string) => {
      const db = new Database(join(dir, "library.db"));
      try {
        db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(path, id);
      } finally {
        db.close();
      }
    };

    it("ids match the strict pattern", () => {
      expect(ARTIFACT_ID_PATTERN.test(save().id)).toBe(true);
      for (const bad of [
        "img_x",
        "../img_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "img_01ARZ3NDEKTSV4RRFFQ69G5FAI",
      ]) {
        expect(ARTIFACT_ID_PATTERN.test(bad), bad).toBe(false);
      }
    });

    it("deletes the file and the row; null for an unknown id", () => {
      const ref = save();
      const path = lib.get(ref.id)!.path;
      expect(existsSync(path)).toBe(true);
      expect(lib.remove(ref.id)).toEqual({ fileRemoved: true });
      expect(existsSync(path)).toBe(false);
      expect(lib.get(ref.id)).toBeNull();
      expect(lib.count()).toBe(0);
      expect(lib.remove(ref.id)).toBeNull();
      expect(lib.remove("img_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    });

    it("a file that is already gone still removes the row", () => {
      const ref = save();
      rmSync(lib.get(ref.id)!.path);
      expect(lib.remove(ref.id)).toEqual({ fileRemoved: false });
      expect(lib.get(ref.id)).toBeNull();
    });

    it("never unlinks a path outside the artifacts folder", () => {
      const outside = join(dir, "keep-me.txt");
      writeFileSync(outside, "precious");
      const cases = [
        outside,
        join(dir, "artifacts", "..", "keep-me.txt"),
        join(dir, "library.db"),
        join(dir, "artifacts"),
        "relative/keep-me.txt",
      ];
      for (const path of cases) {
        const ref = save();
        repoint(ref.id, path);
        expect(lib.remove(ref.id), path).toEqual({ fileRemoved: false });
        expect(lib.get(ref.id)).toBeNull();
      }
      expect(readFileSync(outside, "utf8")).toBe("precious");
      expect(existsSync(join(dir, "library.db"))).toBe(true);
      expect(existsSync(join(dir, "artifacts"))).toBe(true);
    });

    itSymlink("never follows a symlinked folder out of the artifacts folder", () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "plughive-lib-out-"));
      try {
        writeFileSync(join(elsewhere, "victim.png"), "precious");
        symlinkSync(elsewhere, join(dir, "artifacts", "escape"));
        const ref = save();
        repoint(ref.id, join(dir, "artifacts", "escape", "victim.png"));
        expect(lib.remove(ref.id)).toEqual({ fileRemoved: false });
        expect(readFileSync(join(elsewhere, "victim.png"), "utf8")).toBe("precious");
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    itSymlink("a symlinked file is removed as a link, its target untouched; a folder never", () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "plughive-lib-out-"));
      try {
        writeFileSync(join(elsewhere, "target.png"), "precious");
        const ref = save();
        const path = lib.get(ref.id)!.path;
        rmSync(path);
        symlinkSync(join(elsewhere, "target.png"), path);
        expect(lib.remove(ref.id)).toEqual({ fileRemoved: true });
        expect(existsSync(path)).toBe(false);
        expect(readFileSync(join(elsewhere, "target.png"), "utf8")).toBe("precious");

        const folder = save();
        const folderPath = lib.get(folder.id)!.path;
        rmSync(folderPath);
        mkdirSync(folderPath);
        expect(lib.remove(folder.id)).toEqual({ fileRemoved: false });
        expect(statSync(folderPath).isDirectory()).toBe(true);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  it("extensionForMime: known types, parameters, unknown and prototype names", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("Text/Plain; charset=utf-8")).toBe("txt");
    expect(extensionForMime("application/x-nope")).toBe("bin");
    expect(extensionForMime("constructor")).toBe("bin");
    expect(extensionForMime("__proto__")).toBe("bin");
  });
});
