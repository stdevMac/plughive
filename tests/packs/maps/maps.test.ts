import { describe, expect, it } from "vitest";
import mapsPack from "../../../packs/maps/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = {
  GOOGLE_MAPS_API_KEY: "AIza_secret_key_123",
  MAPBOX_ACCESS_TOKEN: "pk.secret_token_456",
};
const VALUES = Object.values(SECRETS);

describe("maps pack", () => {
  it("exposes read-only Google and Mapbox tools", () => {
    const names = toolNames(mapsPack);
    expect(names).toEqual([
      "google_geocode",
      "google_places_search",
      "google_directions",
      "mapbox_geocode",
      "mapbox_directions",
    ]);
    for (const n of names) expect(toolOf(mapsPack, n).annotations?.readOnlyHint, n).toBe(true);
  });

  it("geocodes with Google and never returns the key", async () => {
    const fetch = routerFetch([
      {
        match:
          /^GET https:\/\/maps\.googleapis\.com\/maps\/api\/geocode\/json\?address=10\+Downing\+St&key=/,
        reply: () =>
          jsonResponse({
            status: "OK",
            results: [
              {
                formatted_address: "10 Downing St, London",
                place_id: "pl1",
                geometry: { location: { lat: 51.5, lng: -0.12 } },
                types: ["street_address"],
              },
            ],
          }),
      },
    ]);
    const h = harness(mapsPack, "maps", "google_geocode", { secrets: SECRETS, fetch });
    const out = await h.call({ address: "10 Downing St" });
    expect(out).toEqual({
      results: [
        {
          formatted_address: "10 Downing St, London",
          place_id: "pl1",
          lat: 51.5,
          lng: -0.12,
          types: ["street_address"],
        },
      ],
    });
    expectNoSecrets(out, VALUES);
  });

  it("reports a Google status error without the key", async () => {
    const fetch = routerFetch([
      {
        match: /geocode/,
        reply: () =>
          jsonResponse({
            status: "REQUEST_DENIED",
            error_message: "The key AIza_secret_key_123 is invalid",
          }),
      },
    ]);
    const h = harness(mapsPack, "maps", "google_geocode", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ address: "x" }));
    expect(err.message).toBe("Google Geocoding: REQUEST_DENIED: The key [redacted] is invalid");
    expectNoSecrets(err, VALUES);
  });

  it("searches places with the key and field mask in headers", async () => {
    const fetch = routerFetch([
      {
        method: "POST",
        match: /places\.googleapis\.com\/v1\/places:searchText$/,
        reply: () =>
          jsonResponse({
            places: [
              {
                id: "p1",
                displayName: { text: "Cafe" },
                formattedAddress: "1 Road",
                location: { latitude: 1, longitude: 2 },
                rating: 4.5,
              },
            ],
          }),
      },
    ]);
    const h = harness(mapsPack, "maps", "google_places_search", { secrets: SECRETS, fetch });
    const out = (await h.call({ query: "cafe", limit: 3 })) as { places: unknown[] };
    expect(out.places[0]).toMatchObject({ id: "p1", name: "Cafe", lat: 1, lng: 2, rating: 4.5 });
    const call = fetch.calls[0]!;
    expect(call.headers["x-goog-api-key"]).toBe(SECRETS.GOOGLE_MAPS_API_KEY);
    expect(call.headers["x-goog-fieldmask"]).toContain("places.displayName");
    expect(JSON.parse(call.body!)).toMatchObject({ textQuery: "cafe", pageSize: 3 });
    expect(call.url).not.toContain(SECRETS.GOOGLE_MAPS_API_KEY);
  });

  it("computes Google routes", async () => {
    const fetch = routerFetch([
      {
        method: "POST",
        match: /routes\.googleapis\.com\/directions\/v2:computeRoutes$/,
        reply: () =>
          jsonResponse({
            routes: [
              {
                distanceMeters: 1200,
                duration: "300s",
                legs: [
                  {
                    steps: [
                      { distanceMeters: 1200, navigationInstruction: { instructions: "Go" } },
                    ],
                  },
                ],
              },
            ],
          }),
      },
    ]);
    const h = harness(mapsPack, "maps", "google_directions", { secrets: SECRETS, fetch });
    const out = await h.call({ origin: "A", destination: "B", mode: "walk" });
    expect(out).toEqual({
      routes: [
        {
          description: null,
          distance_m: 1200,
          duration_s: 300,
          warnings: [],
          steps: [{ instruction: "Go", distance_m: 1200 }],
        },
      ],
    });
    expect(JSON.parse(fetch.calls[0]!.body!)).toMatchObject({
      origin: { address: "A" },
      destination: { address: "B" },
      travelMode: "WALK",
    });
  });

  it("geocodes and routes with Mapbox", async () => {
    const fetch = routerFetch([
      {
        match:
          /^GET https:\/\/api\.mapbox\.com\/search\/geocode\/v6\/forward\?q=Paris&limit=5&access_token=/,
        reply: () =>
          jsonResponse({
            features: [
              {
                properties: {
                  name: "Paris",
                  full_address: "Paris, France",
                  feature_type: "place",
                  coordinates: { longitude: 2.35, latitude: 48.85 },
                },
              },
            ],
          }),
      },
      {
        match:
          /^GET https:\/\/api\.mapbox\.com\/directions\/v5\/mapbox\/walking\/2\.35,48\.85;2\.36,48\.86\?/,
        reply: () =>
          jsonResponse({
            code: "Ok",
            routes: [
              {
                distance: 900,
                duration: 600,
                legs: [{ steps: [{ distance: 900, maneuver: { instruction: "Walk north" } }] }],
              },
            ],
          }),
      },
    ]);
    const geo = harness(mapsPack, "maps", "mapbox_geocode", { secrets: SECRETS, fetch });
    const g = await geo.call({ query: "Paris" });
    expect(g).toEqual({
      results: [
        {
          name: "Paris",
          full_address: "Paris, France",
          feature_type: "place",
          mapbox_id: null,
          lng: 2.35,
          lat: 48.85,
        },
      ],
    });
    const dir = harness(mapsPack, "maps", "mapbox_directions", { secrets: SECRETS, fetch });
    const d = await dir.call({
      points: [
        { lng: 2.35, lat: 48.85 },
        { lng: 2.36, lat: 48.86 },
      ],
      profile: "walking",
    });
    expect(d).toEqual({
      routes: [
        {
          distance_m: 900,
          duration_s: 600,
          steps: [{ instruction: "Walk north", distance_m: 900 }],
        },
      ],
    });
    expectNoSecrets([g, d], VALUES);
  });

  it("turns a Mapbox NoRoute answer into an error", async () => {
    const fetch = routerFetch([
      {
        match: /directions/,
        reply: () => jsonResponse({ code: "NoRoute", message: "No route found" }),
      },
    ]);
    const h = harness(mapsPack, "maps", "mapbox_directions", { secrets: SECRETS, fetch });
    const err = await failure(
      h.call({
        points: [
          { lng: 0, lat: 0 },
          { lng: 1, lat: 1 },
        ],
      }),
    );
    expect(err.message).toBe("Mapbox: NoRoute: No route found");
  });

  it("scrubs the token from a Mapbox HTTP error and keeps URLs out of network errors", async () => {
    const fetch = routerFetch([
      {
        match: /geocode/,
        reply: () =>
          jsonResponse({ message: "Not Authorized - Invalid Token pk.secret_token_456" }, 401),
      },
    ]);
    const h = harness(mapsPack, "maps", "mapbox_geocode", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ query: "x" }));
    expect(err.message).toBe("Mapbox 401: Not Authorized - Invalid Token [redacted]");
    expectNoSecrets(err, VALUES);

    const down = harness(mapsPack, "maps", "mapbox_geocode", {
      secrets: SECRETS,
      fetch: async (url) => {
        throw new TypeError(`fetch failed for ${String(url)}`);
      },
    });
    const netErr = await failure(down.call({ query: "x" }));
    expect(netErr.message).toMatch(/^Mapbox: request failed/);
    expectNoSecrets(netErr, VALUES);
  });

  it("validates coordinates", () => {
    const tool = toolOf(mapsPack, "mapbox_directions");
    expect(tool.input.safeParse({ points: [{ lng: 0, lat: 0 }] }).success).toBe(false);
    expect(
      tool.input.safeParse({
        points: [
          { lng: 200, lat: 0 },
          { lng: 0, lat: 0 },
        ],
      }).success,
    ).toBe(false);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(mapsPack, "maps", "google_geocode", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://www.googleapis.com/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "google_geocode",
        args: { address: "x" },
        pack: "maps",
        secret: "GOOGLE_MAPS_API_KEY",
      },
      { tool: "mapbox_geocode", args: { query: "x" }, pack: "maps", secret: "MAPBOX_ACCESS_TOKEN" },
    ]);
  });
});
