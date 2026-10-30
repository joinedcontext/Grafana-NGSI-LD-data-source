import {
  createDataFrame,
  DataFrame,
  DataQueryError,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  MetricFindValue,
  QueryResultMetaNotice,
  ScopedVars,
  TestDataSourceResponse,
} from '@grafana/data';
import { BackendSrvRequest, FetchResponse, getBackendSrv, getTemplateSrv, TemplateSrv } from '@grafana/runtime';
import { fromEvent, lastValueFrom, Observable, takeUntil } from 'rxjs';

import {
  DEFAULT_QUERY,
  NamePattern,
  NgsildQuery,
  NgsildQueryType,
  NgsildSourceOptions,
  queryTypeForValue,
  TemporalPropertyKey,
} from './types';
import { attributeNames, datasetIdOf, Entity, EntityType, getValue, instances } from './ngsildTypes';
import {
  buildRequest,
  hasSelector,
  nameFromAttribute,
  NgsildRequest,
  splitList,
  toQueryString,
  withParam,
} from './request';
import {
  collectSeries,
  entitiesToGeo,
  entitiesToTable,
  entitiesToTimeseries,
  entityLabel,
  pageCut,
  Series,
  seriesToFrames,
  seriesToTrails,
  temporalNames,
} from './frames';
import { DEFAULT_GRAPH_DEPTH, resolveRelated, toNodeGraph } from './NodeGraphHandler';

export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_LIMIT = 1000;
export const DEFAULT_MAX_TEMPORAL_PAGES = 100;
/** Ids per request when entities are fetched by id (keeps URLs short). */
const ID_CHUNK = 50;
/** Frames per query and nodes per graph; more freezes the browser. */
export const MAX_FRAMES = 500;
export const MAX_NODES = 1000;
// ponytail: a variable reads every entity of its type up to this many (pages of Page size); a dropdown
// longer than that is no longer something to pick from
export const MAX_VARIABLE_ENTITIES = 10_000;
/** How long the editor's lookups (types, attributes) are reused. */
const CACHE_MS = 60_000;
const MAX_DETAIL = 200;

const asArray = (data: unknown): Entity[] => (Array.isArray(data) ? data : data ? [data as Entity] : []);

/** A response body: JSON when it parses, else the text as it is (empty: undefined). */
export function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body;
  }
  if (body.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body.trim();
  }
}

/** A failed broker call: the message of errorMessage() and the HTTP status Grafana's proxy answered. */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

/** A text error body as a detail: an HTML page by its <title>, other text cut to MAX_DETAIL characters. */
function textDetail(body: string): string | undefined {
  if (/^<(!doctype|html|head|body|\?xml)/i.test(body)) {
    return body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || undefined;
  }
  return body.length > MAX_DETAIL ? body.slice(0, MAX_DETAIL) + '…' : body;
}

/** Message of a failed broker call; NGSI-LD errors are ProblemDetails (CIM 009 5.5.2). */
export function errorMessage(err: any): string {
  if (err instanceof BrokerError) {
    return err.message; // already formatted from the response
  }
  const d = err?.data;
  const detail = typeof d === 'string' ? textDetail(d) : d?.detail || d?.message || d?.title || d?.error;
  const status = err?.status ? `${err.status}${err.statusText ? ' ' + err.statusText : ''}` : '';
  return [status, detail || (!status ? err?.message : '')].filter(Boolean).join(': ') || 'Unknown error';
}

