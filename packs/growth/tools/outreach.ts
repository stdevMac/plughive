// packs/growth/tools/outreach.ts
//
// Outreach tools: sender profile, cold-email drafting, personalization from
// scraped pages, draft listing, contact-status tracking. There is no default
// call to action: it comes from the tool input or the saved sender profile.
import { defineTool, z } from "plughive/pack";
import { draftInstruction, personalizeInstruction } from "../prompts.js";
import type { GrowthCtx, GrowthServices } from "../services.js";
import { CONTACT_STATUSES } from "../types.js";
import {
  chat,
  parseJsonLoose,
  readArtifactText,
  saveJson,
  scrapePage,
  shortenUrl,
  siteUrl,
  summarize,
  untrustedBlock,
} from "../util.js";

// ------------------------------------------------------- sender profile

const SetSenderInput = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  pitch: z.string().min(10),
  cta_url: z.url({ protocol: /^https?$/ }).optional(),
  bio: z.string().optional(),
});

const profileOut = (p: {
  name: string;
  email: string;
  pitch: string;
  cta_url?: string;
  bio?: string;
  updated_at: number;
}) => ({
  name: p.name,
  email: p.email,
  pitch: p.pitch,
  cta_url: p.cta_url ?? null,
  bio: p.bio ?? null,
  updated_at: p.updated_at,
});

export const setSenderProfile = defineTool<typeof SetSenderInput, GrowthServices>({
  name: "set_sender_profile",
  description:
    "Save the default sender profile (name, email, pitch, optional cta_url and bio). draft_cold_email, " +
    "personalize_outreach and pipeline_run use it when no sender is passed in the call. The profile is " +
    "the only source of the pitch and default call to action; nothing is built in.",
  input: SetSenderInput,
  async run(input, ctx) {
    const p = ctx.sender.set(input);
    ctx.logger.info("sender profile saved");
    return { saved: true, profile: profileOut(p) };
  },
});

const EmptyInput = z.object({});

export const getSenderProfile = defineTool<typeof EmptyInput, GrowthServices>({
  name: "get_sender_profile",
  description: "Return the saved sender profile, or { exists: false } if none is set.",
  annotations: { readOnlyHint: true },
  input: EmptyInput,
  async run(_input, ctx) {
    const p = ctx.sender.get();
    return p ? { exists: true, profile: profileOut(p) } : { exists: false, profile: null };
  },
});

// -------------------------------------------------------------- drafting

export const SenderInput = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  pitch: z.string().min(10),
});

const Touch = z.object({ subject: z.string().min(1), body: z.string().min(1) });
const DraftSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  follow_up_1: Touch,
  follow_up_2: Touch,
});
const PersonalizedSchema = DraftSchema.extend({ personalization_notes: z.string().optional() });

