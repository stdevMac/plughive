// packs/growth/sender.ts
//
// Saved sender profile (name, email, pitch, optional CTA) so outreach tools do
// not need the pitch repeated on every call. One JSON file in the pack dataDir,
// readable by the owner only (it holds the user's name and email).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export class SenderStore {
  private readonly path: string;

  constructor(opts: { root: string }) {
    mkdirSync(opts.root, { recursive: true, mode: 0o700 });
    this.path = join(opts.root, "sender.json");
  }

  get(): SenderProfile | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as SenderProfile;
    } catch {
      return null;
    }
  }

  set(input: Omit<SenderProfile, "updated_at">): SenderProfile {
    const profile: SenderProfile = { ...input, updated_at: Date.now() };
    // `mode` only applies when the file is created; narrow an older 0644 file too.
    writeFileSync(this.path, JSON.stringify(profile, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
    return profile;
  }
}
