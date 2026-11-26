import { describe, expect, it, vi } from "vitest";
import { gateConnection, hostKey, installGuards, makeGate } from "../../../packs/web/screenshot.js";
import { checkUrl, classifyAddress } from "../../../packs/web/ssrf.js";

const kind = (a: string) => classifyAddress(a).kind;

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["2606:4700:4700::1111", "public"],
    ["127.0.0.1", "local"],
    ["10.1.2.3", "local"],
    ["172.16.0.1", "local"],
    ["172.31.255.255", "local"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "local"],
    ["100.64.0.1", "local"],
    ["0.0.0.0", "local"],
    ["::1", "local"],
    ["::", "local"],
    ["fc00::1", "local"],
    ["fd12:3456::1", "local"],
    ["169.254.169.254", "never"],
    ["169.254.1.1", "never"],
    ["100.100.100.200", "never"],
    ["fd00:ec2::254", "never"],
    ["fe80::1", "never"],
    ["224.0.0.1", "never"],
    ["255.255.255.255", "never"],
    ["ff02::1", "never"],
    ["192.0.2.1", "never"],
    ["192.88.99.1", "never"],
    ["2001::5efe:7f00:1", "never"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "never"],
    ["2001:2::1", "never"],
    ["2001:db8::1", "never"],
    ["3fff::1", "never"],
    ["64:ff9b:1::a00:1", "never"],
    ["100::1", "never"],
    ["2001:4860:4860::8888", "public"],
  ])("%s is %s", (addr, expected) => {
    expect(kind(addr)).toBe(expected);
  });

  it("classifies embedded IPv4 addresses", () => {
    expect(kind("::ffff:127.0.0.1")).toBe("local");
    expect(kind("::ffff:7f00:1")).toBe("local");
    expect(kind("::ffff:169.254.169.254")).toBe("never");
    expect(kind("::ffff:8.8.8.8")).toBe("public");
    expect(kind("64:ff9b::a9fe:a9fe")).toBe("never");
  });

  it("refuses the IPv6 forms the daemon's own check refuses (only 2000::/3 is public)", () => {
    // 6to4 and IPv4-compatible forms reach an IPv4 address through a relay or not at all.
    expect(kind("2002:7f00:0001::")).toBe("never");
    expect(kind("2002:0808:0808::1")).toBe("never");
    expect(kind("::127.0.0.1")).toBe("never");
    expect(kind("::8.8.8.8")).toBe("never");
    expect(kind("::ffff:0:808:808")).toBe("never");
    expect(kind("fec0::1")).toBe("never");
    expect(kind("4000::1")).toBe("never");
    expect(kind("e000::1")).toBe("never");
    // A zone index names an interface, not a destination.
    expect(kind("fe80::1%en0")).toBe("never");
    expect(kind("2001:4860:4860::8888%en0")).toBe("never");
    expect(kind("[2606:4700:4700::1111]")).toBe("public");
  });

  it("treats garbage as never", () => {
    expect(kind("not-an-ip")).toBe("never");
    expect(kind("")).toBe("never");
  });
});