const URL_RE = /https?:\/\/[^\s<>"'`)]+/g;

/**
 * Post-validate a generated draft: it may link only to the CTA itself (raw or
 * shortened, exactly: a shortener's host is shared with everyone) or to the
 * prospect's own domain. Anything else (a link a scraped page injected into the
 * model) refuses the draft instead of being saved.
 */
function assertDraftLinks(
  tool: string,
  draft: z.infer<typeof DraftSchema>,
  ctaLinks: readonly string[],
  domain: string | null,
): void {
  const site = domain ? domain.toLowerCase().replace(/^www\./, "") : null;
  const texts = [
    draft.subject,
    draft.body,
    draft.follow_up_1.subject,
    draft.follow_up_1.body,
    draft.follow_up_2.subject,
    draft.follow_up_2.body,
  ];
  for (const text of texts) {
    for (const m of text.matchAll(URL_RE)) {
      // Sentence punctuation right after a link is not part of it.
      const link = m[0].replace(/[.,;:!?]+$/, "");
      let host: string | null = null;
      try {
        host = new URL(link).hostname.toLowerCase();
      } catch {
        host = null;
      }
      const ok =
        ctaLinks.some((c) => sameLink(c, link)) ||
        (host !== null && site !== null && (host === site || host.endsWith(`.${site}`)));
      if (!ok) {
        throw new Error(
          `${tool}: the draft links to ${link}, which is neither the call to action nor the prospect's own domain; refusing to save a draft with foreign links`,
        );
      }
    }
  }
}

/** The same link, ignoring a trailing slash. */
function sameLink(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** The CTA links: the raw cta_url and its shortened form. */
function ctaLinksOf(cta: string | null, shortUrl: string | null): string[] {
  return [cta, shortUrl].filter((u): u is string => typeof u === "string" && u !== "");
}

interface Resolved {
  sender: z.infer<typeof SenderInput>;
  cta: string | null;
}

function resolveSender(
  tool: string,
  ctx: GrowthCtx,
  inline: z.infer<typeof SenderInput> | undefined,
  ctaInput: string | undefined,
): Resolved {
  const profile = ctx.sender.get();
  const sender =
    inline ?? (profile ? { name: profile.name, email: profile.email, pitch: profile.pitch } : null);
  if (!sender) {
    throw new Error(
      `${tool}: no sender provided and no saved profile (call set_sender_profile first or pass sender inline)`,
    );
  }
  return { sender, cta: ctaInput ?? profile?.cta_url ?? null };
}

function leadContext(ctx: GrowthCtx, personId: string) {
  const person = ctx.leads.getPerson(personId);
  if (!person) throw new Error(`person ${personId} not found`);
  const company = person.company_id ? ctx.leads.getCompany(person.company_id) : null;
  return {
    person,
    company,
    json: {
      person: {
        first_name: person.first_name,
        last_name: person.last_name,
        title: person.title,
        seniority: person.seniority,
        email: person.email,
      },
      company: company
        ? {
            name: company.name,
            domain: company.domain,
            industry: company.industry,
            employee_count: company.employee_count,
          }
        : null,
    },
    label: `${person.first_name ?? ""} ${person.last_name ?? ""} @ ${company?.name ?? ""}`.trim(),
  };
}

const DraftInput = z.object({
  person_id: z.string().min(1),
  /** Inline sender override. If omitted, the saved sender profile is used. */
  sender: SenderInput.optional(),
  research_artifact_id: z.string().optional(),
  /** Call-to-action URL. Falls back to the sender profile's cta_url; with neither, no link is used. */
  cta_url: z.url({ protocol: /^https?$/ }).optional(),
  model: z.string().optional(),
});

export async function runDraftColdEmail(input: z.infer<typeof DraftInput>, ctx: GrowthCtx) {
  const lead = leadContext(ctx, input.person_id);
  const { sender, cta } = resolveSender("draft_cold_email", ctx, input.sender, input.cta_url);
  const research = input.research_artifact_id
    ? await readArtifactText(ctx, input.research_artifact_id)
    : null;

  let shortUrl: string | null = null;
  let linkId: string | null = null;
  if (cta) {
    const s = await shortenUrl(ctx, cta, ["cold_email", lead.person.id]);
    shortUrl = s.url;
    linkId = s.linkId;
  }

  const user = JSON.stringify(
    { sender, ...lead.json, research_brief: research, cta_url: shortUrl },
    null,
    2,
  );
  const resp = await chat(ctx, "cold-email", draftInstruction(shortUrl), user, input.model);
  const draft = DraftSchema.parse(parseJsonLoose(resp.text, "draft_cold_email"));
  assertDraftLinks(
    "draft_cold_email",
    draft,
    ctaLinksOf(cta, shortUrl),
    lead.company?.domain ?? null,
  );

  const artifact = await saveJson(
    ctx,
    "draft_cold_email",
    { draft, sender, short_url: shortUrl, dub_link_id: linkId },
    {
      model: resp.model,
      prompt: lead.label,
      meta: { person_id: lead.person.id, dub_link_id: linkId },
      costUsd: resp.costUsd,
    },
  );
  ctx.leads.markContacted(lead.person.id, "drafted", artifact.id);
  ctx.logger.info("draft created", { person_id: lead.person.id, artifact: artifact.id });
  return {
    subject: draft.subject,
    body: draft.body,
    follow_up_1: draft.follow_up_1,
    follow_up_2: draft.follow_up_2,
    short_url: shortUrl,
    dub_link_id: linkId,
    artifact: summarize(artifact),
  };
}

export const draftColdEmail = defineTool<typeof DraftInput, GrowthServices>({
  name: "draft_cold_email",
  description:
    "Draft a 3-touch cold email sequence for a person. The sender comes from the inline sender or the " +
    "saved profile; the call to action from cta_url or the profile (none means no link). A CTA link is " +
    "shortened through dub_shorten_url when that tool is available, else used as given. Saves the draft " +
    "as a JSON artifact and marks the person 'drafted'. Uses an LLM.",
  input: DraftInput,
  run: (input, ctx) => runDraftColdEmail(input, ctx as GrowthCtx),
});

const PersonalizeInput = z.object({
  person_id: z.string().min(1),
  sender: SenderInput.optional(),
  /** Extra URLs to read (for example https://acme.com/pricing). Capped at 3. */
  include_pages: z
    .array(z.url({ protocol: /^https?$/ }))
    .max(3)
    .optional(),
  cta_url: z.url({ protocol: /^https?$/ }).optional(),
  model: z.string().optional(),
});

export async function runPersonalizeOutreach(
  input: z.infer<typeof PersonalizeInput>,
  ctx: GrowthCtx,
) {
  const lead = leadContext(ctx, input.person_id);
  const { sender, cta } = resolveSender("personalize_outreach", ctx, input.sender, input.cta_url);

  const urls: string[] = [];
  if (lead.company?.domain) urls.push(siteUrl(lead.company.domain));
  if (input.include_pages) urls.push(...input.include_pages);

  const pagesScraped: Array<{ url: string; title: string | null; bytes: number }> = [];
  const sections: string[] = [];
  for (const u of urls.slice(0, 4)) {
    const page = await scrapePage(ctx, u, 5000);
    if (!page) continue;
    pagesScraped.push({
      url: u,
      title: page.title,
      bytes: new TextEncoder().encode(page.markdown).length,
    });
    // Scraped text is untrusted: it goes into the prompt inside a per-call
    // boundary it cannot forge, marked as data rather than instructions.
    sections.push(
      `### ${page.title ?? u}\nSource: ${u}\n\n${untrustedBlock(page.markdown, "SCRAPED PAGE")}`,
    );
  }
  const scraped =
    sections.length > 0
      ? `\n\nLive scraped pages:\n${sections.join("\n\n---\n\n")}`
      : "\n\n(no live page content available; relying on lead data alone)";

  let shortUrl: string | null = null;
  let linkId: string | null = null;
  if (cta) {
    const s = await shortenUrl(ctx, cta, ["personalize_outreach", lead.person.id]);
    shortUrl = s.url;
    linkId = s.linkId;
  }

  const user = JSON.stringify({ sender, ...lead.json, cta_url: shortUrl }, null, 2) + scraped;
  const resp = await chat(ctx, "cold-email", personalizeInstruction(shortUrl), user, input.model);
  const draft = PersonalizedSchema.parse(parseJsonLoose(resp.text, "personalize_outreach"));
  assertDraftLinks(
    "personalize_outreach",
    draft,
    ctaLinksOf(cta, shortUrl),
    lead.company?.domain ?? null,
  );

  const artifact = await saveJson(
    ctx,
    "personalize_outreach",
    { draft, sender, short_url: shortUrl, dub_link_id: linkId, pages_scraped: pagesScraped },
    {
      model: resp.model,
      prompt: lead.label,
      meta: { person_id: lead.person.id, dub_link_id: linkId, pages_scraped: pagesScraped.length },
      costUsd: resp.costUsd,
    },
  );
  ctx.leads.markContacted(lead.person.id, "drafted", artifact.id);
  ctx.logger.info("personalized draft created", {
    person_id: lead.person.id,
    pages_scraped: pagesScraped.length,
    artifact: artifact.id,
  });
  return {
    subject: draft.subject,
    body: draft.body,
    follow_up_1: draft.follow_up_1,
    follow_up_2: draft.follow_up_2,
    personalization_notes: draft.personalization_notes ?? null,
    pages_scraped: pagesScraped,
    short_url: shortUrl,
    dub_link_id: linkId,
    artifact: summarize(artifact),
  };
}

export const personalizeOutreach = defineTool<typeof PersonalizeInput, GrowthServices>({
  name: "personalize_outreach",
  description:
    "Draft a 3-touch cold email sequence grounded in the prospect's website. Reads the company homepage " +
    "(and optional include_pages) through a scrape tool when one is available; without one it drafts " +
    "from lead data alone. Same sender and CTA rules as draft_cold_email. Uses an LLM.",
  annotations: { openWorldHint: true },
  input: PersonalizeInput,
  run: (input, ctx) => runPersonalizeOutreach(input, ctx as GrowthCtx),
});

// ------------------------------------------------------------ list_drafts

const ListDraftsInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  fit_score_min: z.number().int().min(0).max(100).optional(),
  since_iso: z.string().optional(),
});

