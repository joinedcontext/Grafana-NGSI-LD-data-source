import { FieldType } from '@grafana/data';

import {
  attributeNames,
  datasetIdOf,
  fieldTypeOf,
  getValue,
  instances,
  isRelationship,
  normalizeValues,
  relationshipTargets,
  representativePoint,
} from './ngsildTypes';

describe('attributeNames', () => {
  it('skips core members and system attributes', () => {
    expect(
      attributeNames({
        id: 'x',
        type: 'T',
        '@context': [],
        scope: '/a',
        createdAt: 't',
        modifiedAt: 't',
        deletedAt: 't',
        expiresAt: 't',
        a: 1,
        b: 2,
      })
    ).toEqual(['a', 'b']);
  });
});

describe('getValue', () => {
  it.each([
    ['a keyValues number', 5, 5],
    ['null', null, null],
    ['a Property', { type: 'Property', value: 3 }, 3],
    [
      'a Property with an @value',
      { type: 'Property', value: { '@value': '2026-01-01', '@type': 'DateTime' } },
      '2026-01-01',
    ],
    ['an object Property', { type: 'Property', value: { a: 1 } }, { a: 1 }],
    ['a Relationship', { type: 'Relationship', object: 'urn:x' }, 'urn:x'],
    ['a VocabProperty', { type: 'VocabProperty', vocab: 'urban' }, 'urban'],
    ['a JsonProperty', { type: 'JsonProperty', json: { k: [1] } }, { k: [1] }],
    ['a ListProperty', { type: 'ListProperty', valueList: [1, 2] }, [1, 2]],
    [
      'a ListRelationship',
      { type: 'ListRelationship', objectList: [{ object: 'urn:a' }, 'urn:b'] },
      ['urn:a', 'urn:b'],
    ],
    ['a bare @value', { '@value': 7 }, 7],
    ['a GeoProperty without value', { type: 'GeoProperty' }, undefined],
    ['a keyValues object', { street: 'x' }, { street: 'x' }],
    ['a keyValues GeoJSON value', { type: 'Point', coordinates: [1, 2] }, { type: 'Point', coordinates: [1, 2] }],
    // temporal members or unknown ones: no value rather than the attribute object ("[object Object]")
    ['a LanguageProperty in temporal form', { type: 'LanguageProperty', languageMaps: [] }, undefined],
    ['a VocabProperty without vocab', { type: 'VocabProperty' }, undefined],
  ])('reads %s', (_, attr, expected) => {
    expect(getValue(attr)).toEqual(expected);
  });

  it('picks the requested language, then @none, then en, then any', () => {
    const attr = (languageMap: Record<string, string>) => ({ type: 'LanguageProperty', languageMap });
    expect(getValue(attr({ sk: 'Námestie', en: 'Square' }), 'sk')).toBe('Námestie');
    expect(getValue(attr({ '@none': 'X', en: 'Square' }), 'de')).toBe('X');
    expect(getValue(attr({ sk: 'Námestie', en: 'Square' }), 'de')).toBe('Square');
    expect(getValue(attr({ sk: 'Námestie' }))).toBe('Námestie');
    expect(getValue({ type: 'LanguageProperty', languageMap: null })).toBeUndefined();
  });
});

describe('instances and datasets', () => {
  it('wraps a single instance and keeps a multi-instance array', () => {
    expect(instances({ value: 1 })).toEqual([{ value: 1 }]);
    expect(instances([{ value: 1 }, { value: 2 }])).toHaveLength(2);
  });

  it('reads string datasetIds only', () => {
    expect(datasetIdOf({ datasetId: 'urn:d' })).toBe('urn:d');
    expect(datasetIdOf({ datasetId: 5 })).toBeUndefined();
    expect(datasetIdOf('x')).toBeUndefined();
  });
});

