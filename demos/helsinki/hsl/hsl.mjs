#!/usr/bin/env node
// Feeds a few live Helsinki vehicles from HSL's public MQTT feed (high-frequency positioning,
// https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/)
// into an NGSI-LD broker as Vehicle entities. Every write sets expiresAt EXPIRES_MINUTES ahead: a vehicle
// that stops reporting drops out of the current state, its history stays in the temporal API.
//
//   BROKER_URL=http://localhost:9090 node hsl.mjs
//
// Settings (environment): BROKER_URL, TENANT, MQTT_URL, HSL_TOPIC (default: trams), VEHICLES (8),
// UPDATE_SECONDS (15), EXPIRES_MINUTES (8).

import mqtt from 'mqtt';
import { pathToFileURL } from 'node:url';

const env = process.env;
const BROKER = (env.BROKER_URL || 'http://localhost:9090').replace(/\/$/, '');
const TENANT = env.TENANT || '';
const MQTT_URL = env.MQTT_URL || 'mqtts://mqtt.hsl.fi:8883';
const TOPIC = env.HSL_TOPIC || '/hfp/v2/journey/ongoing/vp/tram/#';
const VEHICLES = Number(env.VEHICLES || 8);
const UPDATE_MS = Number(env.UPDATE_SECONDS || 15) * 1000;
const EXPIRES_MS = Number(env.EXPIRES_MINUTES || 8) * 60_000;
// a vehicle silent this long gives its slot to the next one seen
const SILENT_MS = 60_000;

/** An HFP `VP` message as an NGSI-LD Vehicle, or undefined when it has no usable id, position or time. */
export function toEntity(vp, mode, expiresAt) {
  const observedAt = typeof vp?.tst === 'string' && !Number.isNaN(Date.parse(vp.tst)) ? vp.tst : undefined;
  if (!observedAt || vp.oper == null || vp.veh == null || !Number.isFinite(vp.lat) || !Number.isFinite(vp.long)) {
    return undefined;
  }
  const prop = (value, unitCode) =>
    Number.isFinite(value) ? { type: 'Property', value, unitCode, observedAt } : undefined;
  const label = mode ? mode[0].toUpperCase() + mode.slice(1) : 'Vehicle';
  return {
    id: `urn:ngsi-ld:Vehicle:HSL-${vp.oper}-${vp.veh}`,
    type: 'Vehicle',
    expiresAt,
    name: { type: 'Property', value: vp.desi ? `${label} ${vp.desi} (${vp.veh})` : `${label} ${vp.veh}` },
    vehicleType: { type: 'Property', value: mode || 'unknown' },
    ...(vp.desi ? { line: { type: 'Property', value: String(vp.desi) } } : {}),
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [vp.long, vp.lat] }, observedAt },
    // undefined members drop out of the JSON body
    speed: prop(vp.spd, 'MTS'),
    heading: prop(vp.hdg, 'DD'),
    // HFP dl is ahead of schedule in seconds; delay is the opposite, late > 0
    delay: prop(Number.isFinite(vp.dl) ? -vp.dl : undefined, 'SEC'),
  };
}

/** Picks which messages to write: at most `max` vehicles, each at most once per `everyMs`. */
export function createTracker(max, everyMs, silentMs) {
  const lastWrite = new Map();
  const lastSeen = new Map();
  return {
    accept(id, now) {
      for (const [v, t] of lastSeen) {
        if (now - t > silentMs) {
          lastSeen.delete(v);
          lastWrite.delete(v);
        }
      }
      if (!lastSeen.has(id) && lastSeen.size >= max) {
        return false;
      }
      lastSeen.set(id, now);
      if (now - (lastWrite.get(id) ?? -Infinity) < everyMs) {
        return false;
      }
      lastWrite.set(id, now);
      return true;
    },
    get size() {
      return lastSeen.size;
    },
  };
}

async function upsert(entities) {
  const res = await fetch(`${BROKER}/ngsi-ld/v1/entityOperations/upsert?options=update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TENANT ? { 'NGSILD-Tenant': TENANT } : {}) },
    body: JSON.stringify(entities),
  });
  if (!res.ok) {
    throw new Error(`upsert -> ${res.status} ${await res.text()}`);
  }
}

function main() {
  const tracker = createTracker(VEHICLES, UPDATE_MS, SILENT_MS);
  const pending = new Map();
  let written = 0;

  const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 5000 });
  client.on('connect', () => {
    console.log(`connected to ${MQTT_URL}, ${TOPIC} -> ${BROKER}`);
    client.subscribe(TOPIC, (err) => err && console.error('subscribe failed:', err.message));
  });
  client.on('error', (err) => console.error('mqtt:', err.message));
  client.on('message', (topic, payload) => {
    let vp;
    try {
      vp = JSON.parse(payload.toString()).VP;
    } catch {
      return;
    }
    const now = Date.now();
    // /hfp/v2/journey/ongoing/vp/<mode>/...
    const entity = toEntity(vp, topic.split('/')[6], new Date(now + EXPIRES_MS).toISOString());
    if (entity && tracker.accept(entity.id, now)) {
      pending.set(entity.id, entity);
    }
  });

  const flush = setInterval(async () => {
    if (!pending.size) {
      return;
    }
    const batch = [...pending.values()];
    pending.clear();
    try {
      await upsert(batch);
      written += batch.length;
    } catch (err) {
      console.error(err.message);
    }
  }, 1000);
  const report = setInterval(() => console.log(`tracking ${tracker.size} vehicles, ${written} updates written`), 60_000);

  const stop = () => {
    clearInterval(flush);
    clearInterval(report);
    client.end(true, () => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