describe("checkUrl", () => {
  const strict = { allowLocal: false };
  const open = { allowLocal: true };

  it("allows public http and https", async () => {
    expect(await checkUrl("https://8.8.8.8/", strict)).toEqual({
      ok: true,
      addresses: ["8.8.8.8"],
      local: false,
      port: 443,
    });
    expect(
      await checkUrl("http://example.com/", { ...strict, resolve: async () => ["93.184.216.34"] }),
    ).toMatchObject({ ok: true, local: false, port: 80 });
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "chrome://version"])(
    "blocks scheme in %s",
    async (u) => {
      const v = await checkUrl(u, open);
      expect(v.ok).toBe(false);
    },
  );

  it("blocks data: and blob: at the top level only", async () => {
    expect((await checkUrl("data:text/html,hi", open, { topLevel: true })).ok).toBe(false);
    expect((await checkUrl("data:image/png;base64,AAAA", strict)).ok).toBe(true);
    expect((await checkUrl("blob:https://a.com/uuid", strict)).ok).toBe(true);
  });

  it("blocks loopback and private literals by default, allows them with the setting", async () => {
    for (const u of [
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://10.0.0.5/",
      "http://192.168.0.1/",
    ]) {
      expect((await checkUrl(u, strict)).ok).toBe(false);
      expect((await checkUrl(u, open)).ok).toBe(true);
    }
  });

  it("canonicalises obfuscated IPv4 forms", async () => {
    for (const u of [
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
    ]) {
      expect((await checkUrl(u, strict)).ok).toBe(false);
    }
  });

  it("always blocks metadata and link-local, even with allowLocal", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00:ec2::254]/",
      "http://100.100.100.200/",
      "http://[::ffff:169.254.169.254]/",
      "http://[fe80::1]/",
    ]) {
      const v = await checkUrl(u, open);
      expect(v.ok).toBe(false);
    }
  });

  it("resolves hostnames and checks every address", async () => {
    const resolve = vi.fn(async () => ["93.184.216.34", "10.0.0.1"]);
    const v = await checkUrl("https://mixed.example/", { allowLocal: false, resolve });
    expect(v.ok).toBe(false);
    expect(resolve).toHaveBeenCalledWith("mixed.example");
    expect((await checkUrl("https://mixed.example/", { allowLocal: true, resolve })).ok).toBe(true);
  });

  it("blocks a name that resolves to metadata even with allowLocal", async () => {
    const v = await checkUrl("https://evil.example/", {
      allowLocal: true,
      resolve: async () => ["169.254.169.254"],
    });
    expect(v.ok).toBe(false);
  });

  it("denies unresolvable hosts and invalid urls", async () => {
    const fail = async () => {
      throw new Error("ENOTFOUND");
    };
    expect((await checkUrl("https://nope.invalid/", { allowLocal: false, resolve: fail })).ok).toBe(
      false,
    );
    expect(
      (await checkUrl("https://nope.invalid/", { allowLocal: false, resolve: async () => [] })).ok,
    ).toBe(false);
    expect((await checkUrl("not a url", strict)).ok).toBe(false);
  });
});

