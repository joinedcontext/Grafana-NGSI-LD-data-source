import { DataQueryRequest, DataSourceInstanceSettings, dateTime } from '@grafana/data';
import { BackendSrvRequest, TemplateSrv } from '@grafana/runtime';
import { lastValueFrom, of, throwError } from 'rxjs';

import { errorMessage, MAX_FRAMES, NgsildDataSource, nextTemporalPage, parseBody } from './datasource';
import { NgsildQuery, NgsildQueryType, NgsildSourceOptions } from './types';

const fetchMock = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: fetchMock }),
  getTemplateSrv: () => ({ replace: (v: string) => v }),
}));

const HOUR = 3600_000;
const START = Date.UTC(2026, 0, 1);
const iso = (t: number) => new Date(t).toISOString();

type Handler = (
  path: string,
  params: Record<string, string>
) => { status?: number; data: unknown; headers?: Record<string, string> } | Error;

/** Routes fetch calls to `handler`; records every request as path + parsed query. */
function serve(handler: Handler) {
  const calls: Array<{ path: string; params: Record<string, string>; req: BackendSrvRequest }> = [];
  fetchMock.mockImplementation((req: BackendSrvRequest) => {
    const url = new URL(req.url, 'http://grafana');
    const path = url.pathname.replace(/^.*\/ngsi-ld\/v1/, '');
    const params = Object.fromEntries(url.searchParams);
    calls.push({ path, params, req });
    // Antares refuses more than one of pick, omit and attrs
    const res =
      [params.pick, params.omit, params.attrs].filter(Boolean).length > 1
        ? Object.assign(new Error(), {
            status: 400,
            data: { detail: 'pick, omit and attrs are mutually exclusive' },
          })
        : handler(path, params);
    return res instanceof Error
      ? throwError(() => res)
      : of({ status: res.status ?? 200, data: res.data, headers: new Map(Object.entries(res.headers ?? {})) });
  });
  return calls;
}

/**
 * In-memory temporal API with Antares' paging: every attribute serves at most `cut` instances
 * per answer (lastN: the newest ones), the answer is 206 when any attribute was cut,
 * `after` and `between` include timeAt, `before` and endTimeAt exclude it.
 */
function temporalBroker(
  history: Record<string, { type: string; attrs: Record<string, number[]> }>,
  cut: number
): Handler {
  return (path, p) => {
    if (path !== '/temporal/entities') {
      return { data: [] };
    }
    const ids = p.id?.split(',');
    const inWindow = (t: number) =>
      p.timerel === 'between'
        ? t >= Date.parse(p.timeAt) && t < Date.parse(p.endTimeAt)
        : p.timerel === 'after'
          ? t >= Date.parse(p.timeAt)
          : p.timerel === 'before'
            ? t < Date.parse(p.timeAt)
            : true;
    let partial = false;
    const entities = Object.entries(history)
      .filter(([id, e]) => (!ids || ids.includes(id)) && (!p.type || p.type.split(',').includes(e.type)))
      .map(([id, e]) => {
        const out: Record<string, unknown> = { id, type: e.type };
        for (const [attr, times] of Object.entries(e.attrs)) {
          let served = times.filter(inWindow).sort((a, b) => a - b);
          const n = Math.min(p.lastN ? Number(p.lastN) : cut, cut);
          if (served.length > n) {
            partial = true;
            served = p.lastN ? served.slice(-n) : served.slice(0, n);
          }
          if (served.length > 0) {
            out[attr] = { type: 'Property', values: served.map((t) => [(t - START) / HOUR, iso(t)]) };
          }
        }
        return out;
      })
      .filter((e) => Object.keys(e).length > 2);
    const offset = Number(p.offset ?? 0);
    return { status: partial ? 206 : 200, data: entities.slice(offset, offset + Number(p.limit ?? 1000)) };
  };
}

const hours = (from: number, to: number, step = 1) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => START + (from + i * step) * HOUR);

function makeDs(
  jsonData: Partial<NgsildSourceOptions> = {},
  url = 'http://grafana/api/datasources/proxy/uid/x/',
  replace?: TemplateSrv['replace']
) {
  const settings = { url, jsonData } as unknown as DataSourceInstanceSettings<NgsildSourceOptions>;
  const templateSrv = { replace: replace ?? ((v?: string) => v ?? '') } as unknown as TemplateSrv;
  return new NgsildDataSource(settings, templateSrv);
}

function request(
  targets: Array<Partial<NgsildQuery>>,
  from = START,
  to = START + 48 * HOUR
): DataQueryRequest<NgsildQuery> {
  return {
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t })),
    range: { from: dateTime(from), to: dateTime(to), raw: { from: '', to: '' } },
    scopedVars: {},
    intervalMs: 60_000,
  } as unknown as DataQueryRequest<NgsildQuery>;
}

/** query() answers once, as an Observable */
const query = (ds: NgsildDataSource, r: DataQueryRequest<NgsildQuery>) => lastValueFrom(ds.query(r));

const valuesOf = (frame: any) => frame.fields[1].values as number[];
/** Temporal requests only; a temporal query ends with a unit lookup on /entities. */
const temporalCalls = <T extends { path: string }>(calls: T[]) => calls.filter((c) => c.path === '/temporal/entities');

beforeEach(() => fetchMock.mockReset());

describe('errorMessage', () => {
  it.each([
    [
      { status: 400, statusText: 'Bad Request', data: { type: 'x', title: 'Bad', detail: 'attrs invalid' } },
      '400 Bad Request: attrs invalid',
    ],
    [{ status: 404, data: { title: 'Not found' } }, '404: Not found'],
    [{ status: 502, data: 'proxy error' }, '502: proxy error'],
    [
      { status: 502, data: '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>' },
      '502: 502 Bad Gateway',
    ],
    [{ status: 504, data: '<!DOCTYPE html><html><body>no title</body></html>' }, '504'],
    [{ status: 500, data: 'x'.repeat(300) }, '500: ' + 'x'.repeat(200) + '…'],
    [{ status: 500 }, '500'],
    [{ message: 'network down' }, 'network down'],
    [undefined, 'Unknown error'],
  ])('%j -> %s', (err, expected) => expect(errorMessage(err)).toBe(expected));
});

