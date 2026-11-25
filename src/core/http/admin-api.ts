// src/core/http/admin-api.ts
//
// Write side of the management API: packs, their settings and secrets, the
// capability preferences and the mounted upstream servers.
//
//   GET    /api/packs                       every pack with its state, tools, secrets (names only)
//   GET    /api/packs/:id/consent           what enabling the pack means, with the hashes to confirm
//   POST   /api/packs/:id/enable            {grants?, manifestHash?, entryHash?}; a user pack needs
//                                           both hashes from /consent (409 when the pack changed)
//   POST   /api/packs/:id/disable
//   POST   /api/packs/:id/reload
//   GET    /api/packs/:id/settings          the declared schema and the values in effect
//   PUT    /api/packs/:id/settings          {values: {key: value | null}} (null clears a key)
//
//   GET    /api/secrets                     names per pack with present/absent and the source
//                                           (keychain | file | memory | env). Never a value.
//   PUT    /api/secrets/:pack/:name         {value}. Write only: the value is never echoed.
//   DELETE /api/secrets/:pack/:name         removes the stored value
//                                           (:pack is a pack id, or "user" for a name that a
//                                           mount in mounts.json refers to)
//
//   GET    /api/capabilities                providers per capability and the preference order
//   PUT    /api/capabilities/:name/preference   {order: [provider id, ...]} ([] clears it)
//
//   GET    /api/mounts                      pack mounts and user mounts with connection state
//   POST   /api/mounts                      add a user mount to mounts.json (http or stdio)
//   POST   /api/mounts/:owner/:id/enable    :owner is a pack id or "user"
//   POST   /api/mounts/:owner/:id/disable
//   DELETE /api/mounts/user/:id             remove a user mount
//   POST   /api/mounts/:owner/:id/oauth/start  begin signing in to an OAuth mount:
//                                           { authorization_url } to open in a browser
//   GET    /api/mounts/:owner/:id/oauth     { signed_in, pending } of an OAuth mount
//   DELETE /api/mounts/:owner/:id/oauth     sign out: forget the mount's tokens
//   GET    /api/mounts/smart                smart mount report: usage, token cost, suggestions
//   PUT    /api/mounts/smart                smart mount settings { mode, idleDays, keep, wake }
//   POST   /api/mounts/smart/park           park suggested mounts { ids? } (src/core/mounts/smart.ts)
//   POST   /api/mounts/smart/apply          apply profile suggestions { keys? }
//   POST   /api/mounts/smart/undo           undo profile changes { keys }
//
// Everything sits behind the admin token (admin-auth.ts; required in every
// configuration, loopback included), the Origin guard and the CSRF rule.
// A stdio mount starts a program on this machine, so it is created here, by
// editing mounts.json, or by the add_mount tool after a person approved it in
// the approvals queue. No MCP tool and no pack reaches this API, because
// requests made through a pack's fetch are refused app-wide.
// A secret can only be stored under a name some pack or user mount declares;
// values are never returned, logged or put into an error message.
import type { Express, Response } from "express";
import { z } from "zod";
import {
  type CapabilityPreferences,
  PROVIDER_ID_RE,
  getCapabilityPreferences,
  setCapabilityPreference,
  setCapabilityPreferences,
} from "../capabilities/router.js";
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  isCapabilityName,
} from "../capabilities/schemas.js";
import { type MountManager, MountOAuthError } from "../mounts/manager.js";
import { SmartMountSettingsPatch, type SmartMounts } from "../mounts/smart.js";
import { USER_MOUNT_PACK, UserMountsError } from "../mounts/user-mounts.js";
import type { CapabilityProviderInfo } from "../pack-api.js";
import { PackChangedError, type PackLoader, PackSettingsError } from "../packs/loader.js";
import { SETTING_LIST_ITEM_MAX_CHARS, SETTING_LIST_MAX_ITEMS } from "../packs/manifest.js";
import { PACK_ID_PATTERN, isDeniedSecretName } from "../packs/manifest.js";
import type { LayeredSecretStore } from "../secrets/index.js";
import { SECRET_NAME_PATTERN } from "../secrets/index.js";
import { type ApiLogger, apiRouter, fail, mountApi, parse, route } from "./api-common.js";
import type { OriginPolicy } from "./origin.js";
import { MAX_SECRET_VALUE_LENGTH } from "./secret-setup.js";

