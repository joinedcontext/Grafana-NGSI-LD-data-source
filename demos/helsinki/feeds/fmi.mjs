#!/usr/bin/env node
// Measured air quality of the Helsinki region from the Finnish Meteorological Institute's open data
// (https://en.ilmatieteenlaitos.fi/open-data, CC BY 4.0) into an NGSI-LD broker: one AirQualityObserved
// entity per station with HISTORY_HOURS of hourly history on start, then each new hour once FMI
// publishes it (usually within the hour).
//
//   BROKER_URL=http://localhost:9090 node fmi.mjs
//
// Settings (environment): BROKER_URL, TENANT, FMI_PLACE (Helsinki), HISTORY_HOURS (48), POLL_MINUTES (10).

import { isMain, purge, call, upsert, waitForBroker, sleep } from './ngsild.mjs';

const env = process.env;
const PLACE = env.FMI_PLACE || 'Helsinki';
const HISTORY_HOURS = Number(env.HISTORY_HOURS || 48);
const POLL_MS = Number(env.POLL_MINUTES || 10) * 60_000;
const HOUR = 3600_000;

// FMI parameter -> attribute name and UN/CEFACT unit (GQ = µg/m³, C62 = index 1-5)
const PARAMETERS = {
  AQINDEX_PT1H_avg: ['airQualityIndex', 'C62'],
  PM10_PT1H_avg: ['pm10', 'GQ'],
  PM25_PT1H_avg: ['pm25', 'GQ'],
  NO2_PT1H_avg: ['no2', 'GQ'],
  O3_PT1H_avg: ['o3', 'GQ'],
};

const all = (re, text) => [...text.matchAll(re)];
const block = (tag, text) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
const rows = (text) =>
  text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r[0] !== '');
const posKey = (lat, lon) => `${Number(lat).toFixed(5)} ${Number(lon).toFixed(5)}`;

/**
 * Stations and hourly observations from FMI's `…airquality::hourly::multipointcoverage` answer.
 * Observations hold only the parameters with a value (FMI sends NaN for the others).
 */
export function parseCoverage(xml) {
  const points = new Map(
    all(/<gml:Point gml:id="point-(\d+)"[^>]*>[\s\S]*?<gml:pos>\s*([-\d.]+)\s+([-\d.]+)/g, xml).map((m) => [m[1], [m[2], m[3]]])
  );
  const stations = new Map();
  for (const [, fmisid, body] of all(/<target:Location gml:id="obsloc-fmisid-(\d+)-pos">([\s\S]*?)<\/target:Location>/g, xml)) {
    const pos = points.get(fmisid);
    if (!pos) {
      continue;
    }
    stations.set(posKey(...pos), {
      fmisid,
      name: body.match(/locationcode\/name">([^<]+)</)?.[1].trim() ?? fmisid,
      region: body.match(/location\/region">([^<]+)</)?.[1].trim() ?? '',
      lat: Number(pos[0]),
      lon: Number(pos[1]),
    });
  }
  const fields = all(/<swe:field name="([^"]+)"/g, xml).map((m) => m[1]);
  const positions = rows(block('gmlcov:positions', xml));
  const tuples = rows(block('gml:doubleOrNilReasonTupleList', xml));
  const observations = [];
  positions.forEach(([lat, lon, epoch], i) => {
    const station = stations.get(posKey(lat, lon));
    const values = {};
    fields.forEach((f, j) => {
      const v = Number(tuples[i]?.[j]);
      if (PARAMETERS[f] && Number.isFinite(v)) {
        values[PARAMETERS[f][0]] = v;
      }
    });
    if (station && Number.isFinite(Number(epoch)) && Object.keys(values).length > 0) {
      observations.push({ fmisid: station.fmisid, time: Number(epoch) * 1000, values });
    }
  });
  return { stations: [...stations.values()], observations };
}

const UNITS = Object.fromEntries(Object.values(PARAMETERS));
const entityId = (fmisid) => `urn:ngsi-ld:AirQualityObserved:FMI-${fmisid}`;
const instance = (attr, value, time) => ({
  type: 'Property',
  value,
  unitCode: UNITS[attr],
  observedAt: new Date(time).toISOString(),
});

/**
 * One entity per station whose current value of each attribute is its newest observation, and the
 * older observations as history (attribute -> instances) for the temporal API.
 */
export function toEntities(stations, observations) {
  const entities = [];
  const history = new Map();
  for (const s of stations) {
    const own = observations.filter((o) => o.fmisid === s.fmisid).sort((a, b) => a.time - b.time);
    if (own.length === 0) {
      continue;
    }
    const current = {};
    const older = {};
    for (const attr of Object.keys(UNITS)) {
      const timed = own.filter((o) => attr in o.values).map((o) => instance(attr, o.values[attr], o.time));
      if (timed.length > 0) {
        current[attr] = timed.pop();
        if (timed.length > 0) {
          older[attr] = timed;
        }
      }
    }
    const id = entityId(s.fmisid);
    entities.push({
      id,
      type: 'AirQualityObserved',
      // "Helsinki Kallio 2" -> "Kallio 2"; the region is in the address
      name: { type: 'Property', value: s.name.startsWith(s.region + ' ') ? s.name.slice(s.region.length + 1) : s.name },
      address: { type: 'Property', value: { addressLocality: s.region, addressCountry: 'FI' } },
      location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [s.lon, s.lat] } },
      stationCode: { type: 'Property', value: s.fmisid },
      dataProvider: { type: 'Property', value: 'Finnish Meteorological Institute' },
      ...current,
    });
    history.set(id, older);
  }
  return { entities, history };
}