export const listDrafts = defineTool<typeof ListDraftsInput, GrowthServices>({
  name: "list_drafts",
  description:
    "List recent cold-email drafts (from draft_cold_email and personalize_outreach) joined to their lead " +
    "and company rows. Optional filter by fit_score_min and ISO since_iso. Returns ready-to-paste " +
    "subject and body for each touch.",
  annotations: { readOnlyHint: true },
  input: ListDraftsInput,
  async run(input, rawCtx) {
    const ctx = rawCtx as GrowthCtx;
    const since = input.since_iso ? { since: input.since_iso } : {};
    const cap = Math.min(input.limit * 4, 200);
    const [a, b] = await Promise.all([
      ctx.library.list({ tool: "draft_cold_email", limit: cap, ...since }),
      ctx.library.list({ tool: "personalize_outreach", limit: cap, ...since }),
    ]);
    const arts = [...a, ...b].sort((x, y) => y.createdAt.localeCompare(x.createdAt));

    const drafts = [];
    for (const art of arts) {
      type Part = { subject: string; body: string };
      let payload: {
        draft?: { subject?: string; body?: string; follow_up_1?: Part; follow_up_2?: Part };
        short_url?: string | null;
        dub_link_id?: string | null;
      } | null;
      try {
        payload = JSON.parse((await readArtifactText(ctx, art.id)) ?? "");
      } catch (e) {
        ctx.logger.warn("draft artifact unreadable", {
          artifact: art.id,
          err: (e as Error).message,
        });
        continue;
      }
      const draft = payload?.draft;
      if (!draft?.subject) continue;

      const personId = (art.meta as { person_id?: string } | null)?.person_id ?? null;
      const person = personId ? ctx.leads.getPerson(personId) : null;
      const company = person?.company_id ? ctx.leads.getCompany(person.company_id) : null;
      if (input.fit_score_min !== undefined && (person?.fit_score ?? -1) < input.fit_score_min) {
        continue;
      }
      const fullName = [person?.first_name, person?.last_name].filter(Boolean).join(" ").trim();
      drafts.push({
        artifact_id: art.id,
        created_at: art.createdAt,
        cost_usd: art.costUsd,
        person: {
          id: person?.id ?? null,
          name: fullName || (person?.email ?? "(unknown)"),
          email: person?.email ?? null,
          title: person?.title ?? null,
          company: company?.name ?? null,
          fit_score: person?.fit_score ?? null,
        },
        short_url: payload?.short_url ?? null,
        dub_link_id: payload?.dub_link_id ?? null,
        subject: draft.subject as string,
        body: draft.body as string,
        follow_up_1: draft.follow_up_1 ?? { subject: "", body: "" },
        follow_up_2: draft.follow_up_2 ?? { subject: "", body: "" },
      });
      if (drafts.length >= input.limit) break;
    }
    return { count: drafts.length, drafts };
  },
});

// ---------------------------------------------------------- mark_contacted

const MarkInput = z.object({
  person_id: z.string().min(1),
  status: z.enum(CONTACT_STATUSES),
  /** Optional artifact id (for example a sent-email log) to attach. */
  artifact_id: z.string().optional(),
});

export const markContacted = defineTool<typeof MarkInput, GrowthServices>({
  name: "mark_contacted",
  description:
    "Update a person's contact_status (new|drafted|sent|replied|won|lost|skipped). Bumps " +
    "last_contacted_at. Use after sending an email, on reply, or to skip a lead. draft_cold_email and " +
    "personalize_outreach already mark 'drafted'.",
  input: MarkInput,
  async run(input, ctx) {
    if (!ctx.leads.getPerson(input.person_id))
      throw new Error(`person ${input.person_id} not found`);
    ctx.leads.markContacted(input.person_id, input.status, input.artifact_id);
    const after = ctx.leads.getPerson(input.person_id)!;
    return {
      person_id: after.id,
      status: after.contact_status ?? "new",
      last_contacted_at: after.last_contacted_at,
    };
  },
});

export const outreachTools = [
  setSenderProfile,
  getSenderProfile,
  draftColdEmail,
  personalizeOutreach,
  listDrafts,
  markContacted,
];
