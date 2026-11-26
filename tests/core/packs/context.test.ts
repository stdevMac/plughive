import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedRequestError } from "../../../src/core/net/safe-fetch.js";
import { SpawnError } from "../../../src/core/pack-api.js";
import {
  MAX_SPAWN_TIMEOUT_MS,
  PACK_MARKER_HEADER,
  PackDisposedError,
  type PackHost,
  PackPermissionError,
  createPackContext,
  isLinkLocalOrMetadataHost,
  isStrippedEnvName,
  packChildEnv,
  storedMime,
} from "../../../src/core/packs/context.js";
import { ManifestError, parseManifest } from "../../../src/core/packs/manifest.js";
import { createMemoryLibrary } from "../../../src/core/packs/testing.js";
import { MissingSecretError, createSecretStore } from "../../../src/core/secrets/index.js";
import type { CallContext, ToolEnvelope } from "../../../src/core/tools/registry.js";
import { canSymlink, expectMode, itSymlink } from "../../support/platform.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function manifest(extra: Record<string, unknown> = {}) {
  return parseManifest({ id: "demo", name: "Demo", version: "0.1.0", apiVersion: 1, ...extra });
}

describe("pack context", () => {
  let tmp: string;
  let dir: string;
  let host: PackHost;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "plughive-ctx-")));
    dir = join(tmp, "data");
    mkdirSync(dir);
    host = {
      store: createSecretStore({
        home: tmp,
        // The store's env is the only env a pack can reach, never process.env.
        env: { DEMO_KEY: "fixture-demo-value", OTHER_PACK_KEY: "fixture-other-value" },
        backend: "memory",
      }),
      logger: silent,
    };
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const ctxFor = (m = manifest(), extra: Record<string, unknown> = {}) =>
    createPackContext({ manifest: m, dataDir: dir, settings: {}, host, ...extra });

  describe("secrets", () => {
    it("returns declared secrets only", async () => {
      const { base } = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
      expect(await base.secrets.get("DEMO_KEY")).toBe("fixture-demo-value");
      expect(await base.secrets.has("DEMO_KEY")).toBe(true);
    });

    it("refuses another pack's secret even when the store has it", async () => {
      const { base } = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
      await expect(base.secrets.get("OTHER_PACK_KEY")).rejects.toBeInstanceOf(PackPermissionError);
      await expect(base.secrets.has("OTHER_PACK_KEY")).rejects.toBeInstanceOf(PackPermissionError);
      // An undeclared value-like argument is never echoed back.
      await expect(base.secrets.get("fixture-env-value")).rejects.toThrow("(invalid name)");
    });

    // C1: the daemon's own configuration and plain process environment are never pack secrets.
    it.each([
      "PLUGHIVE_ACCESS_KEY",
      "PATH",
      "HOME",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ])("rejects the secret name %s in the manifest", (name) => {
      expect(() => manifest({ secrets: [{ name }] })).toThrow(ManifestError);
    });

    it("denies a reserved name at runtime even if a manifest object carries it", async () => {
      const forged = {
        ...manifest(),
        secrets: [{ name: "PLUGHIVE_ACCESS_KEY", required: true }],
      };
      host.store = createSecretStore({
        home: tmp,
        env: { PLUGHIVE_ACCESS_KEY: "fixture-access-key-value" },
        backend: "memory",
      });
      const scoped = ctxFor(forged);
      const err = await scoped.base.secrets.get("PLUGHIVE_ACCESS_KEY").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PackPermissionError);
      expect(err).toMatchObject({ reason: "denied" });
      expect(scoped.allowedSecrets).toEqual([]);
      // The name was never declared to the store, so the env value stays unreachable.
      expect(await host.store.has("PLUGHIVE_ACCESS_KEY")).toBe(false);
    });

    // C1: a user pack reads only what the user granted by name.
    it("gives a user pack only the granted secrets, and says so distinctly from 'missing'", async () => {
      const m = manifest({
        secrets: [{ name: "DEMO_KEY" }, { name: "OTHER_PACK_KEY" }, { name: "UNSET_KEY" }],
      });
      const scoped = ctxFor(m, { source: "user", grants: ["DEMO_KEY", "UNSET_KEY"] });
      expect(scoped.allowedSecrets).toEqual(["DEMO_KEY", "UNSET_KEY"]);
      await host.store.set("DEMO_KEY", "stored-demo-value");
      expect(await scoped.base.secrets.get("DEMO_KEY")).toBe("stored-demo-value");

      const denied = await scoped.base.secrets.get("OTHER_PACK_KEY").catch((e: unknown) => e);
      expect(denied).toBeInstanceOf(PackPermissionError);
      expect(denied).not.toBeInstanceOf(MissingSecretError);
      expect(denied).toMatchObject({
        code: "PACK_PERMISSION_DENIED",
        reason: "secret_not_granted",
      });
      await expect(scoped.base.secrets.has("OTHER_PACK_KEY")).rejects.toBeInstanceOf(
        PackPermissionError,
      );
      // Granted but not configured is the ordinary "missing" case.
      await expect(scoped.base.secrets.get("UNSET_KEY")).rejects.toBeInstanceOf(MissingSecretError);
      // The ungranted name was not declared to the store: its env value is not served.
      expect(await host.store.has("OTHER_PACK_KEY")).toBe(false);
    });

    // M1: the daemon's environment is not a user pack's to read, whatever it is granted.
    it("never serves a user pack from the environment, only from the store", async () => {
      const m = manifest({ secrets: [{ name: "DEMO_KEY" }] });
      const scoped = ctxFor(m, { source: "user", grants: ["DEMO_KEY"] });
      expect(await scoped.base.secrets.has("DEMO_KEY")).toBe(false);
      await expect(scoped.base.secrets.get("DEMO_KEY")).rejects.toBeInstanceOf(MissingSecretError);
      // The grant did not turn the environment fallback on for anyone else either.
      expect(await host.store.has("DEMO_KEY")).toBe(false);
      expect(host.store.hasEnvFallback("DEMO_KEY")).toBe(false);

      // Even while a bundled pack declares the same name (and reads the environment).
      const bundled = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
      expect(await bundled.base.secrets.get("DEMO_KEY")).toBe("fixture-demo-value");
      expect(await scoped.base.secrets.has("DEMO_KEY")).toBe(false);
      await expect(scoped.base.secrets.get("DEMO_KEY")).rejects.toBeInstanceOf(MissingSecretError);

      await host.store.set("DEMO_KEY", "stored-by-the-user");
      expect(await scoped.base.secrets.get("DEMO_KEY")).toBe("stored-by-the-user");
    });

    it("stops serving a name from the environment once no loaded bundled pack declares it", async () => {
      const first = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
      const second = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
      expect(host.store.hasEnvFallback("DEMO_KEY")).toBe(true);
      await first.dispose();
      expect(host.store.hasEnvFallback("DEMO_KEY")).toBe(true);
      await second.dispose();
      expect(host.store.hasEnvFallback("DEMO_KEY")).toBe(false);
      expect(await host.store.get("DEMO_KEY")).toBeNull();
    });

    it.each([
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "SSH_PRIVATE_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AZURE_CLIENT_SECRET",
    ])("rejects the well-known credential %s in any manifest", (name) => {
      expect(() => manifest({ secrets: [{ name }] })).toThrow(ManifestError);
    });

    it.each(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])(
      "%s: a bundled pack may read it, a user pack never (even when granted and stored)",
      async (name) => {
        host.store = createSecretStore({
          home: tmp,
          env: { [name]: "env-value" },
          backend: "memory",
        });
        await host.store.set(name, "stored-value");
        const m = manifest({ secrets: [{ name }] });
        expect(await ctxFor(m).base.secrets.get(name)).toBe("stored-value");
        const user = ctxFor(m, { source: "user", grants: [name] });
        expect(user.allowedSecrets).toEqual([]);
        const err = await user.base.secrets.get(name).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PackPermissionError);
        expect(err).toMatchObject({ reason: "denied" });
      },
    );

    it("gives a user pack with no grants nothing", async () => {
      const scoped = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }), { source: "user" });
      expect(scoped.allowedSecrets).toEqual([]);
      await expect(scoped.base.secrets.get("DEMO_KEY")).rejects.toMatchObject({
        reason: "secret_not_granted",
      });
    });

    it("throws MissingSecretError with pack, name, label and helpUrl", async () => {
      const { base } = ctxFor(
        manifest({
          secrets: [{ name: "UNSET_KEY", label: "Unset key", helpUrl: "https://example.com/key" }],
        }),
      );
      const err = await base.secrets.get("UNSET_KEY").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingSecretError);
      expect(err).toMatchObject({
        code: "MISSING_SECRET",
        pack: "demo",
        name: "UNSET_KEY",
        label: "Unset key",
        helpUrl: "https://example.com/key",
      });
    });
  });

  describe("fetch", () => {
    // H2: the router tells "request sent" from "request answered" through these hooks.
    it("reports a request before it is sent, its answer, and a transport failure", async () => {
      const events: string[] = [];
      const observer = {
        onRequest: (i: { method: string }) => void events.push(`request:${i.method}`),
        onResponse: (i: { method: string; status: number }) =>
          void events.push(`response:${i.method}:${i.status}`),
        onError: (i: { method: string; error: unknown }) =>
          void events.push(`error:${i.method}:${(i.error as Error).message}`),
      };
      let fail = false;
      host.fetchImpl = (async () => {
        events.push("transport");
        if (fail) throw new Error("socket hang up");
        return new Response("ok", { status: 202 });
      }) as typeof fetch;
      const ctx = ctxFor(manifest({ permissions: { network: ["api.example.com"] } })).forCall(
        {},
        "tool",
        observer,
      );
      await ctx.fetch("https://api.example.com/jobs", { method: "post" });
      fail = true;
      await expect(ctx.fetch("https://api.example.com/jobs", { method: "POST" })).rejects.toThrow(
        "socket hang up",
      );
      // A refused host never reaches the transport: nothing is reported as sent.
      await expect(ctx.fetch("https://other.example.com/")).rejects.toBeInstanceOf(
        PackPermissionError,
      );
      expect(events).toEqual([
        "request:POST",
        "transport",
        "response:POST:202",
        "request:POST",
        "transport",
        "error:POST:socket hang up",
      ]);
    });

    let server: Server | null = null;
    afterEach(async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    });
    const listen = async (handler: Parameters<typeof createServer>[1]) => {
      server = createServer(handler);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      return (server.address() as AddressInfo).port;
    };

    it("is denied without a network permission", async () => {
      const { base } = ctxFor();
      await expect(base.fetch("https://api.example.com/")).rejects.toBeInstanceOf(
        PackPermissionError,
      );
    });

    it("blocks an undeclared host before any DNS lookup", async () => {
      const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
      host.fetchPolicy = { lookup };
      const scoped = ctxFor(manifest({ permissions: { network: ["api.example.com"] } }));
      await expect(scoped.base.fetch("https://other.example.com/x")).rejects.toBeInstanceOf(
        BlockedRequestError,
      );
      expect(lookup).not.toHaveBeenCalled();
      await scoped.dispose();
    });

    it("blocks loopback unless it is declared in localNetwork", async () => {
      const port = await listen((_req, res) => res.end("local-ok"));

      const denied = ctxFor(manifest({ permissions: { network: ["*"] } }));
      await expect(denied.base.fetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(
        BlockedRequestError,
      );
      await denied.dispose();

      const allowed = ctxFor(manifest({ permissions: { localNetwork: [`127.0.0.1:${port}`] } }));
      const res = await allowed.base.fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("local-ok");
      await allowed.dispose();
    });

    // H6
    it("never reaches link-local or metadata addresses, whatever is declared", async () => {
      const warn = vi.fn();
      host.logger = { ...silent, warn };
      const scoped = ctxFor(
        manifest({
          permissions: {
            network: ["*"],
            localNetwork: [
              "169.254.169.254:80",
              "[fe80::1]:80",
              "[64:ff9b::a9fe:a9fe]:80",
              "[2002:a9fe:a9fe::]:80",
            ],
          },
        }),
      );
      for (const url of [
        "http://169.254.169.254/latest/meta-data/",
        "http://[fe80::1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
        "http://[2002:a9fe:a9fe::]/",
        "http://metadata.google.internal/computeMetadata/v1/",
      ]) {
        const err = await scoped.base.fetch(url).catch((e: unknown) => e);
        expect(err, url).toBeInstanceOf(PackPermissionError);
        expect(err, url).toMatchObject({ reason: "denied" });
      }
      for (const entry of [
        "169.254.169.254:80",
        "[64:ff9b::a9fe:a9fe]:80",
        "[2002:a9fe:a9fe::]:80",
      ]) {
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ pack: "demo", entry }),
          expect.stringContaining("localNetwork entry ignored"),
        );
      }
      await scoped.dispose();
    });

    it("refuses a public name that resolves to a metadata address", async () => {
      host.fetchPolicy = {
        lookup: async () => [{ address: "169.254.169.254", family: 4 as const }],
      };
      const scoped = ctxFor(manifest({ permissions: { network: ["rebind.example.com"] } }));
      await expect(scoped.base.fetch("http://rebind.example.com/")).rejects.toThrow();
      await scoped.dispose();
    });

    it("classifies link-local and metadata hosts", () => {
      for (const h of [
        "169.254.169.254",
        "169.254.0.1",
        "100.100.100.200",
        "fe80::1",
        "[fe80::1%en0]",
        "::ffff:169.254.169.254",
        "fd00:ec2::254",
        "metadata.google.internal",
        "Metadata.Google.Internal.",
        // IPv6 forms that carry 169.254.169.254 (NAT64, 6to4, Teredo).
        "64:ff9b::a9fe:a9fe",
        "64:ff9b::169.254.169.254",
        "[64:ff9b:1::a9fe:a9fe]",
        "2002:a9fe:a9fe::",
        "2002:a9fe:a9fe:1::1",
        "2001:0:a9fe:a9fe::1",
        "2001:0:4136:e378:8000:63bf:5601:5601",
      ]) {
        expect(isLinkLocalOrMetadataHost(h), h).toBe(true);
      }
      for (const h of [
        "127.0.0.1",
        "10.0.0.1",
        "example.com",
        "::1",
        "192.168.1.1",
        "64:ff9b::808:808",
        "2002:808:808::",
        "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      ]) {
        expect(isLinkLocalOrMetadataHost(h), h).toBe(false);
      }
    });

    it("never reaches the daemon's own port, even when localNetwork names it", async () => {
      const hit = vi.fn();
      const port = await listen((_req, res) => {
        hit();
        res.end("daemon");
      });
      host.daemonPorts = [port];
      const scoped = ctxFor(
        manifest({ permissions: { localNetwork: [`127.0.0.1:${port}`, `localhost:${port}`] } }),
      );
      for (const url of [
        `http://127.0.0.1:${port}/api/profiles`,
        `http://localhost:${port}/mcp`,
        `http://localhost.:${port}/mcp`,
      ]) {
        const err = await scoped.base.fetch(url).catch((e: unknown) => e);
        expect(err, url).toBeInstanceOf(PackPermissionError);
        expect(err, url).toMatchObject({ reason: "denied" });
      }
      expect(hit).not.toHaveBeenCalled();
      await scoped.dispose();
    });

    // L2
    it("never reaches the daemon's own port through a name that resolves to this machine", async () => {
      const hit = vi.fn();
      const daemonPort = await listen((_req, res) => {
        hit();
        res.end("daemon");
      });
      const otherPort = await listen((_req, res) => res.end("other-ok"));
      host.daemonPorts = [daemonPort];
      const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
      host.fetchPolicy = { lookup };
      // A .localhost name is a local name, so the entry stands; the resolved
      // address decides at connect time.
      const scoped = ctxFor(
        manifest({
          permissions: {
            localNetwork: [`rebind.localhost:${daemonPort}`, `rebind.localhost:${otherPort}`],
          },
        }),
      );
      const err = await scoped.base
        .fetch(`http://rebind.localhost:${daemonPort}/api/profiles`)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(hit).not.toHaveBeenCalled();
      // The same name on another port is still reachable: the port decides.
      const ok = await scoped.base.fetch(`http://rebind.localhost:${otherPort}/`);
      expect(await ok.text()).toBe("other-ok");
      expect(lookup).toHaveBeenCalled();
      await scoped.dispose();
    });

    it("ignores a localNetwork entry whose host is not a local name", async () => {
      const warn = vi.fn();
      host.logger = { ...silent, warn };
      host.fetchPolicy = {
        lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      };
      const scoped = ctxFor(
        manifest({ permissions: { localNetwork: ["made-up.example.test:8080"] } }),
      );
      const err = await scoped.base.fetch("http://made-up.example.test:8080/").catch((e) => e);
      expect(err).toBeInstanceOf(PackPermissionError);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ pack: "demo", entry: "made-up.example.test:8080" }),
        expect.stringContaining("localNetwork entry ignored"),
      );
      await scoped.dispose();
    });

    it("refuses a name that resolves to a link-local address on any port", async () => {
      host.fetchPolicy = {
        lookup: async () => [
          { address: "10.0.0.8", family: 4 as const },
          { address: "fe80::1", family: 6 as const },
        ],
      };
      const scoped = ctxFor(manifest({ permissions: { localNetwork: ["nas.example.test:8080"] } }));
      await expect(scoped.base.fetch("http://nas.example.test:8080/")).rejects.toThrow();
      await scoped.dispose();
    });

    it("stamps every request with the pack marker header, which the pack cannot override", async () => {
      const seen: (string | string[] | undefined)[] = [];
      const port = await listen((req, res) => {
        seen.push(req.headers[PACK_MARKER_HEADER]);
        res.end("ok");
      });
      const scoped = ctxFor(manifest({ permissions: { localNetwork: [`127.0.0.1:${port}`] } }));
      const url = `http://127.0.0.1:${port}/`;
      await scoped.base.fetch(url);
      await scoped.base.fetch(url, { headers: { "X-PlugHive-Pack": "legacy" } });
      await scoped.base.fetch(new Request(url, { headers: { [PACK_MARKER_HEADER]: "other" } }));
      expect(PACK_MARKER_HEADER).toBe("x-plughive-pack");
      expect(seen).toEqual(["demo", "demo", "demo"]);
      await scoped.dispose();
    });
  });

  describe("spawn", () => {
    it("refuses an undeclared binary", async () => {
      const { base } = ctxFor(manifest({ permissions: { spawn: ["ffmpeg"] } }));
      await expect(base.spawn("node", ["-v"])).rejects.toBeInstanceOf(PackPermissionError);
      await expect(base.spawn("/bin/sh", ["-c", "true"])).rejects.toBeInstanceOf(
        PackPermissionError,
      );
    });

    it("runs a declared binary without a shell and without the daemon env", async () => {
      process.env.PLUGHIVE_CTX_TEST_LEAK = "fixture-env-value";
      try {
        const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
        const out = await base.spawn("node", [
          "-e",
          "process.stdout.write(JSON.stringify([process.env.PLUGHIVE_CTX_TEST_LEAK ?? null, process.argv[1]]))",
          "$(echo injected)",
        ]);
        expect(out).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
        expect(JSON.parse(out.stdout)).toEqual([null, "$(echo injected)"]);
      } finally {
        Reflect.deleteProperty(process.env, "PLUGHIVE_CTX_TEST_LEAK");
      }
    });

    // L3
    it("gives the child exactly the allowlist: PATH, HOME, TMPDIR, XDG, the locale and the pack's env", async () => {
      const saved = { ...process.env };
      process.env.LANG = "de_DE.UTF-8";
      process.env.LC_CTYPE = "de_DE.UTF-8";
      process.env.LC_BAD = "x$(touch y)";
      process.env.AWS_SECRET_ACCESS_KEY = "fixture-not-for-children";
      process.env.SSH_AUTH_SOCK = "/tmp/fixture-agent.sock";
      process.env.PLUGHIVE_CTX_TEST_LEAK = "fixture-env-value";
      try {
        const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
        const out = await base.spawn(
          "node",
          ["-e", "process.stdout.write(JSON.stringify(process.env))"],
          { env: { DEMO_SETTING: "on", LD_PRELOAD: "/x.so" } },
        );
        const env = JSON.parse(out.stdout) as Record<string, string>;
        // macOS may add __CF_USER_TEXT_ENCODING to any process it starts.
        const names = Object.keys(env)
          .filter((k) => k !== "__CF_USER_TEXT_ENCODING")
          .sort();
        expect(names).toEqual(
          [
            "DEMO_SETTING",
            "HOME",
            "LANG",
            "LC_CTYPE",
            "PATH",
            "TEXMFVAR",
            "TMPDIR",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
          ].sort(),
        );
        expect(env.LANG).toBe("de_DE.UTF-8");
      } finally {
        for (const k of Object.keys(process.env))
          if (!(k in saved)) Reflect.deleteProperty(process.env, k);
        Object.assign(process.env, saved);
      }
    });

    it("reports a timeout and an output cap as flags with the partial output", async () => {
      const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
      const slow = await base.spawn(
        "node",
        // The timeout leaves room for node to start on a loaded machine; the
        // child would otherwise run for a minute.
        ["-e", "process.stdout.write('started'); setTimeout(() => {}, 60000)"],
        { timeoutMs: 3000 },
      );
      expect(slow).toMatchObject({ timedOut: true, truncated: false, stdout: "started" });
      const loud = await base.spawn("node", ["-e", "process.stdout.write('x'.repeat(10000))"], {
        maxOutputBytes: 100,
      });
      expect(loud).toMatchObject({ timedOut: false, truncated: true });
      expect(loud.stdout.length).toBeGreaterThan(0);
      expect(loud.stdout.length).toBeLessThanOrEqual(100);
    });

    // H3
    it("resolves binaries to absolute paths at load and starts the child with a clean PATH", async () => {
      const scoped = ctxFor(
        manifest({ permissions: { spawn: ["node", "definitely-not-installed-xyz"] } }),
      );
      const node = scoped.binaries.get("node");
      expect(node && isAbsolute(node)).toBe(true);
      expect(scoped.binaries.get("definitely-not-installed-xyz")).toBeNull();
      const err = await scoped.base
        .spawn("definitely-not-installed-xyz", [])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpawnError);
      expect(err).toMatchObject({ code: "not_installed" });
    });

    // "#!" scripts and an extension-less name only resolve on POSIX.
    it.skipIf(process.platform === "win32" || !canSymlink())(
      "refuses a binary that lives in the pack folder, the data dir or the home",
      async () => {
        const packDir = join(tmp, "packdir");
        const homeBin = join(tmp, "home", "bin");
        mkdirSync(packDir);
        mkdirSync(homeBin, { recursive: true });
        for (const d of [packDir, homeBin, dir]) {
          writeFileSync(join(d, "packtool"), "#!/bin/sh\necho pwned\n");
          chmodSync(join(d, "packtool"), 0o755);
        }
        // Also through a symlinked PATH entry that points into the pack folder.
        const link = join(tmp, "innocent-bin");
        symlinkSync(packDir, link);
        host.spawnPath = [packDir, homeBin, dir, link, process.env.PATH ?? ""].join(delimiter);
        const scoped = ctxFor(manifest({ permissions: { spawn: ["packtool"] } }), {
          packDir,
          home: join(tmp, "home"),
        });
        expect(scoped.binaries.get("packtool")).toBeNull();
        await expect(scoped.base.spawn("packtool", [])).rejects.toMatchObject({
          code: "not_installed",
        });
      },
    );

    it("strips environment names that change what code runs", async () => {
      const warn = vi.fn();
      host.logger = { ...silent, warn };
      const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
      const out = await base.spawn(
        "node",
        [
          "-e",
          "const e = process.env; process.stdout.write(JSON.stringify({ ok: e.DEMO_VAR, node: e.NODE_OPTIONS ?? null, ld: e.LD_PRELOAD ?? null, dyld: e.DYLD_INSERT_LIBRARIES ?? null, store: e.PLUGHIVE_HOME ?? null, path: e.PATH }))",
        ],
        {
          env: {
            DEMO_VAR: "kept",
            NODE_OPTIONS: "--require /nonexistent/evil.js",
            LD_PRELOAD: "/tmp/evil.so",
            DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
            PLUGHIVE_HOME: "/tmp/elsewhere",
            PATH: "/tmp/evil-bin",
          },
        },
      );
      expect(out.exitCode).toBe(0);
      const env = JSON.parse(out.stdout);
      expect(env).toMatchObject({ ok: "kept", node: null, ld: null, dyld: null, store: null });
      expect(env.path).not.toContain("/tmp/evil-bin");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          dropped: expect.arrayContaining(["NODE_OPTIONS", "LD_PRELOAD", "PATH"]),
        }),
        expect.stringContaining("dropped"),
      );
      for (const n of [
        "PATH",
        "node_options",
        "LD_LIBRARY_PATH",
        "BASH_FUNC_x%%",
        "GIT_SSH_COMMAND",
        // Code, trust and proxy variables a pack must not set.
        "OPENSSL_ENGINES",
        "openssl_engines",
        "GLIBC_TUNABLES",
        "HTTP_PROXY",
        "http_proxy",
        "SSL_CERT_FILE",
        "https_proxy",
        "ALL_PROXY",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "OPENSSL_CONF",
        "home",
        "Home",
        "HOME",
      ]) {
        expect(isStrippedEnvName(n), n).toBe(true);
      }
      // Temp folders stay pack-settable by design (see the child's HOME tests).
      expect(isStrippedEnvName("TMPDIR")).toBe(false);
      expect(isStrippedEnvName("SSH_AUTH_SOCK")).toBe(false);
    });

    // L6: a spawned program gets the pack's own HOME, not the daemon's.
    describe("the child's HOME", () => {
      const PRINT =
        "const e = process.env; process.stdout.write(JSON.stringify({ home: e.HOME, tmp: e.TMPDIR, config: e.XDG_CONFIG_HOME ?? null, cache: e.XDG_CACHE_HOME ?? null, data: e.XDG_DATA_HOME ?? null, state: e.XDG_STATE_HOME ?? null, texvar: e.TEXMFVAR ?? null, os: require('node:os').homedir() }))";
      const envOf = async (m = manifest({ permissions: { spawn: ["node"] } }), env = {}) => {
        const out = await ctxFor(m).base.spawn("node", ["-e", PRINT], { env });
        expect(out.exitCode).toBe(0);
        return JSON.parse(out.stdout) as Record<string, string | null>;
      };

      it("is a private folder under the pack's data dir, with TMPDIR, XDG_* and TEXMFVAR beside it", async () => {
        const env = await envOf();
        const home = join(dir, ".home");
        expect(env).toEqual({
          home,
          tmp: join(dir, ".tmp"),
          config: join(home, ".config"),
          cache: join(home, ".cache"),
          data: join(home, ".local", "share"),
          state: join(home, ".local", "state"),
          texvar: join(home, ".texmf-var"),
          os: home,
        });
        expect(env.home).not.toBe(process.env.HOME);
        for (const d of [
          env.home,
          env.tmp,
          env.config,
          env.cache,
          env.data,
          env.state,
          env.texvar,
        ]) {
          const st = statSync(d as string);
          expect(st.isDirectory(), d as string).toBe(true);
          if (process.platform !== "win32") expect(st.mode & 0o777, d as string).toBe(0o700);
        }
      });

      it("tightens a pre-existing folder to 0700", async () => {
        mkdirSync(join(dir, ".home"), { mode: 0o755 });
        chmodSync(join(dir, ".home"), 0o755);
        await envOf();
        expectMode(join(dir, ".home"), 0o700);
      });

      it("a pack cannot set HOME, but can point TMPDIR and TEXMFVAR elsewhere in its folder", async () => {
        const env = await envOf(undefined, {
          HOME: process.env.HOME ?? "/",
          TMPDIR: join(dir, "work"),
          TEXMFVAR: join(dir, "tex", "var"),
        });
        expect(env.home).toBe(join(dir, ".home"));
        expect(env.tmp).toBe(join(dir, "work"));
        expect(env.texvar).toBe(join(dir, "tex", "var"));
      });

      itSymlink(
        "refuses to start a child when .home was swapped for a link out of the data dir",
        async () => {
          const outside = join(tmp, "real-home");
          mkdirSync(outside);
          symlinkSync(outside, join(dir, ".home"));
          const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
          await expect(base.spawn("node", ["-e", PRINT])).rejects.toThrow();
          expect(existsSync(join(outside, ".config"))).toBe(false);
        },
      );

      itSymlink("refuses a link that stays inside the data dir too", async () => {
        mkdirSync(join(dir, "elsewhere"));
        symlinkSync(join(dir, "elsewhere"), join(dir, ".home"));
        const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
        await expect(base.spawn("node", ["-e", PRINT])).rejects.toMatchObject({
          code: "not_started",
        });
      });

      it("permissions.userHome keeps the user's real HOME and leaves XDG_* to their defaults", async () => {
        const env = await envOf(manifest({ permissions: { spawn: ["node"], userHome: true } }));
        expect(env.home).toBe(process.env.HOME);
        expect(env.tmp).toBe(join(dir, ".tmp"));
        expect(env).toMatchObject({
          config: null,
          cache: null,
          data: null,
          state: null,
          texvar: null,
        });
        expect(existsSync(join(dir, ".home"))).toBe(false);
      });

      it("userHome is off unless the manifest says so, and must be a boolean", () => {
        expect(manifest().permissions.userHome).toBe(false);
        expect(manifest({ permissions: { userHome: true } }).permissions.userHome).toBe(true);
        expect(() => manifest({ permissions: { userHome: "yes" } })).toThrow(ManifestError);
      });

      it("packChildEnv falls back to the pack's HOME when no real one is known", () => {
        expect(packChildEnv("/d", true, "").env.HOME).toBe(join("/d", ".home"));
        expect(packChildEnv("/d", true, "/Users/u").env).toEqual({
          HOME: "/Users/u",
          TMPDIR: join("/d", ".tmp"),
        });
        expect(packChildEnv("/d", false, "/Users/u").env.HOME).toBe(join("/d", ".home"));
      });
    });

    itSymlink("confines cwd to the data dir", async () => {
      const { base } = ctxFor(manifest({ permissions: { spawn: ["node"] } }));
      mkdirSync(join(dir, "work"));
      symlinkSync(tmp, join(dir, "escape"));
      const inside = await base.spawn("node", ["-e", "process.stdout.write(process.cwd())"], {
        cwd: "work",
      });
      expect(realpathSync(inside.stdout)).toBe(join(dir, "work"));
      const dflt = await base.spawn("node", ["-e", "process.stdout.write(process.cwd())"]);
      expect(realpathSync(dflt.stdout)).toBe(dir);
      for (const cwd of ["/", "..", tmp, "escape"]) {
        await expect(base.spawn("node", ["-v"], { cwd }), cwd).rejects.toThrow();
      }
    });

    it("clamps timeout and output limits and rejects nonsense", async () => {
      const calls: unknown[] = [];
      host.spawnImpl = (_b, _a, opts) => {
        calls.push(opts);
        return { stdout: "ok" };
      };
      const { base } = ctxFor(manifest({ permissions: { spawn: ["tool"] } }));
      await base.spawn("tool", [], { timeoutMs: 1e12, maxOutputBytes: 1e15 });
      expect(calls[0]).toMatchObject({
        timeoutMs: MAX_SPAWN_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024 * 1024,
      });
      for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
        await expect(base.spawn("tool", [], { timeoutMs: bad })).rejects.toBeInstanceOf(TypeError);
        await expect(base.spawn("tool", [], { maxOutputBytes: bad })).rejects.toBeInstanceOf(
          TypeError,
        );
      }
      await expect(base.spawn("tool", ["a", 1 as never])).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe("library", () => {
    const bytes = new TextEncoder().encode("hello");

    it("is denied unless declared, and read does not allow writes", async () => {
      host.library = createMemoryLibrary();
      await expect(ctxFor().base.library.list()).rejects.toBeInstanceOf(PackPermissionError);
      const { base } = ctxFor(manifest({ permissions: { library: "read" } }));
      expect(await base.library.list()).toEqual([]);
      await expect(
        base.library.save({ kind: "other", mime: "text/plain", bytes }),
      ).rejects.toBeInstanceOf(PackPermissionError);
    });

    // H7
    it("attributes every artifact to <pack>/<tool>, whatever the pack passes", async () => {
      const lib = createMemoryLibrary();
      host.library = lib;
      const scoped = ctxFor(manifest({ permissions: { library: "write" } }));
      const ctx = scoped.forCall({}, "make_thing");
      const ref = await ctx.library.save({
        kind: "other",
        mime: "text/plain",
        bytes,
        tool: "telegram/send_telegram",
      } as never);
      expect(lib.all()[0]).toMatchObject({ id: ref.id, tool: "demo/make_thing" });
      await scoped.base.library.save({ kind: "other", mime: "text/plain", bytes });
      expect(lib.all()[1]?.tool).toBe("demo/setup");
      // camelCase, and no filesystem path.
      expect(ref).toEqual({
        id: ref.id,
        url: expect.stringContaining(ref.id),
        mime: "text/plain",
        model: null,
        costUsd: null,
        prompt: null,
        bytes: 5,
      });
      expect(JSON.stringify(await ctx.library.get(ref.id))).not.toContain("path");
    });

    it("validates kind, neutralises active mime types and caps the size", async () => {
      const lib = createMemoryLibrary();
      host.library = lib;
      host.maxArtifactBytes = 8;
      const { base } = ctxFor(manifest({ permissions: { library: "write" } }));
      await expect(
        base.library.save({ kind: "script" as never, mime: "text/plain", bytes }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        base.library.save({ kind: "other", mime: "text/plain", bytes: "hello" as never }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        base.library.save({ kind: "other", mime: "text/plain", bytes: new Uint8Array(9) }),
      ).rejects.toBeInstanceOf(RangeError);

      const html = await base.library.save({
        kind: "other",
        mime: "text/html; charset=utf-8",
        bytes,
      });
      expect(html.mime).toBe("text/plain");
      expect(lib.get(html.id)?.meta).toMatchObject({ declaredMime: "text/html" });
      expect(storedMime("image/svg+xml").mime).toBe("text/plain");
      expect(storedMime("application/x-msdownload").mime).toBe("application/octet-stream");
      expect(storedMime("not a mime").mime).toBe("application/octet-stream");
      expect(storedMime("image/png")).toEqual({ mime: "image/png", declared: null });
      expect(storedMime("application/pdf").mime).toBe("application/pdf");
    });

    it("shows a pack only its own artifacts unless it has read-all", async () => {
      const lib = createMemoryLibrary();
      host.library = lib;
      const foreign = lib.seed({ mime: "text/plain", bytes: "theirs", tool: "other/tool" });
      const legacy = lib.seed({ mime: "image/png", bytes: "legacy", tool: "generate_image" });
      const lookalike = lib.seed({ mime: "text/plain", bytes: "x", tool: "demo2/tool" });

      const own = ctxFor(manifest({ permissions: { library: "write" } })).forCall({}, "make");
      const mine = await own.library.save({ kind: "other", mime: "text/plain", bytes });
      expect((await own.library.list()).map((a) => a.id)).toEqual([mine.id]);
      expect((await own.library.list({ tool: "make" })).map((a) => a.id)).toEqual([mine.id]);
      expect(await own.library.list({ tool: "other/tool" })).toEqual([]);
      for (const a of [foreign, legacy, lookalike]) {
        expect(await own.library.get(a.id)).toBeNull();
        await expect(own.library.read(a.id)).rejects.toThrow("artifact not found");
      }
      expect(new TextDecoder().decode(await own.library.read(mine.id))).toBe("hello");

      const all = ctxFor(manifest({ permissions: { library: "read-all" } })).base;
      expect((await all.library.list()).map((a) => a.id).sort()).toEqual(
        [foreign.id, legacy.id, lookalike.id, mine.id].sort(),
      );
      expect(new TextDecoder().decode(await all.library.read(foreign.id))).toBe("theirs");
      expect(await all.library.get(foreign.id)).toMatchObject({
        tool: "other/tool",
        url: expect.stringContaining(foreign.id),
      });
    });

    itSymlink("imports only regular files from the pack's own data dir", async () => {
      const lib = createMemoryLibrary();
      host.library = lib;
      host.maxArtifactBytes = 64;
      const ctx = ctxFor(manifest({ permissions: { library: "write" } })).forCall({}, "render");
      writeFileSync(join(dir, "out.pdf"), "%PDF-fixture");
      const outside = join(tmp, "outside.txt");
      writeFileSync(outside, "outside the data dir");
      symlinkSync(outside, join(dir, "link.txt"));
      writeFileSync(join(dir, "big.bin"), Buffer.alloc(65));

      const ref = await ctx.library.importFile({
        kind: "pdf",
        mime: "application/pdf",
        sourcePath: join(dir, "out.pdf"),
        tool: "spoofed",
      } as never);
      expect(lib.get(ref.id)).toMatchObject({ tool: "demo/render", mime: "application/pdf" });
      const rel = await ctx.library.importFile({
        kind: "pdf",
        mime: "application/pdf",
        sourcePath: "out.pdf",
      });
      expect(rel.bytes).toBe(12);

      for (const sourcePath of [
        outside,
        "../outside.txt",
        "link.txt",
        "/etc/hosts",
        "big.bin",
        ".",
      ]) {
        await expect(
          ctx.library.importFile({ kind: "other", mime: "text/plain", sourcePath }),
          sourcePath,
        ).rejects.toThrow();
      }
      expect(lib.all()).toHaveLength(2);
    });
  });

  describe("llm", () => {
    it("is denied unless declared", async () => {
      host.llm = async () => ({ text: "hi", model: "m", costUsd: null });
      await expect(
        ctxFor().base.llm.chat({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toBeInstanceOf(PackPermissionError);
    });

    // M4
    it("meters and logs nested chats with the calling pack, and passes the call's signal", async () => {
      const records: Record<string, unknown>[] = [];
      const info = vi.fn();
      host.logger = { ...silent, info };
      host.usage = { record: (r) => void records.push(r as unknown as Record<string, unknown>) };
      const seen: (AbortSignal | undefined)[] = [];
      host.llm = async (_req, signal) => {
        seen.push(signal);
        return { text: "hi", model: "test-model", costUsd: 0.25 };
      };
      const scoped = ctxFor(manifest({ permissions: { llm: true } }));
      const abort = new AbortController();
      const ctx = scoped.forCall({ signal: abort.signal }, "summarise");
      expect((await ctx.llm.chat({ messages: [{ role: "user", content: "x" }] })).text).toBe("hi");
      expect(records).toEqual([
        expect.objectContaining({
          tool: "llm.chat",
          status: "ok",
          costUsd: 0.25,
          meta: { caller: "demo", tool: "summarise", model: "test-model" },
        }),
      ]);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ pack: "demo", tool: "summarise", model: "test-model" }),
        "llm.chat",
      );
      expect(seen[0]?.aborted).toBe(false);
      abort.abort();
      expect(seen[0]?.aborted).toBe(true);
      await expect(ctx.llm.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
        "cancelled",
      );
    });

    it("records a failed chat with a redacted error", async () => {
      const records: Record<string, unknown>[] = [];
      host.usage = { record: (r) => void records.push(r as unknown as Record<string, unknown>) };
      host.llm = async () => {
        throw new Error("upstream said fixture-demo-value is wrong");
      };
      const { base } = ctxFor(
        manifest({ secrets: [{ name: "DEMO_KEY" }], permissions: { llm: true } }),
      );
      await base.secrets.get("DEMO_KEY");
      const err = await base.llm
        .chat({ messages: [{ role: "user", content: "x" }] })
        .catch((e: Error) => e);
      expect((err as Error).message).toBe("upstream said [redacted] is wrong");
      expect(records[0]).toMatchObject({ tool: "llm.chat", status: "error" });
      expect(JSON.stringify(records)).not.toContain("fixture-demo-value");
      expect((err as { code?: string }).code).toBeUndefined();
    });

    // L7: the pack can tell a rate limit from a missing provider.
    it("keeps the provider's error code, and only a well-formed one", async () => {
      const failWith = (code: unknown) => {
        host.llm = async () => {
          throw Object.assign(new Error("upstream said fixture-demo-value is wrong"), { code });
        };
      };
      const { base } = ctxFor(
        manifest({ secrets: [{ name: "DEMO_KEY" }], permissions: { llm: true } }),
      );
      await base.secrets.get("DEMO_KEY");
      const fail = () =>
        base.llm
          .chat({ messages: [{ role: "user", content: "x" }] })
          .catch((e: Error & { code?: string }) => e) as Promise<Error & { code?: string }>;

      failWith("RATE_LIMITED");
      const limited = await fail();
      expect(limited.code).toBe("RATE_LIMITED");
      expect(limited.message).toBe("upstream said [redacted] is wrong");

      for (const odd of ["fixture-demo-value", "has space", 42, { a: 1 }, "x".repeat(100)]) {
        failWith(odd);
        expect((await fail()).code, String(odd)).toBeUndefined();
      }
    });
  });

  describe("tools", () => {
    const hostTools = (
      call: (name: string, args: unknown, callCtx: CallContext) => Promise<ToolEnvelope>,
      packId = "other",
      capability?: string,
    ) => ({
      call: vi.fn(call),
      get: () => ({ packId, ...(capability ? { capability } : {}) }),
      resolveCapability: (cap: string) => (cap === "notify" ? "send_note" : undefined),
    });

    it("are denied unless declared", async () => {
      host.tools = hostTools(async () => ({ ok: true, result: 1 }));
      await expect(ctxFor().base.tools.call("list_artifacts", {})).rejects.toBeInstanceOf(
        PackPermissionError,
      );
      expect(host.tools.call).not.toHaveBeenCalled();
    });

    // U2: a manifest that got past validation still cannot take a reserved owner whole.
    it.each(["gateway", "core"])("pack:%s never grants that owner's tools", async (owner) => {
      host.tools = hostTools(async () => ({ ok: true, result: 1 }), owner);
      const m = manifest();
      const forged = {
        ...m,
        permissions: { ...m.permissions, tools: [`pack:${owner}`, "notes__named"] },
      } as typeof m;
      const { base } = ctxFor(forged);
      await expect(base.tools.call("notes__search", {})).rejects.toBeInstanceOf(
        PackPermissionError,
      );
      expect(host.tools.call).not.toHaveBeenCalled();
      // Named one by one, the same tool is reachable.
      expect(await base.tools.call("notes__named", {})).toBe(1);
    });

    // M4: one call path (the registry's), with the caller, the depth and the signal.
    it("go through the host call path with caller, depth and signal", async () => {
      const tools = hostTools(async () => ({ ok: true, result: { echoed: "v" } }));
      host.tools = tools;
      const scoped = ctxFor(manifest({ permissions: { tools: ["pack:other"] } }));
      const abort = new AbortController();
      const ctx = scoped.forCall({ depth: 2, signal: abort.signal }, "outer");
      expect(await ctx.tools.call("some_tool", { a: 1 })).toEqual({ echoed: "v" });
      expect(tools.call).toHaveBeenCalledWith(
        "some_tool",
        { a: 1 },
        expect.objectContaining({ depth: 3, caller: "demo" }),
      );
      const passed = tools.call.mock.calls[0]?.[2].signal;
      abort.abort();
      expect(passed?.aborted).toBe(true);
    });

    it("turn error envelopes back into errors, keeping MISSING_SECRET typed", async () => {
      host.tools = hostTools(async (name) =>
        name === "needs_key"
          ? {
              ok: false,
              error: {
                code: "MISSING_SECRET",
                message: "set it",
                retryable: false,
                pack: "other",
                secret: "OTHER_PACK_KEY",
                label: "Other key",
              },
            }
          : {
              ok: false,
              error: { code: "TOOL_ERROR", message: "boom [redacted]", retryable: false },
            },
      );
      const { base } = ctxFor(manifest({ permissions: { tools: ["pack:other"] } }));
      const missing = await base.tools.call("needs_key", {}).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(MissingSecretError);
      expect(missing).toMatchObject({ pack: "other", name: "OTHER_PACK_KEY", label: "Other key" });
      await expect(base.tools.call("fails", {})).rejects.toMatchObject({
        message: "boom [redacted]",
        code: "TOOL_ERROR",
      });
    });

    it("stops runaway nested tool calls", async () => {
      host.tools = hostTools(async () => ({ ok: true, result: null }), "demo");
      const scoped = ctxFor(manifest({ permissions: { tools: ["loop_tool"] } }));
      const deep = scoped.forCall({ depth: 8 }, "loop_tool");
      await expect(deep.tools.call("loop_tool", {})).rejects.toThrow("nesting deeper than 8");
      expect(host.tools.call).not.toHaveBeenCalled();
    });

    // M8
    it("honours cap:<name> grants, by capability reference and by tool name", async () => {
      const tools = hostTools(async () => ({ ok: true, result: "sent" }), "other", "notify");
      host.tools = tools;
      const { base } = ctxFor(manifest({ permissions: { tools: ["cap:notify"] } }));
      // By capability: whichever tool provides it right now.
      expect(await base.tools.call("cap:notify", { text: "x" })).toBe("sent");
      expect(tools.call.mock.calls[0]?.[0]).toBe("send_note");
      // By name: allowed because that tool provides the granted capability.
      expect(await base.tools.call("send_note", {})).toBe("sent");
      // A capability that was not declared, or that nothing provides.
      await expect(base.tools.call("cap:pay", {})).rejects.toBeInstanceOf(PackPermissionError);
      const none = ctxFor(manifest({ permissions: { tools: ["cap:missing"] } })).base;
      await expect(none.tools.call("cap:missing", {})).rejects.toThrow("no tool provides");
    });
  });

  // M6
  it("logs under the pack's own identity and redacts served secrets", async () => {
    const lines: Array<[Record<string, unknown>, string]> = [];
    host.logger = { ...silent, info: (obj, msg) => lines.push([obj, msg]) };
    const { base } = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
    const value = await base.secrets.get("DEMO_KEY");
    base.logger.info(`using ${value}`, { token: value, pack: "legacy" });
    expect(JSON.stringify(lines)).not.toContain("fixture-demo-value");
    expect(lines[0]?.[0]).toMatchObject({ pack: "demo", token: "[redacted]" });
  });

  it("always has a signal, and forwards clamped, redacted progress", async () => {
    const scoped = ctxFor(manifest({ secrets: [{ name: "DEMO_KEY" }] }));
    expect(scoped.base.signal).toBeInstanceOf(AbortSignal);
    expect(() => scoped.base.progress(0.5, "no listener")).not.toThrow();
    await scoped.base.secrets.get("DEMO_KEY");
    const progress = vi.fn();
    const abort = new AbortController();
    const ctx = scoped.forCall({ progress, signal: abort.signal }, "work");
    ctx.progress(0.25, "token fixture-demo-value");
    ctx.progress(7);
    ctx.progress(Number.NaN);
    expect(progress.mock.calls).toEqual([
      [0.25, "token [redacted]"],
      [1, undefined],
      [0, undefined],
    ]);
    abort.abort();
    expect(ctx.signal.aborted).toBe(true);
    expect(scoped.base.signal.aborted).toBe(false);
  });

  // M3
  it("makes every capability throw after dispose and never rebuilds the fetch agent", async () => {
    host.library = createMemoryLibrary();
    host.llm = async () => ({ text: "hi", model: "m", costUsd: null });
    host.tools = { call: async () => ({ ok: true, result: 1 }), get: () => ({ packId: "other" }) };
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    host.fetchPolicy = { lookup };
    const scoped = ctxFor(
      manifest({
        secrets: [{ name: "DEMO_KEY" }],
        permissions: {
          network: ["api.example.com"],
          spawn: ["node"],
          library: "full",
          llm: true,
          tools: ["pack:other"],
        },
      }),
    );
    const call = scoped.forCall({}, "tool");
    await scoped.dispose();
    await scoped.dispose();
    expect(scoped.base.signal.aborted).toBe(true);
    for (const ctx of [scoped.base, call, scoped.forCall({}, "later")]) {
      await expect(ctx.secrets.get("DEMO_KEY")).rejects.toBeInstanceOf(PackDisposedError);
      await expect(ctx.secrets.has("DEMO_KEY")).rejects.toBeInstanceOf(PackDisposedError);
      await expect(ctx.fetch("https://api.example.com/")).rejects.toBeInstanceOf(PackDisposedError);
      await expect(ctx.spawn("node", ["-v"])).rejects.toBeInstanceOf(PackDisposedError);
      await expect(ctx.library.list()).rejects.toBeInstanceOf(PackDisposedError);
      await expect(
        ctx.library.save({ kind: "other", mime: "text/plain", bytes: new Uint8Array(1) }),
      ).rejects.toBeInstanceOf(PackDisposedError);
      await expect(
        ctx.llm.chat({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toBeInstanceOf(PackDisposedError);
      await expect(ctx.tools.call("some_tool", {})).rejects.toBeInstanceOf(PackDisposedError);
      expect(() => ctx.logger.info("late")).toThrow(PackDisposedError);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
