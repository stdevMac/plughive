// packs/growth/util.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ArtifactRef, LlmChatResult, PackContext } from "plughive/pack";

const skillCache = new Map<string, string>();

/** Text of a bundled skill (packs/growth/skills/<name>/SKILL.md), used as the system prompt base. */
export function readSkill(name: string): string {
  let text = skillCache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`./skills/${name}/SKILL.md`, import.meta.url), "utf8");
    skillCache.set(name, text);
  }
  return text;
}

/** Parse JSON the model may have wrapped in a fence or prose. */
export function parseJsonLoose(s: string, label: string): unknown {
  const trimmed = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // fall through to the error below
      }
    }
    throw new Error(`${label}: LLM returned invalid JSON: ${(e as Error).message}`);
  }
}

export function chat(
  ctx: PackContext,
  skill: string,
  instruction: string,
  user: string,
  model?: string,
): Promise<LlmChatResult> {
  return ctx.llm.chat({
    ...(model ? { model } : {}),
    messages: [
      { role: "system", content: `${readSkill(skill)}\n\n${instruction}` },
      { role: "user", content: user },
    ],
  });
}

export interface ArtifactSummary {
  id: string;
  mime: string;
  url: string;
}

export const summarize = (a: ArtifactRef): ArtifactSummary => ({
  id: a.id,
  mime: a.mime,
  url: a.url,
});

export async function saveJson(
  ctx: PackContext,
  tool: string,
  value: unknown,
  extra: {
    model?: string;
    prompt?: string;
    meta?: Record<string, unknown>;
    costUsd?: number | null;
  },
): Promise<ArtifactRef> {
  return ctx.library.save({
    kind: "data",
    mime: "application/json",
    bytes: new TextEncoder().encode(JSON.stringify(value, null, 2)),
    tool,
    model: extra.model ?? null,
    prompt: extra.prompt ?? null,
    meta: extra.meta ?? null,
    costUsd: extra.costUsd ?? null,
  });
}

export async function readArtifactText(ctx: PackContext, id: string): Promise<string | null> {
  const rec = await ctx.library.get(id);
  if (!rec) return null;
  return new TextDecoder().decode(await ctx.library.read(rec.id));
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

/**
 * Shorten a link through the optional dub_shorten_url tool. Returns the raw URL
 * when the tool is unavailable or fails, so drafting never depends on it.
 */
export async function shortenUrl(
  ctx: PackContext,
  url: string,
  tags: string[],
): Promise<{ url: string; linkId: string | null }> {
  try {
    const r = obj(await ctx.tools.call("dub_shorten_url", { url, tags }));
    const short = typeof r?.short_url === "string" ? r.short_url : null;
    if (short) return { url: short, linkId: typeof r?.id === "string" ? r.id : null };
  } catch (e) {
    ctx.logger.warn("link shortening unavailable; using the raw url", {
      err: (e as Error).message,
    });
  }
  return { url, linkId: null };
}

/**
 * Fetch a page as markdown through the optional firecrawl_scrape tool. Returns
 * null when no scrape tool is available or the scrape fails.
 */
export async function scrapePage(
  ctx: PackContext,
  url: string,
  maxChars: number,
): Promise<{ title: string | null; markdown: string } | null> {
  try {
    const r = obj(
      await ctx.tools.call("firecrawl_scrape", {
        url,
        formats: ["markdown"],
        only_main_content: true,
        timeout_ms: 30_000,
      }),
    );
    const md = typeof r?.markdown === "string" ? r.markdown.slice(0, maxChars) : "";
    if (!md.trim()) return null;
    return { title: typeof r?.title === "string" ? r.title : null, markdown: md };
  } catch (e) {
    ctx.logger.warn("page scrape unavailable; continuing without it", {
      url,
      err: (e as Error).message,
    });
    return null;
  }
}

export const siteUrl = (domain: string): string => {
  const bare = domain.replace(/^https?:\/\//, "");
  // A hostname is labels of letters, digits and hyphens: nothing that could
  // change the URL's meaning (userinfo, port, path, query, fragment).
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
      bare,
    )
  ) {
    throw new Error(`"${domain}" is not a valid domain (a hostname such as acme.com)`);
  }
  return `https://${bare}`;
};

/**
 * Wrap untrusted text (a scraped page) in a per-call boundary the text cannot
 * contain: the token is random for each call and stripped from the text first,
 * so the page cannot forge or close the block. Prompts must treat what is
 * inside the markers as data, never as instructions.
 */
export function untrustedBlock(text: string, label = "UNTRUSTED CONTENT"): string {
  const token = randomBytes(24).toString("hex");
  const clean = text.split(token).join("");
  return `-----BEGIN ${label} (${token})-----\n${clean}\n-----END ${label} (${token})-----`;
}