export interface AdminApiDeps {
  origin: OriginPolicy;
  logger?: ApiLogger;
  /** $PLUGHIVE_HOME (capability preferences live there). */
  home: string;
  loader: Pick<
    PackLoader,
    | "listPacks"
    | "describeConsent"
    | "enable"
    | "disable"
    | "reload"
    | "getSettings"
    | "setSettings"
  >;
  mounts: Pick<
    MountManager,
    | "listMounts"
    | "userFileError"
    | "setMountEnabled"
    | "addUserMount"
    | "removeUserMount"
    | "sync"
    | "oauthStart"
    | "oauthSignOut"
  >;
  capabilities: { list(capability?: CapabilityName): Promise<CapabilityProviderInfo[]> };
  secrets: Pick<LayeredSecretStore, "set" | "delete" | "has" | "source" | "backendKind">;
  /** Smart mount. Absent: no /api/mounts/smart routes. */
  smart?: Pick<SmartMounts, "report" | "park" | "setSettings" | "applyProfiles" | "undo">;
  /** Makes a loader message safe to return (secrets redacted, private paths hidden). */
  scrub?: (text: string) => string;
  /** Called after packs or mounts changed (the event stream looks again). */
  changed?: () => void;
}

const HASH = z.string().min(1).max(200);
const EnableBody = z
  .object({
    grants: z.array(z.string().regex(SECRET_NAME_PATTERN)).max(64).optional(),
    manifestHash: HASH.optional(),
    entryHash: HASH.optional(),
  })
  .strict();
const SettingsBody = z
  .object({
    values: z.record(
      z.string().min(1).max(64),
      z.union([
        z.string().max(4096),
        z.number(),
        z.boolean(),
        z.null(),
        // A list setting (type "array"); the loader checks each item.
        z
          .array(z.string().max(SETTING_LIST_ITEM_MAX_CHARS))
          .max(SETTING_LIST_MAX_ITEMS),
      ]),
    ),
  })
  .strict();
const SecretBody = z.object({ value: z.string().min(1).max(MAX_SECRET_VALUE_LENGTH) }).strict();
const PreferenceBody = z
  .object({ order: z.array(z.string().regex(PROVIDER_ID_RE)).max(32) })
  .strict();
const BulkPreferenceBody = z
  .object({
    orders: z
      .record(z.string(), z.array(z.string().regex(PROVIDER_ID_RE)).max(32))
      .refine((o) => Object.keys(o).length <= CAPABILITY_NAMES.length, "too many capabilities"),
  })
  .strict();
const EmptyBody = z.object({}).strict().optional();

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "unexpected error");

