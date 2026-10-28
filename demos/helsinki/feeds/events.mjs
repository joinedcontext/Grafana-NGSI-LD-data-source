#!/usr/bin/env node
// Upcoming events in central Helsinki from the City of Helsinki's Linked Events API
// (https://api.hel.fi/linkedevents/v1/, CC BY 4.0) into an NGSI-LD broker: one Event entity per
// event, linked to a PointOfInterest entity for its venue, each venue linked to the City of Helsinki.
// Events and venues expire when their last event ends, so the broker only holds what is still to come.
//
//   BROKER_URL=http://localhost:9090 node events.mjs
//
// Settings (environment): BROKER_URL, TENANT, EVENTS_HOURS (24), EVENTS_MAX (100),
// EVENTS_BBOX (24.90,60.15,25.00,60.20: west,south,east,north), POLL_MINUTES (15).

import { isMain, upsert, waitForBroker, sleep } from './ngsild.mjs';

const env = process.env;
const HOURS = Number(env.EVENTS_HOURS || 24);
const MAX = Number(env.EVENTS_MAX || 100);
const BBOX = env.EVENTS_BBOX || '24.90,60.15,25.00,60.20';
const POLL_MS = Number(env.POLL_MINUTES || 15) * 60_000;
// an event without an end counts as this long
const DEFAULT_DURATION_MS = 3 * 3600_000;

/** The English text of a Linked Events language map, else Finnish, else Swedish; undefined when empty. */
export function text(map) {
  const v = [map?.en, map?.fi, map?.sv].find((t) => typeof t === 'string' && t.trim() !== '');
  return v?.trim();
}

const point = (place) => {
  const c = place?.position?.coordinates;
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[0], c[1]] : undefined;
};

export const CITY = {
  id: 'urn:ngsi-ld:City:Helsinki',
  type: 'City',
  name: { type: 'Property', value: 'Helsinki' },
  location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [24.9384, 60.1699] } },
};

/**
 * Event, PointOfInterest and (with any venue) City entities for Linked Events events (with `include=location,keywords`).
 * Skips events without a name, a venue position or a valid start, and those that ended before `now`.
 */
export function toEntities(events, now) {
  const result = [];
  const venues = new Map();
  for (const ev of events) {
    const name = text(ev?.name);
    const coordinates = point(ev?.location);
    const start = Date.parse(ev?.start_time);
    const end = ev?.end_time ? Date.parse(ev.end_time) : start + DEFAULT_DURATION_MS;
    if (!name || !coordinates || !ev.location.id || !Number.isFinite(start) || !Number.isFinite(end) || end <= now) {
      continue;
    }
    const venueId = `urn:ngsi-ld:PointOfInterest:${ev.location.id}`;
    const expiresAt = new Date(end).toISOString();
    const venueName = text(ev.location.name) ?? ev.location.id;
    const category = text(ev.keywords?.[0]?.name);
    const url = text(ev.info_url);
    result.push({
      id: `urn:ngsi-ld:Event:${ev.id}`,
      type: 'Event',
      expiresAt,
      name: { type: 'Property', value: name },
      startDate: { type: 'Property', value: new Date(start).toISOString() },
      endDate: { type: 'Property', value: expiresAt },
      venue: { type: 'Property', value: venueName },
      ...(category ? { category: { type: 'Property', value: category } } : {}),
      ...(url ? { url: { type: 'Property', value: url } } : {}),
      location: { type: 'GeoProperty', value: { type: 'Point', coordinates } },
      refPointOfInterest: { type: 'Relationship', object: venueId },
    });
    const venue = venues.get(venueId);
    if (!venue || venue.expiresAt < expiresAt) {
      venues.set(venueId, {
        id: venueId,
        type: 'PointOfInterest',
        expiresAt,
        name: { type: 'Property', value: venueName },
        ...(text(ev.location.street_address)
          ? { address: { type: 'Property', value: { streetAddress: text(ev.location.street_address), addressLocality: 'Helsinki' } } }
          : {}),
        location: { type: 'GeoProperty', value: { type: 'Point', coordinates } },
        // the venues lie in the bbox of central Helsinki
        refCity: { type: 'Relationship', object: CITY.id },
      });
    }
  }
  return venues.size > 0 ? [...result, ...venues.values(), CITY] : result;
}

async function fetchEvents() {
  const now = new Date();
  const params = new URLSearchParams({
    start: 'now',
    end: new Date(now.getTime() + HOURS * 3600_000).toISOString(),
    // one-off events, not exhibitions running for months or the umbrella of a series
    max_duration: '1d',
    super_event_type: 'none',
    bbox: BBOX,
    include: 'location,keywords',
    sort: 'start_time',
    page_size: String(Math.min(MAX, 100)),
  });
  const events = [];
  let url = `https://api.hel.fi/linkedevents/v1/event/?${params}`;
  while (url && events.length < MAX) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      throw new Error(`Linked Events -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const page = await res.json();
    events.push(...(page.data ?? []));
    url = page.meta?.next;
  }
  return events.slice(0, MAX);
}

async function main() {
  process.on('SIGTERM', () => process.exit(0));
  await waitForBroker();
  for (;;) {
    try {
      const entities = toEntities(await fetchEvents(), Date.now());
      await upsert(entities);
      const count = (type) => entities.filter((e) => e.type === type).length;
      console.log(`${count('Event')} events at ${count('PointOfInterest')} venues`);
    } catch (err) {
      console.error('events failed:', err.message);
    }
    await sleep(POLL_MS);
  }
}

if (isMain(import.meta.url)) {
  main();
}
