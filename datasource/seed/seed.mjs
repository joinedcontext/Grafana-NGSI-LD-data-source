#!/usr/bin/env node
// Seeds an NGSI-LD broker with a small smart-city dataset that exercises every
// read feature of the Grafana plugin: units, history (> one temporal page),
// multi-instance attributes, Language/Vocab/Json/List properties, Point,
// Point, LineString, Polygon and MultiPolygon locations in central Helsinki,
// relationships and scopes.
//
//   node seed.mjs [--broker http://localhost:9090] [--tenant t] [--anchor 2026-01-01T00:00:00Z] [--hours 48]
//
// Without --anchor the history ends at the current hour (live demo data);
// with --anchor it starts at that instant, so values are reproducible (tests).
// Re-running replaces the dataset.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const BROKER = (args.broker || process.env.BROKER_URL || 'http://localhost:9090').replace(/\/$/, '');
const TENANT = args.tenant || process.env.TENANT || '';
const HOURS = Number(args.hours || process.env.SEED_HOURS || 48);
const HOUR = 3600_000;
const anchor = args.anchor || process.env.SEED_ANCHOR;
// first history instant; the current value is observed one hour after the last instance
const start = anchor ? Date.parse(anchor) : Math.floor(Date.now() / HOUR) * HOUR - HOURS * HOUR;
if (!Number.isFinite(start) || !(HOURS > 0)) {
  console.error('invalid --anchor or --hours');
  process.exit(2);
}
const iso = (t) => new Date(t).toISOString();
const round = (v) => Math.round(v * 10) / 10;

// Deterministic series, i = hour index. tests/integration repeats the pm10 formula: change both together.
const series = {
  temperature: (s, i) => round(8 + s + 6 * Math.sin(((i - 9) * Math.PI) / 12)), // 24-hour cycle
  pm10: (s, i) => round(20 + s * 5 + 10 * Math.sin(i / 4)),
  pm25: (s, i) => round(8 + s * 2 + 4 * Math.sin(i / 4)),
  no2: (s, i) => round(30 + s * 3 + 15 * Math.cos(i / 6)),
  relativeHumidity: (s, i) => round(55 + s + 20 * Math.sin(i / 8)),
};
const units = { temperature: 'CEL', pm10: 'GQ', pm25: 'GQ', no2: 'GQ', relativeHumidity: 'P1' };

const stations = [
  { n: 1, name: { fi: 'Mannerheimintie', sv: 'Mannerheimvägen', en: 'Mannerheimintie' }, coords: [24.93939, 60.16964], scope: '/Helsinki/Kluuvi' },
  { n: 2, name: { fi: 'Kallio', sv: 'Berghäll', en: 'Kallio' }, coords: [24.95064, 60.18736], scope: '/Helsinki/Kallio' },
  { n: 3, name: { fi: 'Mäkelänkatu', sv: 'Mäkelägatan', en: 'Makelankatu' }, coords: [24.95219, 60.19627], scope: '/Helsinki/Vallila' },
];

const aqId = (n) => `urn:ngsi-ld:AirQualityObserved:HEL-0${n}`;
const devId = (n) => `urn:ngsi-ld:Device:HEL-0${n}`;
const CITY_HALL = 'urn:ngsi-ld:Building:CityHall';
const now = start + HOURS * HOUR;

