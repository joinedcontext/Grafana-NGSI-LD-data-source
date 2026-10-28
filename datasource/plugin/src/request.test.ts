import {
  buildRequest,
  intervalToDuration,
  isIsoDuration,
  nameFromAttribute,
  splitList,
  toQueryString,
  withParam,
} from './request';
import { NamePattern, NgsildQuery, NgsildQueryType } from './types';

const q = (patch: Partial<NgsildQuery>): NgsildQuery => ({ refId: 'A', ...patch });
const ctx = { pageSize: 100 };
const params = (r: { params: Array<[string, string]> }) => Object.fromEntries(r.params);

describe('splitList', () => {
  it('splits, trims and drops empty items', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(splitList([' x ', ''])).toEqual(['x']);
    expect(splitList(undefined)).toEqual([]);
    expect(splitList('')).toEqual([]);
  });
});

describe('nameFromAttribute', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['id', false],
    ['id_short', false],
    ['name', true],
  ])('%s -> %s', (entityName, expected) => {
    expect(nameFromAttribute({ entityName })).toBe(expected);
  });
});

describe('isIsoDuration', () => {
  it.each(['PT1H', 'P1D', 'P1Y2M3W4DT5H6M7.5S', 'PT0.5S', 'P7D'])('accepts %s', (d) =>
    expect(isIsoDuration(d)).toBe(true)
  );
  it.each(['', 'P', 'PT', '1H', 'PT1', 'P1H', 'auto', 'PT-1S'])('rejects %s', (d) =>
    expect(isIsoDuration(d)).toBe(false)
  );
});

describe('intervalToDuration', () => {
  it('rounds to whole seconds, at least one', () => {
    expect(intervalToDuration(60_000)).toBe('PT60S');
    expect(intervalToDuration(1499)).toBe('PT1S');
    expect(intervalToDuration(10)).toBe('PT1S');
    expect(intervalToDuration(undefined)).toBe('PT60S');
  });
});

describe('toQueryString', () => {
  it('percent-encodes every value and keeps the order', () => {
    expect(
      toQueryString([
        ['q', 'a==1;b=="x y"'],
        ['timeAt', '2026-01-01T00:00:00+01:00'],
      ])
    ).toBe('q=a%3D%3D1%3Bb%3D%3D%22x%20y%22&timeAt=2026-01-01T00%3A00%3A00%2B01%3A00');
    expect(toQueryString([])).toBe('');
  });
});

describe('withParam', () => {
  it('replaces, appends and removes a parameter without mutating the input', () => {
    const p: Array<[string, string]> = [
      ['a', '1'],
      ['b', '2'],
    ];
    expect(withParam(p, 'a', '3')).toEqual([
      ['b', '2'],
      ['a', '3'],
    ]);
    expect(withParam(p, 'c', '4')).toHaveLength(3);
    expect(withParam(p, 'a', undefined)).toEqual([['b', '2']]);
    expect(p).toHaveLength(2);
  });
});

