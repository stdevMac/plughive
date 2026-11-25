// packs/stock/index.ts
//
// Search free stock media and download it into the artifact library with its
// attribution (author, links, license) stored in the artifact's meta and
// returned to the caller.
//   Pexels:    https://www.pexels.com/api/documentation/
//   Unsplash:  https://unsplash.com/documentation
//              (guidelines: hotlink or track downloads, credit with utm links)
//   Freesound: https://freesound.org/docs/api/resources_apiv2.html
//              (previews need only a token; original files need OAuth2 and are
//              not offered here)
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, num, obj, requestBytes, requestJson, str } from "./http.js";

const PEXELS = "https://api.pexels.com/v1";
const UNSPLASH = "https://api.unsplash.com";
const FREESOUND = "https://freesound.org/apiv2";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/** Hosts a download link may point at, per provider (ctx.fetch enforces the manifest too). */
const MEDIA_HOSTS: Record<string, readonly string[]> = {
  pexels: [
    "images.pexels.com",
    "videos.pexels.com",
    "static-videos.pexels.com",
    "player.vimeo.com",
  ],
  unsplash: ["images.unsplash.com"],
  freesound: ["cdn.freesound.org", "freesound.org"],
};

const query = z.string().min(1).max(200);
const perPage = z.number().int().min(1).max(50).optional();
const orientation = z.enum(["landscape", "portrait", "square"]).optional();

