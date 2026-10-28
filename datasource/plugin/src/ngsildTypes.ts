import { FieldType } from '@grafana/data';

/** Simplified temporal representation: [value, time]; aggregated adds the bucket end. */
export type GeoCoordinates = [number, number];
export interface Entity {
  id: string;
  type: string | string[];
  [attribute: string]: any;
}

export interface EntityType {
  id?: string;
  typeName: string;
  attributeNames?: string[];
}

/** Entity members that are not attributes (CIM 009 4.5 core members and system attributes). */
export const CORE_MEMBERS: readonly string[] = Object.freeze([
  'id',
  'type',
  '@context',
  'scope',
  'createdAt',
  'modifiedAt',
  'deletedAt',
  'expiresAt',
]);

export const attributeNames = (entity: Entity): string[] =>
  Object.keys(entity).filter((k) => !CORE_MEMBERS.includes(k));

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The plain value of one attribute instance in normalized, concise or keyValues form.
 * Property → value, Relationship → object, LanguageProperty → text in `lang`,
 * VocabProperty → vocab, JsonProperty → json, ListProperty → valueList, ListRelationship → objects.
 */
export function getValue(attr: unknown, lang?: string): unknown {
  if (!isObject(attr)) {
    return attr; // keyValues, or a bare concise value
  }
  if ('value' in attr) {
    const v = attr.value;
    return isObject(v) && '@value' in v ? v['@value'] : v;
  }
  if ('object' in attr) {
    return attr.object;
  }
  if ('languageMap' in attr) {
    const map = attr.languageMap ?? {};
    return map[lang ?? ''] ?? map['@none'] ?? map.en ?? Object.values(map)[0];
  }
  if ('vocab' in attr) {
    return attr.vocab;
  }
  if ('json' in attr) {
    return attr.json;
  }
  if ('valueList' in attr) {
    return attr.valueList;
  }
  if ('objectList' in attr) {
    return (attr.objectList as any[]).map((o) => (isObject(o) ? o.object : o));
  }
  if ('@value' in attr) {
    return attr['@value'];
  }
  // an attribute without a member read above has no value; any other object is a keyValues value (address, GeoJSON)
  return ATTRIBUTE_TYPES.includes(attr.type) ? undefined : attr;
}

const ATTRIBUTE_TYPES = [
  'Property',
  'GeoProperty',
  'Relationship',
  'LanguageProperty',
  'VocabProperty',
  'JsonProperty',
  'ListProperty',
  'ListRelationship',
];

/**
 * Instances of an attribute: a multi-instance attribute is an array, one per datasetId; in the simplified
 * (keyValues) form it is { dataset: { <datasetId>: value } }, "@none" the default instance (4.5.4).
 */
export function instances(attr: unknown): unknown[] {
  if (Array.isArray(attr)) {
    return attr;
  }
  if (isObject(attr) && Object.keys(attr).length === 1 && isObject(attr.dataset)) {
    return Object.entries(attr.dataset).map(([datasetId, value]) =>
      datasetId === '@none' ? value : { value, datasetId }
    );
  }
  return [attr];
}

export const datasetIdOf = (attr: unknown): string | undefined =>
  isObject(attr) && typeof attr.datasetId === 'string' ? attr.datasetId : undefined;

export const isRelationship = (attr: unknown): boolean =>
  isObject(attr) &&
  (attr.type === 'Relationship' || attr.type === 'ListRelationship' || 'object' in attr || 'objectList' in attr);

/** Target entity ids of a (List)Relationship instance. */
export function relationshipTargets(attr: unknown): string[] {
  if (!isObject(attr)) {
    return [];
  }
  const v = getValue(attr);
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Grafana field type that fits a column of values. */
export function fieldTypeOf(values: unknown[]): FieldType {
  const sample = values.find((v) => v !== undefined && v !== null);
  if (typeof sample === 'number') {
    return FieldType.number;
  }
  if (typeof sample === 'boolean') {
    return FieldType.boolean;
  }
  if (typeof sample === 'string') {
    return ISO_DATE.test(sample) ? FieldType.time : FieldType.string;
  }
  return sample === undefined ? FieldType.number : FieldType.string;
}

/** Values as Grafana can show them: objects and arrays become JSON text, dates epoch ms. */
export function normalizeValues(values: unknown[], type: FieldType): unknown[] {
  return values.map((v) => {
    if (v === undefined || v === null) {
      return null;
    }
    if (type === FieldType.time) {
      return typeof v === 'string' ? Date.parse(v) : v;
    }
    if (typeof v === 'object') {
      return JSON.stringify(v);
    }
    if (type === FieldType.number && typeof v !== 'number') {
      return null; // mixed column; never mislabel a string as a number
    }
    return v;
  });
}

/** Representative [lon, lat] of a GeoJSON geometry: the point itself, else the mean of all positions. */
export function representativePoint(geometry: unknown): GeoCoordinates | undefined {
  if (!isObject(geometry)) {
    return undefined;
  }
  const positions: GeoCoordinates[] = [];
  const collect = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      positions.push([c[0], c[1]]);
    } else if (Array.isArray(c)) {
      c.forEach(collect);
    }
  };
  if (geometry.type === 'GeometryCollection') {
    (geometry.geometries ?? []).forEach((g: any) => collect(g?.coordinates));
  } else if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    // the closing position repeats the first one; drop it from each ring
    const rings: unknown[] = geometry.type === 'Polygon' ? [geometry.coordinates] : (geometry.coordinates ?? []);
    rings.forEach((poly: any) =>
      (poly ?? []).forEach((ring: any) => collect(Array.isArray(ring) ? ring.slice(0, -1) : ring))
    );
  } else {
    collect(geometry.coordinates);
  }
  if (positions.length === 0) {
    return undefined;
  }
  const sum = positions.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [sum[0] / positions.length, sum[1] / positions.length];
}