describe('buildRequest', () => {
  it('builds an entity query with type, attrs, q, scopeQ, lang and limit', () => {
    const r = buildRequest(
      q({
        queryType: NgsildQueryType.ENTITY,
        entityType: 'A, B',
        idPattern: ' urn:x:.* ',
        attributes: ['pm10', 'pm10', 'no2'],
        customQuery: ' pm10>40 ',
        scopeQuery: '/City/#',
        lang: 'sk',
      }),
      ctx
    );
    expect(r.path).toBe('/entities');
    expect(r.params).toEqual([
      ['type', 'A,B'],
      ['idPattern', 'urn:x:.*'],
      ['attrs', 'pm10,no2'],
      ['q', 'pm10>40'],
      ['scopeQ', '/City/#'],
      ['lang', 'sk'],
      ['limit', '100'],
    ]);
  });

  it('sends ids together with type and idPattern', () => {
    const p = params(
      buildRequest(q({ queryType: NgsildQueryType.ENTITY, entityId: 'a, b', entityType: 'T', idPattern: 'x' }), ctx)
    );
    expect(p).toMatchObject({ id: 'a,b', type: 'T', idPattern: 'x' });
    expect(p.local).toBeUndefined();
  });

  it.each([
    ['ids', { entityId: 'a' }],
    ['an idPattern', { idPattern: 'urn:x:.*' }],
    ['a scope', { entityId: 'a', scopeQuery: '/A' }],
  ])('makes a query by %s alone local (CIM 009 5.7.2.4)', (_, patch) => {
    expect(params(buildRequest(q({ queryType: NgsildQueryType.ENTITY, ...patch }), ctx)).local).toBe('true');
    expect(params(buildRequest(q({ ...patch }), { ...ctx, from: 0, to: 1 })).local).toBe('true');
  });

  it.each([
    ['type', { entityType: 'T' }],
    ['attrs', { attributes: ['p'] }],
    ['q', { customQuery: 'p>1' }],
    ['georel', { georel: 'near;maxDistance==1', coordinates: '[1,2]' }],
  ])('keeps a query with %s non-local', (_, patch) => {
    expect(
      params(buildRequest(q({ queryType: NgsildQueryType.ENTITY, entityId: 'a', ...patch }), ctx)).local
    ).toBeUndefined();
  });

  it('adds the name attribute and the geoproperty to attrs', () => {
    const named = params(
      buildRequest(q({ queryType: NgsildQueryType.ENTITY, attributes: ['pm10'], entityName: 'name' }), ctx)
    );
    expect(named.attrs).toBe('pm10,name');
    const byAttr = buildRequest(
      q({
        queryType: NgsildQueryType.ENTITY,
        attributes: ['pm10'],
        entityName: 'name',
        namePattern: NamePattern.ATTRIBUTE,
      }),
      ctx
    );
    expect(params(byAttr).attrs).toBe('pm10');
    const geo = params(
      buildRequest(q({ queryType: NgsildQueryType.GEO, attributes: ['pm10'], geoproperty: 'area' }), ctx)
    );
    expect(geo.attrs).toBe('pm10,area');
    expect(params(buildRequest(q({ queryType: NgsildQueryType.GEO, attributes: ['pm10'] }), ctx)).attrs).toBe(
      'pm10,location'
    );
  });

  it('omits attrs when no attribute is selected', () => {
    expect(
      params(buildRequest(q({ queryType: NgsildQueryType.ENTITY, entityName: 'name' }), ctx)).attrs
    ).toBeUndefined();
  });

  it('adds a geo-query only with a georel, defaulting the geometry and stripping whitespace', () => {
    const p = params(
      buildRequest(
        q({ queryType: NgsildQueryType.ENTITY, georel: ' near;maxDistance==500 ', coordinates: '[19.1, 48.7]' }),
        ctx
      )
    );
    expect(p).toMatchObject({ georel: 'near;maxDistance==500', geometry: 'Point', coordinates: '[19.1,48.7]' });
    expect(p.geoproperty).toBeUndefined();
    const none = params(
      buildRequest(q({ queryType: NgsildQueryType.ENTITY, coordinates: '[1,2]', geometry: 'Polygon' }), ctx)
    );
    expect(none.georel).toBeUndefined();
    expect(none.coordinates).toBeUndefined();
    // a georel just picked in the editor, coordinates not typed yet: no geo-query (the broker would answer 400)
    const pending = params(
      buildRequest(q({ queryType: NgsildQueryType.ENTITY, entityType: 'T', georel: 'within', coordinates: ' ' }), ctx)
    );
    expect(pending.georel).toBeUndefined();
    expect(pending.geometry).toBeUndefined();
  });

  it('puts the representation into format and the flags into options', () => {
    const query = q({ queryType: NgsildQueryType.ENTITY, ngsildOptions: ['sysAttrs', 'keyValues'] });
    const p = params(buildRequest(query, ctx));
    expect(p.format).toBe('keyValues');
    expect(p.options).toBe('sysAttrs');
  });

  describe('temporal', () => {
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2026, 0, 2);

    it('asks for temporalValues between the range ends', () => {
      const r = buildRequest(
        q({ queryType: NgsildQueryType.TEMPORAL, entityType: 'T', ngsildOptions: ['keyValues', 'sysAttrs'] }),
        { ...ctx, from, to }
      );
      expect(r.path).toBe('/temporal/entities');
      expect(params(r)).toMatchObject({
        format: 'temporalValues',
        timerel: 'between',
        timeAt: '2026-01-01T00:00:00.000Z',
        endTimeAt: '2026-01-02T00:00:00.000Z',
        limit: '100',
      });
    });

    it('uses after / before for an open range and nothing without one', () => {
      const after = params(buildRequest(q({ queryType: NgsildQueryType.TEMPORAL }), { ...ctx, from }));
      expect(after).toMatchObject({ timerel: 'after', timeAt: '2026-01-01T00:00:00.000Z' });
      expect(after.endTimeAt).toBeUndefined();
      expect(params(buildRequest(q({ queryType: NgsildQueryType.TEMPORAL }), { ...ctx, to }))).toMatchObject({
        timerel: 'before',
        timeAt: '2026-01-02T00:00:00.000Z',
      });
      expect(
        params(buildRequest(q({ queryType: NgsildQueryType.TEMPORAL }), { ...ctx, from: NaN })).timerel
      ).toBeUndefined();
    });

    it('builds an aggregation with an explicit, automatic or whole-range period', () => {
      const base = q({ queryType: NgsildQueryType.TEMPORAL, aggrMethod: 'avg, max' });
      const explicit = params(buildRequest({ ...base, aggrPeriodDuration: 'PT1H' }, ctx));
      expect(explicit).toMatchObject({
        format: 'aggregatedValues',
        aggrMethods: 'avg,max',
        aggrPeriodDuration: 'PT1H',
      });
      expect(
        params(buildRequest({ ...base, aggrPeriodDuration: 'auto' }, { ...ctx, intervalMs: 300_000 }))
          .aggrPeriodDuration
      ).toBe('PT300S');
      expect(params(buildRequest(base, ctx)).aggrPeriodDuration).toBeUndefined();
    });

    it('sends the time property only when it is not observedAt, and a whole positive lastN', () => {
      const p = params(
        buildRequest(q({ queryType: NgsildQueryType.TEMPORAL, timeProperty: 'modifiedAt', lastN: 5.7 }), ctx)
      );
      expect(p).toMatchObject({ timeproperty: 'modifiedAt', lastN: '5' });
      const d = params(
        buildRequest(q({ queryType: NgsildQueryType.TEMPORAL, timeProperty: 'observedAt', lastN: 0 }), ctx)
      );
      expect(d.timeproperty).toBeUndefined();
      expect(d.lastN).toBeUndefined();
    });

    it('ignores temporal settings in an entity query', () => {
      const p = params(
        buildRequest(q({ queryType: NgsildQueryType.ENTITY, aggrMethod: 'avg', lastN: 3 }), { ...ctx, from, to })
      );
      expect(p.timerel).toBeUndefined();
      expect(p.aggrMethods).toBeUndefined();
      expect(p.lastN).toBeUndefined();
    });
  });
});

