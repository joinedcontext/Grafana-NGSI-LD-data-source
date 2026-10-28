import { FieldType } from '@grafana/data';

import {
  collectSeries,
  displayName,
  entitiesToGeo,
  entitiesToTable,
  entitiesToTimeseries,
  drawableParts,
  entityLabel,
  mapGeometry,
  pageCut,
  Series,
  seriesKey,
  seriesToFrames,
  shortId,
  temporalNames,
} from './frames';
import { Entity } from './ngsildTypes';
import { NamePattern, NgsildQuery } from './types';

const q = (patch: Partial<NgsildQuery> = {}): NgsildQuery => ({ refId: 'A', ...patch });
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T01:00:00.000Z';
const T2 = '2026-01-01T02:00:00.000Z';
const ms = Date.parse;
const field = (frame: { fields: Array<{ name: string }> }, name: string) =>
  frame.fields.find((f) => f.name === name) as any;

describe('shortId', () => {
  it.each([
    ['urn:ngsi-ld:Sensor:S1', 'S1'],
    ['https://example.org/types/Sensor', 'Sensor'],
    ['https://example.org/ns#Sensor', 'Sensor'],
    ['plain', 'plain'],
    ['urn:x:', 'urn:x:'],
  ])('%s -> %s', (id, expected) => expect(shortId(id)).toBe(expected));
});

describe('entityLabel', () => {
  const e: Entity = {
    id: 'urn:ngsi-ld:S:S1',
    type: 'S',
    name: { type: 'LanguageProperty', languageMap: { sk: 'Stanica', en: 'Station' } },
  };

  it('uses the short id by default and the full id on request', () => {
    expect(entityLabel(e, q())).toBe('S1');
    expect(entityLabel(e, q({ entityName: 'id' }))).toBe('urn:ngsi-ld:S:S1');
    expect(entityLabel(e, q({ useLongEntityName: true }))).toBe('urn:ngsi-ld:S:S1');
  });

  it('uses the name attribute in the query language, or an explicit value', () => {
    expect(entityLabel(e, q({ entityName: 'name', lang: 'sk' }))).toBe('Stanica');
    expect(entityLabel(e, q({ entityName: 'name' }), 'Given')).toBe('Given');
  });

  it('falls back to the short id when the name attribute is missing or empty', () => {
    expect(entityLabel(e, q({ entityName: 'label' }))).toBe('S1');
    expect(entityLabel({ ...e, label: { type: 'Property', value: '' } }, q({ entityName: 'label' }))).toBe('S1');
  });
});

describe('displayName', () => {
  it('follows the naming pattern and adds dataset and method', () => {
    expect(displayName(q(), 'S1', 'pm10')).toBe('S1:pm10');
    expect(displayName(q({ namePattern: NamePattern.ENTITY_NAME }), 'S1', 'pm10')).toBe('S1');
    expect(displayName(q({ namePattern: NamePattern.ATTRIBUTE }), 'S1', 'pm10', 'urn:ngsi-ld:Dataset:raw', 'avg')).toBe(
      'pm10 (raw, avg)'
    );
  });
});

