import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export enum NgsildQueryType {
  ENTITY = 'entity',
  TEMPORAL = 'temporal',
  GEO = 'geo',
  NODE_GRAPH = 'nodegraph',
}

export const queryTypeForValue = (type?: string): NgsildQueryType | undefined => {
  switch (type?.toLowerCase()) {
    case 'entity':
    case 'entities':
      return NgsildQueryType.ENTITY;
    case 'temporal':
    case 'timseries': // misspelling stored by dashboards of the original plugin
    case 'timeseries':
      return NgsildQueryType.TEMPORAL;
    case 'geo':
      return NgsildQueryType.GEO;
    case 'graph':
    case 'nodegraph':
    case 'node_graph':
      return NgsildQueryType.NODE_GRAPH;
    default:
      return undefined;
  }
};

/** CIM 009 4.5.19: aggregation methods of the aggregated temporal representation. */
export const AGGREGATION_METHODS = [
  'totalCount',
  'distinctCount',
  'sum',
  'avg',
  'min',
  'max',
  'stddev',
  'sumsq',
] as const;
/** aggrPeriodDuration value that maps to the panel interval ($__interval). */
export const AUTO_PERIOD = 'auto';

export enum NamePattern {
  ENTITY_PLUS_ATTRIBUTE = 'entity_plus_attribute',
  ENTITY_NAME = 'entity_name',
  ATTRIBUTE = 'attribute',
}

export const namePatternFromValue = (namePattern?: string): NamePattern => {
  switch (namePattern?.toLowerCase()) {
    case 'entity_name':
      return NamePattern.ENTITY_NAME;
    case 'attribute':
      return NamePattern.ATTRIBUTE;
    default:
      return NamePattern.ENTITY_PLUS_ATTRIBUTE;
  }
};

/** Shape of the frames of an entity (current value) query. */
export type EntityFormat = 'timeseries' | 'table';

export type TemporalPropertyKey = 'observedAt' | 'createdAt' | 'modifiedAt' | 'deletedAt';

export interface NgsildQuery extends DataQuery {
  /** Comma-separated entity ids; template variables allowed. */
  entityId?: string;
  /** Regular expression over entity ids (idPattern). */
  idPattern?: string;
  attributes?: string[];
  /** Comma-separated entity types. */
  entityType?: string;
  /** See NamePattern; default entity_plus_attribute. */
  namePattern?: string;
  /** id_short (default), id, or the attribute holding the entity name, e.g. "name". */
  entityName?: string;
  /** @deprecated use entityName */
  useLongEntityName?: boolean;
  /** NGSI-LD query language (q). */
  customQuery?: string;
  /** NGSI-LD scope query (scopeQ). */
  scopeQuery?: string;
  /** Language for LanguageProperty values (lang). */
  lang?: string;

  /** Geo-query (CIM 009 4.10): georel, e.g. near;maxDistance==2000 */
  georel?: string;
  geometry?: string;
  /** Coordinates as JSON text, longitude first, e.g. [24.94,60.17] */
  coordinates?: string;
  geoproperty?: string;
  /** GEO: where the map draws an entity: its point (lines and polygons at their centre) or its shape. */
  geoLocation?: GeoLocation;

  /** TEMPORAL: the time property the range applies to; default observedAt. */
  timeProperty?: TemporalPropertyKey;
  /** TEMPORAL: comma-separated aggregation methods (aggrMethods). */
  aggrMethod?: string;
  /** TEMPORAL: ISO 8601 duration or "auto"; empty = the whole range. */
  aggrPeriodDuration?: string;
  /** TEMPORAL: only the newest N instances per attribute. */
  lastN?: number;

  /** ENTITY: one frame per attribute (timeseries, default) or one table. */
  format?: EntityFormat;

  /** NODE_GRAPH: attributes shown in the nodes; key "" = all types, other keys = entity type. */
  primaryNodeAttributes?: Record<string, string[]>;
  secondaryNodeAttributes?: Record<string, string[]>;
  /** NODE_GRAPH: attribute in [0,1] that colours the node arc. */
  arcColorNodeAttributes?: Record<string, string[]>;
  arcColorComplementLabel?: string;
  primaryArcColor?: string;
  secondaryArcColor?: string;
  /** NODE_GRAPH: how many relationship hops to follow; default 4. */
  graphDepth?: number;

  /** Extra representation options: sysAttrs, keyValues, concise. */
  ngsildOptions?: string[];
  /** Maximum number of entities (paged in steps of the broker's page limit). */
  limit?: number;
}

export type GeoLocation = 'point' | 'shape';

export const DEFAULT_QUERY: Partial<NgsildQuery> = {
  queryType: NgsildQueryType.TEMPORAL,
};

export interface NgsildSourceOptions extends DataSourceJsonData {
  /** JSON-LD @context sent as Link header; empty = core context. */
  contextUrl?: string;
  tenant?: string;
  /** "oauth" routes requests through the OAuth2 client-credentials route of plugin.json. */
  authType?: string;
  /** Header the Grafana proxy adds, value in secureJsonData.httpHeaderValue1 (API key, bearer token). */
  httpHeaderName1?: string;
  /** The Grafana proxy forwards the signed-in user's OAuth token (Grafana's "Forward OAuth Identity"). */
  oauthPassThru?: boolean;
  tokenUrl?: string;
  /** Upper bound of requests per temporal query when the broker answers 206; default 100. */
  maxTemporalPages?: number;
  /** Page size for entity queries; Antares caps it at 1000. */
  pageSize?: number;
}

export interface NgsildSecureJsonData {
  clientId?: string;
  clientSecret?: string;
}
