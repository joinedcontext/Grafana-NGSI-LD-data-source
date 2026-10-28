import { createDataFrame, DataFrame, Field, FieldType } from '@grafana/data';
import GeoJSON from 'ol/format/GeoJSON';
import { Geometry } from 'ol/geom';

import { AGGREGATION_METHODS, NamePattern, namePatternFromValue, NgsildQuery } from './types';
import {
  attributeNames,
  datasetIdOf,
  Entity,
  fieldTypeOf,
  getValue,
  instances,
  isRelationship,
  normalizeValues,
  representativePoint,
} from './ngsildTypes';
import { grafanaUnit } from './units';
import { nameFromAttribute } from './request';

/** One time series: an attribute instance set (datasetId) of an entity, optionally one aggregation method. */
export interface Series {
  entityId: string;
  entityType: string;
  attr: string;
  datasetId?: string;
  method?: string;
  unitCode?: string;
  /** time (epoch ms) → value */
  points: Map<number, unknown>;
}

export const seriesKey = (s: Pick<Series, 'entityId' | 'attr' | 'datasetId' | 'method'>): string =>
  [s.entityId, s.attr, s.datasetId ?? '', s.method ?? ''].join('\u0000');

const typeOf = (e: Entity): string => (Array.isArray(e.type) ? e.type.join(',') : e.type);

/** Short form of an id or URI: the part after the last ':', '/' or '#'. */
export const shortId = (id: string): string => {
  const cut = Math.max(id.lastIndexOf(':'), id.lastIndexOf('/'), id.lastIndexOf('#'));
  return cut >= 0 && cut < id.length - 1 ? id.substring(cut + 1) : id;
};

/** Entity label per the query's entityName setting. */
export function entityLabel(entity: Entity, q: NgsildQuery, nameValue?: unknown): string {
  if (nameFromAttribute(q)) {
    const v = nameValue !== undefined ? nameValue : getValue(instances(entity[q.entityName!])[0], q.lang);
    if (v !== undefined && v !== null && v !== '') {
      return String(v);
    }
  }
  const long = q.entityName === 'id' || (q.entityName === undefined && q.useLongEntityName);
  return long ? entity.id : shortId(entity.id);
}

/** Display name of a value field per the query's naming pattern. */
export function displayName(q: NgsildQuery, label: string, attr: string, datasetId?: string, method?: string): string {
  const qualifiers = [datasetId && shortId(datasetId), method].filter(Boolean);
  const suffix = qualifiers.length > 0 ? ` (${qualifiers.join(', ')})` : '';
  switch (namePatternFromValue(q.namePattern)) {
    case NamePattern.ATTRIBUTE:
      return attr + suffix;
    case NamePattern.ENTITY_NAME:
      return label + suffix;
    default:
      return `${label}:${attr}${suffix}`;
  }
}

const NULL_URI = 'urn:ngsi-ld:null';

/** Members of an attribute instance in the simplified temporal form (CIM 009 4.5.9), one per attribute type. */
const SIMPLIFIED = ['values', 'languageMaps', 'vocabs', 'jsons', 'valueLists'] as const;

/**
 * [value, time] pairs of an attribute instance in the simplified temporal form: a Property's `values`
 * hold plain values, the other members wrap them ({ languageMap: ... }); a LanguageProperty gives its `lang` text.
 * Undefined when the instance is not in that form.
 */
export function temporalPairs(inst: Record<string, any>, lang?: string): Array<[unknown, unknown]> | undefined {
  const key = SIMPLIFIED.find((k) => Array.isArray(inst[k]));
  return key && inst[key].map((p: unknown[]) => [key === 'values' ? p?.[0] : getValue(p?.[0], lang), p?.[1]]);
}

/**
 * Collects the series of temporal entities in the simplified (temporalValues) or aggregated
 * (aggregatedValues, one array per method) form. Adds to `into`, so 206 pages merge; returns how many
 * points were new.
 */