export function mountAdminApi(app: Express, deps: AdminApiDeps): void {
  const { loader, mounts } = deps;
  const scrub = (text: string) => (deps.scrub ? deps.scrub(text) : text).slice(0, 500);
  const changed = () => deps.changed?.();
  const unknownPack = (res: Response) => fail(res, 404, "UNKNOWN_PACK", "no such pack");
  const packId = (raw: string | undefined) =>
    raw !== undefined && PACK_ID_PATTERN.test(raw) ? raw : null;
  const statusOf = async (id: string) => (await loader.listPacks()).find((p) => p.id === id);
  /** A loader refusal: 404 for an unknown pack, else 400 with the scrubbed reason. */
  const packFailure = (res: Response, e: unknown) => {
    const message = messageOf(e);
    if (message.startsWith("unknown pack")) return unknownPack(res);
    return fail(res, 400, "PACK_ERROR", scrub(message));
  };

  // ---- packs --------------------------------------------------------------
  const packs = apiRouter(deps.origin);
  packs.get(
    "/",
    route(async (_req, res) => {
      res.json({ ok: true, packs: await loader.listPacks() });
    }),
  );
  packs.get(
    "/:id/consent",
    route(async (req, res) => {
      const id = packId(req.params.id);
      if (!id) return unknownPack(res);
      try {
        res.json({ ok: true, consent: await loader.describeConsent(id) });
      } catch (e) {
        packFailure(res, e);
      }
    }),
  );
  packs.post(
    "/:id/enable",
    route(async (req, res) => {
      const id = packId(req.params.id);
      if (!id) return unknownPack(res);
      const body = parse(EnableBody, req.body ?? {}, res);
      if (!body) return;
      try {
        const consent = await loader.describeConsent(id);
        if (consent.source === "user") {
          // The user agrees to what /consent showed them, not to whatever is
          // on disk by the time this request arrives.
          if (!body.manifestHash || !body.entryHash) {
            return fail(
              res,
              400,
              "CONSENT_REQUIRED",
              "enabling a user pack needs manifestHash and entryHash from GET /api/packs/<id>/consent",
            );
          }
        }
        // The loader compares these with what it records, in one step.
        await loader.enable(id, {
          grants: body.grants ?? [],
          ...(body.manifestHash && body.entryHash
            ? { expected: { manifestHash: body.manifestHash, entryHash: body.entryHash } }
            : {}),
        });
      } catch (e) {
        if (e instanceof PackChangedError) {
          return fail(
            res,
            409,
            "PACK_CHANGED",
            "the pack changed since it was reviewed; review it again",
          );
        }
        return packFailure(res, e);
      } finally {
        changed();
      }
      res.json({ ok: true, pack: (await statusOf(id)) ?? null });
    }),
  );
  for (const action of ["disable", "reload"] as const) {
    packs.post(
      `/:id/${action}`,
      route(async (req, res) => {
        const id = packId(req.params.id);
        if (!id) return unknownPack(res);
        if (parse(EmptyBody, req.body, res) === undefined && req.body !== undefined) return;
        try {
          await loader[action](id);
        } catch (e) {
          return packFailure(res, e);
        } finally {
          changed();
        }
        res.json({ ok: true, pack: (await statusOf(id)) ?? null });
      }),
    );
  }
  packs.get(
    "/:id/settings",
    route((req, res) => {
      const id = packId(req.params.id);
      if (!id) return unknownPack(res);
      try {
        res.json({ ok: true, pack: id, ...loader.getSettings(id) });
      } catch (e) {
        packFailure(res, e);
      }
    }),
  );
  packs.put(
    "/:id/settings",
    route(async (req, res) => {
      const id = packId(req.params.id);
      if (!id) return unknownPack(res);
      const body = parse(SettingsBody, req.body, res);
      if (!body) return;
      try {
        await loader.setSettings(id, body.values);
      } catch (e) {
        if (e instanceof PackSettingsError) {
          return fail(res, 400, "INVALID_SETTINGS", scrub(e.message));
        }
        return packFailure(res, e);
      } finally {
        changed();
      }
      res.json({ ok: true, pack: id, ...loader.getSettings(id) });
    }),
  );
  mountApi(app, "/api/packs", packs, deps.logger);

  // ---- secrets ------------------------------------------------------------
  interface SecretRow {
    pack: string;
    name: string;
    label: string | null;
    help_url: string | null;
    required: boolean;
    granted: boolean;
    /** A user pack or a user mount: only a stored value counts, never the environment. */
    stored_only: boolean;
  }
  /** Every secret name something declares. The only names this API accepts. */
  const declaredSecrets = async (): Promise<SecretRow[]> => {
    const rows: SecretRow[] = [];
    for (const p of await loader.listPacks()) {
      for (const s of p.secrets) {
        rows.push({
          pack: p.id,
          name: s.name,
          label: s.label ?? null,
          help_url: s.helpUrl ?? null,
          required: s.required,
          granted: s.granted,
          stored_only: p.source !== "builtin",
        });
      }
    }
    const seen = new Set<string>();
    for (const m of await mounts.listMounts()) {
      if (m.source !== "user") continue;
      for (const s of m.secrets) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        rows.push({
          pack: USER_MOUNT_PACK,
          name: s.name,
          label: null,
          help_url: null,
          required: true,
          granted: true,
          stored_only: true,
        });
      }
    }
    return rows.filter((r) => SECRET_NAME_PATTERN.test(r.name) && !isDeniedSecretName(r.name));
  };
  const secretTarget = async (pack: string | undefined, name: string | undefined) => {
    if (pack === undefined || name === undefined) return null;
    if (pack !== USER_MOUNT_PACK && !PACK_ID_PATTERN.test(pack)) return null;
    if (!SECRET_NAME_PATTERN.test(name) || isDeniedSecretName(name)) return null;
    return (await declaredSecrets()).find((r) => r.pack === pack && r.name === name) ?? null;
  };
  const unknownSecret = (res: Response) =>
    fail(res, 404, "UNKNOWN_SECRET", "no pack or mount declares a secret of that name");

  const secrets = apiRouter(deps.origin);
  secrets.get(
    "/",
    route(async (_req, res) => {
      const out = [];
      for (const row of await declaredSecrets()) {
        let source: string | null = null;
        try {
          source = await deps.secrets.source(row.name);
          if (source === "env" && row.stored_only) source = null;
        } catch {
          source = null;
        }
        out.push({ ...row, present: source !== null, source });
      }
      res.json({ ok: true, backend: deps.secrets.backendKind, secrets: out });
    }),
  );
  secrets.put(
    "/:pack/:name",
    route(async (req, res) => {
      const target = await secretTarget(req.params.pack, req.params.name);
      if (!target) return unknownSecret(res);
      // Not through parse(): a zod issue could quote the value.
      const body = SecretBody.safeParse(req.body);
      if (!body.success) {
        return fail(
          res,
          400,
          "INVALID_REQUEST",
          `the body must be {"value": "<1 to ${MAX_SECRET_VALUE_LENGTH} characters>"}`,
        );
      }
      await deps.secrets.set(target.name, body.data.value);
      deps.logger?.info({ pack: target.pack, secret: target.name }, "secret stored");
      // A mount that waited for this secret can connect now.
      await mounts.sync().catch(() => undefined);
      changed();
      res.json({ ok: true, pack: target.pack, name: target.name, present: true });
    }),
  );
  secrets.delete(
    "/:pack/:name",
    route(async (req, res) => {
      const target = await secretTarget(req.params.pack, req.params.name);
      if (!target) return unknownSecret(res);
      await deps.secrets.delete(target.name);
      deps.logger?.info({ pack: target.pack, secret: target.name }, "secret removed");
      await mounts.sync().catch(() => undefined);
      changed();
      // An environment variable of that name still provides a value (to a bundled pack).
      const present = target.stored_only
        ? false
        : await deps.secrets.has(target.name).catch(() => false);
      res.json({ ok: true, pack: target.pack, name: target.name, present });
    }),
  );
  mountApi(app, "/api/secrets", secrets, deps.logger);

  // ---- capabilities -------------------------------------------------------
  const capabilityView = async (prefs: CapabilityPreferences) => {
    const providers = await deps.capabilities.list();
    const now = Date.now();
    return CAPABILITY_NAMES.map((name) => {
      const mine = providers.filter((p) => p.capability === name);
      // What a call without `provider` would run first: the list is already
      // in routing order, so the first ready provider it would pick.
      const ready = (p: (typeof mine)[number]) => p.configured && p.autoRoute;
      const first =
        mine.find(
          (p) => ready(p) && (p.coolingDownUntil === null || Date.parse(p.coolingDownUntil) <= now),
        ) ?? mine.find(ready);
      return {
        name,
        preference: prefs.order[name] ?? [],
        wouldUse: first?.id ?? null,
        providers: mine,
      };
    });
  };
  const capabilities = apiRouter(deps.origin);
  capabilities.get(
    "/",
    route(async (_req, res) => {
      res.json({
        ok: true,
        capabilities: await capabilityView(getCapabilityPreferences(deps.home)),
      });
    }),
  );
  capabilities.put(
    "/preference",
    route(async (req, res) => {
      const body = parse(BulkPreferenceBody, req.body, res);
      if (!body) return;
      const unknown = Object.keys(body.orders).find((n) => !isCapabilityName(n));
      if (unknown !== undefined) {
        return fail(res, 404, "UNKNOWN_CAPABILITY", "no such capability");
      }
      const prefs = setCapabilityPreferences(
        deps.home,
        body.orders as Partial<Record<CapabilityName, string[]>>,
      );
      res.json({ ok: true, capabilities: await capabilityView(prefs) });
    }),
  );
  capabilities.put(
    "/:name/preference",
    route(async (req, res) => {
      const name = req.params.name;
      if (!isCapabilityName(name)) {
        return fail(res, 404, "UNKNOWN_CAPABILITY", "no such capability");
      }
      const body = parse(PreferenceBody, req.body, res);
      if (!body) return;
      const prefs = setCapabilityPreference(deps.home, name, body.order);
      const view = await capabilityView(prefs);
      res.json({ ok: true, capability: view.find((c) => c.name === name) });
    }),
  );
  mountApi(app, "/api/capabilities", capabilities, deps.logger);

  // ---- mounts -------------------------------------------------------------
  const MOUNT_STATUS: Record<UserMountsError["code"], number> = {
    INVALID_MOUNT: 400,
    MOUNT_EXISTS: 409,
    MOUNT_LIMIT: 409,
    MOUNTS_FILE_INVALID: 409,
    UNKNOWN_MOUNT: 404,
  };
  const mountFailure = (res: Response, e: unknown) => {
    if (e instanceof UserMountsError) {
      const issues = (e.issues as { path?: unknown[]; message?: string }[] | undefined)
        ?.slice(0, 20)
        .map((i) => ({
          path: Array.isArray(i.path) ? i.path.join(".") : "",
          message: String(i.message ?? "").slice(0, 300),
        }));
      return fail(res, MOUNT_STATUS[e.code], e.code, scrub(e.message), issues);
    }
    if (e instanceof MountOAuthError) {
      const status = { UNKNOWN_MOUNT: 404, NOT_OAUTH: 409, OAUTH_FAILED: 502 }[e.code];
      return fail(res, status, e.code, e.code === "UNKNOWN_MOUNT" ? "no such mount" : e.message);
    }
    const message = messageOf(e);
    if (message.startsWith("unknown mount")) {
      return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
    }
    if (/cannot be switched on/.test(message)) {
      return fail(res, 409, "MOUNT_NOT_MOUNTABLE", scrub(message));
    }
    throw e;
  };
  const listView = async () => ({
    mounts: await mounts.listMounts(),
    mounts_file_error: mounts.userFileError(),
  });
  const MOUNT_PART = /^[a-z][a-z0-9-]{1,31}$/;

  const mountsRouter = apiRouter(deps.origin);
  mountsRouter.get(
    "/",
    route(async (_req, res) => {
      res.json({ ok: true, ...(await listView()) });
    }),
  );
  mountsRouter.post(
    "/",
    route(async (req, res) => {
      const body: unknown = req.body;
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return fail(res, 400, "INVALID_MOUNT", "the body must be a mount object");
      }
      let id: string;
      try {
        id = await mounts.addUserMount(body);
      } catch (e) {
        return mountFailure(res, e);
      }
      const transport = (body as { transport?: unknown }).transport;
      deps.logger?.info({ mount: id, transport: String(transport) }, "user mount added");
      changed();
      res
        .status(201)
        .json({ ok: true, id, mount: (await mounts.listMounts()).find((m) => m.id === id) });
    }),
  );
  const smart = deps.smart;
  if (smart) {
    mountsRouter.get(
      "/smart",
      route(async (_req, res) => {
        res.json({ ok: true, ...(await smart.report()) });
      }),
    );
    mountsRouter.put(
      "/smart",
      route(async (req, res) => {
        const body = SmartMountSettingsPatch.safeParse(req.body);
        if (!body.success) {
          return fail(
            res,
            400,
            "INVALID_SETTINGS",
            body.error.issues[0]?.message ?? "invalid settings",
          );
        }
        const settings = smart.setSettings(body.data);
        deps.logger?.info(
          { mode: settings.mode, idleDays: settings.idleDays },
          "smart mount settings changed",
        );
        res.json({ ok: true, settings });
      }),
    );
    const ParkBody = z
      .object({
        ids: z
          .array(z.string().regex(/^[a-z][a-z0-9-]{1,31}\/[a-z][a-z0-9-]{1,31}$/))
          .max(64)
          .optional(),
      })
      .strict();
    mountsRouter.post(
      "/smart/park",
      route(async (req, res) => {
        const body = ParkBody.safeParse(req.body ?? {});
        if (!body.success) return fail(res, 400, "INVALID_BODY", "ids must be mount ids");
        const result = await smart.park(body.data.ids);
        if (result.parked.length) changed();
        res.json({ ok: true, ...result });
      }),
    );
    const Key = z.string().min(1).max(200);
    const ApplyBody = z.object({ keys: z.array(Key).max(64).optional() }).strict();
    mountsRouter.post(
      "/smart/apply",
      route(async (req, res) => {
        const body = ApplyBody.safeParse(req.body ?? {});
        if (!body.success) return fail(res, 400, "INVALID_BODY", "keys must be suggestion keys");
        const result = await smart.applyProfiles(body.data.keys);
        if (result.applied.length) changed();
        res.json({ ok: true, ...result });
      }),
    );
    const UndoBody = z.object({ keys: z.array(Key).min(1).max(64) }).strict();
    mountsRouter.post(
      "/smart/undo",
      route(async (req, res) => {
        const body = UndoBody.safeParse(req.body ?? {});
        if (!body.success) return fail(res, 400, "INVALID_BODY", "keys must be change keys");
        const undone = smart.undo(body.data.keys);
        if (undone.length) changed();
        res.json({ ok: true, undone });
      }),
    );
  }
  for (const action of ["enable", "disable"] as const) {
    mountsRouter.post(
      `/:owner/:id/${action}`,
      route(async (req, res) => {
        const { owner, id } = req.params;
        if (!owner || !id || !MOUNT_PART.test(owner) || !MOUNT_PART.test(id)) {
          return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
        }
        const full = `${owner}/${id}`;
        try {
          await mounts.setMountEnabled(full, action === "enable");
        } catch (e) {
          return mountFailure(res, e);
        }
        changed();
        res.json({
          ok: true,
          mount: (await mounts.listMounts()).find((m) => m.id === full) ?? null,
        });
      }),
    );
  }
  // OAuth sign-in. The tokens never leave the daemon: these routes hand out
  // the vendor's authorization URL and a signed-in flag, nothing more.
  const oauthId = (req: { params: Record<string, string | undefined> }): string | null => {
    const { owner, id } = req.params;
    if (!owner || !id || !MOUNT_PART.test(owner) || !MOUNT_PART.test(id)) return null;
    return owner === USER_MOUNT_PACK ? null : `${owner}/${id}`;
  };
  mountsRouter.post(
    "/:owner/:id/oauth/start",
    route(async (req, res) => {
      const full = oauthId(req);
      if (!full) return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
      let url: string;
      try {
        url = await mounts.oauthStart(full);
      } catch (e) {
        return mountFailure(res, e);
      }
      changed();
      res.json({ ok: true, authorization_url: url });
    }),
  );
  mountsRouter.get(
    "/:owner/:id/oauth",
    route(async (req, res) => {
      const full = oauthId(req);
      const m = full ? (await mounts.listMounts()).find((x) => x.id === full) : undefined;
      if (!m) return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
      if (!m.oauth) return fail(res, 409, "NOT_OAUTH", "this mount does not use OAuth sign-in");
      res.json({
        ok: true,
        signed_in: m.oauth.signedIn,
        pending: m.oauth.pending,
        connected: m.connected,
        error: m.error,
      });
    }),
  );
  mountsRouter.delete(
    "/:owner/:id/oauth",
    route(async (req, res) => {
      const full = oauthId(req);
      if (!full) return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
      try {
        await mounts.oauthSignOut(full);
      } catch (e) {
        return mountFailure(res, e);
      }
      changed();
      res.json({
        ok: true,
        mount: (await mounts.listMounts()).find((m) => m.id === full) ?? null,
      });
    }),
  );
  mountsRouter.delete(
    `/${USER_MOUNT_PACK}/:id`,
    route(async (req, res) => {
      const id = req.params.id;
      if (!id || !MOUNT_PART.test(id)) return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
      let removed: boolean;
      try {
        removed = await mounts.removeUserMount(id);
      } catch (e) {
        return mountFailure(res, e);
      }
      if (!removed) return fail(res, 404, "UNKNOWN_MOUNT", "no such mount");
      deps.logger?.info({ mount: `${USER_MOUNT_PACK}/${id}` }, "user mount removed");
      changed();
      res.json({ ok: true, removed: `${USER_MOUNT_PACK}/${id}` });
    }),
  );
  mountApi(app, "/api/mounts", mountsRouter, deps.logger);
}