export class NgsildDataSource extends DataSourceApi<NgsildQuery, NgsildSourceOptions> {
  private readonly baseUrl: string;
  private readonly settings: NgsildSourceOptions;
  private readonly headers: Record<string, string>;
  private readonly pageSize: number;
  private readonly maxTemporalPages: number;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    instanceSettings: DataSourceInstanceSettings<NgsildSourceOptions>,
    private readonly templateSrv: TemplateSrv = getTemplateSrv()
  ) {
    super(instanceSettings);
    const jd = instanceSettings.jsonData ?? {};
    this.settings = jd;
    const root = (instanceSettings.url ?? '').replace(/\/+$/, '');
    this.baseUrl = (jd.authType === 'oauth' ? root + '/oauth' : root) + '/ngsi-ld/v1';
    this.pageSize = jd.pageSize && jd.pageSize > 0 ? jd.pageSize : DEFAULT_PAGE_SIZE;
    this.maxTemporalPages =
      jd.maxTemporalPages && jd.maxTemporalPages > 0 ? jd.maxTemporalPages : DEFAULT_MAX_TEMPORAL_PAGES;
    this.headers = { Accept: 'application/json' };
    if (jd.contextUrl?.trim()) {
      this.headers.Link = `<${jd.contextUrl.trim()}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`;
    }
    if (jd.tenant?.trim()) {
      this.headers['NGSILD-Tenant'] = jd.tenant.trim();
    }
  }

  getDefaultQuery(): Partial<NgsildQuery> {
    return DEFAULT_QUERY;
  }

  filterQuery(q: NgsildQuery): boolean {
    return !q.hide;
  }

  /**
   * One broker GET; throws a BrokerError carrying the broker's problem detail. The body is read as text:
   * gateways and Grafana's proxy answer errors in plain text, which a JSON read would replace with
   * "Unexpected error". An aborted `signal` cancels the request.
   */
  async get(path: string, params: Array<[string, string]> = [], signal?: AbortSignal): Promise<FetchResponse<any>> {
    if (signal?.aborted) {
      throw new BrokerError('Query cancelled');
    }
    const qs = toQueryString(params);
    const req: BackendSrvRequest = {
      method: 'GET',
      url: this.baseUrl + path + (qs ? '?' + qs : ''),
      headers: this.headers,
      responseType: 'text',
      showErrorAlert: false,
    };
    const fetch$ = getBackendSrv().fetch(req);
    let res: FetchResponse<unknown>;
    try {
      res = await lastValueFrom(signal ? fetch$.pipe(takeUntil(fromEvent(signal, 'abort'))) : fetch$);
    } catch (err) {
      const e = err as { status?: number; data?: unknown };
      throw new BrokerError(
        signal?.aborted ? 'Query cancelled' : errorMessage({ ...e, data: parseBody(e?.data) }),
        e?.status
      );
    }
    const data = parseBody(res.data);
    if (typeof data === 'string') {
      // a web page or proxy answering 200, not the broker
      throw new BrokerError(
        'The URL does not answer with NGSI-LD JSON. Enter the broker root without /ngsi-ld/v1, as the Grafana server reaches it.',
        res.status
      );
    }
    return { ...res, data };
  }

  /** A lookup shared for CACHE_MS; a failed one is not kept. */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return hit.value as Promise<T>;
    }
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** First request a query sends; shown in the query editor. */
  previewRequest(q: NgsildQuery, from?: number, to?: number, intervalMs?: number): NgsildRequest {
    const resolved = this.applyTemplateVariables(q, {});
    const sent =
      resolved.queryType === NgsildQueryType.NODE_GRAPH
        ? nodeGraphQuery(resolved)
        : resolved.queryType === NgsildQueryType.GEO && resolved.geoLocation === 'trail'
          ? trailQuery(resolved)
          : resolved;
    return buildRequest(sent, {
      from,
      to,
      intervalMs,
      pageSize: Math.min(this.pageSize, q.limit || DEFAULT_LIMIT),
    });
  }

  applyTemplateVariables(q: NgsildQuery, scopedVars: ScopedVars): NgsildQuery {
    const r = (v?: string, format = 'csv') => (v ? this.templateSrv.replace(v, scopedVars, format) : v);
    return {
      ...q,
      // an unknown type stays as it is, so the query fails with a message instead of running as temporal
      queryType: q.queryType ? (queryTypeForValue(q.queryType) ?? q.queryType) : NgsildQueryType.TEMPORAL,
      entityId: r(q.entityId),
      entityType: r(q.entityType),
      idPattern: r(q.idPattern, 'regex'),
      attributes: q.attributes?.flatMap((a) => splitList(r(a))),
      entityName: r(q.entityName),
      customQuery: r(q.customQuery),
      scopeQuery: r(q.scopeQuery),
      lang: r(q.lang),
      georel: r(q.georel),
      geometry: r(q.geometry),
      coordinates: r(q.coordinates),
      geoproperty: r(q.geoproperty),
      aggrMethod: r(q.aggrMethod),
      aggrPeriodDuration: r(q.aggrPeriodDuration),
    };
  }

  /** Unsubscribing (refresh, new time range, leaving the dashboard) stops the paging of every target. */
  query(request: DataQueryRequest<NgsildQuery>): Observable<DataQueryResponse> {
    return new Observable<DataQueryResponse>((subscriber) => {
      const abort = new AbortController();
      this.runTargets(request, abort.signal).then(
        (res) => {
          subscriber.next(res);
          subscriber.complete();
        },
        (err) => subscriber.error(err)
      );
      return () => abort.abort();
    });
  }

  private async runTargets(request: DataQueryRequest<NgsildQuery>, signal: AbortSignal): Promise<DataQueryResponse> {
    const targets = request.targets.filter((t) => !t.hide);
    const results = await Promise.all(
      targets.map((t) =>
        this.runQuery(
          this.applyTemplateVariables({ ...DEFAULT_QUERY, ...t }, request.scopedVars),
          request,
          signal
        ).then(
          (frames) => ({ frames, error: undefined as DataQueryError | undefined }),
          (err) => ({
            frames: [] as DataFrame[],
            error: { refId: t.refId, message: errorMessage(err) } as DataQueryError,
          })
        )
      )
    );
    const errors = results.flatMap((r) => (r.error ? [r.error] : []));
    return { data: results.flatMap((r) => r.frames), ...(errors.length > 0 ? { errors } : {}) };
  }

  private async runQuery(
    q: NgsildQuery,
    request: Pick<DataQueryRequest, 'range' | 'intervalMs'>,
    signal?: AbortSignal
  ): Promise<DataFrame[]> {
    if (!hasSelector(q)) {
      return withNotices(
        [],
        [{ severity: 'info', text: 'Select an entity type, entity id, id pattern, attribute, query or geo filter.' }],
        q.refId
      );
    }
    const from = request.range?.from?.valueOf();
    const to = request.range?.to?.valueOf();
    switch (q.queryType) {
      case NgsildQueryType.TEMPORAL:
        return this.runTemporal(q, from, to, request.intervalMs, signal);
      case NgsildQueryType.GEO: {
        if (q.geoLocation === 'trail') {
          return this.runTemporal(trailQuery(q), from, to, request.intervalMs, signal, (series, tq, names) => [
            seriesToTrails(series, tq, names),
          ]);
        }
        const { entities, notices } = await this.fetchEntities(q, signal);
        if (entities.length === 0) {
          notices.push(await this.noEntitiesNotice(q));
        }
        return withNotices([entitiesToGeo(entities, q)], notices, q.refId);
      }
      case NgsildQueryType.NODE_GRAPH:
        return this.runNodeGraph(q, signal);
      case NgsildQueryType.ENTITY: {
        const { entities, notices } = await this.fetchEntities(q, signal);
        if (entities.length === 0) {
          notices.push(await this.noEntitiesNotice(q));
        }
        const frames =
          q.format === 'table'
            ? [entitiesToTable(entities, q)]
            : entitiesToTimeseries(entities, q, Number.isFinite(to) ? to! : Date.now());
        return withNotices(capFrames(frames, notices), notices, q.refId);
      }
      default:
        throw new Error(`Unsupported query type ${q.queryType}`);
    }
  }

  /**
   * Entities of a query, paged by offset up to the query's limit (CIM 009 5.5.9). `pick` keeps only those
   * members (4.21), for lookups that need no values. A long id list goes out in chunks of ID_CHUNK.
   */
  async fetchEntities(
    q: NgsildQuery,
    signal?: AbortSignal,
    pick?: string[]
  ): Promise<{ entities: Entity[]; notices: QueryResultMetaNotice[] }> {
    const limit = q.limit && q.limit > 0 ? q.limit : DEFAULT_LIMIT;
    const limitNotice: QueryResultMetaNotice = {
      severity: 'info',
      text: `Showing the first ${limit} entities; raise the query limit for more.`,
    };
    const ids = splitList(q.entityId);
    if (ids.length > ID_CHUNK) {
      const entities: Entity[] = [];
      for (let i = 0; i < ids.length && entities.length < limit; i += ID_CHUNK) {
        const chunk = { ...q, entityId: ids.slice(i, i + ID_CHUNK).join(','), limit: limit - entities.length };
        entities.push(...(await this.fetchEntities(chunk, signal, pick)).entities);
      }
      return { entities, notices: entities.length >= limit ? [limitNotice] : [] };
    }
    // a temporal query reads current values here; Geo keeps its type, which adds the geoproperty to attrs
    const queryType = q.queryType === NgsildQueryType.TEMPORAL ? NgsildQueryType.ENTITY : q.queryType;
    const req = buildRequest({ ...q, queryType }, { pageSize: Math.min(this.pageSize, limit) });
    // Antares refuses pick together with attrs; pick already names the attributes
    const params = pick ? withParam(withParam(req.params, 'attrs', undefined), 'pick', pick.join(',')) : req.params;
    const entities: Entity[] = [];
    let total: number | undefined;
    for (;;) {
      const want = Math.min(this.pageSize, limit - entities.length);
      let p = withParam(params, 'limit', String(want));
      // the first page counts the matches (4.13), so the limit notice only shows when more exist
      p = entities.length > 0 ? withParam(p, 'offset', String(entities.length)) : withParam(p, 'count', 'true');
      const res = await this.get(req.path, p, signal);
      total ??= resultsCount(res);
      const page = asArray(res.data);
      entities.push(...page);
      if (entities.length >= limit) {
        return { entities, notices: (total ?? Infinity) > limit ? [limitNotice] : [] };
      }
      // a short page ends the list, unless the broker counted more: then it served fewer than asked
      const more = total !== undefined ? entities.length < total : page.length === want;
      if (page.length === 0 || !more) {
        return { entities, notices: [] };
      }
    }
  }

  private async runTemporal(
    q: NgsildQuery,
    from?: number,
    to?: number,
    intervalMs?: number,
    signal?: AbortSignal,
    toFrames: (series: Iterable<Series>, q: NgsildQuery, names: Map<string, unknown>) => DataFrame[] = seriesToFrames
  ): Promise<DataFrame[]> {
    const limit = q.limit && q.limit > 0 ? q.limit : DEFAULT_LIMIT;
    const { path, params } = buildRequest(q, { from, to, intervalMs, pageSize: Math.min(this.pageSize, limit) });
    const run: TemporalRun = {
      path,
      timeProperty: q.timeProperty || 'observedAt',
      backwards: !!(q.lastN && q.lastN > 0),
      lastN: q.lastN,
      skip: nameFromAttribute(q) && q.namePattern !== NamePattern.ATTRIBUTE ? [q.entityName!] : [],
      series: new Map(),
      names: new Map(),
      q,
      requests: 0,
      notices: [],
      signal,
    };
    // entities are paged by offset over the original window (CIM 009 5.5.9), each page's
    // instances by 206 continuation pinned to that page's entity ids; a long id list in chunks
    const ids = splitList(q.entityId);
    const idChunks = ids.length > ID_CHUNK ? chunks(ids, ID_CHUNK) : [undefined];
    let total = 0;
    for (const idChunk of idChunks) {
      const base = idChunk ? withParam(params, 'id', idChunk.join(',')) : params;
      for (let offset = 0; total < limit && !run.truncated;) {
        const want = Math.min(this.pageSize, limit - total);
        const page = withParam(
          withParam(base, 'limit', String(want)),
          offset > 0 ? 'offset' : 'count',
          offset > 0 ? String(offset) : idChunk ? undefined : 'true'
        );
        const count = await this.collectPage(page, run);
        total += count;
        // a counted query pages by position: a broker may leave entities without instances in the range
        // out of a page, so a short page ends the list only when nothing is counted after it
        offset += run.total !== undefined ? want : count;
        if (run.total !== undefined ? offset >= run.total : count < want) {
          break;
        }
      }
      if (total >= limit || run.truncated) {
        break;
      }
    }
    if (total >= limit && (run.total ?? Infinity) > limit) {
      run.notices.push({
        severity: 'info',
        text: `Showing the first ${limit} entities; raise the query limit for more.`,
      });
    }
    if (run.backwards) {
      run.series.forEach((s) => {
        const keep = [...s.points.keys()].sort((a, b) => b - a).slice(0, q.lastN);
        s.points = new Map(keep.map((t) => [t, s.points.get(t)]));
      });
    }
    if (run.series.size === 0 && !run.truncated) {
      // a broker may leave out entities without instances in the range, so only an unknown type is certain
      run.notices.push(
        (total === 0 ? await this.unknownTypeNotice(q) : undefined) ?? {
          severity: 'info',
          text: `No instances with ${run.timeProperty} in this time range.`,
        }
      );
    }
    await this.fillFromCurrent(run).catch(() => undefined); // units and names are cosmetic; never fail the query on them
    return withNotices(capFrames(toFrames(run.series.values(), q, run.names), run.notices), run.notices, q.refId);
  }

  /**
   * collectHistory, except that a failure after the query's first request ends the run with a warning and
   * keeps what arrived: one failed page of many should not empty the panel.
   */
  private async collectPage(params: Array<[string, string]>, run: TemporalRun): Promise<number> {
    const first = run.requests === 0;
    try {
      return await this.collectHistory(params, run);
    } catch (err) {
      if (first || run.signal?.aborted) {
        throw err;
      }
      run.truncated = true;
      run.notices.push({
        severity: 'warning',
        text: `Temporal result incomplete: request ${run.requests} failed (${errorMessage(err)}). Showing what arrived before.`,
      });
      return 0;
    }
  }

  /** One temporal request and, after a 206, its continuations; returns the entities of the first answer. */
  private async collectHistory(params: Array<[string, string]>, run: TemporalRun): Promise<number> {
    run.requests++;
    const res = await this.get(run.path, params, run.signal);
    if (run.requests === 1) {
      run.total = resultsCount(res);
    }
    const data = asArray(res.data);
    const added = collectSeries(data, run.series, run.skip, run.q.lang?.trim(), run.timeProperty === 'deletedAt');
    temporalNames(data, run.q).forEach((v, k) => run.names.set(k, v));
    if (res.status !== 206 || run.truncated) {
      return data.length;
    }
    const cut = pageCut(data, run.backwards);
    if (!cut || added === 0) {
      // nothing timed to continue from, or the broker repeats the page: stop instead of looping
      run.notices.push({
        severity: 'warning',
        text: 'The broker returned a partial temporal result that cannot be continued; some instances are missing.',
      });
      return data.length;
    }
    const open = run.backwards
      ? cut.ids.filter((id) => [...run.series.values()].some((s) => s.entityId === id && s.points.size < run.lastN!))
      : cut.ids;
    const next = nextTemporalPage(params, cut.boundary, run.backwards);
    for (let i = 0; i < open.length && !run.truncated; i += ID_CHUNK) {
      if (run.requests >= this.maxTemporalPages) {
        run.truncated = true;
        run.notices.push({
          severity: 'warning',
          text: `Temporal result cut after ${run.requests} requests (at ${cut.boundary}). Narrow the time range, use aggregation, or raise "Max temporal pages".`,
        });
        break;
      }
      const chunk = open.slice(i, i + ID_CHUNK);
      let p = withParam(withParam(next, 'id', chunk.join(',')), 'limit', String(chunk.length));
      p = withParam(p, 'offset', undefined); // type stays: an id alone is a local-only query (5.7.2.4)
      await this.collectPage(p, run);
    }
    return data.length;
  }

  /**
   * Units and entity names from the current entities: the simplified and aggregated temporal forms carry
   * no unitCode, and a name attribute (often a LanguageProperty) rarely has history in the time range.
   */
  private async fillFromCurrent(run: TemporalRun): Promise<void> {
    const missing = [...run.series.values()].filter((s) => !s.unitCode);
    const nameAttr = run.skip[0];
    const unnamed = nameAttr
      ? [...new Set([...run.series.values()].map((s) => s.entityId))].filter((id) => !run.names.has(id))
      : [];
    const ids = [...new Set([...missing.map((s) => s.entityId), ...unnamed])];
    if (ids.length === 0) {
      return;
    }
    const attrs = [...new Set([...missing.map((s) => s.attr), ...(unnamed.length > 0 ? [nameAttr] : [])])].join(',');
    const lang = run.q.lang?.trim();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const res = await this.get(
        '/entities',
        [
          ['id', chunk.join(',')],
          ['attrs', attrs],
          ...(lang ? [['lang', lang] as [string, string]] : []),
          ['limit', String(chunk.length)],
        ],
        run.signal
      );
      for (const e of asArray(res.data)) {
        if (nameAttr && unnamed.includes(e.id)) {
          const name = getValue(instances(e[nameAttr])[0], lang);
          if (name !== undefined && name !== null && name !== '') {
            run.names.set(e.id, name);
          }
        }
        for (const attr of attributeNames(e)) {
          for (const inst of instances(e[attr])) {
            const unit = (inst as any)?.unitCode;
            missing
              .filter((s) => s.entityId === e.id && s.attr === attr && s.datasetId === datasetIdOf(inst))
              .forEach((s) => (s.unitCode = unit));
          }
        }
      }
    }
  }

  private async runNodeGraph(q: NgsildQuery, signal?: AbortSignal): Promise<DataFrame[]> {
    const { entities, notices } = await this.fetchEntities(nodeGraphQuery(q), signal);
    if (entities.length === 0) {
      notices.push(await this.noEntitiesNotice(q));
    }
    const all = await resolveRelated(
      entities,
      (ids) => this.entitiesById(ids, signal),
      q.graphDepth ?? DEFAULT_GRAPH_DEPTH,
      MAX_NODES
    );
    if (all.length >= MAX_NODES) {
      notices.push({
        severity: 'warning',
        text: `The graph stops at ${MAX_NODES} nodes; lower the depth or narrow the query.`,
      });
    }
    return withNotices(toNodeGraph(all, q), notices, q.refId);
  }

  /** Why a query found no entities: a type the broker does not know, or nothing matching. */
  private async noEntitiesNotice(q: NgsildQuery): Promise<QueryResultMetaNotice> {
    return (await this.unknownTypeNotice(q)) ?? { severity: 'info', text: 'No entities match this query.' };
  }

  private async unknownTypeNotice(q: NgsildQuery): Promise<QueryResultMetaNotice | undefined> {
    const asked = splitList(q.entityType);
    const known = asked.length > 0 ? (await this.getTypes().catch(() => [])).map((t) => t.typeName) : [];
    const unknown = known.length > 0 ? asked.filter((t) => !known.includes(t)) : [];
    return unknown.length > 0
      ? {
          severity: 'warning',
          text: `The broker has no entities of type ${unknown.join(', ')}. Known types: ${known.join(', ')}.`,
        }
      : undefined;
  }

  /** Entities by id, types unknown (relationship targets); CIM 009 5.7.2.4 allows that only as a local query. */
  async entitiesById(ids: string[], signal?: AbortSignal): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const chunk of chunks(ids, ID_CHUNK)) {
      const res = await this.get(
        '/entities',
        [
          ['id', chunk.join(',')],
          ['local', 'true'],
          ['limit', String(chunk.length)],
        ],
        signal
      );
      out.push(...asArray(res.data));
    }
    return out;
  }

  /** Entity types with their attribute names (GET /types?details=true, CIM 009 5.7.6), reused for CACHE_MS. */
  getTypes(): Promise<EntityType[]> {
    return this.cached('types', () => this.loadTypes());
  }

  private async loadTypes(): Promise<EntityType[]> {
    const data = (await this.get('/types', [['details', 'true']])).data;
    const list: any[] = Array.isArray(data) ? data : (data?.typeList ?? (data ? [data] : []));
    return list
      .map((t) =>
        typeof t === 'string' ? { typeName: t, attributeNames: [] } : { ...t, typeName: t.typeName ?? t.id }
      )
      .filter((t) => t.typeName);
  }

  /** Attribute names known to the broker (GET /attributes, CIM 009 5.7.8), reused for CACHE_MS. */
  getAttributeNames(): Promise<string[]> {
    return this.cached('attributes', async () => {
      const data = (await this.get('/attributes')).data;
      const list: any[] = Array.isArray(data) ? data : (data?.attributeList ?? []);
      return list.map((a) => (typeof a === 'string' ? a : (a.attributeName ?? a.id))).filter(Boolean);
    });
  }

  /**
   * Variable queries:
   *   types()                      entity types
   *   attributes() | attributes(T) attribute names, of all or of type T
   *   entities(T[, nameAttr])      entity ids (text: the name attribute or the short id)
   *   values(T, attr)              distinct current values of attr
   */
  async metricFindQuery(query: string, options?: { scopedVars?: ScopedVars }): Promise<MetricFindValue[]> {
    const m = (query ?? '').trim().match(/^(\w+)\s*(?:\((.*)\))?$/s);
    if (!m) {
      throw new Error(
        `Invalid variable query "${query}". Use types(), attributes(Type), entities(Type, nameAttr) or values(Type, attr).`
      );
    }
    // split before interpolating: a multi-value $type becomes "A,B", one type list, not two arguments
    const [type, second] = (m[2] ?? '')
      .split(',')
      .map((s) => this.templateSrv.replace(s.trim().replace(/^["']|["']$/g, ''), options?.scopedVars, 'csv'));
    const uniq = (values: string[]) =>
      [...new Set(values)]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((v) => ({ text: v, value: v }));
    switch (m[1].toLowerCase()) {
      case 'types':
        return uniq((await this.getTypes()).map((t) => t.typeName));
      case 'attributes':
        if (type) {
          const t = (await this.getTypes()).find((x) => x.typeName === type || x.id === type);
          return uniq(t?.attributeNames ?? []);
        }
        return uniq(await this.getAttributeNames());
      case 'entities': {
        const q: NgsildQuery = {
          refId: 'var',
          entityType: type,
          entityName: second || 'id_short',
          attributes: second ? [second] : [],
          limit: MAX_VARIABLE_ENTITIES,
        };
        const { entities } = await this.fetchEntities(q, undefined, ['id', ...(second ? [second] : [])]);
        return entities.map((e) => ({ text: entityLabel(e, q), value: e.id }));
      }
      case 'values': {
        if (!type || !second) {
          throw new Error('values(Type, attribute) needs a type and an attribute');
        }
        const { entities } = await this.fetchEntities(
          { refId: 'var', entityType: type, attributes: [second], limit: MAX_VARIABLE_ENTITIES },
          undefined,
          ['id', second]
        );
        return uniq(
          entities
            .flatMap((e) => instances(e[second]).map((i) => getValue(i)))
            .filter((v) => v !== undefined && v !== null)
            .map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))
        );
      }
      default:
        throw new Error(`Unknown variable query function "${m[1]}"`);
    }
  }

  /** Why the health check failed, in terms of the settings to change. */
  private healthError(err: unknown): string {
    const message = err instanceof Error ? err.message : errorMessage(err);
    const status = err instanceof BrokerError ? err.status : undefined;
    // Grafana's proxy answers an upstream 401 as 400 with this text, so a broker cannot sign the user out
    if (status === 401 || status === 403 || /Authentication to data source failed/.test(message)) {
      return `The NGSI-LD API refused the credentials (${message}). Check the authentication settings.`;
    }
    if (this.settings.oauthPassThru && status === 500) {
      return `Forward OAuth identity needs a Grafana sign-in through the identity provider the broker trusts (${message}).`;
    }
    return `Cannot reach the NGSI-LD API (${message}). Check the broker URL.`;
  }

  async testDatasource(): Promise<TestDataSourceResponse> {
    let types: EntityType[];
    try {
      types = await this.loadTypes(); // never the cached answer: the settings may have just changed
    } catch (err) {
      return { status: 'error', message: this.healthError(err) };
    }
    const tenant = this.headers['NGSILD-Tenant'];
    let message = `NGSI-LD broker reachable${tenant ? ` (tenant ${tenant})` : ''}: ${types.length} entity type(s).`;
    if (types.length > 0) {
      try {
        await this.get('/temporal/entities', [
          ['type', types[0].typeName],
          ['timerel', 'before'],
          ['timeAt', new Date().toISOString()],
          ['lastN', '1'],
          ['limit', '1'],
        ]);
        message += ' Temporal API available.';
      } catch (err) {
        message += ` Temporal API not available (${errorMessage(err)}).`;
      }
      try {
        await this.get('/entities', [
          ['type', types[0].typeName],
          ['pick', 'id'],
          ['limit', String(this.pageSize)],
        ]);
      } catch (err) {
        if (/limit/i.test(errorMessage(err))) {
          return {
            status: 'error',
            message: `The broker refuses Page size ${this.pageSize} (${errorMessage(err)}). Lower Page size.`,
          };
        }
      }
    }
    return { status: 'success', message };
  }
}

/** Parameters of the next temporal page after a 206 whose served range ended at `end`. */
export function nextTemporalPage(
  params: Array<[string, string]>,
  end: string,
  backwards: boolean
): Array<[string, string]> {
  const get = (k: string) => params.find(([key]) => key === k)?.[1];
  const timerel = get('timerel');
  const timeAt = get('timeAt');
  let p = params;
  if (!backwards) {
    // forwards (4.11: between/after include timeAt; the boundary instant is de-duplicated)
    if (timerel === 'before') {
      p = withParam(withParam(withParam(p, 'timerel', 'between'), 'timeAt', end), 'endTimeAt', timeAt);
    } else {
      p = withParam(withParam(p, 'timerel', timerel === 'between' ? 'between' : 'after'), 'timeAt', end);
    }
  } else if (timerel === 'between') {
    p = withParam(p, 'endTimeAt', end); // endTimeAt is exclusive
  } else if (timerel === 'after') {
    p = withParam(withParam(p, 'timerel', 'between'), 'endTimeAt', end);
  } else {
    p = withParam(withParam(p, 'timerel', 'before'), 'timeAt', end); // before is exclusive
  }
  return p;
}

/** State of one temporal query across its requests. */
interface TemporalRun {
  path: string;
  timeProperty: TemporalPropertyKey;
  backwards: boolean;
  lastN?: number;
  skip: string[];
  series: Map<string, Series>;
  names: Map<string, unknown>;
  q: NgsildQuery;
  requests: number;
  /** entities matching the query (NGSILD-Results-Count of the first page), when the broker counts */
  total?: number;
  /** set when the request budget ran out or a later request failed */
  truncated?: boolean;
  notices: QueryResultMetaNotice[];
  signal?: AbortSignal;
}

/** NGSILD-Results-Count of an answer to count=true (6.3.13), when the broker sent it. */
function resultsCount(res: FetchResponse<unknown>): number | undefined {
  const n = Number((res.headers as Headers | undefined)?.get?.('NGSILD-Results-Count') ?? NaN);
  return Number.isFinite(n) ? n : undefined;
}

/** A Geo query with Location: Trail as the temporal query of its location attribute. */
export function trailQuery(q: NgsildQuery): NgsildQuery {
  return {
    ...q,
    queryType: NgsildQueryType.TEMPORAL,
    attributes: [q.geoproperty || 'location'],
    aggrMethod: undefined,
    aggrPeriodDuration: undefined,
  };
}

/**
 * A node graph query as sent: attrs would drop the relationships, and with them the edges, so it stays
 * only as the sole selector (with the stat attributes).
 */
export function nodeGraphQuery(q: NgsildQuery): NgsildQuery {
  const stats = [q.primaryNodeAttributes, q.secondaryNodeAttributes, q.arcColorNodeAttributes].flatMap((r) =>
    Object.values(r ?? {}).flat()
  );
  const selector = q.entityType || q.entityId || q.idPattern || q.customQuery;
  const attributes = !selector && q.attributes?.length ? [...new Set([...q.attributes, ...stats])] : undefined;
  return { ...q, attributes };
}

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** The first MAX_FRAMES frames, with a notice when there were more. */
function capFrames(frames: DataFrame[], notices: QueryResultMetaNotice[]): DataFrame[] {
  if (frames.length <= MAX_FRAMES) {
    return frames;
  }
  notices.push({
    severity: 'warning',
    text: `Showing ${MAX_FRAMES} of ${frames.length} series; select attributes or lower the limit.`,
  });
  return frames.slice(0, MAX_FRAMES);
}

/** Notices on the first frame; without frames on an empty one, so the panel shows why it has no data. */
function withNotices(frames: DataFrame[], notices: QueryResultMetaNotice[], refId: string): DataFrame[] {
  if (notices.length === 0) {
    return frames;
  }
  if (frames.length === 0) {
    return [createDataFrame({ refId, fields: [], meta: { notices } })];
  }
  frames[0].meta = { ...frames[0].meta, notices: [...(frames[0].meta?.notices ?? []), ...notices] };
  return frames;
}
