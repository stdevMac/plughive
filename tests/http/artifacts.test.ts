import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
// tests/http/artifacts.test.ts
//
// GET /artifacts/:id. Artifacts are untrusted content served from the daemon's
// own origin: nothing a browser could run is ever shown inline (H1), and with
// an access key configured the route needs it or a signed link (H2).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_CSP,
  artifactDelivery,
  contentDisposition,
  createArtifactSigner,
  mountArtifacts,
  signArtifactLinks,
} from "../../src/http/artifacts.js";
import { Library } from "../../src/lib/library.js";
import { type LiteHarness, bootLite, mockTool, modernClient, toolJson } from "./harness.js";

const HTML = "<!doctype html><script>document.title='pwned'</script>";

describe("artifacts route", () => {
  let dir: string;
  let lib: Library;
  let server: Server;
  let baseUrl: string;
  const warnings: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    warnings.length = 0;
    dir = mkdtempSync(join(tmpdir(), "ar-"));
    lib = new Library({ root: dir, baseUrl: "http://127.0.0.1:0" });
    const app = express();
    mountArtifacts(app, lib, { logger: { warn: (obj) => void warnings.push(obj) } });
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => r());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const save = (mime: string, body: string, kind: "image" | "video" | "audio" = "image") =>
    lib.save({ kind, mime, bytes: Buffer.from(body), tool: "t" });

  it("the route no longer serves a second /health", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(404);
  });

  it("H1: an allow-listed type is shown inline, with nosniff and a sandbox policy", async () => {
    const ref = save("image/png", "abc");
    const r = await fetch(`${baseUrl}/artifacts/${ref.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toBe(
      `inline; filename="image-${ref.id}.png"; filename*=UTF-8''image-${ref.id}.png`,
    );
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toBe("sandbox; default-src 'none'");
    expect(await r.text()).toBe("abc");
  });

  it.each([
    ["text/html", "html"],
    ["text/html; charset=utf-8", "html"],
    ["image/svg+xml", "svg"],
    ["application/xhtml+xml", "bin"],
    ["text/xml", "bin"],
    ["application/javascript", "bin"],
    ["text/javascript", "bin"],
  ])("H1: %s is a download of opaque bytes, never a page of this origin", async (mime, ext) => {
    const ref = save(mime, HTML);
    const r = await fetch(`${baseUrl}/artifacts/${ref.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="image-${ref.id}.${ext}"; filename*=UTF-8''image-${ref.id}.${ext}`,
    );
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(await r.text()).toBe(HTML);
  });

  it("H1: the delivery policy is an allow-list, and never trusts the stored type or id", () => {
    for (const mime of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/flac",
      "audio/mp4",
      "application/pdf",
    ]) {
      expect(artifactDelivery("a1", mime)).toMatchObject({
        contentType: mime,
        disposition: "inline",
      });
    }
    expect(artifactDelivery("a1", "text/plain")).toEqual({
      contentType: "text/plain",
      disposition: "attachment",
      filename: "a1.txt",
    });
    expect(artifactDelivery("a1", "application/json").disposition).toBe("attachment");
    // A stored type that is not a media type at all, and an id that could break the header.
    expect(artifactDelivery('x"\r\nSet-Cookie: a=b', "text/html\r\nX-Evil: 1")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
      filename: "artifact.bin",
    });
    expect(artifactDelivery("a1", "IMAGE/SVG+XML").contentType).toBe("application/octet-stream");
    // The name is <kind>-<id>.<ext>; a kind that is not a plain word is left out.
    expect(artifactDelivery("a1", "audio/opus", "audio").filename).toBe("audio-a1.opus");
    expect(artifactDelivery("a1", "text/vtt", "document").filename).toBe("document-a1.vtt");
    expect(artifactDelivery("a1", "image/png", 'x"; y').filename).toBe("a1.png");
    expect(artifactDelivery("a1", "application/x-unknown", "data").filename).toBe("data-a1.bin");
    expect(artifactDelivery("a1", "constructor").filename).toBe("a1.bin");
  });

  it("download=1 asks for a save, with an RFC 5987 name, and keeps the safety headers", async () => {
    const ref = save("image/png", "abc");
    const r = await fetch(`${baseUrl}/artifacts/${ref.id}?download=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="image-${ref.id}.png"; filename*=UTF-8''image-${ref.id}.png`,
    );
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    // Only exactly "1" switches; anything else keeps the normal policy.
    for (const q of ["download=0", "download=true", "download=1&download=1", "download[]=1"]) {
      const other = await fetch(`${baseUrl}/artifacts/${ref.id}?${q}`);
      expect(other.headers.get("content-disposition")?.startsWith("inline;")).toBe(true);
    }
    // Active content stays opaque bytes when downloaded.
    const page = save("text/html", HTML);
    const d = await fetch(`${baseUrl}/artifacts/${page.id}?download=1`);
    expect(d.headers.get("content-type")).toBe("application/octet-stream");
    expect(d.headers.get("content-disposition")?.startsWith("attachment;")).toBe(true);
  });

  it("contentDisposition cannot inject a header or parameter and encodes per RFC 5987", () => {
    expect(contentDisposition("attachment", "image-a1.png")).toBe(
      `attachment; filename="image-a1.png"; filename*=UTF-8''image-a1.png`,
    );
    const NUL = String.fromCharCode(0);
    const LS = String.fromCharCode(0x2028);
    const evil = contentDisposition(
      "attachment",
      `a"b\\c\r\nSet-Cookie: x=1;%2F/..${NUL}${LS}.png`,
    );
    for (const bad of ["\r", "\n", NUL, LS]) expect(evil.includes(bad)).toBe(false);
    expect(evil).toBe(
      `attachment; filename="abcSet-Cookie: x=12F...png"; filename*=UTF-8''abcSet-Cookie%3A%20x%3D12F...png`,
    );
    // Non-ASCII: an ASCII fallback plus the exact UTF-8 name; RFC 5987 attr-chars only.
    const intl = contentDisposition("inline", "café (1)'*.png");
    expect(intl).toBe(
      `inline; filename="caf_ (1)'*.png"; filename*=UTF-8''caf%C3%A9%20%281%29%27%2A.png`,
    );
    const star = intl.split("filename*=UTF-8''")[1] ?? "";
    expect(star).toMatch(/^[A-Za-z0-9!#$&+.^_`|~%-]+$/);
    // Nothing usable left: a safe default; overlong names are capped.
    expect(contentDisposition("attachment", "\r\n/")).toBe(
      `attachment; filename="artifact"; filename*=UTF-8''artifact`,
    );
    expect(contentDisposition("attachment", "..")).toContain('filename="artifact"');
    expect(contentDisposition("attachment", "x".repeat(1000)).length).toBeLessThan(450);
  });

  it("H1: serves byte ranges", async () => {
    const ref = save("video/mp4", "0123456789", "video");
    const r = await fetch(`${baseUrl}/artifacts/${ref.id}`, { headers: { range: "bytes=2-5" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(await r.text()).toBe("2345");
    const bad = await fetch(`${baseUrl}/artifacts/${ref.id}`, {
      headers: { range: "bytes=50-60" },
    });
    expect(bad.status).toBe(416);
  });

  it("H1: a row whose file is gone is a JSON 404, the daemon keeps serving, and no path leaks", async () => {
    const gone = save("image/png", "abc");
    const kept = save("image/png", "still here");
    const path = lib.get(gone.id)!.path;
    unlinkSync(path);
    const r = await fetch(`${baseUrl}/artifacts/${gone.id}`);
    expect(r.status).toBe(404);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "artifact not found" },
    });
    expect(text).not.toContain(dir);
    expect(warnings).toEqual([{ artifact: gone.id }]);
    // Same server, next request.
    expect(await (await fetch(`${baseUrl}/artifacts/${kept.id}`)).text()).toBe("still here");
  });

  it("returns 404 for unknown and malformed ids", async () => {
    expect((await fetch(`${baseUrl}/artifacts/img_nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/artifacts/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });
});

describe("H2: artifacts behind an access key", () => {
  const KEY = "test-access-key-0123456789";
  let h: LiteHarness;
  let dir: string;
  let lib: Library;
  let id: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ar-key-"));
    lib = new Library({ root: dir, baseUrl: "http://127.0.0.1:0" });
    id = lib.save({
      kind: "image",
      mime: "image/png",
      bytes: Buffer.from("secret picture"),
      tool: "t",
    }).id;
    const art = lib.get(id)!;
    h = await bootLite({
      accessKey: KEY,
      artifacts: { [id]: { id, path: art.path, mime: art.mime, bytes: art.bytes } },
      artifactsRoot: dir,
      packs: {
        demo: [
          mockTool("make_picture", async () => ({
            url: `http://127.0.0.1:${h.port}/artifacts/${id}`,
            nested: [{ url: `http://127.0.0.1:${h.port}/artifacts/${id}` }],
            elsewhere: `https://example.com/artifacts/${id}`,
          })),
        ],
      },
    });
  });
  afterEach(async () => {
    await h.close();
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("needs the key or a signed link", async () => {
    const anonymous = await fetch(`${h.base}/artifacts/${id}`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain("secret picture");
    // An unknown id is not distinguishable from a known one without the key.
    expect((await fetch(`${h.base}/artifacts/img_nope`)).status).toBe(401);

    const keyed = await fetch(`${h.base}/artifacts/${id}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(keyed.status).toBe(200);
    expect(await keyed.text()).toBe("secret picture");

    const signed = h.signArtifact(id);
    expect(signed).toMatch(
      new RegExp(`^${h.base}/artifacts/${id}\\?exp=\\d+&sig=[A-Za-z0-9_-]{43}$`),
    );
    expect(signed).not.toContain(KEY);
    const viaLink = await fetch(signed);
    expect(viaLink.status).toBe(200);
    expect(await viaLink.text()).toBe("secret picture");
  });

  it("refuses a tampered link, a link for another artifact and a wrong key", async () => {
    const url = new URL(h.signArtifact(id));
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    // "A" and "B" in the last place decode to the same bytes: a second spelling is refused too.
    const respelled = sig.slice(0, -1) + String.fromCharCode(sig.charCodeAt(sig.length - 1) + 1);
    for (const query of [
      `exp=${exp}&sig=${flipped}`,
      `exp=${exp}&sig=${respelled}`,
      `exp=${exp}&sig=${sig}=`,
      `exp=${Number(exp) + 1}&sig=${sig}`,
      `exp=${exp}`,
      `sig=${sig}`,
      `exp=${exp}&sig=${sig}&sig=${sig}`,
      "exp=99999999999999&sig=",
    ]) {
      expect((await fetch(`${h.base}/artifacts/${id}?${query}`)).status, query).toBe(401);
    }
    expect((await fetch(`${h.base}/artifacts/other_id?exp=${exp}&sig=${sig}`)).status).toBe(401);
    const wrong = await fetch(`${h.base}/artifacts/${id}`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("the artifact links in a tool result are signed, and only this daemon's", async () => {
    const client = await modernClient(h.base, { headers: { authorization: `Bearer ${KEY}` } });
    try {
      const { result } = toolJson(await client.callTool({ name: "make_picture", arguments: {} }));
      expect(result.elsewhere).toBe(`https://example.com/artifacts/${id}`);
      for (const link of [result.url, result.nested[0].url]) {
        expect(link).toContain(`${h.base}/artifacts/${id}?exp=`);
        const r = await fetch(link);
        expect(r.status).toBe(200);
        expect(await r.text()).toBe("secret picture");
      }
    } finally {
      await client.close();
    }
  });
});

describe("H2: artifact link signer", () => {
  const key = Buffer.alloc(32, 7);

  it("a link expires", () => {
    let now = 1_000_000;
    const signer = createArtifactSigner({ key, ttlMs: 1000, now: () => now });
    const { exp, sig } = signer.sign("img_1");
    expect(exp).toBe(1_001_000);
    expect(signer.verify("img_1", String(exp), sig)).toBe(true);
    now = 1_000_999;
    expect(signer.verify("img_1", String(exp), sig)).toBe(true);
    now = 1_001_000;
    expect(signer.verify("img_1", String(exp), sig)).toBe(false);
  });

  it("is bound to the id, the expiry and the key; junk never throws", () => {
    const signer = createArtifactSigner({ key, now: () => 5 });
    const { exp, sig } = signer.sign("img_1");
    expect(signer.verify("img_2", String(exp), sig)).toBe(false);
    expect(signer.verify("img_1", String(exp + 1), sig)).toBe(false);
    expect(
      createArtifactSigner({ key: Buffer.alloc(32, 8), now: () => 5 }).verify(
        "img_1",
        String(exp),
        sig,
      ),
    ).toBe(false);
    for (const junk of [undefined, null, 1, [], {}, "", "x".repeat(500), ["a", "b"]]) {
      expect(signer.verify("img_1", junk, sig)).toBe(false);
      expect(signer.verify("img_1", String(exp), junk)).toBe(false);
    }
    expect(() => createArtifactSigner({ key: Buffer.alloc(8) })).toThrow(/32 bytes/);
  });

  it("signArtifactLinks keeps an input-owned __proto__ key as data", () => {
    const signer = createArtifactSigner({ key, now: () => 5 });
    const base = "http://127.0.0.1:7777";
    const input = JSON.parse(`{"__proto__":{"link":"${base}/artifacts/img_1"},"plain":"x"}`);
    const out = signArtifactLinks(input, base, signer) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    const proto = out.__proto__ as unknown as Record<string, unknown>;
    expect(proto.link).toBe(signer.url(base, "img_1"));
    expect(JSON.parse(JSON.stringify(out)).__proto__.link).toBe(signer.url(base, "img_1"));
  });

  it("signArtifactLinks only rewrites exact artifact URLs of this daemon and leaves the input alone", () => {
    const signer = createArtifactSigner({ key, now: () => 5 });
    const base = "http://127.0.0.1:7777";
    const input = {
      a: `${base}/artifacts/img_1`,
      b: `${base}/artifacts/img_1/extra`,
      c: `${base}/artifacts/img_1?already=1`,
      d: "http://evil.example/artifacts/img_1",
      e: [`${base}/artifacts/img_2`, 3, null],
      f: `see ${base}/artifacts/img_1`,
    };
    const frozen = JSON.stringify(input);
    const out = signArtifactLinks(input, base, signer) as typeof input;
    expect(JSON.stringify(input)).toBe(frozen);
    expect(out.a).toBe(signer.url(base, "img_1"));
    expect(out.e[0]).toBe(signer.url(base, "img_2"));
    expect([out.b, out.c, out.d, out.f, out.e[1], out.e[2]]).toEqual([
      input.b,
      input.c,
      input.d,
      input.f,
      3,
      null,
    ]);
  });
});

describe("L-2: the stored path must be a real file inside the library's artifacts folder", () => {
  let dir: string;
  let outsideDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ar-l2-"));
    outsideDir = mkdtempSync(join(tmpdir(), "ar-l2-out-"));
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "real.txt"), "inside");
    writeFileSync(join(outsideDir, "secret.txt"), "outside secret");
    // A symlink inside the artifacts folder that points out of the library.
    symlinkSync(join(outsideDir, "secret.txt"), join(dir, "artifacts", "link.txt"));
    const source = {
      rootValue: dir,
      get: (id: string) =>
        ({
          img_real: {
            id: "img_real",
            path: join(dir, "artifacts", "real.txt"),
            mime: "text/plain",
            bytes: 6,
          },
          img_link: {
            id: "img_link",
            path: join(dir, "artifacts", "link.txt"),
            mime: "text/plain",
            bytes: 14,
          },
          img_away: {
            id: "img_away",
            path: join(outsideDir, "secret.txt"),
            mime: "text/plain",
            bytes: 14,
          },
        })[id] ?? null,
    };
    const app = express();
    mountArtifacts(app, source);
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => r());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("serves a real file inside the artifacts folder", async () => {
    const r = await fetch(`${baseUrl}/artifacts/img_real`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("inside");
  });

  it("refuses a symlinked artifact path and a path outside the library", async () => {
    for (const id of ["img_link", "img_away"]) {
      const r = await fetch(`${baseUrl}/artifacts/${id}`);
      expect(r.status, id).toBe(404);
      expect(await r.text()).not.toContain("outside secret");
    }
  });
});
