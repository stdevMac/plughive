import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UnsafePathError,
  assertReadableUserFile,
  openInside,
  readFileCapped,
  resolveInside,
  safeFilename,
} from "../../../src/core/fs/safe-path.js";
import { canSymlink, itPosix, itSymlink } from "../../support/platform.js";

let base: string; // canonical temp dir
let root: string;
let outside: string;

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "plughive-safe-path-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  mkdirSync(outside);
  mkdirSync(join(base, "root-sibling"));
  writeFileSync(join(root, "a.txt"), "hello");
  writeFileSync(join(root, "sub", "b.PNG"), "png");
  writeFileSync(join(outside, "secret.txt"), "top secret");
  writeFileSync(join(base, "root-sibling", "x.txt"), "sibling");
  if (!canSymlink()) return; // the link tests below are skipped too
  symlinkSync(outside, join(root, "link-out")); // dir link leaving root
  symlinkSync(join(outside, "secret.txt"), join(root, "link-file-out.txt"));
  symlinkSync(join(root, "sub"), join(root, "link-in")); // dir link staying inside
  symlinkSync(join(outside, "does-not-exist"), join(root, "dangling"));
  symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
  symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
  symlinkSync(root, join(base, "root-alias"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof UnsafePathError) return err.reason;
    throw err;
  }
  return "NOT_REJECTED";
}

async function asyncReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof UnsafePathError) return err.reason;
    throw err;
  }
  return "NOT_REJECTED";
}