async function fetchCoverage(hours) {
  const start = new Date(Math.floor((Date.now() - hours * HOUR) / HOUR) * HOUR).toISOString().replace('.000', '');
  const url =
    'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature' +
    '&storedquery_id=urban::observations::airquality::hourly::multipointcoverage' +
    `&place=${encodeURIComponent(PLACE)}&maxlocations=20&starttime=${start}&parameters=${Object.keys(PARAMETERS).join(',')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`FMI -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return parseCoverage(await res.text());
}

/** Writes the stations with their history; returns the newest observation time per station. */
async function backfill() {
  const { stations, observations } = await fetchCoverage(HISTORY_HOURS);
  const { entities, history } = toEntities(stations, observations);
  for (const e of entities) {
    await purge(e.id);
  }
  await upsert(entities, 'replace');
  for (const [id, older] of history) {
    if (Object.keys(older).length > 0) {
      await call('POST', `/temporal/entities/${encodeURIComponent(id)}/attrs`, older);
    }
  }
  console.log(`${entities.length} stations, ${observations.length} hourly observations since ${HISTORY_HOURS} h`);
  const latest = new Map();
  observations.forEach((o) => latest.set(o.fmisid, Math.max(latest.get(o.fmisid) ?? 0, o.time)));
  return latest;
}

/** Writes the observations newer than `latest`, oldest first, so each becomes a history instance. */
async function poll(latest) {
  const { observations } = await fetchCoverage(3);
  const fresh = observations.filter((o) => o.time > (latest.get(o.fmisid) ?? 0)).sort((a, b) => a.time - b.time);
  for (const o of fresh) {
    const attrs = Object.fromEntries(Object.entries(o.values).map(([attr, v]) => [attr, instance(attr, v, o.time)]));
    await upsert([{ id: entityId(o.fmisid), type: 'AirQualityObserved', ...attrs }]);
    latest.set(o.fmisid, o.time);
  }
  if (fresh.length > 0) {
    console.log(`${fresh.length} new hourly observations, newest ${new Date(fresh.at(-1).time).toISOString()}`);
  }
}

async function main() {
  process.on('SIGTERM', () => process.exit(0));
  await waitForBroker();
  let latest;
  while (!latest) {
    try {
      latest = await backfill();
    } catch (err) {
      console.error('backfill failed, retrying in a minute:', err.message);
      await sleep(60_000);
    }
  }
  for (;;) {
    await sleep(POLL_MS);
    try {
      await poll(latest);
    } catch (err) {
      console.error('poll failed:', err.message);
    }
  }
}

if (isMain(import.meta.url)) {
  main();
}