export function collectSeries(
  entities: Entity[],
  into: Map<string, Series>,
  skipAttrs: string[] = [],
  lang?: string,
  deletions = false
): number {
  let added = 0;
  const put = (base: Omit<Series, 'points'>, time: unknown, raw: unknown) => {
    // a deletion instance holds "urn:ngsi-ld:null" (4.5.7): a gap, or 1 per deletion when timed by deletedAt
    const value = raw === NULL_URI ? (deletions ? 1 : null) : raw;
    const t = typeof time === 'string' ? Date.parse(time) : NaN;
    if (!Number.isFinite(t)) {
      return;
    }
    const key = seriesKey(base);
    let s = into.get(key);
    if (!s) {
      s = { ...base, points: new Map() };
      into.set(key, s);
    }
    if (!s.unitCode && base.unitCode) {
      s.unitCode = base.unitCode;
    }
    if (!s.points.has(t)) {
      added++;
    }
    s.points.set(t, value);
  };
  for (const e of entities) {
    for (const attr of attributeNames(e)) {
      if (skipAttrs.includes(attr)) {
        continue;
      }
      for (const inst of instances(e[attr])) {
        if (typeof inst !== 'object' || inst === null || isRelationship(inst)) {
          continue;
        }
        const i = inst as Record<string, any>;
        const base = { entityId: e.id, entityType: typeOf(e), attr, datasetId: datasetIdOf(i), unitCode: i.unitCode };
        const pairs = temporalPairs(i, lang);
        if (pairs) {
          pairs.forEach(([value, time]) => put(base, time, value));
          continue;
        }
        for (const method of AGGREGATION_METHODS.filter((m) => Array.isArray(i[m]))) {
          // the bucket start stands for the bucket
          i[method].forEach((p: unknown[]) => put({ ...base, method }, p?.[1], p?.[0]));
        }
      }
    }
  }
  return added;
}

/** Where a 206 temporal page stopped: the entities to continue and the instant to continue from. */
export interface PageCut {
  ids: string[];
  boundary: string;
}

/**
 * Where a 206 temporal page (CIM 009 6.3.10) has to continue. Antares cuts every attribute instance
 * set at the same instance count, so the sets that reached the page's largest count are the cut ones.
 * Forwards the page continues at the earliest end of a cut set, backwards (lastN) at the latest start,
 * so no entity's instances are skipped; the Content-Range end alone would skip those of entities with
 * sparser data. Only entities with a cut set are continued.
 * Undefined when the page holds no timed instance (nothing to continue from).
 */
export function pageCut(entities: Entity[], backwards: boolean): PageCut | undefined {
  const sets: Array<{ id: string; count: number; first: number; last: number }> = [];
  for (const e of entities) {
    for (const attr of attributeNames(e)) {
      const byDataset = new Map<string, { id: string; count: number; first: number; last: number }>();
      for (const inst of instances(e[attr])) {
        if (typeof inst !== 'object' || inst === null || isRelationship(inst)) {
          continue;
        }
        const key = datasetIdOf(inst) ?? '';
        for (const [, time] of temporalPairs(inst as Record<string, any>) ?? []) {
          const t = typeof time === 'string' ? Date.parse(time) : NaN;
          if (!Number.isFinite(t)) {
            continue;
          }
          const set = byDataset.get(key) ?? { id: e.id, count: 0, first: t, last: t };
          set.count++;
          set.first = Math.min(set.first, t);
          set.last = Math.max(set.last, t);
          byDataset.set(key, set);
        }
      }
      sets.push(...byDataset.values());
    }
  }
  let full = 0;
  for (const s of sets) {
    full = Math.max(full, s.count);
  }
  if (full === 0) {
    return undefined;
  }
  const cut = sets.filter((s) => s.count === full);
  let boundary = backwards ? -Infinity : Infinity;
  for (const s of cut) {
    boundary = backwards ? Math.max(boundary, s.first) : Math.min(boundary, s.last);
  }
  return { ids: [...new Set(cut.map((s) => s.id))], boundary: new Date(boundary).toISOString() };
}

/** Last known value per entity of the name attribute in a temporal result. */
export function temporalNames(entities: Entity[], q: NgsildQuery): Map<string, unknown> {
  const names = new Map<string, unknown>();
  if (!nameFromAttribute(q)) {
    return names;
  }
  for (const e of entities) {
    const raw = e[q.entityName!];
    if (raw === undefined) {
      continue;
    }
    const insts = instances(raw);
    const last = insts[insts.length - 1] as any;
    const pairs = typeof last === 'object' && last !== null ? temporalPairs(last, q.lang) : undefined;
    const v = pairs ? pairs[pairs.length - 1]?.[0] : getValue(last, q.lang);
    if (v !== undefined) {
      names.set(e.id, v);
    }
  }
  return names;
}