// Shapes from OpenStreetMap (© OpenStreetMap contributors, ODbL), simplified
const shape = (id, type, name, geometry, extra = {}) => ({
  id,
  type,
  name: { type: 'Property', value: name },
  ...extra,
  location: { type: 'GeoProperty', value: geometry },
});
const places = [
  shape('urn:ngsi-ld:Building:Cathedral', 'Building', 'Helsinki Cathedral', {type:'Polygon',coordinates:[[[24.951622,60.17048],[24.951642,60.170249],[24.951875,60.170257],[24.951883,60.170218],[24.951972,60.170216],[24.951973,60.1701],[24.952443,60.170113],[24.952421,60.170222],[24.952507,60.170228],[24.952512,60.170272],[24.952749,60.170276],[24.952723,60.170509],[24.952484,60.170498],[24.952478,60.170538],[24.952386,60.170539],[24.952381,60.170574],[24.952399,60.170575],[24.95239,60.170657],[24.951919,60.170647],[24.951937,60.170531],[24.951853,60.170524],[24.951853,60.170483],[24.951622,60.17048]]]}),
  shape('urn:ngsi-ld:Road:Mannerheimintie', 'Road', 'Mannerheimintie', {type:'LineString',coordinates:[[24.94343,60.166762],[24.937009,60.171027],[24.936117,60.171404],[24.935761,60.171637],[24.9339,60.173555],[24.932897,60.174749],[24.932067,60.17554],[24.930736,60.176623],[24.929876,60.177469],[24.92946,60.178113],[24.928214,60.180551],[24.927498,60.181783],[24.926669,60.182352],[24.926118,60.182641],[24.922814,60.184787],[24.920808,60.18621],[24.919709,60.187049]]}, {
    trafficIntensity: { type: 'Property', value: 1850, unitCode: 'E50', observedAt: iso(now) },
    refBuilding: { type: 'Relationship', object: CITY_HALL },
  }),
  shape('urn:ngsi-ld:Zone:SenateSquare', 'Zone', 'Senate Square', {type:'Polygon',coordinates:[[[24.951196,60.169714],[24.951241,60.169248],[24.951272,60.169228],[24.95329,60.169271],[24.953336,60.169294],[24.953309,60.169761],[24.953254,60.169798],[24.951249,60.169751],[24.951208,60.169737],[24.951196,60.169714]]]}),
  shape('urn:ngsi-ld:Park:Esplanadi', 'Park', 'Esplanadi', {type:'MultiPolygon',coordinates:[[[[24.944212,60.167608],[24.944255,60.167178],[24.944393,60.167178],[24.944399,60.167141],[24.944791,60.167152],[24.944917,60.167206],[24.945607,60.167226],[24.945559,60.167645],[24.944212,60.167608]]],[[[24.949603,60.167747],[24.949641,60.167276],[24.950879,60.167302],[24.950881,60.16755],[24.950856,60.167775],[24.949603,60.167747]]]]}),
  shape('urn:ngsi-ld:Park:Kaisaniemi', 'Park', 'Kaisaniemi Park', {type:'Polygon',coordinates:[[[24.941308,60.176457],[24.941724,60.176007],[24.942016,60.175555],[24.942401,60.173104],[24.942418,60.173154],[24.942486,60.173164],[24.942543,60.173121],[24.943422,60.17312],[24.943441,60.173014],[24.944319,60.173036],[24.94433,60.172919],[24.946575,60.172983],[24.946545,60.173382],[24.948929,60.173431],[24.949341,60.173815],[24.949354,60.174064],[24.949454,60.174164],[24.949633,60.174294],[24.949984,60.174421],[24.950099,60.174535],[24.949967,60.175755],[24.947945,60.175863],[24.94409,60.176319],[24.943558,60.176276],[24.943254,60.176411],[24.943367,60.176525],[24.942173,60.177028],[24.942059,60.177016],[24.941836,60.176879],[24.941643,60.17657],[24.941308,60.176457]]]}),
];

