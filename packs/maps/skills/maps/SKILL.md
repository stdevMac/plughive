---
name: maps
description: Geocode addresses, search places and get directions with Google Maps (google_geocode, google_places_search, google_directions) or Mapbox (mapbox_geocode, mapbox_directions). Use when the user needs coordinates, nearby businesses, or travel time and route steps.
---

# Maps

## Tools

- `google_geocode`: address or place name to formatted address, place id and lat/lng.
- `google_places_search`: text search such as "coffee near Shoreditch" or "Lisbon Oceanarium". Returns name, address, location, rating, phone, website and a Google Maps link. `open_now` filters to places open now.
- `google_directions`: route between two addresses. `mode` is drive, walk, bicycle, two_wheeler or transit. Returns distance (m), duration (s) and steps.
- `mapbox_geocode`: address or place to name, full address and longitude/latitude. `country` narrows it (for example `us` or `gb,ie`).
- `mapbox_directions`: route through 2 to 25 `points` given as `{lng, lat}`. Geocode addresses first. `profile` is driving, driving-traffic, walking or cycling.

## Setup

Google tools need `GOOGLE_MAPS_API_KEY` with the Geocoding API, Places API (New) and Routes API enabled. Mapbox tools need `MAPBOX_ACCESS_TOKEN`. If a call fails with `MISSING_SECRET`, tell the user which secret to set; either provider alone is enough.

## Tips

- Distances are meters and durations seconds: convert for the user.
- Google answers REQUEST_DENIED when an API is not enabled for the key; tell the user which API to enable.
- All tools only read; each call is billed by the provider per request.