describe("installGuards", () => {
  function fakeContext(pages?: () => { frames(): unknown[] }[]) {
    let routeHandler: ((r: unknown) => Promise<void>) | undefined;
    let wsHandler: ((w: unknown) => Promise<void> | void) | undefined;
    return {
      ctx: {
        ...(pages ? { pages } : {}),
        route: async (_p: unknown, h: (r: never) => Promise<void>) => {
          routeHandler = h as never;
        },
        routeWebSocket: async (_p: unknown, h: (w: never) => Promise<void> | void) => {
          wsHandler = h as never;
        },
      },
      request: async (url: string, from?: { navigation?: boolean; frame?: unknown }) => {
        const route = {
          request: () => ({
            url: () => url,
            isNavigationRequest: () => from?.navigation === true,
            ...(from?.frame ? { frame: () => from.frame } : {}),
          }),
          abort: vi.fn(async () => {}),
          continue: vi.fn(async () => {}),
        };
        await routeHandler?.(route);
        return route;
      },
      socket: async (url: string) => {
        const ws = { url: () => url, close: vi.fn(async () => {}), connectToServer: vi.fn() };
        await wsHandler?.(ws);
        return ws;
      },
    };
  }

  it("continues allowed requests and aborts blocked ones, recording them", async () => {
    const h = fakeContext();
    const blocked = await installGuards(
      h.ctx as never,
      makeGate({ allowLocal: false, resolve: async () => ["93.184.216.34"] }, false),
    );
    const ok = await h.request("https://example.com/a.js");
    expect(ok.continue).toHaveBeenCalled();
    expect(ok.abort).not.toHaveBeenCalled();

    const bad = await h.request("http://169.254.169.254/latest/meta-data/");
    expect(bad.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(bad.continue).not.toHaveBeenCalled();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.url).toBe("http://169.254.169.254/latest/meta-data/");
  });

  it("re-checks redirect hops (each is a new request through the same guard)", async () => {
    const h = fakeContext();
    const blocked = await installGuards(
      h.ctx as never,
      makeGate(
        {
          allowLocal: false,
          resolve: async (host) =>
            host === "redirector.example" ? ["93.184.216.34"] : ["127.0.0.1"],
        },
        false,
      ),
    );
    expect((await h.request("https://redirector.example/")).continue).toHaveBeenCalled();
    expect((await h.request("http://internal.example/admin")).abort).toHaveBeenCalled();
    expect(blocked).toHaveLength(1);
  });

  it("guards websockets with the same policy", async () => {
    const h = fakeContext();
    const blocked = await installGuards(h.ctx as never, makeGate({ allowLocal: false }, false));
    const bad = await h.socket("ws://127.0.0.1:9000/");
    expect(bad.close).toHaveBeenCalledWith({ code: 1008, reason: "blocked" });
    expect(bad.connectToServer).not.toHaveBeenCalled();
    const good = await h.socket("wss://8.8.8.8/");
    expect(good.connectToServer).toHaveBeenCalled();
    expect(blocked).toHaveLength(1);
  });

  // M2 -----------------------------------------------------------------------

  const frame = (url: string, parent: unknown = null) => ({
    url: () => url,
    parentFrame: () => parent,
  });
  const names: Record<string, string> = {
    "public.example": "93.184.216.34",
    "app.local.example": "127.0.0.1",
    "other.local.example": "10.0.0.7",
  };
  const resolve = async (host: string) => [names[host] ?? "93.184.216.34"];

  it("refuses to run without WebSocket interception instead of leaving sockets unguarded", async () => {
    const h = fakeContext();
    const ctx = { route: h.ctx.route };
    await expect(
      installGuards(ctx as never, makeGate({ allowLocal: false }, false)),
    ).rejects.toThrow(/routeWebSocket/);
  });

  it("with allowLocalUrls, a public page still cannot reach a local address", async () => {
    const h = fakeContext();
    const gate = makeGate({ allowLocal: true, resolve }, false);
    await installGuards(h.ctx as never, gate);
    const main = frame("about:blank");
    const top = await h.request("https://public.example/", { navigation: true, frame: main });
    expect(top.continue).toHaveBeenCalled();

    const doc = frame("https://public.example/");
    for (const url of ["http://127.0.0.1:3000/x.png", "http://other.local.example/admin"]) {
      const sub = await h.request(url, { frame: doc });
      expect(sub.abort).toHaveBeenCalledWith("blockedbyclient");
    }
    // A redirect or script navigation of the main frame to a local address.
    expect(
      (await h.request("http://127.0.0.1:3000/", { navigation: true, frame: doc })).abort,
    ).toHaveBeenCalled();
    // An iframe pointed at a local address.
    expect(
      (
        await h.request("http://app.local.example/", {
          navigation: true,
          frame: frame("about:blank", doc),
        })
      ).abort,
    ).toHaveBeenCalled();
    expect((await h.socket("ws://127.0.0.1:9000/")).close).toHaveBeenCalled();
    expect(gate.blocked).toHaveLength(5);
    expect(gate.blocked[0]?.reason).toMatch(/only from a local page/);
  });

  it("with allowLocalUrls, a typed local page loads local resources, but a public frame inside it does not", async () => {
    const h = fakeContext();
    const gate = makeGate({ allowLocal: true, resolve }, true);
    await installGuards(h.ctx as never, gate);
    const main = frame("about:blank");
    expect(
      (await h.request("http://app.local.example/", { navigation: true, frame: main })).continue,
    ).toHaveBeenCalled();
    const doc = frame("http://app.local.example/");
    expect(
      (await h.request("http://127.0.0.1:5173/app.js", { frame: doc })).continue,
    ).toHaveBeenCalled();
    expect((await h.socket("ws://127.0.0.1:5173/hmr")).connectToServer).toHaveBeenCalled();

    const ad = frame("https://public.example/ad", doc);
    expect(
      (await h.request("http://127.0.0.1:5173/secret", { frame: ad })).abort,
    ).toHaveBeenCalled();
    // srcdoc / about:blank children inherit from their parent.
    const blank = frame("about:srcdoc", ad);
    expect(
      (await h.request("http://127.0.0.1:5173/secret", { frame: blank })).abort,
    ).toHaveBeenCalled();
    const blankLocal = frame("about:srcdoc", doc);
    expect(
      (await h.request("http://127.0.0.1:5173/ok", { frame: blankLocal })).continue,
    ).toHaveBeenCalled();

    // Once the main frame leaves for a public page, local is gone for good.
    await h.request("https://public.example/", { navigation: true, frame: doc });
    expect(gate.localTop).toBe(false);
    expect(
      (await h.request("http://127.0.0.1:5173/app.js", { frame: doc })).abort,
    ).toHaveBeenCalled();
    expect((await gateConnection(gate, "http://127.0.0.1:5173/")).ok).toBe(false);
  });

  it("with allowLocalUrls, once a public frame has loaded, sockets and workers lose the local allowance", async () => {
    const h = fakeContext();
    const gate = makeGate({ allowLocal: true, resolve }, true);
    await installGuards(h.ctx as never, gate);
    const main = frame("about:blank");
    await h.request("http://app.local.example/", { navigation: true, frame: main });
    const doc = frame("http://app.local.example/");
    // A worker of the local page, before anything public has loaded.
    expect((await h.request("http://127.0.0.1:5173/w.js")).continue).toHaveBeenCalled();

    // The local page embeds a public frame; that frame's script could open a
    // socket or start a worker, and neither can be traced back to it.
    const iframe = await h.request("https://public.example/ad", {
      navigation: true,
      frame: frame("about:blank", doc),
    });
    expect(iframe.continue).toHaveBeenCalled();
    expect(gate.publicFrame).toBe(true);
    expect(gate.localTop).toBe(true);
    expect((await h.socket("ws://127.0.0.1:5173/hmr")).close).toHaveBeenCalled();
    expect((await h.request("http://127.0.0.1:5173/w2.js")).abort).toHaveBeenCalled();
    expect((await h.socket("wss://8.8.8.8/")).connectToServer).toHaveBeenCalled();
    // The local page's own requests still load.
    expect(
      (await h.request("http://127.0.0.1:5173/app.js", { frame: doc })).continue,
    ).toHaveBeenCalled();
  });

  it("with allowLocalUrls, a local frame that redirected to a public page also ends the allowance", async () => {
    // The route handler saw only the first hop (local); the frame committed a public URL.
    const committed: unknown[] = [];
    const h = fakeContext(() => [{ frames: () => committed }]);
    const gate = makeGate({ allowLocal: true, resolve }, true);
    await installGuards(h.ctx as never, gate);
    const main = frame("about:blank");
    await h.request("http://app.local.example/", { navigation: true, frame: main });
    const doc = frame("http://app.local.example/");
    committed.push(doc);
    expect((await h.socket("ws://127.0.0.1:5173/hmr")).connectToServer).toHaveBeenCalled();

    const iframe = await h.request("http://127.0.0.1:5173/redirect", {
      navigation: true,
      frame: frame("about:blank", doc),
    });
    expect(iframe.continue).toHaveBeenCalled();
    expect(gate.publicFrame).toBe(false);
    committed.push(frame("https://public.example/landed", doc));
    expect((await h.socket("ws://127.0.0.1:5173/hmr")).close).toHaveBeenCalled();
    expect(gate.publicFrame).toBe(true);
    expect(gate.localTop).toBe(true);
    expect((await h.request("http://127.0.0.1:5173/w.js")).abort).toHaveBeenCalled();
    // A main frame that landed on a public page ends local for good.
    committed.push(frame("https://public.example/top"));
    gate.publicFrame = false;
    await h.request("http://127.0.0.1:5173/w2.js");
    expect(gate.localTop).toBe(false);
  });

  it("with allowLocalUrls, the proxy reaches only the local hosts the page requested (no redirect pivot)", async () => {
    // A public resource inside a local page answers 302 to a LAN host. The
    // browser follows the redirect without the route handler seeing it, so
    // only the proxy can refuse it.
    const h = fakeContext();
    const gate = makeGate({ allowLocal: true, resolve }, true);
    await installGuards(h.ctx as never, gate);
    await h.request("http://app.local.example/", { navigation: true, frame: frame("about:blank") });
    const doc = frame("http://app.local.example/");
    expect(
      (await h.request("http://127.0.0.1:5173/app.js", { frame: doc })).continue,
    ).toHaveBeenCalled();
    expect(
      (await h.request("https://public.example/pixel", { frame: doc })).continue,
    ).toHaveBeenCalled();
    expect(gate.localTop).toBe(true);

    expect((await gateConnection(gate, "http://app.local.example/")).ok).toBe(true);
    expect((await gateConnection(gate, "http://127.0.0.1:5173/app.js")).ok).toBe(true);
    const pivot = await gateConnection(gate, "http://127.0.0.1:8080/admin");
    expect(pivot).toMatchObject({ ok: false, reason: expect.stringMatching(/redirect/) });
    expect(gate.blocked.at(-1)?.url).toBe("http://127.0.0.1:8080/admin");
    // Public hosts still connect.
    expect((await gateConnection(gate, "https://public.example/")).ok).toBe(true);
  });

  it("an origin let through as local that the proxy connects to a public address stops being local", async () => {
    let answer = ["127.0.0.1"];
    const gate = makeGate({ allowLocal: true, resolve: async () => answer }, true);
    gate.localOrigins.add("rebind.example:80");
    expect((await gateConnection(gate, "http://rebind.example/")).ok).toBe(true);
    expect(gate.localOrigins.has("rebind.example:80")).toBe(true);
    answer = ["93.184.216.34"];
    expect((await gateConnection(gate, "http://rebind.example/x")).ok).toBe(true);
    expect(gate.localOrigins.size).toBe(0);
    expect(gate.publicFrame).toBe(true);
    expect(gate.localTop).toBe(false);
    // Nothing local after that, even from the first answer again.
    answer = ["127.0.0.1"];
    expect((await gateConnection(gate, "http://rebind.example/y")).ok).toBe(false);
  });

  it("an https page and the proxy's CONNECT target share one key", async () => {
    let answer = ["127.0.0.1"];
    const gate = makeGate({ allowLocal: true, resolve: async () => answer }, true);
    // The route handler saw https://secure.example/; the proxy sees CONNECT secure.example:443.
    expect(hostKey("https://secure.example/")).toBe("secure.example:443");
    expect(hostKey("http://secure.example:443/")).toBe("secure.example:443");
    gate.localOrigins.add(hostKey("https://secure.example/") as string);
    answer = ["93.184.216.34"];
    expect((await gateConnection(gate, "http://secure.example:443/")).ok).toBe(true);
    expect(gate.localTop).toBe(false);
    expect(gate.publicFrame).toBe(true);
  });

  it("classifies committed frames by the origins let through as local, never by a fresh lookup", async () => {
    let onPage: ((p: unknown) => void) | undefined;
    let onNav: ((f: unknown) => void) | undefined;
    const h = fakeContext(() => []);
    (h.ctx as Record<string, unknown>).on = (_e: string, cb: (p: unknown) => void) => {
      onPage = cb;
    };
    const gate = makeGate({ allowLocal: true, resolve }, true);
    await installGuards(h.ctx as never, gate);
    onPage?.({ frames: () => [], on: (_e: string, cb: (f: unknown) => void) => (onNav = cb) });
    await h.request("http://app.local.example/", { navigation: true, frame: frame("about:blank") });
    const doc = frame("http://app.local.example/");
    onNav?.(doc);
    onNav?.(frame("about:srcdoc", doc));
    expect(gate.publicFrame).toBe(false);
    // Same name, but it was never let through as a navigation: public (a
    // rebinding answer cannot make it local afterwards).
    onNav?.(frame("http://other.local.example/", doc));
    expect(gate.publicFrame).toBe(true);
    expect(gate.localTop).toBe(true);

    for (const url of ["data:text/html,hi", "blob:https://public.example/1", "filesystem:x"]) {
      const g = makeGate({ allowLocal: true, resolve }, true);
      const h2 = fakeContext(() => [{ frames: () => [frame(url, doc)] }]);
      await installGuards(h2.ctx as never, g);
      g.localOrigins.add("app.local.example:80");
      expect((await h2.socket("ws://127.0.0.1:5173/")).close, url).toHaveBeenCalled();
    }
    // blob: of a local origin stays local.
    const g = makeGate({ allowLocal: true, resolve }, true);
    g.localOrigins.add("app.local.example:80");
    const h3 = fakeContext(() => [
      { frames: () => [frame("blob:http://app.local.example/9", doc)] },
    ]);
    await installGuards(h3.ctx as never, g);
    expect((await h3.socket("ws://127.0.0.1:5173/")).connectToServer).toHaveBeenCalled();
  });

  it("refuses the daemon's own port on every local address, whatever the setting", async () => {
    for (const allowLocal of [false, true]) {
      const policy = { allowLocal, resolve, daemonPorts: [7777, 7794] };
      for (const url of [
        "http://127.0.0.1:7777/api/secrets",
        "http://localhost:7794/",
        "http://[::1]:7777/",
        "http://0.0.0.0:7777/",
        "http://other.local.example:7777/mcp",
      ]) {
        const v = await checkUrl(url, {
          ...policy,
          resolve: async (h) => (h === "localhost" ? ["127.0.0.1"] : resolve(h)),
        });
        expect(v, url).toMatchObject({ ok: false });
        if (allowLocal) expect((v as { reason: string }).reason).toMatch(/daemon itself/);
      }
    }
    // The same port on a public host is someone else's service.
    expect(
      (
        await checkUrl("http://public.example:7777/", {
          allowLocal: false,
          resolve,
          daemonPorts: [7777],
        })
      ).ok,
    ).toBe(true);
    // And the proxy gives the same answer for a typed local page.
    const gate = makeGate({ allowLocal: true, resolve, daemonPorts: [7777] }, true);
    gate.localTargets.add("127.0.0.1:7777");
    gate.localTargets.add("127.0.0.1:3000");
    expect(await gateConnection(gate, "http://127.0.0.1:7777/")).toMatchObject({ ok: false });
    expect(await gateConnection(gate, "http://127.0.0.1:3000/")).toEqual({
      ok: true,
      address: "127.0.0.1",
    });
  });
});
