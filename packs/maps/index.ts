// packs/maps/index.ts
//
// Geocoding, place search and directions through Google Maps Platform and Mapbox.
//   Google Geocoding: https://developers.google.com/maps/documentation/geocoding/requests-geocoding
//   Google Places (New) Text Search: https://developers.google.com/maps/documentation/places/web-service/text-search
//   Google Routes computeRoutes: https://developers.google.com/maps/documentation/routes/compute_route_directions
//   Mapbox Geocoding v6: https://docs.mapbox.com/api/search/geocoding/
//   Mapbox Directions v5: https://docs.mapbox.com/api/navigation/directions/
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, noControl, num, obj, requestJson, scrub, str } from "./http.js";

const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACES = "https://places.googleapis.com/v1/places:searchText";
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MAPBOX = "https://api.mapbox.com";

const PLACE_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.nationalPhoneNumber",
].join(",");
const ROUTE_FIELDS = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.description",
  "routes.warnings",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.navigationInstruction",
].join(",");

const text = (max: number) =>
  z.string().trim().min(1).max(max).refine(noControl, "no control characters");
const lon = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const language = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language code such as en or pt-BR")
  .optional();
const region = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "a two-letter region code such as us")
  .optional();

const READ = { readOnlyHint: true, openWorldHint: true } as const;
// Google Maps Platform and Mapbox bill per request directly on their APIs, so
// the policy gate needs the "paid" tag on these tools.
const PAID = ["maps", "paid"] as const;

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

async function googleKey(ctx: PackContext): Promise<string> {
  return ctx.secrets.get("GOOGLE_MAPS_API_KEY");
}

const googleGeocode = defineTool({
  name: "google_geocode",
  description:
    "Turn an address or place name into coordinates with the Google Geocoding API. Returns up to `limit` matches with formatted address, place id, lat/lng and types.",
  tags: PAID,
  secrets: ["GOOGLE_MAPS_API_KEY"],
  annotations: { title: "Geocode (Google)", ...READ },
  input: z.object({
    address: text(500),
    region,
    language,
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async run(input, ctx) {
    const key = await googleKey(ctx);
    const q = new URLSearchParams({ address: input.address, key });
    if (input.region) q.set("region", input.region);
    if (input.language) q.set("language", input.language);
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Google Geocoding",
      `${GEOCODE}?${q}`,
      { headers: { Accept: "application/json" } },
      [key],
    );
    const status = str(out.status);
    if (status === "ZERO_RESULTS") return { results: [] };
    if (status !== "OK") {
      const msg = str(out.error_message);
      throw new Error(
        `Google Geocoding: ${status ?? "unknown status"}${msg ? `: ${scrub(msg, [key])}` : ""}`,
      );
    }
    return {
      results: arr(out.results)
        .slice(0, input.limit)
        .map((r) => {
          const o = obj(r);
          const loc = obj(obj(o.geometry).location);
          return {
            formatted_address: str(o.formatted_address),
            place_id: str(o.place_id),
            lat: num(loc.lat),
            lng: num(loc.lng),
            types: arr(o.types).filter((t): t is string => typeof t === "string"),
          };
        }),
    };
  },
});

const googlePlaces = defineTool({
  name: "google_places_search",
  description:
    'Search places by text ("pizza in Lisbon", "Eiffel Tower") with Google Places Text Search. Returns name, address, location, rating, website, phone and a Google Maps link.',
  tags: PAID,
  secrets: ["GOOGLE_MAPS_API_KEY"],
  annotations: { title: "Search places (Google)", ...READ },
  input: z.object({
    query: text(500),
    limit: z.number().int().min(1).max(20).default(10),
    language,
    region,
    open_now: z.boolean().optional(),
  }),
  async run(input, ctx) {
    const key = await googleKey(ctx);
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Google Places",
      PLACES,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": PLACE_FIELDS,
        },
        body: JSON.stringify({
          textQuery: input.query,
          pageSize: input.limit,
          languageCode: input.language,
          regionCode: input.region,
          openNow: input.open_now,
        }),
      },
      [key],
    );
    return {
      places: arr(out.places).map((p) => {
        const o = obj(p);
        const loc = obj(o.location);
        return {
          id: str(o.id),
          name: str(obj(o.displayName).text),
          address: str(o.formattedAddress),
          lat: num(loc.latitude),
          lng: num(loc.longitude),
          types: arr(o.types).filter((t): t is string => typeof t === "string"),
          rating: num(o.rating),
          rating_count: num(o.userRatingCount),
          phone: str(o.nationalPhoneNumber),
          website: str(o.websiteUri),
          maps_url: str(o.googleMapsUri),
        };
      }),
    };
  },
});

