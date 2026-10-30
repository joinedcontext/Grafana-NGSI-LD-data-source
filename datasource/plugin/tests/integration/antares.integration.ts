/**
 * End-to-end tests of the data source against a running NGSI-LD broker (Antares):
 * the real request building, paging and frame conversion over real HTTP.
 *
 *   docker compose up -d antares        (from datasource/)
 *   NGSILD_BROKER_URL=http://localhost:9090 npm run test:integration
 *
 * The suite seeds its own tenant with ../../seed/seed.mjs at a fixed anchor, so every value is known.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import {
  DataQueryRequest,
  DataSourceInstanceSettings,
  dateTime,
  NodeGraphDataFrameFieldNames as G,
} from '@grafana/data';
import { BackendSrvRequest, TemplateSrv } from '@grafana/runtime';
import { from, lastValueFrom } from 'rxjs';

import { NgsildDataSource } from '../../src/datasource';
import { NgsildQuery, NgsildQueryType, NgsildSourceOptions } from '../../src/types';

const BROKER = (process.env.NGSILD_BROKER_URL || 'http://localhost:9090').replace(/\/$/, '');
const TENANT = 'grafana-it';
// past the broker's default of 100 instances per attribute and answer (Antares
// ANTARES_TEMPORAL_DEFAULT_INSTANCES), so a temporal query pages through 206 answers
const HOURS = 250;
const HOUR = 3600_000;
const START = Date.UTC(2026, 0, 1);
const END = START + HOURS * HOUR;
const AQ = (n: number) => `urn:ngsi-ld:AirQualityObserved:HEL-0${n}`;
// repeats the seed's pm10 formula (seed.mjs `series`), station n, hour i
const pm10 = (n: number, i: number) => Math.round((20 + n * 5 + 10 * Math.sin(i / 4)) * 10) / 10;

/** Grafana's backend proxy, replaced by a direct fetch: same request in, same FetchResponse out. */
jest.mock('@grafana/runtime', () => ({
  getTemplateSrv: () => ({ replace: (v: string) => v }),
  getBackendSrv: () => ({
    fetch: (req: BackendSrvRequest) =>
      from(
        fetch(req.url, { method: req.method, headers: req.headers }).then(async (res) => {
          const text = await res.text();
          // as Grafana's fetch: the raw text for responseType text, else parsed JSON
          const data = req.responseType === 'text' ? text : text ? JSON.parse(text) : undefined;
          if (!res.ok) {
            throw { status: res.status, statusText: res.statusText, data };
          }
          return { status: res.status, statusText: res.statusText, data, headers: res.headers, ok: true };
        })
      ),
  }),
}));

function makeDs(jsonData: Partial<NgsildSourceOptions> = {}) {
  const settings = {
    url: BROKER,
    jsonData: { tenant: TENANT, ...jsonData },
  } as unknown as DataSourceInstanceSettings<NgsildSourceOptions>;
  return new NgsildDataSource(settings, { replace: (v?: string) => v ?? '' } as unknown as TemplateSrv);
}

async function query(q: Partial<NgsildQuery>, ds = makeDs()) {
  return lastValueFrom(
    ds.query({
      targets: [{ refId: 'A', ...q }],
      range: { from: dateTime(START), to: dateTime(END), raw: { from: '', to: '' } },
      scopedVars: {},
      intervalMs: HOUR,
    } as unknown as DataQueryRequest<NgsildQuery>)
  );
}

const field = (frame: any, name: string) => frame.fields.find((f: any) => f.name === name);
const byEntity = (frames: any[]) => Object.fromEntries(frames.map((f) => [f.fields[1].labels.entity, f]));

beforeAll(() => {
  execFileSync(
    'node',
    [
      path.resolve(__dirname, '../../../seed/seed.mjs'),
      '--broker',
      BROKER,
      '--tenant',
      TENANT,
      '--anchor',
      new Date(START).toISOString(),
      '--hours',
      String(HOURS),
    ],
    { stdio: 'pipe', timeout: 60_000 }
  );
}, 90_000);

describe('connection', () => {
  it('passes the data source health check', async () => {
    const res = await makeDs().testDatasource();
    expect(res.status).toBe('success');
    expect(res.message).toContain(`tenant ${TENANT}`);
    expect(res.message).toContain('Temporal API available');
  });

  it('reports an unknown tenant with the broker message', async () => {
    const res = await makeDs({ tenant: 'no-such-tenant-x' }).testDatasource();
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/404.*tenant no-such-tenant-x does not exist/);
  });

  it('reports an unreachable broker', async () => {
    const settings = {
      url: 'http://127.0.0.1:1',
      jsonData: {},
    } as unknown as DataSourceInstanceSettings<NgsildSourceOptions>;
    const res = await new NgsildDataSource(settings, {
      replace: (v?: string) => v ?? '',
    } as unknown as TemplateSrv).testDatasource();
    expect(res.status).toBe('error');
  });
});