describe("resolveInside", () => {
  it("resolves relative paths inside the root", () => {
    expect(resolveInside(root, "a.txt")).toBe(join(root, "a.txt"));
    expect(resolveInside(root, "sub/deep/new.bin")).toBe(join(root, "sub", "deep", "new.bin"));
    expect(resolveInside(root, "./sub/./b.PNG")).toBe(join(root, "sub", "b.PNG"));
    expect(resolveInside(root, ".")).toBe(root);
    expect(resolveInside(root, "not/yet/created.txt")).toBe(
      join(root, "not", "yet", "created.txt"),
    );
  });

  it("accepts an absolute path only when it is inside the root", () => {
    expect(resolveInside(root, join(root, "sub", "b.PNG"))).toBe(join(root, "sub", "b.PNG"));
    expect(reasonOf(() => resolveInside(root, join(outside, "secret.txt")))).toBe("outside_root");
    expect(reasonOf(() => resolveInside(root, "/etc/passwd"))).toBe("outside_root");
    expect(reasonOf(() => resolveInside(root, base))).toBe("outside_root");
  });

  it("rejects every '..' form, including ones that would stay inside", () => {
    for (const path of [
      "..",
      "../outside/secret.txt",
      "sub/../../outside/secret.txt",
      "sub/../a.txt",
      "sub/..",
      "..\\outside\\secret.txt",
      "sub\\..\\..\\outside",
      "a/b/../../../../etc/passwd",
      `${root}/../outside/secret.txt`,
    ]) {
      expect(
        reasonOf(() => resolveInside(root, path)),
        path,
      ).toBe("parent_segment");
    }
  });

  it("does not treat names that merely contain dots as traversal", () => {
    expect(resolveInside(root, "..hidden")).toBe(join(root, "..hidden"));
    expect(resolveInside(root, "a..b/c...d")).toBe(join(root, "a..b", "c...d"));
  });

  it("is not fooled by a sibling directory sharing the root's prefix", () => {
    expect(reasonOf(() => resolveInside(root, join(base, "root-sibling", "x.txt")))).toBe(
      "outside_root",
    );
    expect(reasonOf(() => resolveInside(root, `${root}-sibling/x.txt`))).toBe("outside_root");
  });

  it("rejects NUL bytes, empty and non-string input", () => {
    expect(reasonOf(() => resolveInside(root, "a.txt\0.png"))).toBe("nul_byte");
    expect(reasonOf(() => resolveInside(`${root}\0`, "a.txt"))).toBe("nul_byte");
    expect(reasonOf(() => resolveInside(root, ""))).toBe("invalid_path");
    expect(reasonOf(() => resolveInside("", "a.txt"))).toBe("invalid_path");
    expect(reasonOf(() => resolveInside(root, 42 as unknown as string))).toBe("invalid_path");
  });

  itSymlink("rejects symlinks that leave the root", () => {
    expect(reasonOf(() => resolveInside(root, "link-out"))).toBe("symlink_escape");
    expect(reasonOf(() => resolveInside(root, "link-out/secret.txt"))).toBe("symlink_escape");
    expect(reasonOf(() => resolveInside(root, "link-out/new-file.txt"))).toBe("symlink_escape");
    expect(reasonOf(() => resolveInside(root, "link-file-out.txt"))).toBe("symlink_escape");
    expect(reasonOf(() => resolveInside(root, join(root, "link-out", "secret.txt")))).toBe(
      "symlink_escape",
    );
  });

  itSymlink("rejects dangling and looping symlinks (a write would follow them)", () => {
    expect(reasonOf(() => resolveInside(root, "dangling"))).toBe("symlink_escape");
    expect(reasonOf(() => resolveInside(root, "dangling/child.txt"))).toBe("symlink_escape");
    expect(reasonOf(() => resolveInside(root, "loop-a"))).toBe("symlink_escape");
  });

  itSymlink("follows symlinks that stay inside and returns the canonical path", () => {
    expect(resolveInside(root, "link-in/b.PNG")).toBe(join(root, "sub", "b.PNG"));
    expect(resolveInside(root, "link-in/new.txt")).toBe(join(root, "sub", "new.txt"));
  });

  itSymlink("canonicalises a root that is itself a symlink", () => {
    const alias = join(base, "root-alias");
    expect(resolveInside(alias, "a.txt")).toBe(join(root, "a.txt"));
    expect(resolveInside(alias, join(alias, "sub", "b.PNG"))).toBe(join(root, "sub", "b.PNG"));
    expect(resolveInside(alias, join(root, "a.txt"))).toBe(join(root, "a.txt"));
    expect(reasonOf(() => resolveInside(alias, "link-out/secret.txt"))).toBe("symlink_escape");
  });

  it("requires the root to exist", () => {
    expect(reasonOf(() => resolveInside(join(base, "missing-root"), "a.txt"))).toBe("root_missing");
  });

  it("error messages do not echo the path", () => {
    try {
      resolveInside(root, "../outside/secret.txt");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("secret.txt");
      expect((err as Error).message).not.toContain(root);
    }
  });
});

