import { AUTO_PERIOD, NamePattern, NgsildQuery, NgsildQueryType } from './types';

/** A broker request relative to /ngsi-ld/v1, parameters in order. */
export interface NgsildRequest {
  path: string;
  params: Array<[string, string]>;
}

export interface RequestContext {
  /** Time range in epoch ms (temporal queries). */
  from?: number;
  to?: number;
  /** Panel interval, used for aggrPeriodDuration=auto. */
  intervalMs?: number;
  /** Entities per request (limit). */
  pageSize: number;
}

export const splitList = (value?: string | string[]): string[] =>
  (Array.isArray(value) ? value : (value ?? '').split(',')).map((v) => v.trim()).filter((v) => v);

/** True when the entity name comes from an attribute rather than the id. */
export const nameFromAttribute = (q: Pick<NgsildQuery, 'entityName'>): boolean =>
  !!q.entityName && q.entityName !== 'id' && q.entityName !== 'id_short';

const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
export const isIsoDuration = (s: string): boolean => ISO_DURATION.test(s);

/** Panel interval as an ISO 8601 duration, whole seconds, at least one second. */
export const intervalToDuration = (intervalMs?: number): string =>
  `PT${Math.max(1, Math.round((intervalMs ?? 60_000) / 1000))}S`;

/** True when the query names something to select; without it nothing is sent. */
export const hasSelector = (q: NgsildQuery): boolean =>
  !!(
    q.entityType ||
    q.entityId ||
    q.idPattern ||
    q.attributes?.length ||
    q.customQuery ||
    (q.georel && q.coordinates?.trim())
  );

/** Builds the broker request for a query whose template variables are already resolved. */
export function buildRequest(q: NgsildQuery, ctx: RequestContext): NgsildRequest {
  const params: Array<[string, string]> = [];
  const add = (key: string, value?: string | number) => {
    if (value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value))) {
      params.push([key, String(value)]);
    }
  };
  const temporal = q.queryType === NgsildQueryType.TEMPORAL;
  const ids = splitList(q.entityId);

  add('id', ids.join(','));
  add('type', splitList(q.entityType).join(','));
  add('idPattern', q.idPattern?.trim());

  const attrs = splitList(q.attributes);
  if (attrs.length > 0) {
    if (nameFromAttribute(q) && q.namePattern !== NamePattern.ATTRIBUTE) {
      attrs.push(q.entityName!);
    }
    if (q.queryType === NgsildQueryType.GEO) {
      attrs.push(q.geoproperty || 'location');
    }
    add('attrs', [...new Set(attrs)].join(','));
  }
  add('q', q.customQuery?.trim());
  add('scopeQ', q.scopeQuery?.trim());
  const coordinates = q.coordinates?.replace(/\s+/g, '');
  if (q.georel?.trim() && coordinates) {
    // a georel without coordinates is a broker error; the editor marks the field until it is set
    add('georel', q.georel.trim());
    add('geometry', q.geometry || 'Point');
    add('coordinates', coordinates);
    add('geoproperty', q.geoproperty || undefined);
  }
  add('lang', q.lang?.trim());
  // Without these selectors a query has to be local (5.5.13): type, attrs, q or georel for /entities
  // (6.4.3.2), type or attrs for /temporal/entities (6.18.3.2)
  const selectors = temporal ? ['type', 'attrs'] : ['type', 'attrs', 'q', 'georel'];
  if (!params.some(([k]) => selectors.includes(k))) {
    add('local', 'true');
  }

  // representation (format, 6.3.7); options keeps the flags (sysAttrs, 6.3.11). Only current-value
  // queries offer them: keyValues would turn a node graph's relationships into plain strings.
  const options = q.queryType === NgsildQueryType.ENTITY ? (q.ngsildOptions ?? []) : [];
  const methods = splitList(q.aggrMethod);
  const format = temporal
    ? methods.length > 0
      ? 'aggregatedValues'
      : 'temporalValues'
    : options.find((o) => o === 'keyValues' || o === 'concise');
  add('format', format);
  add('options', options.filter((o) => o !== format).join(','));

  if (temporal) {
    const { from, to } = ctx;
    const hasFrom = Number.isFinite(from);
    const hasTo = Number.isFinite(to);
    if (hasFrom || hasTo) {
      add('timerel', hasFrom && hasTo ? 'between' : hasFrom ? 'after' : 'before');
      add('timeAt', new Date((hasFrom ? from : to)!).toISOString());
      if (hasFrom && hasTo) {
        add('endTimeAt', new Date(to!).toISOString());
      }
    }
    if (q.timeProperty && q.timeProperty !== 'observedAt') {
      add('timeproperty', q.timeProperty);
    }
    if (methods.length > 0) {
      add('aggrMethods', methods.join(','));
      const period = q.aggrPeriodDuration?.trim();
      add('aggrPeriodDuration', period === AUTO_PERIOD ? intervalToDuration(ctx.intervalMs) : period);
    }
    if (q.lastN && q.lastN > 0) {
      add('lastN', Math.floor(q.lastN));
    }
  }
  add('limit', ctx.pageSize);
  return { path: temporal ? '/temporal/entities' : '/entities', params };
}

/** Query string with every value percent-encoded (no form encoding: '+' stays literal). */
export const toQueryString = (params: Array<[string, string]>): string =>
  params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export const withParam = (params: Array<[string, string]>, key: string, value?: string): Array<[string, string]> => {
  const rest = params.filter(([k]) => k !== key);
  return value === undefined ? rest : [...rest, [key, value]];
};