describe('seriesKey', () => {
  it('tells instance sets and methods apart', () => {
    const base = { entityId: 'e', attr: 'a' };
    const keys = new Set([
      seriesKey(base),
      seriesKey({ ...base, datasetId: 'd' }),
      seriesKey({ ...base, method: 'avg' }),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe('collectSeries', () => {
  it('reads the simplified representation and counts new points only', () => {
    const into = new Map<string, Series>();
    const page: Entity[] = [
      {
        id: 'e1',
        type: 'T',
        pm10: {
          type: 'Property',
          unitCode: 'GQ',
          values: [
            [1, T0],
            [2, T1],
          ],
        },
        name: { type: 'Property', values: [['N', T0]] },
      },
    ];
    expect(collectSeries(page, into, ['name'])).toBe(2);
    expect(collectSeries(page, into, ['name'])).toBe(0); // a repeated 206 boundary adds nothing
    const s = [...into.values()];
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ entityId: 'e1', entityType: 'T', attr: 'pm10', unitCode: 'GQ' });
    expect([...s[0].points]).toEqual([
      [ms(T0), 1],
      [ms(T1), 2],
    ]);
  });

  it('reads the aggregated representation, one series per method', () => {
    const into = new Map<string, Series>();
    collectSeries([{ id: 'e', type: 'T', pm10: { type: 'Property', avg: [[1.5, T0, T1]], max: [[2, T0, T1]] } }], into);
    expect([...into.values()].map((s) => [s.method, [...s.points]])).toEqual([
      ['avg', [[ms(T0), 1.5]]],
      ['max', [[ms(T0), 2]]],
    ]);
  });

  it('reads LanguageProperty, VocabProperty and JsonProperty history, per datasetId (Antares temporalValues)', () => {
    const into = new Map<string, Series>();
    collectSeries(
      [
        {
          id: 'e',
          type: ['A', 'B'],
          name: { type: 'LanguageProperty', languageMaps: [[{ languageMap: { en: 'One', sk: 'Jeden' } }, T0]] },
          cat: { type: 'VocabProperty', vocabs: [[{ vocab: 'urban' }, T0]] },
          j: { type: 'JsonProperty', jsons: [[{ json: { a: 1 } }, T1]] },
          p: [
            { type: 'Property', datasetId: 'urn:d1', values: [[1, T0]] },
            { type: 'Property', datasetId: 'urn:d2', values: [[2, T1]] },
          ],
          rel: { type: 'Relationship', objects: [['urn:x', T0]] },
          bad: { type: 'Property', values: [[3, 'not a time']] },
        },
      ],
      into,
      [],
      'sk'
    );
    expect([...into.values()].map((s) => [s.attr, s.entityType, s.datasetId, [...s.points]])).toEqual([
      ['name', 'A,B', undefined, [[ms(T0), 'Jeden']]],
      ['cat', 'A,B', undefined, [[ms(T0), 'urban']]],
      ['j', 'A,B', undefined, [[ms(T1), { a: 1 }]]],
      ['p', 'A,B', 'urn:d1', [[ms(T0), 1]]],
      ['p', 'A,B', 'urn:d2', [[ms(T1), 2]]],
    ]);
  });

  it('keeps the first unit code seen across pages', () => {
    const into = new Map<string, Series>();
    collectSeries([{ id: 'e', type: 'T', p: { values: [[1, T0]] } }], into);
    collectSeries([{ id: 'e', type: 'T', p: { unitCode: 'CEL', values: [[2, T1]] } }], into);
    expect([...into.values()][0].unitCode).toBe('CEL');
  });
});

describe('pageCut', () => {
  const values = (...times: string[]) => ({ type: 'Property', values: times.map((t, i) => [i, t]) });

  it('continues forwards from the earliest end of the cut sets, for the cut entities only', () => {
    const page: Entity[] = [
      { id: 'dense', type: 'T', p: values(T0, T1, T2) },
      { id: 'sparse', type: 'T', p: values('2025-12-01T00:00:00Z', '2025-12-15T00:00:00Z', T1) },
      { id: 'short', type: 'T', p: values(T0) },
    ];
    expect(pageCut(page, false)).toEqual({ ids: ['dense', 'sparse'], boundary: T1 });
  });

  it('continues backwards from the latest start of the cut sets', () => {
    const page: Entity[] = [
      { id: 'a', type: 'T', p: values(T2, T1) },
      { id: 'b', type: 'T', p: values(T2, T0) },
    ];
    expect(pageCut(page, true)).toEqual({ ids: ['a', 'b'], boundary: T1 });
  });

  it('counts every datasetId of a multi-instance attribute on its own, and LanguageProperty history too', () => {
    const page: Entity[] = [
      {
        id: 'e',
        type: 'T',
        p: [
          {
            type: 'Property',
            datasetId: 'd1',
            values: [
              [1, T0],
              [2, T1],
            ],
          },
          { type: 'Property', datasetId: 'd2', values: [[3, T0]] },
        ],
      },
      {
        id: 'n',
        type: 'T',
        name: {
          type: 'LanguageProperty',
          languageMaps: [
            [{ languageMap: { en: 'a' } }, T0],
            [{ languageMap: { en: 'b' } }, T2],
          ],
        },
      },
    ];
    expect(pageCut(page, false)).toEqual({ ids: ['e', 'n'], boundary: T1 });
  });

  it('ignores relationships and untimed values, and is undefined for a page without times', () => {
    expect(
      pageCut([{ id: 'e', type: 'T', r: { type: 'Relationship', objects: [['x', T0]] }, n: { value: 1 } }], false)
    ).toBeUndefined();
    expect(pageCut([], false)).toBeUndefined();
  });
});

describe('temporalNames', () => {
  it('takes the newest value of the name attribute per entity', () => {
    const names = temporalNames(
      [
        {
          id: 'a',
          type: 'T',
          name: {
            values: [
              ['Old', T0],
              ['New', T1],
            ],
          },
        },
        { id: 'b', type: 'T', name: { type: 'LanguageProperty', languageMap: { en: 'Bee' } } },
        { id: 'c', type: 'T' },
        {
          id: 'd',
          type: 'T',
          name: {
            type: 'LanguageProperty',
            languageMaps: [
              [{ languageMap: { en: 'Old' } }, T0],
              [{ languageMap: { en: 'Dee', sk: 'Dé' } }, T1],
            ],
          },
        },
      ],
      q({ entityName: 'name', lang: 'sk' })
    );
    expect([...names]).toEqual([
      ['a', 'New'],
      ['b', 'Bee'],
      ['d', 'Dé'],
    ]);
    expect(temporalNames([{ id: 'a', type: 'T', name: { values: [['x', T0]] } }], q()).size).toBe(0);
  });
});

describe('seriesToFrames', () => {
  it('builds a time-ordered [Time, value] frame with labels, name and unit', () => {
    const s: Series = {
      entityId: 'urn:ngsi-ld:S:S1',
      entityType: 'S',
      attr: 'temperature',
      datasetId: 'urn:ngsi-ld:Dataset:raw',
      unitCode: 'CEL',
      points: new Map([
        [ms(T1), 2],
        [ms(T0), 1],
      ]),
    };
    const [frame] = seriesToFrames([s], q({ entityName: 'name' }), new Map([['urn:ngsi-ld:S:S1', 'Station']]));
    expect(frame.refId).toBe('A');
    expect(frame.name).toBe('Station');
    expect(field(frame, 'Time').values).toEqual([ms(T0), ms(T1)]);
    const v = field(frame, 'temperature');
    expect(v.values).toEqual([1, 2]);
    expect(v.type).toBe(FieldType.number);
    expect(v.config).toEqual({ displayNameFromDS: 'Station:temperature (raw)', unit: 'celsius' });
    expect(v.labels).toEqual({ entity: 'urn:ngsi-ld:S:S1', type: 'S', datasetId: 'urn:ngsi-ld:Dataset:raw' });
  });

  it('drops the unit of counts and labels the aggregation', () => {
    const base = { entityId: 'e', entityType: 'T', attr: 'p', unitCode: 'CEL', points: new Map([[0, 3]]) };
    const [count, avg] = seriesToFrames(
      [
        { ...base, method: 'totalCount' },
        { ...base, method: 'avg' },
      ],
      q(),
      new Map()
    );
    expect(field(count, 'p').config.unit).toBeUndefined();
    expect(field(avg, 'p').config.unit).toBe('celsius');
    expect(field(avg, 'p').labels.aggregation).toBe('avg');
  });
});

describe('entitiesToTimeseries', () => {
  const e: Entity = {
    id: 'urn:x:E1',
    type: 'T',
    name: { type: 'Property', value: 'Eins' },
    temp: { type: 'Property', value: 21, unitCode: 'CEL', observedAt: T1 },
    power: [
      { type: 'Property', value: 1, datasetId: 'urn:d:heat', modifiedAt: T0 },
      { type: 'Property', value: 2, datasetId: 'urn:d:light' },
    ],
    ref: { type: 'Relationship', object: 'urn:x:E2' },
  };

  it('makes a frame per attribute instance, skips relationships and the name attribute', () => {
    const frames = entitiesToTimeseries([e], q({ entityName: 'name' }), ms(T2));
    expect(frames.map((f) => f.fields[1].config.displayNameFromDS)).toEqual([
      'Eins:temp',
      'Eins:power (heat)',
      'Eins:power (light)',
    ]);
    expect(frames.map((f) => f.fields[0].values[0])).toEqual([ms(T1), ms(T0), ms(T2)]);
    expect(frames[0].fields[1].config.unit).toBe('celsius');
    expect(frames[1].fields[1].labels).toEqual({ entity: 'urn:x:E1', type: 'T', datasetId: 'urn:d:heat' });
  });

  it('keeps the name attribute as a value when names come from the id', () => {
    expect(entitiesToTimeseries([e], q(), 0).map((f) => f.fields[1].name)).toContain('name');
  });
});

describe('entitiesToTable', () => {
  it('orders the columns as the query lists the attributes, the others after them', () => {
    const frame = entitiesToTable(
      [
        {
          id: 'a',
          type: 'T',
          name: { value: 'A' },
          isOnline: { value: true },
          pm10: { value: 3 },
          extra: { value: 0 },
          b: { value: 1 },
        },
      ],
      q({ attributes: ['name', 'pm10', 'isOnline'] })
    );
    expect(frame.fields.map((f) => f.name)).toEqual(['id', 'type', 'name', 'pm10', 'isOnline', 'b', 'extra']);
  });

  it('makes a row per entity and a sorted column per attribute instance set', () => {
    const frame = entitiesToTable(
      [
        { id: 'a', type: ['T', 'U'], z: { value: 1, unitCode: 'CEL' }, p: [{ value: 1, datasetId: 'urn:d:x' }] },
        { id: 'b', type: 'T', z: { value: 2, unitCode: 'CEL' }, obj: { value: { k: 1 } } },
      ],
      q()
    );
    expect(frame.meta?.preferredVisualisationType).toBe('table');
    expect(frame.fields.map((f) => f.name)).toEqual(['id', 'type', 'obj', 'p (x)', 'z']);
    expect(field(frame, 'type').values).toEqual(['T,U', 'T']);
    expect(field(frame, 'z').values).toEqual([1, 2]);
    expect(field(frame, 'z').config.unit).toBe('celsius');
    expect(field(frame, 'obj').values).toEqual([null, '{"k":1}']);
    expect(field(frame, 'p (x)').values).toEqual([1, null]);
  });

  it('sets no unit when a column mixes units', () => {
    const frame = entitiesToTable(
      [
        { id: 'a', type: 'T', v: { value: 1, unitCode: 'CEL' } },
        { id: 'b', type: 'T', v: { value: 2, unitCode: 'FAH' } },
      ],
      q()
    );
    expect(field(frame, 'v').config.unit).toBeUndefined();
  });

  it('builds an empty table for no entities', () => {
    expect(entitiesToTable([], q()).length).toBe(0);
  });
});

describe('entitiesToGeo', () => {
  it('locates entities by their geoproperty and skips those without a usable geometry', () => {
    const frame = entitiesToGeo(
      [
        {
          id: 'urn:x:P',
          type: 'T',
          location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [19, 48] } },
          pm10: { value: 5 },
        },
        {
          id: 'urn:x:L',
          type: 'T',
          location: {
            type: 'GeoProperty',
            value: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [2, 2],
              ],
            },
          },
        },
        { id: 'urn:x:none', type: 'T', pm10: { value: 1 } },
      ],
      q()
    );
    expect(frame.length).toBe(2);
    expect(field(frame, 'name').values).toEqual(['P', 'L']);
    expect(field(frame, 'latitude').values).toEqual([48, 1]);
    expect(field(frame, 'longitude').values).toEqual([19, 1]);
    expect(field(frame, 'geometryType').values).toEqual(['Point', 'LineString']);
    expect(JSON.parse(field(frame, 'geometry').values[0])).toEqual({ type: 'Point', coordinates: [19, 48] });
    expect(field(frame, 'pm10').values).toEqual([5, null]);
    expect(field(frame, 'location')).toBeUndefined();
  });

  it('reads another geoproperty and keeps the name attribute out of the columns', () => {
    const frame = entitiesToGeo(
      [
        {
          id: 'a',
          type: 'T',
          name: { value: 'A' },
          area: { type: 'GeoProperty', value: { type: 'Point', coordinates: [1, 2] } },
        },
      ],
      q({ geoproperty: 'area', entityName: 'name' })
    );
    expect(field(frame, 'name').values).toEqual(['A']);
    expect(frame.fields.filter((f) => f.name === 'name')).toHaveLength(1);
    expect(field(frame, 'area')).toBeUndefined();
  });

  it('gives the shapes as map geometries with geoLocation "shape", a row per drawable part', () => {
    const ring = [
      [19, 48],
      [19.01, 48],
      [19.01, 48.01],
      [19, 48],
    ];
    const hole = [
      [19.002, 48.002],
      [19.004, 48.002],
      [19.004, 48.004],
      [19.002, 48.002],
    ];
    const shapes = [
      { type: 'Point', coordinates: [19.15, 48.74] },
      {
        type: 'LineString',
        coordinates: [
          [19.144, 48.737],
          [19.149, 48.738],
        ],
      },
      { type: 'Polygon', coordinates: [ring, hole] },
      { type: 'MultiPolygon', coordinates: [[ring], [hole]] },
    ];
    const entities = shapes.map((value, i) => ({
      id: `urn:x:${i}`,
      type: 'T',
      location: { type: 'GeoProperty', value },
      pm10: { value: i },
    }));
    const frame = entitiesToGeo(entities, q({ geoLocation: 'shape' }));
    const geometry = field(frame, 'geometry');
    expect(geometry.type).toBe(FieldType.geo);
    // Grafana's markers layer draws lines; a polygon is drawn as the outline of each ring
    expect(geometry.values.map((g: any) => g.getType())).toEqual([
      'Point',
      'LineString',
      'LineString',
      'LineString',
      'LineString',
      'LineString',
    ]);
    expect(field(frame, 'id').values).toEqual(['urn:x:0', 'urn:x:1', 'urn:x:2', 'urn:x:2', 'urn:x:3', 'urn:x:3']);
    expect(field(frame, 'geometryType').values).toEqual([
      'Point',
      'LineString',
      'Polygon',
      'Polygon',
      'MultiPolygon',
      'MultiPolygon',
    ]);
    expect(field(frame, 'pm10').values).toEqual([0, 1, 2, 2, 3, 3]);
    // Web Mercator metres, the map projection: x = R * longitude in radians
    expect(geometry.values[0].getCoordinates()[0]).toBeCloseTo((6378137 * 19.15 * Math.PI) / 180, 3);
    expect(geometry.values[2].getCoordinates()).toHaveLength(4); // the closed ring
    expect(field(frame, 'latitude').values[0]).toBe(48.74); // the table keeps the point
  });

  it('keeps one row per entity without geoLocation "shape"', () => {
    const value = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [19, 48],
            [19.01, 48],
            [19.01, 48.01],
            [19, 48],
          ],
        ],
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    };
    const frame = entitiesToGeo([{ id: 'a', type: 'T', location: { type: 'GeoProperty', value } }], q());
    expect(frame.length).toBe(1);
    expect(JSON.parse(field(frame, 'geometry').values[0])).toEqual(value);
  });

  describe('drawableParts', () => {
    const line = (coordinates: unknown) => ({ type: 'LineString', coordinates });
    it.each([
      ['a point', { type: 'Point', coordinates: [1, 2] }, [{ type: 'Point', coordinates: [1, 2] }]],
      [
        'a line',
        line([
          [0, 0],
          [1, 1],
        ]),
        [
          line([
            [0, 0],
            [1, 1],
          ]),
        ],
      ],
      [
        'a polygon with a hole',
        { type: 'Polygon', coordinates: [['outer'], ['hole']] },
        [line(['outer']), line(['hole'])],
      ],
      [
        'a multi polygon',
        { type: 'MultiPolygon', coordinates: [[['a']], [['b'], ['c']]] },
        [line(['a']), line(['b']), line(['c'])],
      ],
      ['a multi line', { type: 'MultiLineString', coordinates: [['a'], ['b']] }, [line(['a']), line(['b'])]],
      [
        'a multi point',
        {
          type: 'MultiPoint',
          coordinates: [
            [1, 2],
            [3, 4],
          ],
        },
        [
          { type: 'Point', coordinates: [1, 2] },
          { type: 'Point', coordinates: [3, 4] },
        ],
      ],
      [
        'a collection',
        {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [1, 2] },
            { type: 'MultiLineString', coordinates: [['a']] },
          ],
        },
        [{ type: 'Point', coordinates: [1, 2] }, line(['a'])],
      ],
      ['an empty collection', { type: 'GeometryCollection' }, []],
      ['a polygon without rings', { type: 'Polygon' }, []],
      ['an unknown geometry', { type: 'Nonsense' }, [{ type: 'Nonsense' }]],
    ])('splits %s', (_, geometry, expected) => {
      expect(drawableParts(geometry)).toEqual(expected);
    });
  });

  it('turns a geometry the map cannot read into null', () => {
    expect(mapGeometry({ type: 'Point', coordinates: [1, 2] })?.getType()).toBe('Point');
    expect(mapGeometry({ type: 'Nonsense' })).toBeNull();
    expect(mapGeometry(undefined)).toBeNull();
  });
});
