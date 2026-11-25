// src/core/http/preferences-api.ts
//
//   GET /api/preferences   {ok, preferences: {locale}}  (null = not chosen yet)
//   PUT /api/preferences   {locale}: merged into <home>/preferences.json
//
// The dashboard's language choice lives here, not only in the browser, so
// the desktop app's window and tray menu follow it too (src/core/preferences.ts).
// Behind the admin token or a dashboard session, the Origin guard and the
// CSRF rule, like the rest of /api.
import type { Express } from "express";
import { PreferencesPatch, readPreferences, writePreferences } from "../preferences.js";
import { type ApiLogger, apiRouter, mountApi, parse, route } from "./api-common.js";
import type { OriginPolicy } from "./origin.js";

export interface PreferencesApiDeps {
  origin: OriginPolicy;
  home: string;
  logger?: ApiLogger;
}

export function mountPreferencesApi(app: Express, deps: PreferencesApiDeps): void {
  const router = apiRouter(deps.origin);
  router.get(
    "/",
    route((_req, res) => {
      res.json({ ok: true, preferences: readPreferences(deps.home) });
    }),
  );
  router.put(
    "/",
    route((req, res) => {
      const patch = parse(PreferencesPatch, req.body, res);
      if (!patch) return;
      res.json({ ok: true, preferences: writePreferences(deps.home, patch) });
    }),
  );
  mountApi(app, "/api/preferences", router, deps.logger);
}
