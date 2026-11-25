import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPack, targetsOf } from "../../scripts/check-pack.mjs";

const pkg = {
  bin: { plughive: "dist/src/cli.js" },
  exports: {
    "./pack": { types: "./src/core/pack-api.ts", default: "./dist/src/core/pack-api.js" },
  },
};
const good = [
  "package.json",
  "README.md",
  "dist/src/cli.js",
  "dist/src/core/pack-api.js",
  "dist/packs/web/pack.json",
  "dist/web/dist/index.html",
  "src/core/pack-api.ts",
];
const packed = (extra: string[] = [], drop: string[] = []) => ({
  files: [...good.filter((p) => !drop.includes(p)), ...extra].map((path) => ({ path })),
});

describe("check-pack (M3)", () => {
  it("accepts a package with every target and nothing forbidden", () => {
    expect(checkPack(pkg, packed())).toEqual([]);
  });

  it("collects bin and every export condition as targets", () => {
    expect(targetsOf(pkg).map((t) => t.path)).toEqual([
      "dist/src/cli.js",
      "src/core/pack-api.ts",
      "dist/src/core/pack-api.js",
    ]);
  });

  it("fails on a missing bin or export target", () => {
    const problems = checkPack(pkg, packed([], ["dist/src/cli.js", "dist/src/core/pack-api.js"]));
    expect(problems.join("\n")).toMatch(/bin\.plughive points to dist\/src\/cli\.js/);
    expect(problems.join("\n")).toMatch(/exports.*dist\/src\/core\/pack-api\.js/);
  });

  it("fails on env files, tokens, secrets, tests and stray dist entries", () => {
    const problems = checkPack(
      pkg,
      packed([
        ".env",
        "dist/packs/x/.env.local",
        "dist/admin-token",
        "dist/src/secrets.json",
        "dist/src/a.test.js",
        "src/tests/helper.ts",
        "dist/tests/old.js",
        "dist/scripts/smoke.js",
        "dist/web/src/main.js",
        "tests/x.ts",
        "dist/packs/x/server.pem",
        "dist/packs/x/id.KEY",
        "dist/packs/x/cert.p12",
      ]),
    ).join("\n");
    for (const needle of [
      ".env is an .env file",
      "dist/packs/x/.env.local is an .env file",
      "admin-token is an admin token",
      "secrets.json is a secrets file",
      "a.test.js is a test file",
      "src/tests/helper.ts is inside a tests/ directory",
      "unexpected dist entry: dist/tests/old.js",
      "unexpected dist entry: dist/scripts/smoke.js",
      "unexpected dist/web entry: dist/web/src/main.js",
      "unexpected top-level entry: tests/x.ts",
      "dist/packs/x/server.pem is a private key or certificate bundle",
      "dist/packs/x/id.KEY is a private key or certificate bundle",
      "dist/packs/x/cert.p12 is a private key or certificate bundle",
    ])
      expect(problems).toContain(needle);
  });

  it("allows .env.example and checks the real package.json targets", () => {
    expect(checkPack(pkg, packed(["dist/packs/x/.env.example"]))).toEqual([]);
    const real = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const paths = targetsOf(real).map((t) => t.path);
    expect(paths).toContain("dist/src/cli.js");
    expect(real.scripts.prepack).toMatch(/clean.*build/);
  });
});
