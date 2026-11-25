import { describe, expect, it } from "vitest";
import socialPack from "../../../packs/social/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = { AYRSHARE_API_KEY: "ayr_secret_key_123", AYRSHARE_PROFILE_KEY: "prof_key_456" };
const VALUES = Object.values(SECRETS);

describe("social pack", () => {
  it("marks posting and deleting destructive, history read-only", () => {
    expect(toolNames(socialPack)).toEqual([
      "ayrshare_post",
      "ayrshare_delete_post",
      "ayrshare_history",
    ]);
    expect(toolOf(socialPack, "ayrshare_post").annotations?.destructiveHint).toBe(true);
    expect(toolOf(socialPack, "ayrshare_delete_post").annotations?.destructiveHint).toBe(true);
    expect(toolOf(socialPack, "ayrshare_history").annotations?.readOnlyHint).toBe(true);
  });

  it("posts with bearer auth and the profile key", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.ayrshare\.com\/api\/post$/,
        reply: () =>
          jsonResponse({
            status: "success",
            id: "ayr_1",
            refId: "ref",
            errors: [],
            postIds: [
              { status: "success", id: "tw1", platform: "twitter", postUrl: "https://x.com/a/1" },
            ],
          }),
      },
    ]);
    const h = harness(socialPack, "social", "ayrshare_post", { secrets: SECRETS, fetch });
    const out = await h.call({
      post: "Hello",
      platforms: ["twitter"],
      media_urls: ["https://img.example.com/a.png"],
    });
    expect(out).toEqual({
      id: "ayr_1",
      status: "success",
      ref_id: "ref",
      posts: [{ platform: "twitter", status: "success", id: "tw1", url: "https://x.com/a/1" }],
      errors: [],
    });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe("Bearer ayr_secret_key_123");
    expect(call.headers["profile-key"]).toBe("prof_key_456");
    expect(JSON.parse(call.body!)).toMatchObject({
      post: "Hello",
      platforms: ["twitter"],
      mediaUrls: ["https://img.example.com/a.png"],
    });
    expectNoSecrets(out, VALUES);
  });

  it("omits the profile key header when it is not set", async () => {
    const fetch = routerFetch([
      { match: /\/post$/, reply: () => jsonResponse({ status: "success", id: "x", postIds: [] }) },
    ]);
    const h = harness(socialPack, "social", "ayrshare_post", {
      secrets: { AYRSHARE_API_KEY: SECRETS.AYRSHARE_API_KEY },
      fetch,
    });
    await h.call({ post: "Hi", platforms: ["linkedin"] });
    expect(fetch.calls[0]!.headers["profile-key"]).toBeUndefined();
  });

  it("reports a 200 status:error without secrets", async () => {
    const fetch = routerFetch([
      {
        match: /\/post$/,
        reply: () =>
          jsonResponse({
            status: "error",
            errors: [{ code: 156, message: "Bad key ayr_secret_key_123", platform: "twitter" }],
          }),
      },
    ]);
    const h = harness(socialPack, "social", "ayrshare_post", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ post: "x", platforms: ["twitter"] }));
    expect(err.message).toBe("Ayrshare: Bad key [redacted]");
    expectNoSecrets(err, VALUES);
  });

  it("scrubs keys from an HTTP error", async () => {
    const fetch = routerFetch([
      {
        match: /\/post$/,
        reply: () =>
          jsonResponse({ status: "error", message: "Profile prof_key_456 not found" }, 403),
      },
    ]);
    const h = harness(socialPack, "social", "ayrshare_delete_post", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ id: "ayr_1" }));
    expect(err.message).toBe("Ayrshare 403: Profile [redacted] not found");
    expectNoSecrets(err, VALUES);
  });

  it("deletes by id with a DELETE body", async () => {
    const fetch = routerFetch([
      {
        method: "DELETE",
        match: /\/api\/post$/,
        reply: () => jsonResponse({ status: "success", errors: [] }),
      },
    ]);
    const h = harness(socialPack, "social", "ayrshare_delete_post", { secrets: SECRETS, fetch });
    expect(await h.call({ id: "ayr_1" })).toEqual({ id: "ayr_1", status: "success", errors: [] });
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({ id: "ayr_1" });
  });

  it("lists history and treats code 221 as empty", async () => {
    const fetch = routerFetch([
      {
        match: /\/history\?limit=5&lastDays=7$/,
        reply: () =>
          jsonResponse([
            {
              id: "ayr_1",
              post: "Hello",
              platforms: ["twitter"],
              status: "success",
              created: "2026-11-20T10:00:00Z",
              postIds: [{ platform: "twitter", id: "tw1", postUrl: "https://x.com/a/1" }],
            },
          ]),
      },
      {
        match: /\/history\?lastDays=1$/,
        reply: () => jsonResponse({ status: "error", code: 221, message: "No history found" }, 400),
      },
    ]);
    const h = harness(socialPack, "social", "ayrshare_history", { secrets: SECRETS, fetch });
    const out = (await h.call({ limit: 5, last_days: 7 })) as { posts: { id: string }[] };
    expect(out.posts[0]).toMatchObject({ id: "ayr_1", post: "Hello", platforms: ["twitter"] });
    expect(await h.call({ last_days: 1 })).toEqual({ posts: [] });
  });

  it("accepts only http(s) media URLs", () => {
    const tool = toolOf(socialPack, "ayrshare_post");
    const base = { post: "x", platforms: ["twitter"] };
    expect(
      tool.input.safeParse({ ...base, media_urls: ["https://img.example.com/a.png"] }).success,
    ).toBe(true);
    expect(
      tool.input.safeParse({ ...base, media_urls: ["http://img.example.com/a.png"] }).success,
    ).toBe(true);
    for (const u of [
      "ftp://img.example.com/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAA",
    ]) {
      expect(tool.input.safeParse({ ...base, media_urls: [u] }).success).toBe(false);
    }
  });

  it("rejects unknown platforms", () => {
    const tool = toolOf(socialPack, "ayrshare_post");
    expect(tool.input.safeParse({ post: "x", platforms: ["myspace"] }).success).toBe(false);
    expect(tool.input.safeParse({ post: "x", platforms: [] }).success).toBe(false);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(socialPack, "social", "ayrshare_history", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "ayrshare_history",
        args: {},
        pack: "social",
        secret: "AYRSHARE_API_KEY",
      },
    ]);
  });
});
