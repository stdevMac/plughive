import { describe, expect, it } from "vitest";
import {
  type ServiceSpec,
  launchAgentPlist,
  planService,
  serviceEnv,
  systemdUnit,
  windowsTaskXml,
} from "../../src/cli/service.js";

const spec: ServiceSpec = {
  node: "/opt/node & co/bin/node",
  script: "/Users/a b/plughive/dist/src/cli.js",
  logs: "/Users/a b/.plughive/logs",
  env: { PLUGHIVE_PORT: "7777", PATH: "/usr/bin:/opt/$HOME%x" },
};

describe("service definitions", () => {
  it("macOS: a LaunchAgent with escaped, separate arguments", () => {
    const plist = launchAgentPlist(spec);
    expect(plist).toContain(
      "<string>/opt/node &amp; co/bin/node</string><string>/Users/a b/plughive/dist/src/cli.js</string><string>start</string>",
    );
    expect(plist).toContain("<key>PLUGHIVE_PORT</key><string>7777</string>");
    expect(plist).toContain("/Users/a b/.plughive/logs/stdout.log");
    const plan = planService(spec, "darwin", { home: "/Users/a b", uid: 502 });
    expect(plan.file).toBe("/Users/a b/Library/LaunchAgents/dev.plughive.daemon.plist");
    expect(plan.start).toEqual([["launchctl", ["bootstrap", "gui/502", plan.file]]]);
  });

  it("Linux: a systemd user unit that quotes $, % and spaces", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain(
      'ExecStart="/opt/node & co/bin/node" "/Users/a b/plughive/dist/src/cli.js" start',
    );
    // Environment= does not expand $, so it stays single; % is a specifier.
    expect(unit).toContain('Environment="PATH=/usr/bin:/opt/$HOME%%x"');
    expect(unit).toContain("Restart=on-failure");
    // ExecStart= does expand $, so a $ in a path is doubled there.
    expect(systemdUnit({ ...spec, node: "/opt/$x/node" })).toContain('ExecStart="/opt/$$x/node"');
    const plan = planService(spec, "linux", { home: "/home/a" });
    expect(plan.file).toBe("/home/a/.config/systemd/user/plughive.service");
    expect(plan.start.at(-1)).toEqual([
      "systemctl",
      ["--user", "enable", "--now", "plughive.service"],
    ]);
  });

  it("Windows: a logon task for this user, without elevation", () => {
    const win: ServiceSpec = {
      node: "C:\\Program Files\\nodejs\\node.exe",
      script: "C:\\Users\\a\\plughive\\dist\\src\\cli.js",
      logs: "C:\\Users\\a\\.plughive\\logs",
      env: {},
    };
    const xml = windowsTaskXml(win, "PC\\a&b");
    expect(xml).toContain("<Command>C:\\Program Files\\nodejs\\node.exe</Command>");
    expect(xml).toContain(
      "<Arguments>&quot;C:\\Users\\a\\plughive\\dist\\src\\cli.js&quot; start</Arguments>",
    );
    expect(xml).toContain("<UserId>PC\\a&amp;b</UserId>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    const plan = planService(win, "win32", { home: "C:\\Users\\a", userId: "PC\\a" });
    expect(plan.start[0]?.[0]).toBe("schtasks");
    expect(plan.start[0]?.[1]).toContain("/XML");
  });

  it("carries only non-secret settings into the definition", () => {
    const env = serviceEnv(
      {
        PLUGHIVE_HOME: "/data",
        PLUGHIVE_ACCESS_KEY: "secret",
        PLUGHIVE_ADMIN_TOKEN: "secret",
        FAL_KEY: "secret",
        PATH: "/usr/bin",
      },
      "darwin",
    );
    expect(env).toEqual({ PLUGHIVE_HOME: "/data", PATH: "/usr/bin" });
    expect(serviceEnv({ PATH: "C:\\x" }, "win32")).toEqual({});
    expect(serviceEnv({ PATH: "./node_modules/.bin:/usr/bin:~/x:/usr/bin:/bin" }, "linux")).toEqual(
      {
        PATH: "/usr/bin:/bin",
      },
    );
  });
});

describe("M-13: no newline, carriage return or NUL in a service definition", () => {
  it("serviceEnv refuses control characters in carried values and PATH", async () => {
    const { CliError } = await import("../../src/cli/args.js");
    expect(() =>
      serviceEnv({ PLUGHIVE_HOME: "/data\n[Service]\nExecStart=/bin/sh" }, "linux"),
    ).toThrow(CliError);
    expect(() => serviceEnv({ PLUGHIVE_HOME: "/data\rRestart=always" }, "linux")).toThrow(
      /newline/,
    );
    expect(() => serviceEnv({ PLUGHIVE_PORT: "7777\0" }, "linux")).toThrow(/NUL/);
    expect(() => serviceEnv({ PATH: "/usr/bin\nEnvironment=x" }, "linux")).toThrow(/PATH/);
    expect(serviceEnv({ PLUGHIVE_HOME: "/data", PATH: "/usr/bin" }, "linux")).toEqual({
      PLUGHIVE_HOME: "/data",
      PATH: "/usr/bin",
    });
  });

  it("the definition builders refuse control characters", () => {
    expect(() => systemdUnit({ ...spec, env: { PLUGHIVE_HOME: "/x\nExecStart=/bin/sh" } })).toThrow(
      /newline/,
    );
    expect(() => launchAgentPlist({ ...spec, node: "/opt/node\n<key>x</key>" })).toThrow(/newline/);
    expect(() => windowsTaskXml(spec, "PC\\a\n<Principals>")).toThrow(/newline/);
    // Clean values still render.
    expect(systemdUnit(spec)).toContain("ExecStart=");
  });
});