describe('buildRequest review round 2', () => {
  const params = (r: { params: Array<[string, string]> }) => Object.fromEntries(r.params);
  const ctx = { pageSize: 10 };

  it.each([
    [{ customQuery: 'pm10>0' }, 'true'],
    [{ entityId: 'urn:x:1', customQuery: 'pm10>0' }, 'true'],
    [{ georel: 'near;maxDistance==5', coordinates: '[1,2]' }, 'true'],
    [{ entityType: 'T', customQuery: 'pm10>0' }, undefined],
    [{ attributes: ['pm10'] }, undefined],
  ])('a temporal query %j is local unless it has a type or attrs (6.18.3.2): %s', (q, local) => {
    expect(params(buildRequest({ refId: 'A', queryType: NgsildQueryType.TEMPORAL, ...q }, ctx)).local).toBe(local);
  });

  it.each([{ customQuery: 'pm10>0' }, { georel: 'near;maxDistance==5', coordinates: '[1,2]' }])(
    'a current-value query %j needs no local (6.4.3.2)',
    (q) => {
      expect(params(buildRequest({ refId: 'A', queryType: NgsildQueryType.ENTITY, ...q }, ctx)).local).toBeUndefined();
    }
  );

  it.each([NgsildQueryType.GEO, NgsildQueryType.NODE_GRAPH, NgsildQueryType.TEMPORAL])(
    'ignores stale representation options of a %s query',
    (queryType) => {
      const p = params(
        buildRequest({ refId: 'A', queryType, entityType: 'T', ngsildOptions: ['keyValues', 'sysAttrs'] }, ctx)
      );
      expect(p.options).toBeUndefined();
      expect(p.format).not.toBe('keyValues');
    }
  );
});
