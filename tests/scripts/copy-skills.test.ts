import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyPackAssets, copySkills, copyWeb } from "../../scripts/copy-skills.mjs";

describe("copy-skills build helper", () => {
  it("copies runtime skill prompts into the compiled asset directory", () => {
    const root = mkdtempSync(join(tmpdir(), "plughive-skills-"));
    const source = join(root, "src", "skills");
    const destination = join(root, "dist", "skills");

    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "customer-research.md"), "name: customer-research\n", "utf8");
      expect(() => copySkills(source, destination)).not.toThrow();
      expect(readFileSync(join(destination, "customer-research.md"), "utf8")).toContain(
        "customer-research",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces the dashboard copy, so bundles from earlier builds do not pile up", () => {
    const root = mkdtempSync(join(tmpdir(), "plughive-web-"));
    const source = join(root, "web", "dist");
    const destination = join(root, "dist", "web", "dist");
    try {
      mkdirSync(join(source, "assets"), { recursive: true });
      mkdirSync(join(destination, "assets"), { recursive: true });
      writeFileSync(join(destination, "assets", "index-OLD.js"), "old", "utf8");
      writeFileSync(join(source, "assets", "index-NEW.js"), "new", "utf8");
      writeFileSync(join(source, "index.html"), "<html></html>", "utf8");
      copyWeb(source, destination);
      expect(readdirSync(join(destination, "assets"))).toEqual(["index-NEW.js"]);
      expect(readFileSync(join(destination, "index.html"), "utf8")).toContain("<html>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves local secrets and symlinks out of the pack assets", () => {
    const root = mkdtempSync(join(tmpdir(), "plughive-packs-"));
    const source = join(root, "packs", "demo");
    const destination = join(root, "dist", "packs");
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "pack.json"), "{}", "utf8");
      writeFileSync(join(source, "index.ts"), "export {}", "utf8");
      writeFileSync(join(source, ".env"), "KEY=1", "utf8");
      writeFileSync(join(source, ".env.example"), "KEY=", "utf8");
      writeFileSync(join(source, "client.key"), "k", "utf8");
      symlinkSync(join(root, "outside"), join(source, "link"));
      copyPackAssets(join(root, "packs"), destination);
      expect(readdirSync(join(destination, "demo")).sort()).toEqual([".env.example", "pack.json"]);
      expect(existsSync(join(destination, "demo", "link"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