describe('metadata and variables', () => {
  it('lists the seeded types with their attributes', async () => {
    const types = await makeDs().getTypes();
    expect(types.map((t) => t.typeName).sort()).toEqual([
      'AirQualityObserved',
      'Building',
      'Device',
      'Park',
      'Road',
      'Zone',
    ]);
    expect(types.find((t) => t.typeName === 'AirQualityObserved')?.attributeNames).toEqual(
      expect.arrayContaining(['pm10', 'location'])
    );
  });

  it('answers the variable queries', async () => {
    const ds = makeDs();
    expect((await ds.metricFindQuery('types()')).map((v) => v.text)).toEqual([
      'AirQualityObserved',
      'Building',
      'Device',
      'Park',
      'Road',
      'Zone',
    ]);
    expect((await ds.metricFindQuery('attributes(Device)')).map((v) => v.text)).toEqual(
      expect.arrayContaining(['batteryLevel', 'locatedIn', 'name', 'serialNumber'])
    );
    expect(await ds.metricFindQuery('entities(Device, name)')).toEqual(
      expect.arrayContaining([{ text: 'Sensor box 1', value: 'urn:ngsi-ld:Device:HEL-01' }])
    );
    expect((await ds.metricFindQuery('values(AirQualityObserved, isOnline)')).map((v) => v.text)).toEqual([
      'false',
      'true',
    ]);
  });

  it('rejects an unknown variable function', async () => {
    await expect(makeDs().metricFindQuery('nope()')).rejects.toThrow('Unknown variable query function');
  });
});

