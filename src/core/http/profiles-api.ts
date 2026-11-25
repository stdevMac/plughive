// src/core/http/profiles-api.ts
//
// JSON management API for exposure profiles.
//
//   GET    /api/profiles               list
//   GET    /api/profiles/:id           one profile
//   PUT    /api/profiles/:id           create or replace
//   DELETE /api/profiles/:id           delete (never the default profile)
//   GET    /api/profiles/:id/preview   the exact tools/list payload and its context cost
//   POST   /api/profiles/preview       the same for an unsaved draft (body: a profile; id and name optional)
//
// The caller mounts the admin-token middleware on /api before this, and the
// pack-request guard app-wide.
import express, { type Express, type Response } from "express";
import {
  PROFILE_ID_PATTERN,
  ProfileError,
  ProfileSchema,
  type ProfileStore,
  resolveExposure,
} from "../profiles.js";
import type { ToolRegistry } from "../tools/registry.js";
import { API_BODY_LIMIT } from "./api-common.js";
import { csrfGuard } from "./csrf.js";
import type { OriginPolicy } from "./origin.js";

export interface ProfilesApiDeps {
  profiles: ProfileStore;
  registry: ToolRegistry;
  /** Must match what the MCP endpoint passes to resolveExposure. */
  jobs: boolean;
  /** Which origins may send state-changing requests. */
  origin: OriginPolicy;
  /** Removes secret values and local paths from a message before it is returned. */
  scrub?: (text: string) => string;
}

const fail = (res: Response, status: number, code: string, message: string, issues?: unknown[]) =>
  res.status(status).json({ ok: false, error: { code, message, ...(issues ? { issues } : {}) } });

const notFound = (res: Response) => fail(res, 404, "UNKNOWN_PROFILE", "no such profile");

const BAD_ID_MESSAGE = "profile id must match ^[a-z][a-z0-9-]{1,31}$";

export function mountProfilesApi(
  app: Express,
  { profiles, registry, jobs, origin, scrub }: ProfilesApiDeps,
): void {
  const clean = (text: string) => (scrub ? scrub(text) : text).slice(0, 2000);
  /** A store refusal, with every message scrubbed. */
  const refuse = (res: Response, status: number, e: ProfileError) =>
    fail(
      res,
      status,
      e.code,
      clean(e.message),
      e.issues?.map((issue) => {
        const { path, message, code } = issue as {
          path?: unknown;
          message?: unknown;
          code?: unknown;
        };
        return { code, path, message: clean(String(message ?? "")) };
      }),
    );
  const router = express.Router();
  // Every route that names a profile checks the id the same way creation does.
  router.param("id", (req, res, next, id: string) => {
    if (req.method !== "PUT" && !PROFILE_ID_PATTERN.test(id)) {
      fail(res, 400, "INVALID_PROFILE", BAD_ID_MESSAGE);
      return;
    }
    next();
  });
  router.use(csrfGuard(origin));
  // Parsed only here: after the admin token and CSRF checks, and only for this API.
  router.use(express.json({ limit: API_BODY_LIMIT }));

  router.get("/", (_req, res) => {
    res.json({ ok: true, profiles: profiles.list() });
  });

  router.get("/:id", (req, res) => {
    const profile = profiles.get(req.params.id);
    if (!profile) return notFound(res);
    res.json({ ok: true, profile });
  });

  router.get("/:id/preview", (req, res) => {
    const profile = profiles.get(req.params.id);
    if (!profile) return notFound(res);
    const { mode, tools, cost, directTokens, exposed } = resolveExposure(profile, registry, {
      jobs,
    });
    res.json({
      ok: true,
      profile: profile.id,
      mode,
      tools,
      cost,
      direct_tokens: directTokens,
      exposed_tools: exposed.length,
    });
  });

  // A draft that is not saved: what tools/list would hold and cost. Nothing is written.
  router.post("/preview", (req, res) => {
    const body: unknown = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return fail(res, 400, "INVALID_PROFILE", "the request body must be a JSON object");
    }
    const draft = { id: "draft", name: "Draft", ...(body as Record<string, unknown>) };
    const parsed = ProfileSchema.safeParse(draft);
    if (!parsed.success) {
      return fail(
        res,
        400,
        "INVALID_PROFILE",
        "the draft profile is not valid",
        parsed.error.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    const { mode, tools, cost, directTokens, exposed } = resolveExposure(parsed.data, registry, {
      jobs,
    });
    res.json({
      ok: true,
      profile: parsed.data.id,
      mode,
      tools,
      cost,
      direct_tokens: directTokens,
      exposed_tools: exposed.length,
      exposed: exposed.map((t) => t.name),
    });
  });

  router.put("/:id", (req, res) => {
    const id = req.params.id;
    if (!PROFILE_ID_PATTERN.test(id)) {
      return fail(res, 400, "INVALID_PROFILE", BAD_ID_MESSAGE);
    }
    const body: unknown = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return fail(res, 400, "INVALID_PROFILE", "the request body must be a JSON object");
    }
    const given = (body as { id?: unknown }).id;
    if (given !== undefined && given !== id) {
      return fail(res, 400, "INVALID_PROFILE", "the id in the body does not match the URL");
    }
    try {
      const created = profiles.get(id) === undefined;
      const profile = profiles.put({ ...body, id });
      res.status(created ? 201 : 200).json({ ok: true, profile });
    } catch (e) {
      if (e instanceof ProfileError) {
        return refuse(res, e.code === "PROFILE_LIMIT" ? 409 : 400, e);
      }
      throw e;
    }
  });

  router.delete("/:id", (req, res) => {
    try {
      if (!profiles.delete(req.params.id)) return notFound(res);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof ProfileError) return refuse(res, 409, e);
      throw e;
    }
  });

  // Malformed JSON and oversized bodies from express.json land here.
  router.use((err: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      return fail(
        res,
        status,
        "INVALID_REQUEST",
        status === 413 ? "request body too large" : "malformed JSON body",
      );
    }
    fail(res, 500, "INTERNAL", "internal error");
  });

  app.use("/api/profiles", router);
}