describe("assertReadableUserFile", () => {
  const opts = () => ({ allowedRoots: [root], maxBytes: 1024 });

  it("accepts a regular file inside an allowed root", async () => {
    const result = await assertReadableUserFile(join(root, "a.txt"), opts());
    expect(result).toEqual({ path: join(root, "a.txt"), size: 5 });
  });

  itSymlink("returns the canonical path for an in-root symlink", async () => {
    const result = await assertReadableUserFile(join(root, "link-in", "b.PNG"), opts());
    expect(result.path).toBe(join(root, "sub", "b.PNG"));
  });

  it("requires an absolute path", async () => {
    expect(await asyncReason(assertReadableUserFile("a.txt", opts()))).toBe("invalid_path");
    expect(await asyncReason(assertReadableUserFile("", opts()))).toBe("invalid_path");
    expect(await asyncReason(assertReadableUserFile(`${root}/a.txt\0`, opts()))).toBe("nul_byte");
  });

  it("rejects files outside the allowed roots", async () => {
    expect(await asyncReason(assertReadableUserFile(join(outside, "secret.txt"), opts()))).toBe(
      "outside_root",
    );
    expect(
      await asyncReason(assertReadableUserFile(join(base, "root-sibling", "x.txt"), opts())),
    ).toBe("outside_root");
    expect(
      await asyncReason(assertReadableUserFile(join(root, "..", "outside", "secret.txt"), opts())),
    ).toBe("outside_root");
  });

  itSymlink("rejects symlinks whose real target is outside", async () => {
    expect(await asyncReason(assertReadableUserFile(join(root, "link-file-out.txt"), opts()))).toBe(
      "outside_root",
    );
    expect(
      await asyncReason(assertReadableUserFile(join(root, "link-out", "secret.txt"), opts())),
    ).toBe("outside_root");
  });

  itSymlink("rejects missing files, dangling links and loops", async () => {
    expect(await asyncReason(assertReadableUserFile(join(root, "nope.txt"), opts()))).toBe(
      "not_found",
    );
    expect(await asyncReason(assertReadableUserFile(join(root, "dangling"), opts()))).toBe(
      "not_found",
    );
    expect(await asyncReason(assertReadableUserFile(join(root, "loop-a"), opts()))).toBe(
      "not_found",
    );
  });

  it("rejects directories", async () => {
    expect(await asyncReason(assertReadableUserFile(join(root, "sub"), opts()))).toBe(
      "not_regular_file",
    );
  });

  itPosix("rejects special files", async () => {
    expect(
      await asyncReason(
        assertReadableUserFile("/dev/null", { allowedRoots: ["/dev"], maxBytes: 1024 }),
      ),
    ).toBe("not_regular_file");
  });

  // Git for Windows ships a mkfifo that makes no real FIFO.
  itPosix(
    "rejects a FIFO without blocking",
    async (ctx) => {
      const fifo = join(root, "pipe.txt");
      try {
        execFileSync("mkfifo", [fifo], { stdio: "ignore" });
      } catch {
        ctx.skip();
        return;
      }
      expect(await asyncReason(assertReadableUserFile(fifo, opts()))).toBe("not_regular_file");
    },
    30_000,
  );

  it("enforces the size cap at the boundary", async () => {
    const big = join(root, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 1024);
    expect((await assertReadableUserFile(big, opts())).size).toBe(1024);
    truncateSync(big, 1025);
    expect(await asyncReason(assertReadableUserFile(big, opts()))).toBe("too_large");
    expect(
      await asyncReason(
        assertReadableUserFile(join(root, "a.txt"), { allowedRoots: [root], maxBytes: 0 }),
      ),
    ).toBe("too_large");
  });

  itSymlink("checks the extension of the real file, case-insensitively", async () => {
    const withExt = (allowedExtensions: string[]) => ({ ...opts(), allowedExtensions });
    await expect(
      assertReadableUserFile(join(root, "sub", "b.PNG"), withExt(["png"])),
    ).resolves.toBeDefined();
    await expect(
      assertReadableUserFile(join(root, "sub", "b.PNG"), withExt([".Png", ".jpg"])),
    ).resolves.toBeDefined();
    expect(await asyncReason(assertReadableUserFile(join(root, "a.txt"), withExt([".png"])))).toBe(
      "extension_not_allowed",
    );
    // a link named .png that points at a .txt is judged by its target
    symlinkSync(join(root, "a.txt"), join(root, "disguised.png"));
    expect(
      await asyncReason(assertReadableUserFile(join(root, "disguised.png"), withExt([".png"]))),
    ).toBe("extension_not_allowed");
    expect(await asyncReason(assertReadableUserFile(join(root, "a.txt"), withExt([])))).toBe(
      "extension_not_allowed",
    );
  });

  it("an empty or missing root list allows nothing", async () => {
    expect(
      await asyncReason(
        assertReadableUserFile(join(root, "a.txt"), { allowedRoots: [], maxBytes: 10 }),
      ),
    ).toBe("outside_root");
    expect(
      await asyncReason(
        assertReadableUserFile(join(root, "a.txt"), {
          allowedRoots: [join(base, "missing-root"), ""],
          maxBytes: 10,
        }),
      ),
    ).toBe("outside_root");
  });

  itSymlink("accepts roots given through a symlink", async () => {
    const result = await assertReadableUserFile(join(base, "root-alias", "a.txt"), {
      allowedRoots: [join(base, "root-alias")],
      maxBytes: 10,
    });
    expect(result.path).toBe(join(root, "a.txt"));
  });
});

