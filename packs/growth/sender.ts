// packs/growth/sender.ts
//
// Saved sender profile (name, email, pitch, optional CTA) so outreach tools do
// not need the pitch repeated on every call. One JSON file in the pack dataDir,
// readable by the owner only (it holds the user's name and email).
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "plughive/pack";

export interface SenderProfile {
  name: string;
  email: string;
  /** Short description of what the sender offers; outreach context. */
  pitch: string;
  /** Optional default call-to-action link, such as a calendar or landing page URL. */
  cta_url?: string;
  /** Free-form context (company, role, persona). */
  bio?: string;
  updated_at: number;
}

// What a saved profile must look like; a hand-edited or corrupt file that does
// not match reads as "no profile" rather than feeding odd values into drafts.
const StoredProfile = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  pitch: z.string(),
  cta_url: z.url({ protocol: /^https?$/ }).optional(),
  bio: z.string().optional(),
  updated_at: z.number(),
});

export class SenderStore {
  private readonly root: string;
  private readonly path: string;

  constructor(opts: { root: string }) {
    mkdirSync(opts.root, { recursive: true, mode: 0o700 });
    this.root = opts.root;
    this.path = join(opts.root, "sender.json");
  }

  get(): SenderProfile | null {
    try {
      // Only a plain file: a symlink planted here is not followed.
      if (!lstatSync(this.path).isFile()) return null;
      const parsed = StoredProfile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  set(input: Omit<SenderProfile, "updated_at">): SenderProfile {
    const profile: SenderProfile = { ...input, updated_at: Date.now() };
    // Write a fresh owner-only temp file, then rename it over sender.json: a
    // crash never leaves half a file, and a symlink at sender.json is replaced,
    // not written through.
    const tmp = join(this.root, `.sender.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(profile, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return profile;
  }
}