const unitFor = (unitCode?: string, method?: string): string | undefined =>
  method === 'totalCount' || method === 'distinctCount' || method === 'sumsq' ? undefined : grafanaUnit(unitCode);

function valueField(name: string, values: unknown[], config: Field['config'], labels?: Record<string, string>): Field {
  const type = fieldTypeOf(values);
  return { name, type, values: normalizeValues(values, type) as any[], config, labels };
}

/** The positions of a GeoProperty history, null for a gap; undefined when a value is no geometry. */
function trackOf(values: unknown[]): Array<[number, number] | null> | undefined {
  const points = values.map((v) => (v === null || v === undefined ? null : representativePoint(v)));
  return points.some((p) => p === undefined) || points.every((p) => p === null)
    ? undefined
    : (points as Array<[number, number] | null>);
}

/**
 * One [Time, value] frame per series, points in time order. A GeoProperty history becomes
 * [Time, latitude, longitude], the track that Geomap's route layer draws.
 */
export function seriesToFrames(series: Iterable<Series>, q: NgsildQuery, names: Map<string, unknown>): DataFrame[] {
  const frames: DataFrame[] = [];
  for (const s of series) {
    const times = [...s.points.keys()].sort((a, b) => a - b);
    const values = times.map((t) => s.points.get(t));
    const label = entityLabel({ id: s.entityId, type: s.entityType }, q, names.get(s.entityId));
    const labels: Record<string, string> = { entity: s.entityId, type: s.entityType };
    if (s.datasetId) {
      labels.datasetId = s.datasetId;
    }
    if (s.method) {
      labels.aggregation = s.method;
    }
    const track = trackOf(values);
    const coordinate = (name: string, axis: 0 | 1): Field => ({
      name,
      type: FieldType.number,
      values: track!.map((p) => (p ? p[axis] : null)),
      config: { displayNameFromDS: displayName(q, label, name, s.datasetId, s.method) },
      labels,
    });
    frames.push(
      createDataFrame({
        refId: q.refId,
        name: label,
        fields: [
          { name: 'Time', type: FieldType.time, values: times, config: {} },
          ...(track
            ? [coordinate('latitude', 1), coordinate('longitude', 0)]
            : [
                valueField(
                  s.attr,
                  values,
                  {
                    displayNameFromDS: displayName(q, label, s.attr, s.datasetId, s.method),
                    unit: unitFor(s.unitCode, s.method),
                  },
                  labels
                ),
              ]),
        ],
      })
    );
  }
  return frames;
}

/**
 * GeoProperty histories as one Geomap frame, a row per series: the track as a geo field (a LineString,
 * a Point while it has one position) that the markers layer draws, the newest position as latitude and
 * longitude, and its time. Series that are no geometry history are left out.
 */
export function seriesToTrails(series: Iterable<Series>, q: NgsildQuery, names: Map<string, unknown>): DataFrame {
  const rows: Array<{ s: Series; label: string; positions: Array<[number, number]>; time: number }> = [];
  for (const s of series) {
    const times = [...s.points.keys()].sort((a, b) => a - b);
    const track = trackOf(times.map((t) => s.points.get(t)));
    const timed = (track ?? []).flatMap((p, i) => (p ? [{ p, t: times[i] }] : []));
    if (timed.length > 0) {
      const label = entityLabel({ id: s.entityId, type: s.entityType }, q, names.get(s.entityId));
      rows.push({ s, label, positions: timed.map((x) => x.p), time: timed[timed.length - 1].t });
    }
  }
  const last = (r: (typeof rows)[number]) => r.positions[r.positions.length - 1];
  return createDataFrame({
    refId: q.refId,
    fields: [
      { name: 'name', type: FieldType.string, values: rows.map((r) => r.label), config: {} },
      { name: 'id', type: FieldType.string, values: rows.map((r) => r.s.entityId), config: {} },
      { name: 'type', type: FieldType.string, values: rows.map((r) => r.s.entityType), config: {} },
      { name: 'time', type: FieldType.time, values: rows.map((r) => r.time), config: {} },
      { name: 'latitude', type: FieldType.number, values: rows.map((r) => last(r)[1]), config: {} },
      { name: 'longitude', type: FieldType.number, values: rows.map((r) => last(r)[0]), config: {} },
      { name: 'positions', type: FieldType.number, values: rows.map((r) => r.positions.length), config: {} },
      {
        name: 'geometry',
        type: FieldType.geo,
        values: rows.map((r) =>
          mapGeometry(
            r.positions.length > 1
              ? { type: 'LineString', coordinates: r.positions }
              : { type: 'Point', coordinates: r.positions[0] }
          )
        ),
        config: {},
      },
    ],
  });
}