const entities = [
  ...stations.map((s) => ({
    id: aqId(s.n),
    type: 'AirQualityObserved',
    scope: s.scope,
    name: { type: 'LanguageProperty', languageMap: s.name },
    category: { type: 'VocabProperty', vocab: 'urban' },
    address: {
      type: 'Property',
      value: { addressLocality: 'Helsinki', addressCountry: 'FI', streetAddress: s.name.fi },
    },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: s.coords } },
    airQualityIndex: { type: 'Property', value: s.n, unitCode: 'C62', observedAt: iso(now) },
    isOnline: { type: 'Property', value: s.n !== 3 },
    refDevice: { type: 'Relationship', object: devId(s.n) },
    ...Object.fromEntries(
      Object.keys(series).map((attr) => [
        attr,
        { type: 'Property', value: series[attr](s.n, HOURS), unitCode: units[attr], observedAt: iso(now) },
      ])
    ),
  })),
  ...stations.map((s) => ({
    id: devId(s.n),
    type: 'Device',
    name: { type: 'Property', value: `Sensor box ${s.n}` },
    batteryLevel: { type: 'Property', value: 100 - s.n * 15, unitCode: 'P1', observedAt: iso(now) },
    serialNumber: { type: 'Property', value: `SN-000${s.n}` },
    locatedIn: { type: 'Relationship', object: CITY_HALL },
  })),
  {
    id: CITY_HALL,
    type: 'Building',
    scope: '/Helsinki/Kluuvi',
    name: { type: 'Property', value: 'City Hall' },
    floorsAboveGround: { type: 'Property', value: 4, unitCode: 'C62' },
    openingHours: { type: 'JsonProperty', json: { mo: '08:00-16:00', fr: '08:00-14:00' } },
    tags: { type: 'ListProperty', valueList: ['public', 'heritage'] },
    // multi-instance attribute: one instance per datasetId
    powerConsumption: [
      { type: 'Property', value: 42.5, unitCode: 'KWT', observedAt: iso(now), datasetId: 'urn:ngsi-ld:Dataset:heating' },
      { type: 'Property', value: 7.25, unitCode: 'KWT', observedAt: iso(now), datasetId: 'urn:ngsi-ld:Dataset:lighting' },
    ],
    location: {
      type: 'GeoProperty',
      value: {
        type: 'Polygon',
        coordinates: [[[24.952202,60.168616],[24.952255,60.167999],[24.953532,60.168032],[24.953488,60.168537],[24.953305,60.168533],[24.953307,60.168499],[24.953096,60.168494],[24.953077,60.168695],[24.952963,60.168693],[24.952966,60.168662],[24.952567,60.168653],[24.95257,60.168625],[24.952202,60.168616]]],
      },
    },
  },
  ...places,
];

const headers = (json = true) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(TENANT ? { 'NGSILD-Tenant': TENANT } : {}),
});

async function call(method, path, body, okStatuses = [200, 201, 204]) {
  const res = await fetch(BROKER + '/ngsi-ld/v1' + path, {
    method,
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!okStatuses.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

async function waitForBroker(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      // no tenant header: a tenant that holds nothing yet answers 404
      if ((await fetch(BROKER + '/ngsi-ld/v1/types')).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > until) {
      throw new Error('broker not reachable at ' + BROKER);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  await waitForBroker();
  for (const e of entities) {
    // purge history and current state so a re-run starts clean
    await call('DELETE', `/temporal/entities/${encodeURIComponent(e.id)}`, undefined, [204, 404]);
    await call('DELETE', `/entities/${encodeURIComponent(e.id)}`, undefined, [204, 404]);
  }
  await call('POST', '/entityOperations/upsert?options=replace', entities, [200, 201, 204]);

  const instances = (fn) => Array.from({ length: HOURS }, (_, i) => fn(i, iso(start + i * HOUR)));
  for (const s of stations) {
    const body = Object.fromEntries(
      Object.keys(series).map((attr) => [
        attr,
        instances((i, t) => ({ type: 'Property', value: series[attr](s.n, i), unitCode: units[attr], observedAt: t })),
      ])
    );
    await call('POST', `/temporal/entities/${encodeURIComponent(aqId(s.n))}/attrs`, body);
  }
  await call('POST', `/temporal/entities/${encodeURIComponent(CITY_HALL)}/attrs`, {
    powerConsumption: [
      ...instances((i, t) => ({ type: 'Property', value: round(40 + (i % 6)), unitCode: 'KWT', observedAt: t, datasetId: 'urn:ngsi-ld:Dataset:heating' })),
      ...instances((i, t) => ({ type: 'Property', value: round(5 + (i % 4) * 0.5), unitCode: 'KWT', observedAt: t, datasetId: 'urn:ngsi-ld:Dataset:lighting' })),
    ],
  });
  console.log(`seeded ${entities.length} entities, ${HOURS} hourly instances from ${iso(start)} into ${BROKER}${TENANT ? ' tenant ' + TENANT : ''}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
