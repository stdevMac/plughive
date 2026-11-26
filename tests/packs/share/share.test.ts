import { describe, expect, it } from "vitest";
import sharePack from "../../../packs/share/index.js";
import { presignUrl, rfc3986 } from "../../../packs/share/sigv4.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { toolNames, toolOf } from "../support.js";

const SECRETS = {
  SHARE_S3_ACCESS_KEY_ID: "AKIDSHARETEST",
  SHARE_S3_SECRET_ACCESS_KEY: "share_secret_key_789",
};
const SETTINGS = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "media-links",
};
const HOST = /https:\/\/acct123\.r2\.cloudflarestorage\.com\/media-links\/plughive\/a1\.png\?/;

function seeded(tool: string, fetch: ReturnType<typeof routerFetch>, settings = SETTINGS) {
  const h = harness(sharePack, "share", tool, { secrets: SECRETS, fetch, settings });
  h.t.library!.seed({
    id: "a1",
    kind: "image",
    mime: "image/png",
    bytes: "PNGDATA",
    tool: "other/tool",
  });
  return h;
}

describe("share pack", () => {
  it("signs the AWS SigV4 presigned-URL example exactly", () => {
    const url = presignUrl({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresIn: 86_400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(rfc3986("a b!*")).toBe("a%20b%21%2A");
    expect(() =>
      presignUrl({
        method: "GET",
        url: "https://x.s3.amazonaws.com/k",
        region: "us-east-1",
        accessKeyId: "a",
        secretAccessKey: "b",
        expiresIn: 604_801,
      }),
    ).toThrow(RangeError);
  });

  it("marks both tools destructive", () => {
    expect(toolNames(sharePack)).toEqual(["share_artifact", "share_unshare"]);
    for (const n of ["share_artifact", "share_unshare"]) {
      expect(toolOf(sharePack, n).annotations?.destructiveHint, n).toBe(true);
    }
  });

  it("uploads with a signed PUT and returns a presigned GET link", async () => {
    let uploaded = "";
    const fetch = routerFetch([
      {
        method: "PUT",
        match: HOST,
        reply: async ({ init }) => {
          uploaded = await new Response(init?.body as Blob).text();
          return new Response(null, { status: 200 });
        },
      },
    ]);
    const h = seeded("share_artifact", fetch);
    const out = (await h.call({ artifact_id: "a1", expires_in_s: 600 })) as {
      url: string;
      key: string;
    };
    expect(uploaded).toBe("PNGDATA");
    const put = new URL(fetch.calls[0]!.url);
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(put.searchParams.get("X-Amz-Credential")).toMatch(/\/auto\/s3\/aws4_request$/);
    expect(fetch.calls[0]!.headers["content-type"]).toBe("image/png");
    const link = new URL(out.url);
    expect(link.pathname).toBe("/media-links/plughive/a1.png");
    expect(link.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(link.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(out.key).toBe("plughive/a1.png");
    expectNoSecrets(out, [SECRETS.SHARE_S3_SECRET_ACCESS_KEY]);
    expectNoSecrets(fetch.calls, [SECRETS.SHARE_S3_SECRET_ACCESS_KEY]);
  });

  it("caps link lifetime by the maxExpirySeconds setting", async () => {
    const fetch = routerFetch([]);
    const h = seeded("share_artifact", fetch, { ...SETTINGS, maxExpirySeconds: 300 } as never);
    const err = await failure(h.call({ artifact_id: "a1", expires_in_s: 3600 }));
    expect(err.message).toMatch(/maxExpirySeconds setting \(300\)/);
    expect(fetch.calls).toHaveLength(0);
    expect(
      toolOf(sharePack, "share_artifact").input.safeParse({
        artifact_id: "a1",
        expires_in_s: 604_801,
      }).success,
    ).toBe(false);
  });

  it("deletes the shared copy with a signed DELETE", async () => {
    const fetch = routerFetch([
      { method: "DELETE", match: HOST, reply: () => new Response(null, { status: 204 }) },
    ]);
    const h = seeded("share_unshare", fetch);
    expect(await h.call({ artifact_id: "a1" })).toEqual({
      deleted: true,
      key: "plughive/a1.png",
      bucket: "media-links",
    });
  });

  it("reports S3 XML errors by code and message only, scrubbed", async () => {
    const xml =
      "<Error><Code>SignatureDoesNotMatch</Code><Message>bad share_secret_key_789</Message>" +
      "<StringToSign>AWS4-HMAC-SHA256 secret stuff</StringToSign></Error>";
    const fetch = routerFetch([{ match: HOST, reply: () => new Response(xml, { status: 403 }) }]);
    const h = seeded("share_artifact", fetch);
    const err = await failure(h.call({ artifact_id: "a1" }));
    expect(err.message).toBe("S3 403: SignatureDoesNotMatch: bad [redacted]");
    expectNoSecrets(err, Object.values(SECRETS));
  });

  it("refuses a missing setup, bad endpoints and unknown artifacts", async () => {
    const fetch = routerFetch([]);
    const none = seeded("share_artifact", fetch, {} as never);
    expect((await failure(none.call({ artifact_id: "a1" }))).message).toMatch(
      /endpoint and bucket/,
    );
    const http = seeded("share_artifact", fetch, {
      ...SETTINGS,
      endpoint: "http://x.r2.cloudflarestorage.com",
    });
    expect((await failure(http.call({ artifact_id: "a1" }))).message).toMatch(/bare https/);
    for (const endpoint of [
      "https://user:pass@x.r2.cloudflarestorage.com",
      "https://x.r2.cloudflarestorage.com/#frag",
      "https://x.r2.cloudflarestorage.com/?q=1",
      "https://x.r2.cloudflarestorage.com/path",
    ]) {
      const bad = seeded("share_artifact", fetch, { ...SETTINGS, endpoint });
      expect((await failure(bad.call({ artifact_id: "a1" }))).message).toMatch(/bare https/);
    }
    const ok = seeded("share_artifact", fetch);
    expect((await failure(ok.call({ artifact_id: "zz" }))).message).toMatch(/not found/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("never quotes the presigned URL in a network error", async () => {
    const h = seeded("share_artifact", routerFetch([]));
    const err = await failure(h.call({ artifact_id: "a1" }));
    expect(err.message).toBe("S3: request failed (network error)");
  });

  it("uploads active web types as octet-stream, never inline", async () => {
    for (const mime of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
      "text/javascript",
      "TEXT/HTML; charset=utf-8",
      "text/plain, text/html",
    ]) {
      const fetch = routerFetch([
        { method: "PUT", match: /\/media-links\/plughive\/p1\?/, reply: () => new Response(null) },
      ]);
      const h = harness(sharePack, "share", "share_artifact", {
        secrets: SECRETS,
        fetch,
        settings: SETTINGS,
      });
      h.t.library!.seed({
        id: "p1",
        kind: "other",
        mime,
        bytes: "<script>1</script>",
        tool: "other/tool",
      });
      const out = (await h.call({ artifact_id: "p1" })) as { mime: string };
      expect(out.mime, mime).toBe("application/octet-stream");
      expect(fetch.calls[0]!.headers["content-type"], mime).toBe("application/octet-stream");
    }
    const fetch = routerFetch([
      { method: "PUT", match: /\/plughive\/t1\.txt\?/, reply: () => new Response(null) },
    ]);
    const h = harness(sharePack, "share", "share_artifact", {
      secrets: SECRETS,
      fetch,
      settings: SETTINGS,
    });
    h.t.library!.seed({
      id: "t1",
      kind: "document",
      mime: "text/plain; charset=UTF-8",
      bytes: "hi",
      tool: "other/tool",
    });
    expect(((await h.call({ artifact_id: "t1" })) as { mime: string }).mime).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("refuses . and .. segments in keyPrefix", async () => {
    const fetch = routerFetch([]);
    for (const keyPrefix of ["./x/", "a/./", ".", "a/../b/"]) {
      const h = seeded("share_artifact", fetch, { ...SETTINGS, keyPrefix } as never);
      expect((await failure(h.call({ artifact_id: "a1" }))).message, keyPrefix).toMatch(
        /keyPrefix/,
      );
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses header names or values that could split the canonical request", () => {
    const base = {
      method: "PUT" as const,
      url: "https://x.s3.amazonaws.com/k",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "b",
      expiresIn: 60,
    };
    expect(() => presignUrl({ ...base, headers: { "x-a:b": "v" } })).toThrow(/not a valid header/);
    expect(() => presignUrl({ ...base, headers: { "x-a\nhost": "v" } })).toThrow(
      /not a valid header/,
    );
    expect(() => presignUrl({ ...base, headers: { "x-a": "v\r\nhost: evil" } })).toThrow(
      /not a valid header/,
    );
    expect(presignUrl({ ...base, headers: { "content-type": "image/png" } })).toMatch(
      /X-Amz-SignedHeaders=content-type%3Bhost/,
    );
  });

  it("strips the presigned query from a timeout or abort error that quotes it", async () => {
    const fetch = routerFetch([
      {
        method: "PUT",
        match: HOST,
        reply: ({ url }) => {
          const e = new Error(`Request to ${url} timed out after 5 ms`);
          e.name = "TimeoutError";
          throw e;
        },
      },
    ]);
    const h = seeded("share_artifact", fetch);
    const err = await failure(h.call({ artifact_id: "a1" }));
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toMatch(/timed out after 5 ms/);
    expect(`${err.message} ${err.stack}`).not.toMatch(/X-Amz-|Signature/);
  });

  it("can reach only the declared hosts", async () => {
    const h = seeded("share_artifact", routerFetch([]));
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://storage.googleapis.com/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "share_unshare",
        args: { artifact_id: "a1" },
        pack: "share",
        secret: "SHARE_S3_ACCESS_KEY_ID",
      },
    ]);
  });
});
