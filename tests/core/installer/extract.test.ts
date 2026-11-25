// Archive extraction: links inside the folder are kept, also when the folder
// is reached through a symlink; links that leave it are refused.
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtractError, extractArchive } from "../../../src/core/installer/extract.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tarOf(files: (src: string) => void): { tgz: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "mcp-extract-"));
  dirs.push(base);
  const src = join(base, "src");
  mkdirSync(src);
  files(src);
  const tgz = join(base, "a.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
  return { tgz, base };
}

describe.skipIf(process.platform === "win32")("extractArchive", () => {
  it("keeps a link inside the folder when the folder is reached through a symlink", async () => {
    const { tgz, base } = tarOf((src) => {
      writeFileSync(join(src, "tool"), "bin");
      symlinkSync("tool", join(src, "tool-latest"));
    });
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "via"));
    const dest = join(base, "via", "out");
    mkdirSync(dest);
    await extractArchive(tgz, "tar.gz", dest);
    expect(readFileSync(join(dest, "tool-latest"), "utf8")).toBe("bin");
  });

  it("refuses a link that points outside the folder", async () => {
    const { tgz, base } = tarOf((src) => {
      symlinkSync("../../etc/passwd", join(src, "escape"));
    });
    const dest = join(base, "out");
    mkdirSync(dest);
    await expect(extractArchive(tgz, "tar.gz", dest)).rejects.toBeInstanceOf(ExtractError);
  });
});

describe.skipIf(process.platform === "win32")("extractArchive hard links", () => {
  it("refuses an archive whose entries are hard links to each other", async () => {
    const { tgz, base } = tarOf((src) => {
      writeFileSync(join(src, "tool"), "bin");
      linkSync(join(src, "tool"), join(src, "tool-copy"));
    });
    const dest = join(base, "out");
    mkdirSync(dest);
    await expect(extractArchive(tgz, "tar.gz", dest)).rejects.toThrow(/more than one hard link/);
  });

  it("still extracts a plain archive of regular files", async () => {
    const { tgz, base } = tarOf((src) => {
      writeFileSync(join(src, "tool"), "bin");
      mkdirSync(join(src, "sub"));
      writeFileSync(join(src, "sub", "data.txt"), "data");
    });
    const dest = join(base, "out");
    mkdirSync(dest);
    await extractArchive(tgz, "tar.gz", dest);
    expect(readFileSync(join(dest, "tool"), "utf8")).toBe("bin");
    expect(readFileSync(join(dest, "sub", "data.txt"), "utf8")).toBe("data");
  });
});
