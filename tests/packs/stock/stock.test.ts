import { describe, expect, it } from "vitest";
import stockPack from "../../../packs/stock/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = {
  PEXELS_API_KEY: "pexels_secret_123",
  UNSPLASH_ACCESS_KEY: "unsplash_secret_456",
  FREESOUND_API_KEY: "freesound_secret_789",
};
const VALUES = Object.values(SECRETS);

function bytesResponse(body: string, type: string): Response {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": type },
  });
}

const PEXELS_PHOTO = {
  id: 42,
  width: 4000,
  height: 3000,
  url: "https://www.pexels.com/photo/42/",
  photographer: "Jo",
  photographer_url: "https://www.pexels.com/@jo",
  alt: "A cat",
  src: {
    original: "https://images.pexels.com/photos/42/pexels-photo-42.jpeg",
    medium: "https://images.pexels.com/photos/42/pexels-photo-42.jpeg?h=350",
  },
};

describe("stock pack", () => {
  it("exposes search tools as read-only and the download as a library write", () => {
    expect(toolNames(stockPack)).toEqual([
      "pexels_search",
      "unsplash_search",
      "freesound_search",
      "stock_download",
    ]);
    for (const n of ["pexels_search", "unsplash_search", "freesound_search"]) {
      expect(toolOf(stockPack, n).annotations?.readOnlyHint, n).toBe(true);
    }
    expect(toolOf(stockPack, "stock_download").annotations?.destructiveHint).toBeUndefined();
  });

  it("searches Pexels photos and videos with the raw key header", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.pexels\.com\/v1\/search\?query=cat&per_page=2$/,
        reply: () => jsonResponse({ total_results: 1, photos: [PEXELS_PHOTO] }),
      },
      {
        match: /^GET https:\/\/api\.pexels\.com\/v1\/videos\/search\?query=sea&per_page=15$/,
        reply: () =>
          jsonResponse({
            total_results: 1,
            videos: [
              {
                id: 7,
                width: 1920,
                height: 1080,
                duration: 12,
                url: "https://www.pexels.com/video/7/",
                image: "https://images.pexels.com/videos/7/pic.jpg",
                user: { name: "Sam", url: "https://www.pexels.com/@sam" },
              },
            ],
          }),
      },
    ]);
    const h = harness(stockPack, "stock", "pexels_search", { secrets: SECRETS, fetch });
    const photos = (await h.call({ query: "cat", per_page: 2 })) as {
      results: { id: number; attribution: Record<string, unknown> }[];
    };
    expect(photos.results[0]).toMatchObject({
      id: 42,
      type: "photo",
      attribution: { author: "Jo", license: "Pexels License", text: "Photo by Jo on Pexels" },
    });
    expect(fetch.calls[0]!.headers.authorization).toBe("pexels_secret_123");
    const videos = (await h.call({ query: "sea", type: "video" })) as {
      results: { duration_s: number }[];
    };
    expect(videos.results[0]).toMatchObject({ id: 7, type: "video", duration_s: 12 });
    expectNoSecrets([photos, videos], VALUES);
  });

  it("downloads a Pexels photo into the library without sending the key to the CDN", async () => {
    const fetch = routerFetch([
      { match: /api\.pexels\.com\/v1\/photos\/42$/, reply: () => jsonResponse(PEXELS_PHOTO) },
      {
        match:
          /^GET https:\/\/images\.pexels\.com\/photos\/42\/pexels-photo-42\.jpeg\?auto=compress&cs=tinysrgb&w=1280$/,
        reply: () => bytesResponse("JPEGDATA", "image/jpeg"),
      },
    ]);
    const h = harness(stockPack, "stock", "stock_download", { secrets: SECRETS, fetch });
    const out = (await h.call({ provider: "pexels", id: 42, max_width: 1280 })) as {
      artifact_id: string;
      attribution: Record<string, unknown>;
    };
    expect(out).toMatchObject({ mime: "image/jpeg", bytes: 8, attribution: { author: "Jo" } });
    expect(fetch.calls[1]!.headers.authorization).toBeUndefined();
    const saved = h.t.library!.all();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: "image",
      tool: "stock/stock_download",
      meta: { provider: "pexels", sourceId: "42", attribution: { author: "Jo" } },
    });
    expectNoSecrets([out, saved[0]!.meta], VALUES);
  });

  it("picks the widest mp4 within max_width for a Pexels video", async () => {
    const fetch = routerFetch([
      {
        match: /\/v1\/videos\/videos\/7$/,
        reply: () =>
          jsonResponse({
            id: 7,
            user: { name: "Sam" },
            video_files: [
              { file_type: "video/mp4", width: 3840, link: "https://videos.pexels.com/4k.mp4" },
              { file_type: "video/mp4", width: 1280, link: "https://videos.pexels.com/hd.mp4" },
              { file_type: "video/mp4", width: 640, link: "https://videos.pexels.com/sd.mp4" },
            ],
          }),
      },
      { match: /videos\.pexels\.com\/hd\.mp4$/, reply: () => bytesResponse("MP4", "video/mp4") },
    ]);
    const h = harness(stockPack, "stock", "stock_download", { secrets: SECRETS, fetch });
    await h.call({ provider: "pexels", type: "video", id: 7, max_width: 1920 });
    expect(fetch.calls[1]!.url).toBe("https://videos.pexels.com/hd.mp4");
    expect(h.t.library!.all()[0]).toMatchObject({ kind: "video", mime: "video/mp4" });
  });

  it("refuses a download link on an unexpected host", async () => {
    const fetch = routerFetch([
      {
        match: /\/v1\/photos\/1$/,
        reply: () =>
          jsonResponse({ ...PEXELS_PHOTO, id: 1, src: { original: "https://evil.example.com/x" } }),
      },
    ]);
    const h = harness(stockPack, "stock", "stock_download", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ provider: "pexels", id: 1 }));
    expect(err.message).toMatch(/unexpected host/);
    expect(fetch.calls).toHaveLength(1);
  });

  it("searches Unsplash with utm attribution links", async () => {
    const fetch = routerFetch([
      {
        match:
          /^GET https:\/\/api\.unsplash\.com\/search\/photos\?query=hill&per_page=15&orientation=squarish$/,
        reply: () =>
          jsonResponse({
            total: 1,
            results: [
              {
                id: "abc",
                width: 10,
                height: 10,
                urls: { small: "https://images.unsplash.com/s" },
                links: { html: "https://unsplash.com/photos/abc" },
                user: { name: "Ana", links: { html: "https://unsplash.com/@ana" } },
              },
            ],
          }),
      },
    ]);
    const h = harness(stockPack, "stock", "unsplash_search", {
      secrets: SECRETS,
      fetch,
      settings: { unsplashAppName: "myapp" },
    });
    const out = (await h.call({ query: "hill", orientation: "square" })) as {
      results: { attribution: { author_url: string } }[];
    };
    expect(out.results[0]!.attribution.author_url).toBe(
      "https://unsplash.com/@ana?utm_source=myapp&utm_medium=referral",
    );
    expect(fetch.calls[0]!.headers.authorization).toBe("Client-ID unsplash_secret_456");
    expect(fetch.calls[0]!.headers["accept-version"]).toBe("v1");
  });

  it("tracks the Unsplash download before saving", async () => {
    const fetch = routerFetch([
      {
        match: /api\.unsplash\.com\/photos\/abc$/,
        reply: () =>
          jsonResponse({
            id: "abc",
            urls: { raw: "https://images.unsplash.com/photo-abc?ixid=1" },
            links: {
              html: "https://unsplash.com/photos/abc",
              download_location: "https://api.unsplash.com/photos/abc/download?ixid=1",
            },
            user: { name: "Ana", links: { html: "https://unsplash.com/@ana" } },
          }),
      },
      {
        match: /api\.unsplash\.com\/photos\/abc\/download\?ixid=1$/,
        reply: () => jsonResponse({ url: "x" }),
      },
      {
        match: /images\.unsplash\.com\/photo-abc/,
        reply: () => bytesResponse("JPG", "image/jpeg"),
      },
    ]);
    const h = harness(stockPack, "stock", "stock_download", { secrets: SECRETS, fetch });
    const out = await h.call({ provider: "unsplash", id: "abc" });
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/photos/abc",
      "/photos/abc/download",
      "/photo-abc",
    ]);
    expect(fetch.calls[2]!.url).toContain("w=1920");
    expect(out).toMatchObject({ attribution: { author: "Ana", license: "Unsplash License" } });
  });

  it("searches Freesound and downloads the HQ preview with its license", async () => {
    const sound = {
      id: 5,
      name: "Rain",
      username: "bob",
      license: "http://creativecommons.org/licenses/by/4.0/",
      duration: 3.5,
      url: "https://freesound.org/people/bob/sounds/5/",
      previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/5-hq.mp3" },
    };
    const fetch = routerFetch([
      {
        match:
          /^GET https:\/\/freesound\.org\/apiv2\/search\/\?query=rain&fields=.*&page_size=15&filter=duration%3A%5B0\+TO\+10%5D$/,
        reply: () => jsonResponse({ count: 1, results: [sound] }),
      },
      { match: /\/apiv2\/sounds\/5\/\?fields=/, reply: () => jsonResponse(sound) },
      {
        match: /cdn\.freesound\.org\/previews\/0\/5-hq\.mp3$/,
        reply: () => bytesResponse("ID3", "audio/mpeg"),
      },
    ]);
    const search = harness(stockPack, "stock", "freesound_search", { secrets: SECRETS, fetch });
    const found = (await search.call({ query: "rain", max_duration_s: 10 })) as {
      results: { attribution: { license: string } }[];
    };
    expect(found.results[0]!.attribution.license).toBe(sound.license);
    expect(fetch.calls[0]!.headers.authorization).toBe("Token freesound_secret_789");

    const dl = harness(stockPack, "stock", "stock_download", { secrets: SECRETS, fetch });
    const out = await dl.call({ provider: "freesound", id: 5 });
    expect(out).toMatchObject({ mime: "audio/mpeg", attribution: { author: "bob" } });
    expect(dl.t.library!.all()[0]).toMatchObject({ kind: "audio" });
    expect(fetch.calls[2]!.headers.authorization).toBeUndefined();
  });

  it("scrubs keys from provider errors", async () => {
    const fetch = routerFetch([
      {
        match: /pexels/,
        reply: () => jsonResponse({ error: "bad key pexels_secret_123" }, 401),
      },
    ]);
    const h = harness(stockPack, "stock", "pexels_search", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ query: "x" }));
    expect(err.message).toBe("Pexels 401: bad key [redacted]");
    expectNoSecrets(err, VALUES);
  });

  it("rejects ids that would change the path", () => {
    const tool = toolOf(stockPack, "stock_download");
    expect(tool.input.safeParse({ provider: "unsplash", id: "../me" }).success).toBe(false);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(stockPack, "stock", "pexels_search", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://www.pexels.com/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      { tool: "pexels_search", args: { query: "x" }, pack: "stock", secret: "PEXELS_API_KEY" },
      {
        tool: "unsplash_search",
        args: { query: "x" },
        pack: "stock",
        secret: "UNSPLASH_ACCESS_KEY",
      },
      {
        tool: "stock_download",
        args: { provider: "freesound", id: 5 },
        pack: "stock",
        secret: "FREESOUND_API_KEY",
      },
    ]);
  });
});