/** "1234s" (a protobuf Duration) as seconds. */
function seconds(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const googleDirections = defineTool({
  name: "google_directions",
  description:
    "Route between two addresses with the Google Routes API: distance, duration and turn-by-turn steps. Modes: drive, walk, bicycle, two_wheeler, transit.",
  tags: PAID,
  secrets: ["GOOGLE_MAPS_API_KEY"],
  annotations: { title: "Directions (Google)", ...READ },
  input: z.object({
    origin: text(500),
    destination: text(500),
    mode: z.enum(["drive", "walk", "bicycle", "two_wheeler", "transit"]).default("drive"),
    alternatives: z.boolean().default(false),
    language,
  }),
  async run(input, ctx) {
    const key = await googleKey(ctx);
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Google Routes",
      ROUTES,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": ROUTE_FIELDS,
        },
        body: JSON.stringify({
          origin: { address: input.origin },
          destination: { address: input.destination },
          travelMode: input.mode.toUpperCase(),
          computeAlternativeRoutes: input.alternatives,
          languageCode: input.language,
        }),
      },
      [key],
    );
    return {
      routes: arr(out.routes).map((r) => {
        const o = obj(r);
        return {
          description: str(o.description),
          distance_m: num(o.distanceMeters),
          duration_s: seconds(o.duration),
          warnings: arr(o.warnings).filter((w): w is string => typeof w === "string"),
          steps: arr(o.legs).flatMap((leg) =>
            arr(obj(leg).steps).map((s) => {
              const st = obj(s);
              return {
                instruction: str(obj(st.navigationInstruction).instructions),
                distance_m: num(st.distanceMeters),
              };
            }),
          ),
        };
      }),
    };
  },
});

// ---------------------------------------------------------------------------
// Mapbox
// ---------------------------------------------------------------------------

const mapboxGeocode = defineTool({
  name: "mapbox_geocode",
  description:
    "Turn an address or place name into coordinates with Mapbox Geocoding v6. Returns name, full address, feature type and longitude/latitude.",
  tags: PAID,
  secrets: ["MAPBOX_ACCESS_TOKEN"],
  annotations: { title: "Geocode (Mapbox)", ...READ },
  input: z.object({
    query: text(256),
    limit: z.number().int().min(1).max(10).default(5),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}(,[A-Za-z]{2})*$/, "ISO 3166 alpha-2 codes, comma separated")
      .optional(),
    language,
  }),
  async run(input, ctx) {
    const token = await ctx.secrets.get("MAPBOX_ACCESS_TOKEN");
    const q = new URLSearchParams({
      q: input.query,
      limit: String(input.limit),
      access_token: token,
    });
    if (input.country) q.set("country", input.country);
    if (input.language) q.set("language", input.language);
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Mapbox",
      `${MAPBOX}/search/geocode/v6/forward?${q}`,
      { headers: { Accept: "application/json" } },
      [token],
    );
    return {
      results: arr(out.features).map((f) => {
        const p = obj(obj(f).properties);
        const c = obj(p.coordinates);
        return {
          name: str(p.name),
          full_address: str(p.full_address),
          feature_type: str(p.feature_type),
          mapbox_id: str(p.mapbox_id),
          lng: num(c.longitude),
          lat: num(c.latitude),
        };
      }),
    };
  },
});

const mapboxDirections = defineTool({
  name: "mapbox_directions",
  description:
    "Route through 2 to 25 points (longitude, latitude) with Mapbox Directions: distance, duration and turn-by-turn steps. Geocode addresses first with mapbox_geocode.",
  tags: PAID,
  secrets: ["MAPBOX_ACCESS_TOKEN"],
  annotations: { title: "Directions (Mapbox)", ...READ },
  input: z.object({
    points: z
      .array(z.object({ lng: lon, lat }))
      .min(2)
      .max(25),
    profile: z.enum(["driving", "driving-traffic", "walking", "cycling"]).default("driving"),
    alternatives: z.boolean().default(false),
    language,
  }),
  async run(input, ctx) {
    const token = await ctx.secrets.get("MAPBOX_ACCESS_TOKEN");
    const coords = input.points.map((p) => `${p.lng},${p.lat}`).join(";");
    const q = new URLSearchParams({
      access_token: token,
      steps: "true",
      overview: "false",
      alternatives: String(input.alternatives),
    });
    if (input.language) q.set("language", input.language);
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Mapbox",
      `${MAPBOX}/directions/v5/mapbox/${input.profile}/${coords}?${q}`,
      { headers: { Accept: "application/json" } },
      [token],
    );
    const code = str(out.code);
    if (code && code !== "Ok") {
      const msg = str(out.message);
      throw new Error(`Mapbox: ${code}${msg ? `: ${scrub(msg, [token])}` : ""}`);
    }
    return {
      routes: arr(out.routes).map((r) => {
        const o = obj(r);
        return {
          distance_m: num(o.distance),
          duration_s: num(o.duration),
          steps: arr(o.legs).flatMap((leg) =>
            arr(obj(leg).steps).map((s) => {
              const st = obj(s);
              return {
                instruction: str(obj(st.maneuver).instruction),
                distance_m: num(st.distance),
              };
            }),
          ),
        };
      }),
    };
  },
});

export default definePack({
  tools: [googleGeocode, googlePlaces, googleDirections, mapboxGeocode, mapboxDirections],
});