const timeOf = (inst: any, fallback: number): number => {
  const t = inst && typeof inst === 'object' ? (inst.observedAt ?? inst.modifiedAt ?? inst.createdAt) : undefined;
  const ms = typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : fallback;
};

/** Current values, one [Time, value] frame per entity attribute instance (relationships skipped). */
export function entitiesToTimeseries(entities: Entity[], q: NgsildQuery, fallbackTime: number): DataFrame[] {
  const frames: DataFrame[] = [];
  for (const e of entities) {
    const label = entityLabel(e, q);
    for (const attr of attributeNames(e)) {
      if (nameFromAttribute(q) && attr === q.entityName) {
        continue;
      }
      for (const inst of instances(e[attr])) {
        if (isRelationship(inst)) {
          continue;
        }
        const datasetId = datasetIdOf(inst);
        const labels: Record<string, string> = { entity: e.id, type: typeOf(e), ...(datasetId ? { datasetId } : {}) };
        frames.push(
          createDataFrame({
            refId: q.refId,
            name: label,
            fields: [
              { name: 'Time', type: FieldType.time, values: [timeOf(inst, fallbackTime)], config: {} },
              valueField(
                attr,
                [getValue(inst, q.lang)],
                {
                  displayNameFromDS: displayName(q, label, attr, datasetId),
                  unit: grafanaUnit((inst as any)?.unitCode),
                },
                labels
              ),
            ],
          })
        );
      }
    }
  }
  return frames;
}

interface Column {
  attr: string;
  name: string;
  values: unknown[];
  units: Set<string>;
}