describe('parseBody', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['[1,2]', [1, 2]],
    [' RBAC: access denied\n', 'RBAC: access denied'],
    ['', undefined],
    ['  ', undefined],
    [{ already: 'parsed' }, { already: 'parsed' }],
    [undefined, undefined],
  ])('%j -> %j', (body, expected) => expect(parseBody(body)).toEqual(expected));
});

describe('get', () => {
  it('reads the body as text and parses JSON', async () => {
    const calls = serve(() => ({ data: '[{"id":"e","type":"T"}]' }));
    expect((await makeDs().get('/entities')).data).toEqual([{ id: 'e', type: 'T' }]);
    expect(calls[0].req.responseType).toBe('text');
  });

  it.each([
    [{ status: 403, statusText: 'Forbidden', data: 'RBAC: access denied' }, '403 Forbidden: RBAC: access denied'],
    [{ status: 400, data: '{"type":"x","title":"BadRequestData","detail":"bad q"}' }, '400: bad q'],
    [{ status: 502, data: '' }, '502'],
  ])('keeps the reason of a plain-text or JSON error body: %j', async (err, message) => {
    serve(() => Object.assign(new Error(), err));
    await expect(makeDs().get('/types')).rejects.toMatchObject({ message, status: err.status });
  });

  it('rejects a 200 answer that is not JSON (a web page at the broker URL)', async () => {
    serve(() => ({ data: '<!doctype html><html><title>Welcome</title></html>' }));
    await expect(makeDs().get('/types')).rejects.toThrow('does not answer with NGSI-LD JSON');
    expect((await makeDs().testDatasource()).message).toMatch(
      /^Cannot reach the NGSI-LD API \(The URL does not answer with NGSI-LD JSON/
    );
  });

  it('answers an empty body as undefined', async () => {
    serve(() => ({ status: 204, data: '' }));
    expect((await makeDs().get('/x')).data).toBeUndefined();
  });

  it('does not send a request once the signal is aborted', async () => {
    const calls = serve(() => ({ data: [] }));
    const abort = new AbortController();
    abort.abort();
    await expect(makeDs().get('/types', [], abort.signal)).rejects.toThrow('Query cancelled');
    expect(calls).toHaveLength(0);
  });
});

describe('constructor', () => {
  it('sends JSON-LD context and tenant headers to the NGSI-LD root', async () => {
    const calls = serve(() => ({ data: [] }));
    await makeDs({ contextUrl: ' https://ctx/c.jsonld ', tenant: ' t1 ' }).get('/types');
    expect(calls[0].req.url).toBe('http://grafana/api/datasources/proxy/uid/x/ngsi-ld/v1/types');
    expect(calls[0].req.headers).toEqual({
      Accept: 'application/json',
      Link: '<https://ctx/c.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"',
      'NGSILD-Tenant': 't1',
    });
    expect(calls[0].req.showErrorAlert).toBe(false);
  });

  it('routes through the OAuth route and leaves out empty headers', async () => {
    const calls = serve(() => ({ data: [] }));
    await makeDs({ authType: 'oauth', tenant: '  ' }, '/proxy').get('/types');
    expect(calls[0].req.url).toBe('/proxy/oauth/ngsi-ld/v1/types');
    expect(calls[0].req.headers).toEqual({ Accept: 'application/json' });
  });

  it('turns a failed call into an Error with the problem detail', async () => {
    serve(() => Object.assign(new Error(), { status: 400, data: { detail: 'bad q' } }));
    await expect(makeDs().get('/entities')).rejects.toThrow('400: bad q');
  });
});

describe('applyTemplateVariables', () => {
  const replace = jest.fn((v: string, _vars: unknown, format?: string) =>
    v.replace('$t', format === 'regex' ? 'A|B' : 'A,B')
  );
  const ds = makeDs({}, '/p', replace as any);

  it('replaces variables in every text field, regex-escaped in the id pattern', () => {
    const out = ds.applyTemplateVariables(
      { refId: 'A', entityType: '$t', idPattern: '$t', attributes: ['$t', 'x'], customQuery: 'a==$t' },
      {}
    );
    expect(out).toMatchObject({
      entityType: 'A,B',
      idPattern: 'A|B',
      attributes: ['A', 'B', 'x'],
      customQuery: 'a==A,B',
    });
  });

  it('defaults to temporal and normalises legacy type names, keeping unknown ones', () => {
    expect(ds.applyTemplateVariables({ refId: 'A' }, {}).queryType).toBe(NgsildQueryType.TEMPORAL);
    expect(ds.applyTemplateVariables({ refId: 'A', queryType: 'timseries' }, {}).queryType).toBe(
      NgsildQueryType.TEMPORAL
    );
    expect(ds.applyTemplateVariables({ refId: 'A', queryType: 'graph' }, {}).queryType).toBe(
      NgsildQueryType.NODE_GRAPH
    );
    expect(ds.applyTemplateVariables({ refId: 'A', queryType: 'bogus' }, {}).queryType).toBe('bogus');
  });
});

describe('query', () => {
  it('skips hidden queries and says what a query without a selector needs', async () => {
    serve(() => ({ data: [] }));
    const res = await query(
      makeDs(),
      request([
        { hide: true, entityType: 'T' },
        { queryType: NgsildQueryType.ENTITY },
        { queryType: NgsildQueryType.ENTITY, georel: 'within' },
      ])
    );
    expect(res.data.map((f) => [f.refId, f.fields.length, f.meta?.notices?.[0].text])).toEqual([
      ['B', 0, 'Select an entity type, entity id, id pattern, attribute, query or geo filter.'],
      ['C', 0, 'Select an entity type, entity id, id pattern, attribute, query or geo filter.'], // georel without coordinates
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops paging and the request in flight when the subscriber leaves', async () => {
    const calls = serve(temporalBroker({ e: { type: 'T', attrs: { p: hours(0, 40) } } }, 5));
    const next = jest.fn();
    const sub = makeDs()
      .query(request([{ queryType: NgsildQueryType.TEMPORAL, entityType: 'T' }]))
      .subscribe({ next, error: next });
    sub.unsubscribe(); // a refresh or a new time range
    await new Promise((r) => setTimeout(r, 10));
    expect(temporalCalls(calls)).toHaveLength(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('caps current-value series at MAX_FRAMES with a warning', async () => {
    const attrs = Object.fromEntries(
      Array.from({ length: MAX_FRAMES + 20 }, (_, i) => [`a${i}`, { type: 'Property', value: i }])
    );
    serve(() => ({ data: [{ id: 'urn:x:E', type: 'T', ...attrs }] }));
    const res = await query(makeDs(), request([{ queryType: NgsildQueryType.ENTITY, entityType: 'T' }]));
    expect(res.data).toHaveLength(MAX_FRAMES);
    expect(res.data[0].meta?.notices?.[0].text).toBe(
      `Showing ${MAX_FRAMES} of ${MAX_FRAMES + 20} series; select attributes or lower the limit.`
    );
  });

  it('reports an error per query and keeps the frames of the others', async () => {
    serve((path, p) =>
      p.type === 'Bad'
        ? Object.assign(new Error(), { status: 400, data: { detail: 'unknown type' } })
        : { data: [{ id: 'e', type: 'T', v: { value: 1 } }] }
    );
    const res = await query(
      makeDs(),
      request([
        { queryType: NgsildQueryType.ENTITY, entityType: 'Bad' },
        { queryType: NgsildQueryType.ENTITY, entityType: 'T', format: 'table' },
        { queryType: 'bogus', entityType: 'T' },
      ])
    );
    expect(res.data).toHaveLength(1);
    expect(res.data[0].refId).toBe('B');
    expect(res.errors).toEqual([
      { refId: 'A', message: '400: unknown type' },
      { refId: 'C', message: 'Unsupported query type bogus' },
    ]);
  });

  it('builds current-value frames stamped with the range end when no time is observed', async () => {
    serve(() => ({ data: [{ id: 'urn:x:E', type: 'T', v: { type: 'Property', value: 3 } }] }));
    const res = await query(makeDs(), request([{ queryType: NgsildQueryType.ENTITY, entityType: 'T' }]));
    expect(res.data[0].fields[0].values).toEqual([START + 48 * HOUR]);
    expect(valuesOf(res.data[0])).toEqual([3]);
  });

  it('builds a geomap table', async () => {
    serve(() => ({
      data: [
        {
          id: 'urn:x:E',
          type: 'T',
          location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [19, 48] } },
        },
      ],
    }));
    const res = await query(makeDs(), request([{ queryType: NgsildQueryType.GEO, entityType: 'T' }]));
    expect(res.data[0].fields.find((f: any) => f.name === 'latitude').values).toEqual([48]);
  });

  it('builds a node graph that loads related entities and the stat attributes', async () => {
    const calls = serve((_path, p) =>
      p.id
        ? { data: [{ id: 'urn:x:D', type: 'Device' }] }
        : { data: [{ id: 'urn:x:S', type: 'S', t: { value: 1 }, ref: { type: 'Relationship', object: 'urn:x:D' } }] }
    );
    const res = await query(
      makeDs(),
      request([
        {
          queryType: NgsildQueryType.NODE_GRAPH,
          entityType: 'S',
          attributes: ['ref'],
          primaryNodeAttributes: { '': ['t'] },
        },
      ])
    );
    expect(calls[0].params.attrs).toBeUndefined(); // attrs would drop the relationships, and the edges with them
    expect(calls[1].params).toMatchObject({ id: 'urn:x:D', limit: '1' });
    expect(res.data.map((f) => f.name)).toEqual(['nodes', 'edges']);
    expect(res.data[0].fields[0].values).toEqual(['urn:x:S', 'urn:x:D']);
  });

  it('keeps attrs in a node graph when they are the only selector, with the stat attributes', async () => {
    const calls = serve(() => ({ data: [] }));
    await query(
      makeDs(),
      request([{ queryType: NgsildQueryType.NODE_GRAPH, attributes: ['ref'], primaryNodeAttributes: { '': ['t'] } }])
    );
    expect(calls[0].params.attrs).toBe('ref,t');
  });
});

describe('fetchEntities', () => {
  const broker =
    (total: number): Handler =>
    (_path, p) => {
      const offset = Number(p.offset ?? 0);
      const n = Math.max(0, Math.min(Number(p.limit), total - offset));
      return { data: Array.from({ length: n }, (_, i) => ({ id: `e${offset + i}`, type: 'T' })) };
    };

  it('pages by offset until a short page', async () => {
    const calls = serve(broker(5));
    const { entities, notices } = await makeDs({ pageSize: 2 }).fetchEntities({ refId: 'A', entityType: 'T' });
    expect(entities.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(calls.map((c) => [c.params.limit, c.params.offset])).toEqual([
      ['2', undefined],
      ['2', '2'],
      ['2', '4'],
    ]);
    expect(notices).toEqual([]);
  });

  it('stops at the query limit and says so', async () => {
    const calls = serve(broker(10));
    const { entities, notices } = await makeDs({ pageSize: 2 }).fetchEntities({
      refId: 'A',
      entityType: 'T',
      limit: 3,
    });
    expect(entities).toHaveLength(3);
    expect(calls.map((c) => c.params.limit)).toEqual(['2', '1']);
    expect(notices[0].text).toContain('first 3 entities');
  });

  it('splits a long id list into chunks and keeps the limit across them', async () => {
    const calls = serve((_p, params) => ({
      data: params.id
        .split(',')
        .slice(0, Number(params.limit))
        .map((id) => ({ id, type: 'T' })),
    }));
    const ids = Array.from({ length: 120 }, (_, i) => `e${i}`);
    const all = await makeDs().fetchEntities({ refId: 'A', entityId: ids.join(',') });
    expect(all.entities).toHaveLength(120);
    expect(calls.map((c) => c.params.id.split(',').length)).toEqual([50, 50, 20]);
    const capped = await makeDs().fetchEntities({ refId: 'A', entityId: ids.join(','), limit: 60 });
    expect(capped.entities).toHaveLength(60);
    expect(capped.notices[0].text).toContain('first 60 entities');
  });

  it('sends pick for lookups that need no values', async () => {
    const calls = serve(() => ({ data: [] }));
    await makeDs().fetchEntities({ refId: 'A', entityType: 'T' }, undefined, ['id']);
    expect(calls[0].params.pick).toBe('id');
  });

  it('sends pick instead of attrs, never both', async () => {
    const calls = serve(() => ({ data: [] }));
    await makeDs().fetchEntities({ refId: 'A', entityType: 'T', attributes: ['name'] }, undefined, ['id', 'name']);
    expect(calls[0].params.pick).toBe('id,name');
    expect(calls[0].params.attrs).toBeUndefined();
    await makeDs().fetchEntities({ refId: 'A', entityType: 'T', attributes: ['name'] });
    expect(calls[1].params.attrs).toBe('name');
    expect(calls[1].params.pick).toBeUndefined();
  });

  it('accepts a single entity object as answer', async () => {
    serve(() => ({ data: { id: 'e', type: 'T' } }));
    expect((await makeDs().fetchEntities({ refId: 'A', entityId: 'e' })).entities).toEqual([{ id: 'e', type: 'T' }]);
  });

  it('keeps paging past a short page while the count says more exist', async () => {
    // a broker that serves at most 3 entities an answer, whatever the limit
    const calls = serve((_path, p) => {
      const offset = Number(p.offset ?? 0);
      const n = Math.max(0, Math.min(3, Number(p.limit), 7 - offset));
      return {
        data: Array.from({ length: n }, (_, i) => ({ id: `e${offset + i}`, type: 'T' })),
        headers: p.count === 'true' ? { 'NGSILD-Results-Count': '7' } : undefined,
      };
    });
    const { entities, notices } = await makeDs({ pageSize: 5 }).fetchEntities({ refId: 'A', entityType: 'T' });
    expect(entities.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    expect(calls.map((c) => c.params.offset)).toEqual([undefined, '3', '6']);
    expect(notices).toEqual([]);
  });

  it('stops at an empty page even when the count says more exist', async () => {
    const calls = serve((_path, p) => ({
      data: p.offset ? [] : [{ id: 'e0', type: 'T' }],
      headers: { 'NGSILD-Results-Count': '5' },
    }));
    const { entities } = await makeDs({ pageSize: 1 }).fetchEntities({ refId: 'A', entityType: 'T' });
    expect(entities).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe('temporal query', () => {
  const run = (ds: NgsildDataSource, q: Partial<NgsildQuery>, from = START, to = START + 48 * HOUR) =>
    query(ds, request([{ queryType: NgsildQueryType.TEMPORAL, entityType: 'T', ...q }], from, to));

  it('collects every instance over many 206 pages', async () => {
    const calls = serve(temporalBroker({ e: { type: 'T', attrs: { p: hours(0, 40) } } }, 9));
    const res = await run(makeDs(), {});
    expect(valuesOf(res.data[0])).toEqual(Array.from({ length: 41 }, (_, i) => i));
    expect(temporalCalls(calls)).toHaveLength(5); // 9 points per page, the boundary instant repeats
    expect(calls[1].params).toMatchObject({
      timerel: 'between',
      timeAt: iso(START + 8 * HOUR),
      endTimeAt: iso(START + 48 * HOUR),
      id: 'e',
    });
    expect(calls[1].params.type).toBe('T'); // an id alone would be a local-only query (5.7.2.4)
    expect(res.data[0].meta?.notices).toBeUndefined();
  });

  it('does not skip the instances of an entity with sparser data', async () => {
    serve(
      temporalBroker(
        {
          dense: { type: 'T', attrs: { p: hours(0, 30) } },
          sparse: { type: 'T', attrs: { p: hours(0, 30, 6) } },
          late: { type: 'T', attrs: { p: hours(20, 30, 2) } },
        },
        4
      )
    );
    const res = await run(makeDs(), {});
    const byEntity = Object.fromEntries(res.data.map((f) => [f.fields[1].labels!.entity, valuesOf(f)]));
    expect(byEntity.dense).toEqual(Array.from({ length: 31 }, (_, i) => i));
    expect(byEntity.sparse).toEqual([0, 6, 12, 18, 24, 30]);
    expect(byEntity.late).toEqual([20, 22, 24, 26, 28, 30]);
  });

  it('pages lastN backwards and keeps the newest N', async () => {
    const calls = serve(temporalBroker({ e: { type: 'T', attrs: { p: hours(0, 40) } } }, 5));
    const res = await run(makeDs(), { lastN: 12 });
    expect(valuesOf(res.data[0])).toEqual(Array.from({ length: 12 }, (_, i) => 29 + i));
    expect(calls[1].params).toMatchObject({ timerel: 'between', endTimeAt: iso(START + 36 * HOUR) });
    expect(temporalCalls(calls)).toHaveLength(3);
  });

  it('stops at the request budget with a warning', async () => {
    const calls = serve(temporalBroker({ e: { type: 'T', attrs: { p: hours(0, 40) } } }, 5));
    const res = await run(makeDs({ maxTemporalPages: 3 }), {});
    expect(temporalCalls(calls)).toHaveLength(3);
    expect(valuesOf(res.data[0])).toHaveLength(13);
    expect(res.data[0].meta?.notices?.[0]).toMatchObject({ severity: 'warning' });
    expect(res.data[0].meta?.notices?.[0].text).toContain('Max temporal pages');
  });

  it('keeps what arrived when a later page fails', async () => {
    const broker = temporalBroker({ e: { type: 'T', attrs: { p: hours(0, 40) } } }, 9);
    let n = 0;
    serve((path, p) =>
      path === '/temporal/entities' && ++n === 3
        ? Object.assign(new Error(), { status: 504, data: 'upstream request timeout' })
        : broker(path, p)
    );
    const res = await run(makeDs(), {});
    expect(res.errors).toBeUndefined();
    expect(valuesOf(res.data[0])).toHaveLength(17); // two pages of 9, the boundary instant shared
    expect(res.data[0].meta?.notices?.[0]).toEqual({
      severity: 'warning',
      text: 'Temporal result incomplete: request 3 failed (504: upstream request timeout). Showing what arrived before.',
    });
  });

  it('fails when the first request fails', async () => {
    serve(() => Object.assign(new Error(), { status: 400, data: { detail: 'bad q' } }));
    const res = await run(makeDs(), {});
    expect(res.errors).toEqual([{ refId: 'A', message: '400: bad q' }]);
  });

  it('says why a temporal query found nothing', async () => {
    serve(() => ({ data: [] }));
    const res = await run(makeDs(), { timeProperty: 'modifiedAt' });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].meta?.notices?.[0].text).toBe('No instances with modifiedAt in this time range.');
  });

  it('splits a long id list into chunks', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `e${i}`);
    const calls = serve(
      temporalBroker(Object.fromEntries(ids.map((id) => [id, { type: 'T', attrs: { p: hours(0, 1) } }])), 10)
    );
    const res = await run(makeDs(), { entityId: ids.join(',') });
    expect(res.data).toHaveLength(60);
    expect(temporalCalls(calls).map((c) => c.params.id.split(',').length)).toEqual([50, 10]);
  });

  it('stops with a warning when the broker repeats a partial page', async () => {
    const calls = serve(() => ({ status: 206, data: [{ id: 'e', type: 'T', p: { values: [[1, iso(START)]] } }] }));
    const res = await run(makeDs(), {});
    expect(temporalCalls(calls)).toHaveLength(2);
    expect(res.data[0].meta?.notices?.[0].text).toContain('cannot be continued');
  });

  it('pages by position when the broker leaves entities without history out of a counted page', async () => {
    // pages the 6 matches first, then drops b and d, which have no instances in the range
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const calls = serve((path, p) => {
      if (path !== '/temporal/entities') {
        return { data: [] };
      }
      const offset = Number(p.offset ?? 0);
      const page = (p.id ? p.id.split(',') : ids.slice(offset, offset + Number(p.limit))).filter(
        (id) => !['b', 'd'].includes(id)
      );
      return {
        data: page.map((id) => ({ id, type: 'T', p: { type: 'Property', values: [[1, iso(START)]] } })),
        headers: p.count === 'true' ? { 'NGSILD-Results-Count': '6' } : undefined,
      };
    });
    const res = await run(makeDs({ pageSize: 2 }), {});
    expect(res.data.map((f) => f.fields[1].labels.entity)).toEqual(['a', 'c', 'e', 'f']);
    expect(temporalCalls(calls).map((c) => c.params.offset)).toEqual([undefined, '2', '4']);
  });

  it('continues a cut aggregated page per method, from the earliest cut bucket', async () => {
    const buckets = hours(0, 8); // 9 hourly buckets, 4 a page
    const calls = serve((path, p) => {
      if (path !== '/temporal/entities') {
        return { data: [] };
      }
      const served = buckets.filter((t) => t >= Date.parse(p.timeAt) && t < Date.parse(p.endTimeAt));
      const page = served.slice(0, 4);
      const bucket = (t: number) => [(t - START) / HOUR, iso(t), iso(t + HOUR)];
      return {
        status: served.length > 4 ? 206 : 200,
        data: [{ id: 'e', type: 'T', p: { type: 'Property', max: page.map(bucket), min: page.map(bucket) } }],
      };
    });
    const res = await run(makeDs(), { aggrMethod: 'max,min', aggrPeriodDuration: 'PT1H' }, START, START + 9 * HOUR);
    expect(res.data.map(valuesOf)).toEqual([buckets.map((_, i) => i), buckets.map((_, i) => i)]);
    expect(temporalCalls(calls).map((c) => c.params.timeAt)).toEqual([
      iso(START),
      iso(START + 3 * HOUR),
      iso(START + 6 * HOUR),
    ]);
    expect(res.data[0].meta?.notices).toBeUndefined();
  });

  it('pages entities by offset and continues each page by its own ids', async () => {
    const history = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { type: 'T', attrs: { p: hours(0, 5) } }]));
    const calls = serve(temporalBroker(history, 4));
    const res = await run(makeDs({ pageSize: 2 }), {});
    expect(res.data.map((f) => valuesOf(f).length)).toEqual([6, 6, 6]);
    expect(temporalCalls(calls).map((c) => [c.params.offset, c.params.id])).toEqual([
      [undefined, undefined],
      [undefined, 'a,b'],
      ['2', undefined],
      [undefined, 'c'],
    ]);
  });

  it('fills missing units from the current entity and ignores a failing unit lookup', async () => {
    const history = temporalBroker({ e: { type: 'T', attrs: { p: hours(0, 1) } } }, 10);
    serve((path, p) =>
      path === '/entities'
        ? { data: [{ id: 'e', type: 'T', p: { type: 'Property', value: 1, unitCode: 'CEL' } }] }
        : history(path, p)
    );
    expect((await run(makeDs(), {})).data[0].fields[1].config.unit).toBe('celsius');

    serve((path, p) => (path === '/entities' ? new Error('down') : history(path, p)));
    const res = await run(makeDs(), {});
    expect(res.errors).toBeUndefined();
    expect(res.data[0].fields[1].config.unit).toBeUndefined();
  });

  it('names series by an attribute without charting that attribute', async () => {
    serve(() => ({
      data: [
        { id: 'urn:x:e', type: 'T', p: { values: [[1, iso(START)]] }, name: { values: [['Station', iso(START)]] } },
      ],
    }));
    const res = await run(makeDs(), { entityName: 'name', attributes: ['p'] });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].fields[1].config.displayNameFromDS).toBe('Station:p');
  });

  it('takes a name without history in the range from the current entity, in the query language', async () => {
    const calls = serve((path) =>
      path === '/entities'
        ? {
            data: [
              {
                id: 'urn:x:e',
                type: 'T',
                name: { type: 'Property', value: 'SNP Square', lang: 'en' },
                p: { value: 1, unitCode: 'CEL' },
              },
            ],
          }
        : { data: [{ id: 'urn:x:e', type: 'T', p: { values: [[1, iso(START)]] } }] }
    );
    const res = await run(makeDs(), { entityName: 'name', attributes: ['p'], lang: 'en' });
    expect(res.data[0].fields[1].config).toMatchObject({ displayNameFromDS: 'SNP Square:p', unit: 'celsius' });
    const lookup = calls.find((c) => c.path === '/entities')!;
    expect(lookup.params).toMatchObject({ id: 'urn:x:e', attrs: 'p,name', lang: 'en' });
  });

  it('keeps the short id when the current entity has no name either', async () => {
    serve((path) =>
      path === '/entities'
        ? { data: [{ id: 'urn:x:e', type: 'T', p: { value: 1, unitCode: 'CEL' } }] }
        : { data: [{ id: 'urn:x:e', type: 'T', p: { values: [[1, iso(START)]] } }] }
    );
    const res = await run(makeDs(), { entityName: 'name', attributes: ['p'] });
    expect(res.data[0].fields[1].config.displayNameFromDS).toBe('e:p');
  });

  it('looks nothing up when units and names are already known', async () => {
    const calls = serve(() => ({
      data: [
        {
          id: 'urn:x:e',
          type: 'T',
          p: { type: 'Property', unitCode: 'CEL', values: [[1, iso(START)]] },
          name: { values: [['N', iso(START)]] },
        },
      ],
    }));
    await run(makeDs(), { entityName: 'name', attributes: ['p'] });
    expect(calls.filter((c) => c.path === '/entities')).toHaveLength(0);
  });
});

describe('nextTemporalPage', () => {
  const B = '2026-01-01T05:00:00.000Z';
  const p = (entries: Record<string, string>) => Object.entries(entries) as Array<[string, string]>;
  const obj = (params: Array<[string, string]>) => Object.fromEntries(params);

  it.each([
    [
      'between forwards',
      { timerel: 'between', timeAt: 'A', endTimeAt: 'Z' },
      false,
      { timerel: 'between', timeAt: B, endTimeAt: 'Z' },
    ],
    ['after forwards', { timerel: 'after', timeAt: 'A' }, false, { timerel: 'after', timeAt: B }],
    ['before forwards', { timerel: 'before', timeAt: 'Z' }, false, { timerel: 'between', timeAt: B, endTimeAt: 'Z' }],
    ['no window forwards', {}, false, { timerel: 'after', timeAt: B }],
    [
      'between backwards',
      { timerel: 'between', timeAt: 'A', endTimeAt: 'Z' },
      true,
      { timerel: 'between', timeAt: 'A', endTimeAt: B },
    ],
    ['after backwards', { timerel: 'after', timeAt: 'A' }, true, { timerel: 'between', timeAt: 'A', endTimeAt: B }],
    ['before backwards', { timerel: 'before', timeAt: 'Z' }, true, { timerel: 'before', timeAt: B }],
    ['no window backwards', {}, true, { timerel: 'before', timeAt: B }],
  ])('%s', (_, params, backwards, expected) => {
    expect(obj(nextTemporalPage(p({ type: 'T', ...params }), B, backwards))).toEqual({ type: 'T', ...expected });
  });
});

describe('metadata', () => {
  it('reads types with details in every answer shape', async () => {
    serve(() => ({ data: [{ id: 'urn:T', typeName: 'T', attributeNames: ['a'] }, { id: 'U' }, 'V', {}] }));
    expect(await makeDs().getTypes()).toEqual([
      { id: 'urn:T', typeName: 'T', attributeNames: ['a'] },
      { id: 'U', typeName: 'U' },
      { typeName: 'V', attributeNames: [] },
    ]);
    serve(() => ({ data: { typeList: ['A'] } }));
    expect((await makeDs().getTypes()).map((t) => t.typeName)).toEqual(['A']);
    serve(() => ({ data: '' }));
    expect(await makeDs().getTypes()).toEqual([]);
  });

  it('reads attribute names from a list or an AttributeList', async () => {
    serve(() => ({ data: { attributeList: ['a', 'b'] } }));
    expect(await makeDs().getAttributeNames()).toEqual(['a', 'b']);
    serve(() => ({ data: [{ attributeName: 'x' }, { id: 'y' }, 'z', {}] }));
    expect(await makeDs().getAttributeNames()).toEqual(['x', 'y', 'z']);
  });

  it('reuses types and attributes for a minute, but not a failed lookup, and never in the health check', async () => {
    const calls = serve((path) => (path === '/types' ? { data: [{ typeName: 'T' }] } : { data: ['a'] }));
    const ds = makeDs();
    await ds.getTypes();
    await ds.getTypes();
    await ds.getAttributeNames();
    await ds.getAttributeNames();
    expect(calls.map((c) => c.path)).toEqual(['/types', '/attributes']);
    await ds.testDatasource();
    expect(calls.filter((c) => c.path === '/types')).toHaveLength(2);

    serve(() => Object.assign(new Error(), { status: 503 }));
    const failing = makeDs();
    await expect(failing.getTypes()).rejects.toThrow('503');
    serve(() => ({ data: [{ typeName: 'T' }] }));
    expect(await failing.getTypes()).toEqual([{ typeName: 'T' }]);
  });

  it('loads entities by id in chunks of 50', async () => {
    const calls = serve((_p, params) => ({ data: params.id.split(',').map((id) => ({ id, type: 'T' })) }));
    const ids = Array.from({ length: 120 }, (_, i) => `e${i}`);
    expect(await makeDs().entitiesById(ids)).toHaveLength(120);
    expect(calls.map((c) => c.params.limit)).toEqual(['50', '50', '20']);
    expect(calls.every((c) => c.params.local === 'true')).toBe(true); // types unknown: local query (5.7.2.4)
  });

  it('previews the request of a query', () => {
    const r = makeDs({ pageSize: 500 }).previewRequest({
      refId: 'A',
      queryType: NgsildQueryType.ENTITY,
      entityType: 'T',
      limit: 20,
    });
    expect(r).toEqual({
      path: '/entities',
      params: [
        ['type', 'T'],
        ['limit', '20'],
      ],
    });
  });
});

describe('metricFindQuery', () => {
  beforeEach(() =>
    serve((path, p) => {
      if (path === '/types') {
        return { data: [{ typeName: 'T', attributeNames: ['b', 'a'] }, { typeName: 'S' }] };
      }
      if (path === '/attributes') {
        return { data: { attributeList: ['x', 'x', 'w'] } };
      }
      return {
        data: [
          { id: 'urn:x:e1', type: 'T', name: { value: 'One' }, v: { value: 2 } },
          { id: 'urn:x:e2', type: 'T', v: [{ value: 1 }, { value: { k: 1 }, datasetId: 'd' }] },
          { id: 'urn:x:e3', type: 'T', v: { value: 2 } },
          { id: 'urn:x:e4', type: 'T', v: { value: null } },
        ].map((e) =>
          p.pick ? Object.fromEntries(Object.entries(e).filter(([k]) => ['type', ...p.pick.split(',')].includes(k))) : e
        ),
      };
    })
  );
  const texts = (r: Array<{ text: string }>) => r.map((v) => v.text);

  it('lists types and attribute names, sorted and distinct', async () => {
    const ds = makeDs();
    expect(texts(await ds.metricFindQuery('types()'))).toEqual(['S', 'T']);
    expect(texts(await ds.metricFindQuery('attributes()'))).toEqual(['w', 'x']);
    expect(texts(await ds.metricFindQuery(' attributes("T") '))).toEqual(['a', 'b']);
    expect(await ds.metricFindQuery('attributes(Nope)')).toEqual([]);
  });

  it('lists entities with a name attribute or the short id as text', async () => {
    const ds = makeDs();
    expect(await ds.metricFindQuery('entities(T, name)')).toEqual(
      expect.arrayContaining([
        { text: 'One', value: 'urn:x:e1' },
        { text: 'e2', value: 'urn:x:e2' },
      ])
    );
    expect(fetchMock.mock.calls[0][0].url).toContain('pick=id%2Cname');
    expect(fetchMock.mock.calls[0][0].url).not.toContain('attrs=');
    expect((await ds.metricFindQuery('entities(T)'))[0]).toEqual({ text: 'e1', value: 'urn:x:e1' });
  });

  it('lists the distinct current values of an attribute', async () => {
    expect(texts(await makeDs().metricFindQuery('values(T, v)'))).toEqual(['{"k":1}', '1', '2']);
  });

  it.each([
    ['', 'Invalid variable query'],
    ['types(', 'Invalid variable query'],
    ['nothing()', 'Unknown variable query function "nothing"'],
    ['values(T)', 'needs a type and an attribute'],
  ])('rejects %j', async (query, message) => {
    await expect(makeDs().metricFindQuery(query)).rejects.toThrow(message);
  });
});

describe('testDatasource', () => {
  it('reports the types and a working temporal API', async () => {
    const calls = serve((path) => (path === '/types' ? { data: [{ typeName: 'T' }] } : { data: [] }));
    expect(await makeDs({ tenant: 'city' }).testDatasource()).toEqual({
      status: 'success',
      message: 'NGSI-LD broker reachable (tenant city): 1 entity type(s). Temporal API available.',
    });
    expect(calls[1].params).toEqual({
      type: 'T',
      timerel: 'before',
      timeAt: expect.any(String),
      lastN: '1',
      limit: '1',
    });
    expect(Date.parse(calls[1].params.timeAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('reports a missing temporal API without failing', async () => {
    serve((path) => (path === '/types' ? { data: [{ typeName: 'T' }] } : Object.assign(new Error(), { status: 501 })));
    const res = await makeDs().testDatasource();
    expect(res.status).toBe('success');
    expect(res.message).toContain('Temporal API not available (501)');
  });

  it('skips the temporal check on an empty broker', async () => {
    const calls = serve(() => ({ data: [] }));
    expect((await makeDs().testDatasource()).message).toBe('NGSI-LD broker reachable: 0 entity type(s).');
    expect(calls).toHaveLength(1);
  });

  it('fails when the broker cannot be reached', async () => {
    serve(() => Object.assign(new Error(), { status: 502, statusText: 'Bad Gateway' }));
    const res = await makeDs({}, '/p').testDatasource();
    expect(res).toEqual({
      status: 'error',
      message: 'Cannot reach the NGSI-LD API (502 Bad Gateway). Check the broker URL.',
    });
  });

  it.each([
    [{ status: 401, data: 'Jwt is missing' }, '401: Jwt is missing'],
    [{ status: 403, statusText: 'Forbidden', data: 'RBAC: access denied' }, '403 Forbidden: RBAC: access denied'],
    // Grafana's proxy turns the broker's 401 into this 400
    [
      { status: 400, data: { message: 'Authentication to data source failed' } },
      '400: Authentication to data source failed',
    ],
  ])('names refused credentials as such: %j', async (err, detail) => {
    serve(() => Object.assign(new Error(), err));
    const res = await makeDs().testDatasource();
    expect(res).toEqual({
      status: 'error',
      message: `The NGSI-LD API refused the credentials (${detail}). Check the authentication settings.`,
    });
  });

  it('explains a failed identity forward', async () => {
    serve(() => Object.assign(new Error(), { status: 500, data: { message: 'Internal Server Error' } }));
    expect((await makeDs({ oauthPassThru: true }).testDatasource()).message).toBe(
      'Forward OAuth identity needs a Grafana sign-in through the identity provider the broker trusts (500: Internal Server Error).'
    );
    expect((await makeDs().testDatasource()).message).toBe(
      'Cannot reach the NGSI-LD API (500: Internal Server Error). Check the broker URL.'
    );
  });

  it('keeps the status of a failed call on the thrown error', async () => {
    serve(() => Object.assign(new Error(), { status: 404, data: { title: 'Not found' } }));
    await expect(makeDs().get('/x')).rejects.toMatchObject({ status: 404, message: '404: Not found' });
  });
});

describe('geo queries', () => {
  it('asks for the location along with selected attributes', async () => {
    const calls = serve(() => ({
      data: [
        { id: 'urn:x:1', type: 'T', pm10: { value: 3 }, location: { value: { type: 'Point', coordinates: [1, 2] } } },
      ],
    }));
    const res = await query(
      makeDs(),
      request([{ queryType: NgsildQueryType.GEO, entityType: 'T', attributes: ['pm10'] }])
    );
    expect(calls[0].params.attrs).toBe('pm10,location');
    expect(res.data[0].fields.find((f: any) => f.name === 'latitude').values).toEqual([2]);
  });

  it('draws trails from the temporal history of the location (Location: Trail)', async () => {
    const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] });
    const calls = serve(() => ({
      data: [
        {
          id: 'urn:x:V1',
          type: 'Vehicle',
          location: {
            type: 'GeoProperty',
            values: [
              [point(24.94, 60.16), '2026-10-28T10:00:00Z'],
              [point(24.95, 60.17), '2026-10-28T10:01:00Z'],
            ],
          },
        },
      ],
    }));
    const q = {
      queryType: NgsildQueryType.GEO,
      geoLocation: 'trail' as const,
      entityType: 'Vehicle',
      attributes: ['speed'],
    };
    const res = await query(makeDs(), request([q]));
    expect(calls[0].path).toBe('/temporal/entities');
    expect(calls[0].params.attrs).toBe('location');
    expect(res.data).toHaveLength(1);
    const frame = res.data[0];
    expect(frame.fields.find((f: any) => f.name === 'latitude').values).toEqual([60.17]);
    expect(frame.fields.find((f: any) => f.name === 'positions').values).toEqual([2]);
    expect(frame.fields.find((f: any) => f.name === 'geometry').values[0].getType()).toBe('LineString');
    expect(makeDs().previewRequest(q as any).path).toBe('/temporal/entities');
  });
});

describe('empty answers', () => {
  const broker: Handler = (path) => (path === '/types' ? { data: [{ typeName: 'T' }] } : { data: [] });

  it.each([NgsildQueryType.ENTITY, NgsildQueryType.GEO, NgsildQueryType.NODE_GRAPH])(
    'say that nothing matched (%s)',
    async (queryType) => {
      serve(broker);
      const res = await query(makeDs(), request([{ queryType, entityType: 'T' }]));
      expect(res.data[0].meta?.notices?.[0]).toEqual({ severity: 'info', text: 'No entities match this query.' });
    }
  );

  it.each([NgsildQueryType.ENTITY, NgsildQueryType.TEMPORAL])(
    'name a type the broker does not know (%s)',
    async (queryType) => {
      serve(broker);
      const res = await query(makeDs(), request([{ queryType, entityType: 'T,Typo' }]));
      expect(res.data[0].meta?.notices?.[0]).toEqual({
        severity: 'warning',
        text: 'The broker has no entities of type Typo. Known types: T.',
      });
    }
  );
});

describe('limit notice', () => {
  const counted =
    (total: number): Handler =>
    (_path, p) => {
      const offset = Number(p.offset ?? 0);
      const n = Math.max(0, Math.min(Number(p.limit), total - offset));
      return {
        data: Array.from({ length: n }, (_, i) => ({ id: `e${offset + i}`, type: 'T' })),
        headers: p.count === 'true' ? { 'NGSILD-Results-Count': String(total) } : undefined,
      };
    };

  it('stays away when exactly `limit` entities exist', async () => {
    const calls = serve(counted(3));
    const { entities, notices } = await makeDs().fetchEntities({ refId: 'A', entityType: 'T', limit: 3 });
    expect(entities).toHaveLength(3);
    expect(notices).toEqual([]);
    expect(calls[0].params.count).toBe('true');
  });

  it('shows when more exist', async () => {
    serve(counted(4));
    const { notices } = await makeDs().fetchEntities({ refId: 'A', entityType: 'T', limit: 3 });
    expect(notices[0].text).toContain('first 3 entities');
  });

  it('counts the entities of a temporal query on its first page', async () => {
    const calls = serve((path, p) =>
      path === '/temporal/entities'
        ? {
            data: [{ id: 'e0', type: 'T', a: { type: 'Property', values: [[1, iso(START)]] } }],
            headers: p.count === 'true' ? { 'NGSILD-Results-Count': '1' } : undefined,
          }
        : { data: [] }
    );
    const res = await query(makeDs(), request([{ entityType: 'T', limit: 1 }]));
    expect(temporalCalls(calls)[0].params.count).toBe('true');
    expect(res.data[0].meta?.notices).toBeUndefined();
  });
});

describe('deletion instances', () => {
  const deleted: Handler = (path) =>
    path === '/temporal/entities'
      ? {
          data: [
            {
              id: 'e',
              type: 'T',
              a: {
                type: 'Property',
                values: [
                  [5, iso(START)],
                  ['urn:ngsi-ld:null', iso(START + HOUR)],
                ],
              },
            },
          ],
        }
      : { data: [] };

  it('are gaps in a value series', async () => {
    serve(deleted);
    const res = await query(makeDs(), request([{ entityType: 'T' }]));
    expect(valuesOf(res.data[0])).toEqual([5, null]);
  });

  it('count 1 each when the series is timed by deletedAt', async () => {
    serve(deleted);
    const res = await query(makeDs(), request([{ entityType: 'T', timeProperty: 'deletedAt' }]));
    expect(valuesOf(res.data[0])).toEqual([5, 1]);
  });
});

describe('variable queries with variables', () => {
  it('keeps a multi-value type variable as one type list', async () => {
    const calls = serve(() => ({ data: [{ id: 'urn:x:1', type: 'A', name: { value: 'One' } }] }));
    const replace = (v?: string) => (v === '$types' ? 'A,B' : (v ?? ''));
    const res = await makeDs({}, undefined, replace as any).metricFindQuery('entities($types, name)');
    expect(calls[0].params.type).toBe('A,B');
    expect(calls[0].params.pick).toBe('id,name');
    expect(res).toEqual([{ text: 'One', value: 'urn:x:1' }]);
  });

  it('orders numeric values as numbers', async () => {
    serve(() => ({ data: ['10', '2', '1'].map((v, i) => ({ id: `e${i}`, type: 'T', v: { value: Number(v) } })) }));
    const res = await makeDs().metricFindQuery('values(T, v)');
    expect(res.map((v) => v.text)).toEqual(['1', '2', '10']);
  });
});

describe('variable paging', () => {
  it('reads every entity of the type, past the default query limit', async () => {
    const calls = serve((_path, p) => {
      const offset = Number(p.offset ?? 0);
      const n = Math.max(0, Math.min(Number(p.limit), 2500 - offset));
      return {
        data: Array.from({ length: n }, (_, i) => ({
          id: `urn:x:e${offset + i}`,
          type: 'T',
          v: { value: (offset + i) % 3 },
        })),
        headers: p.count === 'true' ? { 'NGSILD-Results-Count': '2500' } : undefined,
      };
    });
    expect(await makeDs().metricFindQuery('entities(T)')).toHaveLength(2500);
    expect(calls).toHaveLength(3);
    expect((await makeDs().metricFindQuery('values(T, v)')).map((v) => v.text)).toEqual(['0', '1', '2']);
  });
});

describe('health check page size', () => {
  it('fails when the broker refuses the page size', async () => {
    serve((path, p) =>
      path === '/types'
        ? { data: [{ typeName: 'T' }] }
        : path === '/entities' && p.limit === '5000'
          ? Object.assign(new Error(), { status: 403, data: { detail: 'limit 5000 exceeds the server maximum 1000' } })
          : { data: [] }
    );
    const res = await makeDs({ pageSize: 5000 }).testDatasource();
    expect(res).toEqual({
      status: 'error',
      message: 'The broker refuses Page size 5000 (403: limit 5000 exceeds the server maximum 1000). Lower Page size.',
    });
  });

  it('ignores other failures of the probe', async () => {
    serve((path) =>
      path === '/types'
        ? { data: [{ typeName: 'T' }] }
        : path === '/entities'
          ? new Error('pick unsupported')
          : { data: [] }
    );
    expect((await makeDs().testDatasource()).status).toBe('success');
  });
});