function mediaUrl(provider: string, raw: string | null): string {
  if (!raw) throw new Error(`${providerName(provider)}: the item has no downloadable file.`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${providerName(provider)}: the download link is not a URL.`);
  }
  if (u.protocol !== "https:" || !MEDIA_HOSTS[provider]?.includes(u.hostname)) {
    throw new Error(`${providerName(provider)}: the download link is on an unexpected host.`);
  }
  return u.toString();
}

function providerName(p: string): string {
  return p === "pexels" ? "Pexels" : p === "unsplash" ? "Unsplash" : "Freesound";
}

// ---------------------------------------------------------------------------
// Pexels
// ---------------------------------------------------------------------------

async function pexels(ctx: PackContext, path: string): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("PEXELS_API_KEY");
  return obj(
    await requestJson(
      ctx.fetch,
      "Pexels",
      `${PEXELS}${path}`,
      { headers: { Authorization: key } },
      [key],
    ),
  );
}

function pexelsPhoto(p: unknown) {
  const o = obj(p);
  const src = obj(o.src);
  return {
    id: num(o.id),
    type: "photo" as const,
    width: num(o.width),
    height: num(o.height),
    alt: str(o.alt),
    preview_url: str(src.medium),
    attribution: {
      author: str(o.photographer),
      author_url: str(o.photographer_url),
      source_url: str(o.url),
      license: "Pexels License",
      license_url: "https://www.pexels.com/license/",
      text: `Photo by ${str(o.photographer) ?? "unknown"} on Pexels`,
    },
  };
}

function pexelsVideo(v: unknown) {
  const o = obj(v);
  const user = obj(o.user);
  return {
    id: num(o.id),
    type: "video" as const,
    width: num(o.width),
    height: num(o.height),
    duration_s: num(o.duration),
    preview_url: str(o.image),
    attribution: {
      author: str(user.name),
      author_url: str(user.url),
      source_url: str(o.url),
      license: "Pexels License",
      license_url: "https://www.pexels.com/license/",
      text: `Video by ${str(user.name) ?? "unknown"} on Pexels`,
    },
  };
}

const pexelsSearch = defineTool({
  name: "pexels_search",
  description:
    "Search Pexels free stock photos or videos. Returns ids, sizes, a preview URL and attribution. Download one into the library with stock_download.",
  secrets: ["PEXELS_API_KEY"],
  annotations: { title: "Search Pexels", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query,
    type: z.enum(["photo", "video"]).default("photo"),
    per_page: perPage,
    orientation,
  }),
  async run(input, ctx) {
    const q = new URLSearchParams({ query: input.query, per_page: String(input.per_page ?? 15) });
    if (input.orientation) q.set("orientation", input.orientation);
    if (input.type === "video") {
      const out = await pexels(ctx, `/videos/search?${q}`);
      return { total: num(out.total_results), results: arr(out.videos).map(pexelsVideo) };
    }
    const out = await pexels(ctx, `/search?${q}`);
    return { total: num(out.total_results), results: arr(out.photos).map(pexelsPhoto) };
  },
});

// ---------------------------------------------------------------------------
// Unsplash
// ---------------------------------------------------------------------------

function utm(ctx: PackContext, url: string | null): string | null {
  if (!url) return null;
  const app = str(ctx.settings.unsplashAppName) ?? "plughive";
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", app);
    u.searchParams.set("utm_medium", "referral");
    return u.toString();
  } catch {
    return null;
  }
}

async function unsplash(ctx: PackContext, url: string): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("UNSPLASH_ACCESS_KEY");
  return obj(
    await requestJson(
      ctx.fetch,
      "Unsplash",
      url,
      { headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" } },
      [key],
    ),
  );
}

function unsplashPhoto(ctx: PackContext, p: unknown) {
  const o = obj(p);
  const user = obj(o.user);
  const author = str(user.name);
  return {
    id: str(o.id),
    type: "photo" as const,
    width: num(o.width),
    height: num(o.height),
    alt: str(o.alt_description) ?? str(o.description),
    preview_url: str(obj(o.urls).small),
    attribution: {
      author,
      author_url: utm(ctx, str(obj(user.links).html)),
      source_url: utm(ctx, str(obj(o.links).html)),
      license: "Unsplash License",
      license_url: "https://unsplash.com/license",
      text: `Photo by ${author ?? "unknown"} on Unsplash`,
    },
  };
}

const unsplashSearch = defineTool({
  name: "unsplash_search",
  description:
    "Search Unsplash free photos. Returns ids, sizes, a preview URL and attribution (credit the photographer and Unsplash with the returned links). Download one into the library with stock_download.",
  secrets: ["UNSPLASH_ACCESS_KEY"],
  annotations: { title: "Search Unsplash", readOnlyHint: true, openWorldHint: true },
  input: z.object({ query, per_page: z.number().int().min(1).max(30).optional(), orientation }),
  async run(input, ctx) {
    const q = new URLSearchParams({ query: input.query, per_page: String(input.per_page ?? 15) });
    // Unsplash names the square orientation "squarish".
    if (input.orientation)
      q.set("orientation", input.orientation === "square" ? "squarish" : input.orientation);
    const out = await unsplash(ctx, `${UNSPLASH}/search/photos?${q}`);
    return {
      total: num(out.total),
      results: arr(out.results).map((p) => unsplashPhoto(ctx, p)),
    };
  },
});

// ---------------------------------------------------------------------------
// Freesound
// ---------------------------------------------------------------------------

const FS_FIELDS = "id,name,username,license,duration,previews,url,tags";

async function freesound(ctx: PackContext, path: string): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("FREESOUND_API_KEY");
  return obj(
    await requestJson(
      ctx.fetch,
      "Freesound",
      `${FREESOUND}${path}`,
      { headers: { Authorization: `Token ${key}` } },
      [key],
    ),
  );
}

function freesoundSound(s: unknown) {
  const o = obj(s);
  const author = str(o.username);
  const license = str(o.license);
  return {
    id: num(o.id),
    type: "audio" as const,
    name: str(o.name),
    duration_s: num(o.duration),
    tags: arr(o.tags)
      .filter((t): t is string => typeof t === "string")
      .slice(0, 20),
    preview_url: str(obj(o.previews)["preview-hq-mp3"]),
    attribution: {
      author,
      author_url: author ? `https://freesound.org/people/${encodeURIComponent(author)}/` : null,
      source_url: str(o.url),
      license: license ?? null,
      license_url: license,
      text: `"${str(o.name) ?? "sound"}" by ${author ?? "unknown"} on Freesound (${license ?? "see source"})`,
    },
  };
}

const freesoundSearch = defineTool({
  name: "freesound_search",
  description:
    "Search Freesound sound effects and recordings. Returns ids, names, durations, license and attribution. Licenses vary per sound (CC0, CC BY, CC BY-NC): check before commercial use. Download a preview into the library with stock_download.",
  secrets: ["FREESOUND_API_KEY"],
  annotations: { title: "Search Freesound", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query,
    per_page: perPage,
    max_duration_s: z.number().positive().max(3600).optional(),
  }),
  async run(input, ctx) {
    const q = new URLSearchParams({
      query: input.query,
      fields: FS_FIELDS,
      page_size: String(input.per_page ?? 15),
    });
    if (input.max_duration_s !== undefined)
      q.set("filter", `duration:[0 TO ${input.max_duration_s}]`);
    const out = await freesound(ctx, `/search/?${q}`);
    return { total: num(out.count), results: arr(out.results).map(freesoundSound) };
  },
});