/** Attribute columns, one per attribute instance set: "attr" or "attr (dataset)", in the query's attribute order. */
function attributeColumns(entities: Entity[], q: NgsildQuery, skip: string[]): Column[] {
  const columns = new Map<string, Column>();
  entities.forEach((e, row) => {
    for (const attr of attributeNames(e)) {
      if (skip.includes(attr)) {
        continue;
      }
      for (const inst of instances(e[attr])) {
        const ds = datasetIdOf(inst);
        const name = ds ? `${attr} (${shortId(ds)})` : attr;
        let col = columns.get(name);
        if (!col) {
          col = { attr, name, values: new Array(entities.length).fill(null), units: new Set() };
          columns.set(name, col);
        }
        col.values[row] = getValue(inst, q.lang);
        const unit = (inst as any)?.unitCode;
        if (unit) {
          col.units.add(unit);
        }
      }
    }
  });
  // the query's attribute order, then the attributes it did not name
  const rank = (c: Column) => {
    const i = q.attributes?.indexOf(c.attr) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...columns.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const columnField = (c: Column): Field =>
  valueField(c.name, c.values, c.units.size === 1 ? { unit: grafanaUnit([...c.units][0]) } : {});

/** Current values as one table: a row per entity, a column per attribute. */
export function entitiesToTable(entities: Entity[], q: NgsildQuery): DataFrame {
  // an entity member (CIM 009 4.5.1), not an attribute; brokers may send it only with sysAttrs
  const expires = entities.map((e) => (typeof e.expiresAt === 'string' ? Date.parse(e.expiresAt) : NaN));
  return createDataFrame({
    refId: q.refId,
    meta: { preferredVisualisationType: 'table' },
    fields: [
      { name: 'id', type: FieldType.string, values: entities.map((e) => e.id), config: {} },
      { name: 'type', type: FieldType.string, values: entities.map(typeOf), config: {} },
      ...(expires.some(Number.isFinite)
        ? [
            {
              name: 'expiresAt',
              type: FieldType.time,
              values: expires.map((t) => (Number.isFinite(t) ? t : null)),
              config: {},
            },
          ]
        : []),
      ...attributeColumns(entities, q, []).map(columnField),
    ],
  });
}

const GEO_COLUMNS = ['name', 'latitude', 'longitude', 'id', 'type', 'geometryType', 'geometry'];

// Geomap draws geo fields in the map projection; NGSI-LD GeoJSON is WGS 84 (CIM 009 4.7)
const geoJson = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

/** A GeoJSON geometry as the OpenLayers geometry the Geomap panel draws; null when it does not parse. */
export function mapGeometry(geometry: unknown): Geometry | null {
  try {
    return geoJson.readGeometry(geometry) ?? null;
  } catch {
    return null;
  }
}

/**
 * The parts of a GeoJSON geometry that Grafana's Geomap markers layer draws as shapes: it draws a
 * LineString as a line and every other geometry as one point (Grafana 12.3 and 13). So points and lines
 * stay, a multi geometry or collection splits into its members, and a polygon becomes the outlines of its
 * rings. A geometry that is none of these is returned as it is, for mapGeometry to reject.
 */
export function drawableParts(geometry: any): any[] {
  const lines = (rings: unknown): any[] =>
    Array.isArray(rings) ? rings.map((coordinates) => ({ type: 'LineString', coordinates })) : [];
  const parts = (type: string): any[] =>
    Array.isArray(geometry?.coordinates)
      ? geometry.coordinates.map((coordinates: unknown) => ({ type, coordinates }))
      : [];
  switch (geometry?.type) {
    case 'Polygon':
      return lines(geometry.coordinates);
    case 'MultiPolygon':
      return parts('Polygon').flatMap(drawableParts);
    case 'MultiLineString':
      return parts('LineString');
    case 'MultiPoint':
      return parts('Point');
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap(drawableParts);
    default:
      return [geometry];
  }
}

/**
 * Entities with a geometry in `geoproperty` (default location) as a geomap table:
 * name, latitude, longitude (point, else the mean of the positions), geometry, attributes.
 * The geometry is GeoJSON text, or with geoLocation "shape" a geo field the Geomap panel draws: then an
 * entity has a row per drawable part (see drawableParts), each with the entity's columns.
 */
export function entitiesToGeo(entities: Entity[], q: NgsildQuery): DataFrame {
  const geoproperty = q.geoproperty || 'location';
  const shape = q.geoLocation === 'shape';
  const rows: Array<{ e: Entity; geometry: any; point: [number, number]; part: any }> = [];
  for (const e of entities) {
    const geometry = getValue(instances(e[geoproperty])[0]);
    const point = representativePoint(geometry);
    if (point) {
      (shape ? drawableParts(geometry) : [geometry]).forEach((part) => rows.push({ e, geometry, point, part }));
    }
  }
  const located = rows.map((r) => r.e);
  const skip = [geoproperty, ...GEO_COLUMNS, ...(nameFromAttribute(q) ? [q.entityName!] : [])];
  return createDataFrame({
    refId: q.refId,
    fields: [
      { name: 'name', type: FieldType.string, values: located.map((e) => entityLabel(e, q)), config: {} },
      { name: 'latitude', type: FieldType.number, values: rows.map((r) => r.point[1]), config: { unit: 'degree' } },
      { name: 'longitude', type: FieldType.number, values: rows.map((r) => r.point[0]), config: { unit: 'degree' } },
      { name: 'id', type: FieldType.string, values: located.map((e) => e.id), config: {} },
      { name: 'type', type: FieldType.string, values: located.map(typeOf), config: {} },
      { name: 'geometryType', type: FieldType.string, values: rows.map((r) => r.geometry?.type ?? null), config: {} },
      shape
        ? { name: 'geometry', type: FieldType.geo, values: rows.map((r) => mapGeometry(r.part)), config: {} }
        : { name: 'geometry', type: FieldType.string, values: rows.map((r) => JSON.stringify(r.geometry)), config: {} },
      ...attributeColumns(located, q, skip).map(columnField),
    ],
  });
}
