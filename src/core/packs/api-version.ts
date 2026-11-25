// src/core/packs/api-version.ts
//
// The one place the pack API version is defined. `pack-api.ts` and
// `manifest.ts` both re-export it.

/** Pack API version this daemon implements. Manifests may declare any version up to it. */
export const PACK_API_VERSION = 1 as const;