describe('relationships', () => {
  it('recognises relationships by type or member', () => {
    expect(isRelationship({ type: 'Relationship', object: 'a' })).toBe(true);
    expect(isRelationship({ object: 'a' })).toBe(true);
    expect(isRelationship({ objectList: [] })).toBe(true);
    expect(isRelationship({ type: 'Property', value: 1 })).toBe(false);
    expect(isRelationship('urn:a')).toBe(false);
  });

  it('lists the target ids', () => {
    expect(relationshipTargets({ type: 'Relationship', object: 'urn:a' })).toEqual(['urn:a']);
    expect(
      relationshipTargets({ type: 'ListRelationship', objectList: [{ object: 'urn:a' }, { object: 'urn:b' }] })
    ).toEqual(['urn:a', 'urn:b']);
    expect(relationshipTargets({ type: 'Relationship', object: 5 })).toEqual([]);
    expect(relationshipTargets('urn:a')).toEqual([]);
  });
});

describe('fieldTypeOf', () => {
  it.each([
    [[null, 1], FieldType.number],
    [[true], FieldType.boolean],
    [['2026-01-01T00:00:00Z'], FieldType.time],
    [['2026-01-01T00:00:00.123+01:00'], FieldType.time],
    [['2026-01-01'], FieldType.string],
    [['text'], FieldType.string],
    [[{ a: 1 }], FieldType.string],
    [[], FieldType.number],
    [[undefined, null], FieldType.number],
  ])('%j -> %s', (values, expected) => {
    expect(fieldTypeOf(values)).toBe(expected);
  });
});

describe('normalizeValues', () => {
  it('maps missing values to null, objects to JSON and dates to epoch ms', () => {
    expect(normalizeValues([undefined, null, { a: 1 }, [1]], FieldType.string)).toEqual([null, null, '{"a":1}', '[1]']);
    expect(normalizeValues(['2026-01-01T00:00:00Z', 5], FieldType.time)).toEqual([Date.UTC(2026, 0, 1), 5]);
  });

  it('never labels a string as a number', () => {
    expect(normalizeValues([1, 'x', 2], FieldType.number)).toEqual([1, null, 2]);
  });
});

describe('representativePoint', () => {
  it('returns a point itself', () => {
    expect(representativePoint({ type: 'Point', coordinates: [19.1, 48.7] })).toEqual([19.1, 48.7]);
  });

  it('averages a line', () => {
    expect(
      representativePoint({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [2, 4],
        ],
      })
    ).toEqual([1, 2]);
  });

  it('ignores the closing position of polygon rings', () => {
    const square = [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ];
    expect(representativePoint({ type: 'Polygon', coordinates: square })).toEqual([1, 1]);
    expect(representativePoint({ type: 'MultiPolygon', coordinates: [square] })).toEqual([1, 1]);
  });

  it('averages the members of a geometry collection', () => {
    expect(
      representativePoint({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'Point', coordinates: [4, 2] },
        ],
      })
    ).toEqual([2, 1]);
  });

  it.each([
    undefined,
    null,
    'x',
    { type: 'Point' },
    { type: 'Point', coordinates: ['a', 'b'] },
    { type: 'MultiPolygon' },
  ])('is undefined for %j', (g) => expect(representativePoint(g)).toBeUndefined());
});

describe('instances of a keyValues multi-attribute (4.5.4)', () => {
  const kv = { dataset: { '@none': 1, 'urn:ngsi-ld:Dataset:b': 2 } };

  it('gives one instance per datasetId, @none as the default instance', () => {
    const list = instances(kv);
    expect(list.map((i) => getValue(i))).toEqual([1, 2]);
    expect(list.map(datasetIdOf)).toEqual([undefined, 'urn:ngsi-ld:Dataset:b']);
  });

  it('leaves other objects with a dataset member alone', () => {
    expect(instances({ dataset: 'x' })).toEqual([{ dataset: 'x' }]);
    expect(instances({ dataset: {}, other: 1 })).toEqual([{ dataset: {}, other: 1 }]);
  });

  it('gives no instance for an empty dataset map', () => {
    expect(instances({ dataset: {} })).toEqual([]);
  });
});