// ---------------------------------------------------------------------------
// Download into the library
// ---------------------------------------------------------------------------

const idString = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "an id is letters, digits, _ or -");

const download = defineTool({
  name: "stock_download",
  description:
    "Download a Pexels photo or video, an Unsplash photo, or a Freesound preview (high-quality MP3) into the artifact library. The attribution is stored with the artifact and returned: credit the author as it says.",
  annotations: { title: "Download stock media", readOnlyHint: false, openWorldHint: true },
  input: z.object({
    provider: z.enum(["pexels", "unsplash", "freesound"]),
    type: z.enum(["photo", "video"]).default("photo").describe("Pexels only"),
    id: z.union([z.number().int().positive(), idString]),
    max_width: z.number().int().min(160).max(8192).default(1920),
  }),
  async run(input, ctx) {
    const id = encodeURIComponent(String(input.id));
    let url: string;
    let kind: "image" | "video" | "audio";
    let maxBytes: number;
    let attribution: Record<string, unknown>;
    let fallbackMime: string;

    if (input.provider === "pexels" && input.type === "video") {
      const v = await pexels(ctx, `/videos/videos/${id}`);
      const files = arr(v.video_files)
        .map(obj)
        .filter((f) => str(f.link) && str(f.file_type) === "video/mp4");
      files.sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0));
      const pick = files.find((f) => (num(f.width) ?? 0) <= input.max_width) ?? files.at(-1);
      url = mediaUrl("pexels", str(pick?.link));
      kind = "video";
      maxBytes = MAX_VIDEO_BYTES;
      fallbackMime = "video/mp4";
      attribution = pexelsVideo(v).attribution;
    } else if (input.provider === "pexels") {
      const p = await pexels(ctx, `/photos/${id}`);
      const src = obj(p.src);
      const original = str(src.original);
      // Pexels image links take imgix-style resizing parameters.
      url = mediaUrl("pexels", original);
      const sized = new URL(url);
      sized.searchParams.set("auto", "compress");
      sized.searchParams.set("cs", "tinysrgb");
      sized.searchParams.set("w", String(input.max_width));
      url = sized.toString();
      kind = "image";
      maxBytes = MAX_IMAGE_BYTES;
      fallbackMime = "image/jpeg";
      attribution = pexelsPhoto(p).attribution;
    } else if (input.provider === "unsplash") {
      const p = await unsplash(ctx, `${UNSPLASH}/photos/${id}`);
      const raw = mediaUrl("unsplash", str(obj(p.urls).raw));
      const sized = new URL(raw);
      sized.searchParams.set("w", String(input.max_width));
      sized.searchParams.set("fm", "jpg");
      sized.searchParams.set("q", "85");
      url = sized.toString();
      // Unsplash requires a call to download_location for every download.
      const track = str(obj(p.links).download_location);
      if (track?.startsWith(`${UNSPLASH}/`)) await unsplash(ctx, track);
      kind = "image";
      maxBytes = MAX_IMAGE_BYTES;
      fallbackMime = "image/jpeg";
      attribution = unsplashPhoto(ctx, p).attribution;
    } else {
      const s = await freesound(ctx, `/sounds/${id}/?fields=${FS_FIELDS}`);
      const sound = freesoundSound(s);
      url = mediaUrl("freesound", sound.preview_url);
      kind = "audio";
      maxBytes = MAX_AUDIO_BYTES;
      fallbackMime = "audio/mpeg";
      attribution = sound.attribution;
    }

    // Media hosts are public CDNs: no credentials are sent to them.
    const { bytes, mime } = await requestBytes(
      ctx.fetch,
      providerName(input.provider),
      url,
      { timeoutMs: 300_000 },
      [],
      maxBytes,
    );
    const ref = await ctx.library.save({
      kind,
      mime: mime === "application/octet-stream" ? fallbackMime : mime,
      bytes,
      meta: {
        provider: input.provider,
        sourceId: String(input.id),
        attribution,
      },
    });
    return {
      artifact_id: ref.id,
      url: ref.url,
      mime: ref.mime,
      bytes: bytes.byteLength,
      attribution,
    };
  },
});

export default definePack({
  tools: [pexelsSearch, unsplashSearch, freesoundSearch, download],
});
