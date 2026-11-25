// packs/social/index.ts
//
// Post to social networks through Ayrshare, delete those posts, and read the
// post history.
//   https://www.ayrshare.com/docs/apis/post/post
//   https://www.ayrshare.com/docs/apis/post/delete-post
//   https://www.ayrshare.com/docs/apis/history/history
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import {
  apiError,
  arr,
  noControl,
  num,
  obj,
  readJson,
  requestJson,
  scrub,
  send,
  str,
} from "./http.js";

const AYRSHARE = "https://api.ayrshare.com/api";

const PLATFORMS = [
  "bluesky",
  "facebook",
  "gmb",
  "instagram",
  "linkedin",
  "pinterest",
  "reddit",
  "snapchat",
  "telegram",
  "threads",
  "tiktok",
  "twitter",
  "youtube",
] as const;

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => noControl(s) && !/\s/.test(s), "an id has no spaces or control characters");

interface Auth {
  headers: Record<string, string>;
  secrets: string[];
}

async function auth(ctx: PackContext): Promise<Auth> {
  const key = await ctx.secrets.get("AYRSHARE_API_KEY");
  const auth: Auth = { headers: { Authorization: `Bearer ${key}` }, secrets: [key] };
  if (await ctx.secrets.has("AYRSHARE_PROFILE_KEY")) {
    const profile = await ctx.secrets.get("AYRSHARE_PROFILE_KEY");
    auth.headers["Profile-Key"] = profile;
    auth.secrets.push(profile);
  }
  return auth;
}

/** Ayrshare can answer 200 with {status: "error"}; that is an error unless some posts went out. */
function checkStatus(out: Record<string, unknown>, secrets: readonly string[]): void {
  if (out.status === "error" && arr(out.postIds).length === 0) {
    const msg = str(out.message) ?? str(obj(arr(out.errors)[0]).message) ?? "request failed";
    throw new Error(`Ayrshare: ${scrub(msg, secrets)}`);
  }
}

async function ayrshare(
  ctx: PackContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ out: Record<string, unknown>; secrets: string[] }> {
  const a = await auth(ctx);
  const headers = {
    ...a.headers,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const out = obj(
    await requestJson(
      ctx.fetch,
      "Ayrshare",
      `${AYRSHARE}${path}`,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      a.secrets,
    ),
  );
  checkStatus(out, a.secrets);
  return { out, secrets: a.secrets };
}

function errorsOf(v: unknown, secrets: readonly string[]) {
  return arr(v).map((e) => {
    const o = obj(e);
    const message = str(o.message);
    return {
      platform: str(o.platform),
      code: num(o.code),
      message: message === null ? null : scrub(message, secrets),
    };
  });
}

const post = defineTool({
  name: "ayrshare_post",
  description:
    "Publish (or schedule with `schedule_date`) a post to the social accounts linked in Ayrshare. `media_urls` are public image or video URLs. Returns the Ayrshare post id (needed to delete it) and each network's post id and URL.",
  secrets: ["AYRSHARE_API_KEY"],
  tags: ["sends"],
  annotations: {
    title: "Post to social networks (Ayrshare)",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    post: z.string().min(1).max(63_206),
    platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
    media_urls: z
      .array(z.url({ protocol: /^https?$/ }))
      .max(35)
      .optional(),
    schedule_date: z.iso.datetime({ offset: true }).optional(),
    shorten_links: z.boolean().optional(),
  }),
  async run(input, ctx) {
    const { out, secrets } = await ayrshare(ctx, "POST", "/post", {
      post: input.post,
      platforms: input.platforms,
      mediaUrls: input.media_urls,
      scheduleDate: input.schedule_date,
      shortenLinks: input.shorten_links,
    });
    return {
      id: str(out.id),
      status: str(out.status),
      ref_id: str(out.refId),
      posts: arr(out.postIds).map((p) => {
        const o = obj(p);
        return {
          platform: str(o.platform),
          status: str(o.status),
          id: str(o.id),
          url: str(o.postUrl),
        };
      }),
      errors: errorsOf(out.errors, secrets),
    };
  },
});

const del = defineTool({
  name: "ayrshare_delete_post",
  description:
    "Delete a post published or scheduled through Ayrshare, from every network it went to. `id` is the Ayrshare post id from ayrshare_post or ayrshare_history.",
  secrets: ["AYRSHARE_API_KEY"],
  tags: ["sends"],
  annotations: {
    title: "Delete social post (Ayrshare)",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ id }),
  async run(input, ctx) {
    const { out, secrets } = await ayrshare(ctx, "DELETE", "/post", { id: input.id });
    return { id: input.id, status: str(out.status), errors: errorsOf(out.errors, secrets) };
  },
});

const history = defineTool({
  name: "ayrshare_history",
  description:
    "List posts sent through Ayrshare, newest first: id, text, platforms, status, schedule and each network's post URL. `last_days` limits the window (default 30).",
  secrets: ["AYRSHARE_API_KEY"],
  annotations: { title: "Social post history (Ayrshare)", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    last_days: z.number().int().min(0).max(365).optional(),
  }),
  async run(input, ctx) {
    const q = new URLSearchParams();
    if (input.limit !== undefined) q.set("limit", String(input.limit));
    if (input.last_days !== undefined) q.set("lastDays", String(input.last_days));
    const qs = q.toString();
    const a = await auth(ctx);
    const res = await send(
      ctx.fetch,
      "Ayrshare",
      `${AYRSHARE}/history${qs ? `?${qs}` : ""}`,
      { headers: a.headers },
      a.secrets,
    );
    if (res.status === 400) {
      // An empty window is a 400 with code 221; anything else is a real error.
      const body = obj(await readJson("Ayrshare", res).catch(() => ({})));
      if (num(body.code) === 221) return { posts: [] };
      const msg = str(body.message) ?? "bad request";
      throw new Error(`Ayrshare 400: ${scrub(msg, a.secrets)}`);
    }
    if (!res.ok) throw await apiError("Ayrshare", res, a.secrets);
    const out: unknown = await readJson("Ayrshare", res);
    if (!Array.isArray(out)) checkStatus(obj(out), a.secrets);
    const list = Array.isArray(out) ? out : arr(obj(out).history);
    return {
      posts: list.map((p) => {
        const o = obj(p);
        return {
          id: str(o.id),
          post: str(o.post),
          platforms: arr(o.platforms).filter((x): x is string => typeof x === "string"),
          status: str(o.status),
          created: str(o.created),
          schedule_date: str(o.scheduleDate),
          posts: arr(o.postIds).map((x) => {
            const pi = obj(x);
            return { platform: str(pi.platform), id: str(pi.id), url: str(pi.postUrl) };
          }),
        };
      }),
    };
  },
});

export default definePack({ tools: [post, del, history] });