describe('temporal', () => {
  it('collects all hourly values of every station across 206 pages', async () => {
    const res = await query({ entityType: 'AirQualityObserved', attributes: ['pm10'] });
    expect(res.errors).toBeUndefined();
    const frames = byEntity(res.data);
    for (const n of [1, 2, 3]) {
      const f = frames[AQ(n)];
      expect(f.fields[0].values).toEqual(Array.from({ length: HOURS }, (_, i) => START + i * HOUR));
      expect(f.fields[1].values).toEqual(Array.from({ length: HOURS }, (_, i) => pm10(n, i)));
      expect(f.fields[1].config.unit).toBe('conμgm3');
    }
    expect(res.data[0].meta?.notices).toBeUndefined();
  });

  it('pages a query without an attribute list (continuations keep the type)', async () => {
    const res = await query({ entityType: 'AirQualityObserved' });
    expect(res.errors).toBeUndefined();
    const pm = res.data.filter((f: any) => f.fields[1].name === 'pm10');
    expect(pm).toHaveLength(3);
    pm.forEach((f: any) => expect(f.fields[1].values).toHaveLength(HOURS));
  });

  it('queries by entity id alone', async () => {
    const res = await query({ entityId: `${AQ(1)},${AQ(3)}` });
    expect(res.errors).toBeUndefined();
    expect(new Set(res.data.map((f: any) => f.fields[1].labels.entity))).toEqual(new Set([AQ(1), AQ(3)]));
    expect(res.data.find((f: any) => f.fields[1].name === 'no2').fields[1].values).toHaveLength(HOURS);
  });

  it('pages lastN backwards and returns the newest N', async () => {
    const res = await query({ entityId: AQ(2), attributes: ['pm10'], lastN: 20 });
    expect(res.data[0].fields[1].values).toEqual(Array.from({ length: 20 }, (_, i) => pm10(2, HOURS - 20 + i)));
  });

  it('warns and returns a prefix when the request budget runs out', async () => {
    const res = await query({ entityId: AQ(1), attributes: ['pm10'] }, makeDs({ maxTemporalPages: 2 }));
    const values = res.data[0].fields[1].values;
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThan(HOURS);
    expect(values).toEqual(Array.from({ length: values.length }, (_, i) => pm10(1, i)));
    expect(res.data[0].meta?.notices?.[0].text).toContain('Max temporal pages');
  });

  it('keeps the instances of a multi-instance attribute apart by datasetId', async () => {
    const res = await query({ entityId: 'urn:ngsi-ld:Building:CityHall', attributes: ['powerConsumption'] });
    expect(res.data).toHaveLength(2);
    const byDataset = Object.fromEntries(res.data.map((f: any) => [f.fields[1].labels.datasetId, f.fields[1].values]));
    expect(byDataset['urn:ngsi-ld:Dataset:heating']).toHaveLength(HOURS);
    expect(byDataset['urn:ngsi-ld:Dataset:heating'].slice(0, 7)).toEqual([40, 41, 42, 43, 44, 45, 40]);
    expect(byDataset['urn:ngsi-ld:Dataset:lighting'].slice(0, 5)).toEqual([5, 5.5, 6, 6.5, 5]);
  });

  it('aggregates per day', async () => {
    const res = await query({
      entityId: AQ(1),
      attributes: ['pm10'],
      aggrMethod: 'avg,max',
      aggrPeriodDuration: 'P1D',
    });
    const byMethod = Object.fromEntries(res.data.map((f: any) => [f.fields[1].labels.aggregation, f.fields[1].values]));
    const day = (d: number) => Array.from({ length: 24 }, (_, i) => pm10(1, d * 24 + i));
    expect(byMethod.max).toHaveLength(Math.ceil(HOURS / 24));
    expect(byMethod.max.slice(0, 2)).toEqual([Math.max(...day(0)), Math.max(...day(1))]);
    expect(byMethod.avg[0]).toBeCloseTo(day(0).reduce((a, b) => a + b) / 24, 6);
  });

  it('names series by a name attribute in the query language', async () => {
    const res = await query({ entityId: AQ(1), attributes: ['pm10'], entityName: 'name', lang: 'sv' });
    expect(res.data[0].fields[1].config.displayNameFromDS).toBe('Mannerheimvägen:pm10');
  });

  it('reads a geo query with attributes, keeping the location', async () => {
    const res = await query({ queryType: NgsildQueryType.GEO, entityType: 'AirQualityObserved', attributes: ['pm10'] });
    expect(field(res.data[0], 'latitude').values).toHaveLength(3);
    expect(field(res.data[0], 'pm10').values).toHaveLength(3);
  });

  it('runs a temporal query filtered by q alone', async () => {
    const res = await query({ customQuery: 'pm10>0' });
    expect(res.errors).toBeUndefined();
    expect(res.data.length).toBeGreaterThan(0);
  });

  it('says that a type is unknown', async () => {
    const res = await query({ queryType: NgsildQueryType.ENTITY, entityType: 'NoSuchType' });
    expect(res.data[0].meta?.notices?.[0].text).toMatch(
      /^The broker has no entities of type NoSuchType\. Known types: /
    );
  });

  it('returns an empty result for a window without data', async () => {
    const ds = makeDs();
    const res = await lastValueFrom(
      ds.query({
        targets: [{ refId: 'A', entityId: AQ(1), attributes: ['pm10'] }],
        range: { from: dateTime(START - 10 * HOUR), to: dateTime(START - 5 * HOUR), raw: { from: '', to: '' } },
        scopedVars: {},
        intervalMs: HOUR,
      } as unknown as DataQueryRequest<NgsildQuery>)
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.map((f) => [f.fields.length, f.meta?.notices?.[0].text])).toEqual([
      [0, 'No instances with observedAt in this time range.'],
    ]);
  });
});

describe('current values', () => {
  it('returns a table row per entity with units', async () => {
    const res = await query({
      queryType: NgsildQueryType.ENTITY,
      format: 'table',
      entityType: 'AirQualityObserved',
      attributes: ['pm10', 'isOnline'],
    });
    const t = res.data[0];
    expect(field(t, 'id').values).toEqual([AQ(1), AQ(2), AQ(3)]);
    expect(field(t, 'pm10').values).toEqual([1, 2, 3].map((n) => pm10(n, HOURS)));
    expect(field(t, 'isOnline').values).toEqual([true, true, false]);
  });

  it('filters with the query language and scopes', async () => {
    const online = await query({
      queryType: NgsildQueryType.ENTITY,
      format: 'table',
      entityType: 'AirQualityObserved',
      customQuery: 'isOnline==true',
    });
    expect(field(online.data[0], 'id').values).toEqual([AQ(1), AQ(2)]);
    const scoped = await query({
      queryType: NgsildQueryType.ENTITY,
      format: 'table',
      entityType: 'AirQualityObserved',
      scopeQuery: '/Helsinki/Vallila',
    });
    expect(field(scoped.data[0], 'id').values).toEqual([AQ(3)]);
  });

  it('pages entities by offset with a small page size', async () => {
    const { entities } = await makeDs({ pageSize: 2 }).fetchEntities({
      refId: 'A',
      entityType: 'AirQualityObserved,Device',
    });
    expect(entities.map((e) => e.id).sort()).toHaveLength(6);
    expect(new Set(entities.map((e) => e.id)).size).toBe(6);
  });

  it('queries current values by entity id alone', async () => {
    const res = await query({
      queryType: NgsildQueryType.ENTITY,
      format: 'table',
      entityId: 'urn:ngsi-ld:Building:CityHall',
    });
    expect(res.errors).toBeUndefined();
    expect(field(res.data[0], 'floorsAboveGround').values).toEqual([4]);
  });

  it('turns a broker 400 into a query error with its detail', async () => {
    const res = await query({
      queryType: NgsildQueryType.ENTITY,
      entityType: 'AirQualityObserved',
      customQuery: '(pm10',
    });
    expect(res.errors?.[0].message).toMatch(/^400.*invalid q expression/);
  });
});

