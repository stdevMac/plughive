import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// tests/lib/logger.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOG_KEEP_FILES, createLogger, rotateLogFile } from "../../src/lib/logger.js";
import { expectMode } from "../support/platform.js";

const posix = process.platform !== "win32";

describe("logger", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plughive-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes jsonl to a file under root/logs", async () => {
    const logger = createLogger(dir);
    logger.info({ tool: "t" }, "hello");
    await new Promise((r) => setTimeout(r, 50));
    const content = readFileSync(join(dir, "logs", "server.jsonl"), "utf8");
    const line = JSON.parse(content.trim().split("\n").pop()!);
    expect(line.msg).toBe("hello");
    expect(line.tool).toBe("t");
  });

  // L1: the log holds tool names and (masked) arguments.
  it.runIf(posix)("L1: the log folder is 0700 and the file 0600", () => {
    const logger = createLogger(dir);
    logger.info("x");
    expectMode(join(dir, "logs"), 0o700);
    expectMode(join(dir, "logs", "server.jsonl"), 0o600);
  });

  it.runIf(posix)("L1: a folder and files left loose by an older version are tightened", () => {
    const logs = join(dir, "logs");
    mkdirSync(logs, { mode: 0o755 });
    chmodSync(logs, 0o755);
    for (const name of ["server.jsonl", "server.jsonl.1"]) {
      writeFileSync(join(logs, name), "{}\n", { mode: 0o644 });
      chmodSync(join(logs, name), 0o644);
    }
    createLogger(dir);
    expectMode(logs, 0o700);
    expectMode(join(logs, "server.jsonl"), 0o600);
    expectMode(join(logs, "server.jsonl.1"), 0o600);
  });

  it("L1: rotates by size, keeps a fixed number of files and drops the oldest", () => {
    const file = join(dir, "server.jsonl");
    writeFileSync(file, "small");
    expect(rotateLogFile(file, 100)).toBe(false);
    expect(rotateLogFile(join(dir, "absent.jsonl"), 100)).toBe(false);
    for (let round = 1; round <= LOG_KEEP_FILES + 2; round++) {
      writeFileSync(file, `round ${round} ${"x".repeat(200)}`);
      expect(rotateLogFile(file, 100)).toBe(true);
      expect(existsSync(file)).toBe(false);
    }
    expect(readFileSync(`${file}.1`, "utf8")).toContain(`round ${LOG_KEEP_FILES + 2} `);
    expect(readFileSync(`${file}.${LOG_KEEP_FILES}`, "utf8")).toContain("round 3 ");
    expect(existsSync(`${file}.${LOG_KEEP_FILES + 1}`)).toBe(false);
  });

  it("L1: an oversized log is rotated at start, and again while running", async () => {
    const logs = join(dir, "logs");
    mkdirSync(logs);
    const file = join(logs, "server.jsonl");
    writeFileSync(file, `${JSON.stringify({ msg: "old" })}\n${"x".repeat(500)}\n`);
    const logger = createLogger(dir, { maxBytes: 300, checkEveryMs: 10 });
    expect(readFileSync(`${file}.1`, "utf8")).toContain('"old"');
    logger.info({ pad: "y".repeat(400) }, "first");
    expect(readFileSync(file, "utf8")).toContain('"first"');
    // The running check moves the full file aside and reopens a fresh one.
    const deadline = Date.now() + 2000;
    while (!readFileSync(`${file}.1`, "utf8").includes('"first"') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readFileSync(`${file}.1`, "utf8")).toContain('"first"');
    logger.info("second");
    expect(readFileSync(file, "utf8")).toContain('"second"');
    expect(readFileSync(file, "utf8")).not.toContain('"first"');
    if (posix) expectMode(file, 0o600);
  });
  it.runIf(posix)("R4-M4: refuses a symlink planted at the live log file", () => {
    const logs = join(dir, "logs");
    mkdirSync(logs, { mode: 0o700 });
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep", { mode: 0o644 });
    chmodSync(victim, 0o644);
    symlinkSync(victim, join(logs, "server.jsonl"));
    expect(() => createLogger(dir)).toThrow(/refusing to write the log .* symbolic link/);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(statSync(victim).mode & 0o777).toBe(0o644);
  });

  it.runIf(posix)("R4-M4: never chmods through a symlink at a rotated file", () => {
    const logs = join(dir, "logs");
    mkdirSync(logs, { mode: 0o700 });
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep", { mode: 0o644 });
    chmodSync(victim, 0o644);
    symlinkSync(victim, join(logs, "server.jsonl.2"));
    createLogger(dir);
    expect(statSync(victim).mode & 0o777).toBe(0o644);
  });

  it.runIf(posix)("R4-M4: a symlink at the live path is not rotated", () => {
    const victim = join(dir, "victim");
    writeFileSync(victim, "x".repeat(100));
    const file = join(dir, "server.jsonl");
    symlinkSync(victim, file);
    expect(rotateLogFile(file, 10)).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });
});