describe("safeFilename", () => {
  it("keeps ordinary names", () => {
    expect(safeFilename("report-2024_final.v2.pdf")).toBe("report-2024_final.v2.pdf");
    expect(safeFilename("caf\u00e9 men\u00fa.txt")).toBe("caf\u00e9 men\u00fa.txt");
  });

  it("never yields a path separator or a traversal name", () => {
    const hostile = [
      "../../etc/passwd",
      "..\\..\\windows\\system32\\cmd.exe",
      "/etc/shadow",
      "C:\\Users\\x\\secret.txt",
      "..",
      ".",
      "...",
      "./.",
      ".. / ..",
      "a/b\\c",
      "\0\0",
      "name\0.png",
      "\u202egnp.exe",
      "  ",
      "",
    ];
    for (const input of hostile) {
      const out = safeFilename(input);
      expect(out, JSON.stringify(input)).not.toMatch(/[\\/\0]/);
      expect(out).not.toBe("");
      expect(out).not.toBe(".");
      expect(out).not.toBe("..");
      expect(out.startsWith(".")).toBe(false);
    }
    expect(safeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFilename("..")).toBe("file");
    expect(safeFilename("")).toBe("file");
    expect(safeFilename(undefined as unknown as string)).toBe("file");
  });

  it("strips control and bidi characters and hidden-file dots", () => {
    expect(safeFilename("a\r\nb\tc.txt")).toBe("abc.txt");
    expect(safeFilename("invoice\u202efdp.exe")).toBe("invoicefdp.exe");
    expect(safeFilename("zero\u200bwidth\ufeff.txt")).toBe("zerowidth.txt");
    expect(safeFilename(".env")).toBe("env");
    expect(safeFilename("...hidden")).toBe("hidden");
    expect(safeFilename("trailing. . ")).toBe("trailing");
  });

  it("replaces characters that are special on common filesystems", () => {
    expect(safeFilename('a:b*c?d"e<f>g|h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
  });

  it("defuses Windows reserved device names", () => {
    expect(safeFilename("CON")).toBe("_CON");
    expect(safeFilename("nul.txt")).toBe("_nul.txt");
    expect(safeFilename("COM1.log")).toBe("_COM1.log");
    expect(safeFilename("console.log")).toBe("console.log");
  });

  it("bounds the length in bytes and keeps the extension", () => {
    const long = `${"a".repeat(500)}.png`;
    const out = safeFilename(long);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    expect(out.endsWith(".png")).toBe(true);

    const wide = `${"\u00e9".repeat(300)}.jpeg`;
    const wideOut = safeFilename(wide, { maxBytes: 64 });
    expect(Buffer.byteLength(wideOut, "utf8")).toBeLessThanOrEqual(64);
    expect(wideOut.endsWith(".jpeg")).toBe(true);
    expect(wideOut).not.toContain("\ufffd");

    const emoji = "\u{1f600}".repeat(100);
    const emojiOut = safeFilename(emoji, { maxBytes: 30 });
    expect(Buffer.byteLength(emojiOut, "utf8")).toBeLessThanOrEqual(30);
    expect(emojiOut).not.toContain("\ufffd");
  });

  it("uses a validated fallback", () => {
    expect(safeFilename("///", { fallback: "upload" })).toBe("___");
    expect(safeFilename("", { fallback: "upload" })).toBe("upload");
    expect(safeFilename("", { fallback: "../x" })).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the security review (P1-P6).

describe("review regressions", () => {
  let rbase: string;
  let rroot: string;
  let routside: string;

  beforeAll(() => {
    rbase = realpathSync.native(mkdtempSync(join(tmpdir(), "plughive-safe-path-review-")));
    rroot = join(rbase, "root");
    routside = join(rbase, "outside");
    mkdirSync(rroot);
    mkdirSync(routside);
    writeFileSync(join(routside, "secret.txt"), "OUTSIDE-SECRET");
  });

  afterAll(() => {
    rmSync(rbase, { recursive: true, force: true });
  });

  itSymlink(
    "P1: openInside refuses a path whose directory was swapped for an outside symlink",
    async () => {
      mkdirSync(join(rroot, "swap"));
      writeFileSync(join(rroot, "swap", "secret.txt"), "inside");
      const checked = resolveInside(rroot, "swap/secret.txt");
      expect(checked).toBe(join(rroot, "swap", "secret.txt"));
      rmSync(join(rroot, "swap"), { recursive: true });
      symlinkSync(routside, join(rroot, "swap"));
      const reason = await asyncReason(openInside(rroot, "swap/secret.txt"));
      expect(["symlink_escape", "outside_root", "changed_during_check"]).toContain(reason);
    },
  );

  itSymlink(
    "P1: openInside opens a regular in-root file and refuses links, dirs and O_TRUNC",
    async () => {
      writeFileSync(join(rroot, "plain.txt"), "plain");
      const handle = await openInside(rroot, "plain.txt");
      try {
        expect((await readFileCapped(handle, { maxBytes: 100 })).toString()).toBe("plain");
      } finally {
        await handle.close();
      }
      symlinkSync(join(rroot, "plain.txt"), join(rroot, "plain-link.txt"));
      // resolveInside follows in-root links; openInside opens the canonical target
      const viaLink = await openInside(rroot, "plain-link.txt");
      await viaLink.close();
      mkdirSync(join(rroot, "a-dir"));
      expect(await asyncReason(openInside(rroot, "a-dir"))).toBe("not_regular_file");
      await expect(
        openInside(rroot, "plain.txt", { flags: fsConstants.O_WRONLY | fsConstants.O_TRUNC }),
      ).rejects.toBeInstanceOf(TypeError);
      // creating a new file works and uses mode 0600
      const created = await openInside(rroot, "new.txt", {
        flags: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      });
      try {
        if (process.platform !== "win32") expect((await created.stat()).mode & 0o777).toBe(0o600);
      } finally {
        await created.close();
      }
    },
  );

  it("P2: a hard link to an outside file is refused by the descriptor-based APIs", async () => {
    linkSync(join(routside, "secret.txt"), join(rroot, "innocent.txt"));
    expect(await asyncReason(openInside(rroot, "innocent.txt"))).toBe("hard_link");
    const opts = { allowedRoots: [rroot], maxBytes: 1000 };
    expect(await asyncReason(readFileCapped(join(rroot, "innocent.txt"), opts))).toBe("hard_link");
    expect(
      await asyncReason(
        assertReadableUserFile(join(rroot, "innocent.txt"), { ...opts, rejectHardLinks: true }),
      ),
    ).toBe("hard_link");
    // legacy default is unchanged (documented): assertReadableUserFile still accepts it
    await expect(assertReadableUserFile(join(rroot, "innocent.txt"), opts)).resolves.toBeDefined();
    // explicit opt-out
    const h = await openInside(rroot, "innocent.txt", { rejectHardLinks: false });
    await h.close();
  });

  itSymlink("P3: readFileCapped enforces the cap and the roots while reading", async () => {
    mkdirSync(join(rroot, "d"));
    writeFileSync(join(rroot, "d", "a.txt"), "tiny");
    const opts = { allowedRoots: [rroot], maxBytes: 10 };
    expect((await readFileCapped(join(rroot, "d", "a.txt"), opts)).toString()).toBe("tiny");
    appendFileSync(join(rroot, "d", "a.txt"), "X".repeat(1000));
    expect(await asyncReason(readFileCapped(join(rroot, "d", "a.txt"), opts))).toBe("too_large");
    // swap the directory for a symlink to the outside
    writeFileSync(join(routside, "a.txt"), "OUTSIDE-SECRET");
    rmSync(join(rroot, "d"), { recursive: true });
    symlinkSync(routside, join(rroot, "d"));
    expect(await asyncReason(readFileCapped(join(rroot, "d", "a.txt"), opts))).toBe("outside_root");
    // a handle is held to the cap too
    writeFileSync(join(rroot, "big.bin"), Buffer.alloc(50));
    const h = await openInside(rroot, "big.bin");
    try {
      expect(await asyncReason(readFileCapped(h, { maxBytes: 49 }))).toBe("too_large");
    } finally {
      await h.close();
    }
  });

  it("P4: safeFilename edge cases", () => {
    const nan = safeFilename("a".repeat(5000), { maxBytes: Number.NaN });
    expect(Buffer.byteLength(nan, "utf8")).toBeLessThanOrEqual(200);
    expect(
      safeFilename("a".repeat(5000), { maxBytes: Number.POSITIVE_INFINITY }).length,
    ).toBeLessThanOrEqual(200);
    expect(safeFilename("-rf")).toBe("_-rf");
    expect(safeFilename("--output=x.mp4").startsWith("_")).toBe(true);
    expect(safeFilename("abc؜cod.exe")).toBe("abccod.exe");
    expect(safeFilename("a᠎b.txt")).toBe("ab.txt");
    expect(safeFilename("CON")).toBe("_CON");
  });

  it("P5: macOS named-fork paths are rejected", () => {
    writeFileSync(join(rroot, "f.txt"), "data");
    expect(reasonOf(() => resolveInside(rroot, "f.txt/..namedfork/rsrc"))).toBe("named_fork");
    expect(reasonOf(() => resolveInside(rroot, "f.txt/..NamedFork/data"))).toBe("named_fork");
    // a name that merely contains the text is fine
    expect(resolveInside(rroot, "x..namedfork.txt")).toBe(join(rroot, "x..namedfork.txt"));
  });

  it("P7: the descriptor-based APIs reject a ..namedfork path too, not just resolveInside", async () => {
    writeFileSync(join(rroot, "g.txt"), "data");
    const opts = { allowedRoots: [rroot], maxBytes: 1000 };
    expect(
      await asyncReason(assertReadableUserFile(join(rroot, "g.txt", "..namedfork", "rsrc"), opts)),
    ).toBe("named_fork");
    expect(
      await asyncReason(readFileCapped(join(rroot, "g.txt", "..NamedFork", "data"), opts)),
    ).toBe("named_fork");
    expect(
      await asyncReason(assertReadableUserFile(join(rroot, "g.txt/..namedfork/rsrc"), opts)),
    ).toBe("named_fork");
    // and a plain path still works
    expect(await assertReadableUserFile(join(rroot, "g.txt"), opts)).toMatchObject({
      size: 4,
    });
  });

  it("P6: case variants resolve to the on-disk name or are rejected, never outside", () => {
    writeFileSync(join(rroot, "File.txt"), "data");
    const caseInsensitive = existsSync(join(rroot, "FILE.TXT"));
    const lower = caseInsensitive
      ? resolveInside(rroot, "file.txt")
      : resolveInside(rroot, "File.txt");
    expect(lower).toBe(join(rroot, "File.txt"));
    let upper: string | null = null;
    try {
      upper = resolveInside(rroot, join(rroot.toUpperCase(), "File.txt"));
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafePathError);
    }
    if (upper !== null) expect(upper).toBe(join(rroot, "File.txt"));
  });
});