describe('geo', () => {
  it('locates points, polygons and lines', async () => {
    const res = await query({ queryType: NgsildQueryType.GEO, entityType: 'AirQualityObserved,Building,Road' });
    const f = res.data[0];
    const at = (id: string) => field(f, 'id').values.indexOf(id);
    expect(field(f, 'geometryType').values[at(AQ(1))]).toBe('Point');
    expect(field(f, 'latitude').values[at(AQ(1))]).toBeCloseTo(60.16964, 4);
    expect(field(f, 'geometryType').values[at('urn:ngsi-ld:Building:CityHall')]).toBe('Polygon');
    expect(field(f, 'geometryType').values[at('urn:ngsi-ld:Road:Mannerheimintie')]).toBe('LineString');
  });

  it('gives the map a line per polygon ring and keeps points and lines with geoLocation "shape"', async () => {
    const res = await query({
      queryType: NgsildQueryType.GEO,
      entityType: 'AirQualityObserved,Building,Road,Zone,Park',
      geoLocation: 'shape',
    });
    const f = res.data[0];
    const drawn = (id: string) =>
      field(f, 'id')
        .values.map((v: string, i: number) => (v === id ? field(f, 'geometry').values[i].getType() : undefined))
        .filter(Boolean);
    expect(drawn(AQ(1))).toEqual(['Point']);
    const typeOf = (id: string) => field(f, 'geometryType').values[field(f, 'id').values.indexOf(id)];
    expect(drawn('urn:ngsi-ld:Road:Mannerheimintie')).toEqual(['LineString']);
    expect(drawn('urn:ngsi-ld:Zone:SenateSquare')).toEqual(['LineString']);
    expect(drawn('urn:ngsi-ld:Building:CityHall')).toEqual(['LineString']);
    expect(typeOf('urn:ngsi-ld:Zone:SenateSquare')).toBe('Polygon');
    // a MultiPolygon of two parks: one outline each
    expect(drawn('urn:ngsi-ld:Park:Esplanadi')).toEqual(['LineString', 'LineString']);
    expect(typeOf('urn:ngsi-ld:Park:Esplanadi')).toBe('MultiPolygon');
  });

  it('applies a near geo-query', async () => {
    const res = await query({
      queryType: NgsildQueryType.GEO,
      entityType: 'AirQualityObserved',
      georel: 'near;maxDistance==500',
      geometry: 'Point',
      coordinates: '[24.93939,60.16964]',
    });
    expect(field(res.data[0], 'id').values).toEqual([AQ(1)]);
  });
});

describe('node graph', () => {
  it('follows relationships from stations through devices to the city hall', async () => {
    const res = await query({ queryType: NgsildQueryType.NODE_GRAPH, entityId: AQ(1) });
    const [nodes, edges] = res.data;
    expect(field(nodes, G.id).values).toEqual(
      expect.arrayContaining([AQ(1), 'urn:ngsi-ld:Device:HEL-01', 'urn:ngsi-ld:Building:CityHall'])
    );
    const pairs = field(edges, G.source).values.map(
      (s: string, i: number) => `${s}->${field(edges, G.target).values[i]}`
    );
    expect(pairs).toEqual(
      expect.arrayContaining([
        `${AQ(1)}->urn:ngsi-ld:Device:HEL-01`,
        'urn:ngsi-ld:Device:HEL-01->urn:ngsi-ld:Building:CityHall',
      ])
    );
  });

  it('stops at the configured depth', async () => {
    const res = await query({ queryType: NgsildQueryType.NODE_GRAPH, entityId: AQ(1), graphDepth: 1 });
    expect(field(res.data[0], G.id).values).not.toContain('urn:ngsi-ld:Building:CityHall');
  });
});
