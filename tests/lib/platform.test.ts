// The Windows / macOS / Linux differences, tested on whatever OS runs the
// suite: every helper takes the platform as a parameter.
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeIdentityPath } from "../../packs/machines/policy.js";
import { planConnect } from "../../src/clients/index.js";
import { UserMountSchema } from "../../src/core/mounts/user-mounts.js";
import { packChildEnv } from "../../src/core/packs/context.js";
import {
  browserCommand,
  defaultSystemPath,
  exeCandidates,
  fchmodBestEffort,
  homeEnv,
  isAbsoluteAnyOs,
  isBatchScript,
  joinPath,
  osFamily,
  pathDelimiter,
  splitPath,
  systemChildEnv,
  writeFileAtomicSync,
} from "../../src/lib/platform.js";

describe("platform helpers", () => {
  it("uses ; for PATH on Windows and : elsewhere", () => {
    expect(pathDelimiter("win32")).toBe(";");
    expect(pathDelimiter("linux")).toBe(":");
    expect(splitPath("C:\\a;;C:\\b", "win32")).toEqual(["C:\\a", "C:\\b"]);
    expect(splitPath("/a::/b", "darwin")).toEqual(["/a", "/b"]);
    expect(joinPath(["C:\\a", "C:\\b"], "win32")).toBe("C:\\a;C:\\b");
  });

  it("builds a system PATH from SystemRoot on Windows", () => {
    expect(defaultSystemPath("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32;D:\\Win;D:\\Win\\System32\\Wbem",
    );
    expect(defaultSystemPath("win32", {})).toContain("C:\\Windows\\System32");
    expect(defaultSystemPath("linux", {})).toBe("/usr/bin:/bin");
  });

  it("tries PATHEXT extensions for a bare name on Windows only", () => {
    expect(exeCandidates("ffmpeg", "win32", { PATHEXT: ".COM;.EXE" })).toEqual([
      "ffmpeg.com",
      "ffmpeg.exe",
    ]);
    expect(exeCandidates("ffmpeg.exe", "win32", { PATHEXT: ".EXE" })).toEqual(["ffmpeg.exe"]);
    // A junk PATHEXT entry is dropped, not turned into a file name.
    expect(exeCandidates("x", "win32", { PATHEXT: ".EXE;evil;.e x" })).toEqual(["x.exe"]);
    expect(exeCandidates("ffmpeg", "darwin")).toEqual(["ffmpeg"]);
    // An empty or unusable PATHEXT falls back to the default list.
    const defaults = ["x.com", "x.exe", "x.bat", "x.cmd"];
    expect(exeCandidates("x", "win32", { PATHEXT: "" })).toEqual(defaults);
    expect(exeCandidates("x", "win32", { PATHEXT: ";evil;" })).toEqual(defaults);
  });

  it("recognises batch scripts in any case", () => {
    expect(isBatchScript("C:\\nodejs\\npx.CMD")).toBe(true);
    expect(isBatchScript("run.bat")).toBe(true);
    expect(isBatchScript("ffmpeg.exe")).toBe(false);
  });

  it("passes only the Windows start-up variables to a child", () => {
    const env = systemChildEnv("win32", {
      SystemRoot: "C:\\Windows",
      PATHEXT: ".EXE",
      OPENAI_API_KEY: "sk-nope",
      HOME: "C:\\Users\\me",
    });
    expect(env).toEqual({ SystemRoot: "C:\\Windows", PATHEXT: ".EXE" });
    expect(systemChildEnv("linux", { SystemRoot: "x" })).toEqual({});
  });

  it("points every per-user folder at the private home on Windows", () => {
    const env = homeEnv("C:\\data\\.home", "C:\\data\\.tmp", "win32");
    expect(env).toMatchObject({
      HOME: "C:\\data\\.home",
      USERPROFILE: "C:\\data\\.home",
      APPDATA: "C:\\data\\.home\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\data\\.home\\AppData\\Local",
      TEMP: "C:\\data\\.tmp",
      TMP: "C:\\data\\.tmp",
    });
    expect(homeEnv("/d/.home", "/d/.tmp", "linux")).toEqual({
      HOME: "/d/.home",
      TMPDIR: "/d/.tmp",
    });
  });

  it("treats drive, UNC and POSIX paths as absolute", () => {
    for (const p of ["/usr/bin/x", "C:\\x", "c:/x", "\\\\server\\share\\x"])
      expect(isAbsoluteAnyOs(p), p).toBe(true);
    for (const p of ["x", "./x", "C:x", "..\\x"]) expect(isAbsoluteAnyOs(p), p).toBe(false);
  });

  it("opens URLs without a shell on every OS", () => {
    const url = "http://127.0.0.1:7777/#t=a&b=%20";
    expect(browserCommand(url, "darwin")).toEqual({ file: "open", args: [url] });
    expect(browserCommand(url, "linux")).toEqual({ file: "xdg-open", args: [url] });
    expect(browserCommand(url, "win32")).toEqual({
      file: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("names the OS family", () => {
    expect(osFamily("darwin")).toBe("macos");
    expect(osFamily("win32")).toBe("windows");
    expect(osFamily("freebsd")).toBe("linux");
  });
});

describe("packChildEnv on Windows", () => {
  it("gives a pack its own USERPROFILE, APPDATA and TEMP and creates those folders", () => {
    const data = join("data", "pack");
    const { env, dirs } = packChildEnv(data, false, "C:\\Users\\me", "win32");
    const home = join(data, ".home");
    expect(env.USERPROFILE).toBe(home);
    expect(env.APPDATA).toBe(win32.join(home, "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(win32.join(home, "AppData", "Local"));
    expect(env.TEMP).toBe(join(data, ".tmp"));
    expect(env.TMP).toBe(join(data, ".tmp"));
    expect(dirs).toContain(join(".home", win32.join("AppData", "Roaming")));
    expect(dirs).toContain(join(".home", win32.join("AppData", "Local")));
  });

  it("keeps the real user folders for a pack with permissions.userHome", () => {
    const { env, dirs } = packChildEnv("d", true, "C:\\Users\\me", "win32");
    expect(env.USERPROFILE).toBe("C:\\Users\\me");
    expect(env.HOME).toBe("C:\\Users\\me");
    expect(env.APPDATA).toBe(process.env.APPDATA);
    expect(dirs).toEqual([".tmp"]);
  });
});

describe("Claude Desktop entry on Windows", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("starts npx through cmd /c, since npx is npx.cmd there", () => {
    home = mkdtempSync(join(tmpdir(), "cd-win-"));
    const appData = join(home, "AppData", "Roaming");
    const plan = planConnect("claude-desktop", {
      home,
      platform: "win32",
      env: { APPDATA: appData },
      url: "http://127.0.0.1:7777/mcp",
    });
    expect(plan.path.startsWith(appData)).toBe(true);
    const entry = JSON.parse(plan.after).mcpServers.plughive;
    expect(entry.command).toBe("cmd");
    expect(entry.args.slice(0, 3)).toEqual(["/c", "npx", "-y"]);
    expect(entry.args).toContain("http://127.0.0.1:7777/mcp");
  });

  it("refuses a URL that cmd.exe would interpret", () => {
    home = mkdtempSync(join(tmpdir(), "cd-win-"));
    for (const url of [
      "http://127.0.0.1:7777/mcp?a=1&calc",
      "http://127.0.0.1:7777/%PATH%",
      "http://127.0.0.1:7777/p|x",
    ])
      expect(
        () =>
          planConnect("claude-desktop", {
            home,
            platform: "win32",
            env: { APPDATA: join(home, "AppData", "Roaming") },
            url,
          }),
        url,
      ).toThrow(/must not contain/);
  });
});

describe("stdio mount commands", () => {
  const stdio = (command: string) => ({
    id: "files",
    transport: "stdio",
    prefix: "fs",
    command,
  });

  it("accepts Windows absolute paths and plain names", () => {
    for (const c of [
      "npx",
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/tools/server.exe",
      "\\\\host\\share\\server.exe",
      "/usr/local/bin/server",
    ])
      expect(UserMountSchema.safeParse(stdio(c)).success, c).toBe(true);
  });

  it("refuses relative paths with a separator", () => {
    for (const c of ["..\\evil.exe", "bin\\server", "./server", "C:relative.exe"])
      expect(UserMountSchema.safeParse(stdio(c)).success, c).toBe(false);
  });
});

describe("SSH identity paths", () => {
  it("expands ~/ and ~\\ against a Windows home with backslashes", () => {
    expect(normalizeIdentityPath("~\\.ssh\\id_ed25519", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\.ssh\\id_ed25519",
    );
    expect(normalizeIdentityPath("~/.ssh/id_ed25519", "C:\\Users\\me\\")).toBe(
      "C:\\Users\\me\\.ssh/id_ed25519",
    );
    expect(normalizeIdentityPath("~/.ssh/id", "/home/me")).toBe("/home/me/.ssh/id");
    expect(normalizeIdentityPath("C:\\keys\\id", "C:\\Users\\me")).toBe("C:\\keys\\id");
  });
});

describe("fchmodBestEffort", () => {
  it("ignores a refused fchmod on Windows and throws it elsewhere", () => {
    // A closed descriptor makes fchmod fail on every OS.
    expect(() => fchmodBestEffort(2_000_000, 0o600, "win32")).not.toThrow();
    expect(() => fchmodBestEffort(2_000_000, 0o600, "linux")).toThrow();
  });
});

describe("writeFileAtomicSync", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces the file in one step, 0600, and leaves no temp file", () => {
    dir = mkdtempSync(join(tmpdir(), "plughive-atomic-"));
    const target = join(dir, "state.json");
    writeFileSync(target, "old", { mode: 0o644 });
    writeFileAtomicSync(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "never writes through a symlink planted at the path",
    () => {
      dir = mkdtempSync(join(tmpdir(), "plughive-atomic-"));
      const victim = join(dir, "victim");
      writeFileSync(victim, "keep");
      const target = join(dir, "state.json");
      symlinkSync(victim, target);
      writeFileAtomicSync(target, "new");
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("new");
    },
  );
});
