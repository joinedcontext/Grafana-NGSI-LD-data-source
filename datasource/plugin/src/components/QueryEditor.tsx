import React, { useEffect, useId, useState } from 'react';
import { QueryEditorProps, SelectableValue } from '@grafana/data';
import {
  Button,
  ColorPicker,
  InlineField,
  InlineFieldRow,
  InlineSwitch,
  Input,
  MultiSelect,
  RadioButtonGroup,
  Select,
  Stack,
  Text,
} from '@grafana/ui';

import { NgsildDataSource } from '../datasource';
import {
  AGGREGATION_METHODS,
  AUTO_PERIOD,
  DEFAULT_QUERY,
  EntityFormat,
  GeoLocation,
  NamePattern,
  namePatternFromValue,
  NgsildQuery,
  NgsildQueryType,
  NgsildSourceOptions,
  queryTypeForValue,
  TemporalPropertyKey,
} from '../types';
import { EntityType } from '../ngsildTypes';
import { hasSelector, isIsoDuration, splitList, toQueryString } from '../request';
import { shortId } from '../frames';

type Props = QueryEditorProps<NgsildDataSource, NgsildQuery, NgsildSourceOptions>;

const LW = 20; // label width: fits "Time property" and "System attributes" with their info icon
const QUERY_TYPES = [
  { value: NgsildQueryType.TEMPORAL, label: 'Temporal', description: 'History of attribute values (time series)' },
  { value: NgsildQueryType.ENTITY, label: 'Current value', description: 'Current attribute values' },
  { value: NgsildQueryType.GEO, label: 'Geo', description: 'Entity locations for the geomap panel' },
  { value: NgsildQueryType.NODE_GRAPH, label: 'Node graph', description: 'Entities and their relationships' },
];
const NAME_PATTERNS = [
  { value: NamePattern.ENTITY_PLUS_ATTRIBUTE, label: 'Entity:attribute' },
  { value: NamePattern.ENTITY_NAME, label: 'Entity' },
  { value: NamePattern.ATTRIBUTE, label: 'Attribute' },
];
const TIME_PROPERTIES: Array<SelectableValue<TemporalPropertyKey>> = (
  ['observedAt', 'createdAt', 'modifiedAt', 'deletedAt'] as const
).map((v) => ({ value: v, label: v }));
const PERIODS = [
  { value: AUTO_PERIOD, label: 'auto', description: 'Panel interval ($__interval)' },
  { value: '', label: 'whole range', description: 'One bucket for the whole time range' },
  ...['PT1M', 'PT5M', 'PT15M', 'PT1H', 'PT6H', 'P1D', 'P7D', 'P1M'].map((v) => ({ value: v, label: v })),
];
const GEORELS = ['near', 'within', 'contains', 'intersects', 'overlaps', 'disjoint', 'equals'].map((v) => ({
  value: v,
  label: v,
}));
const GEOMETRIES = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'].map((v) => ({
  value: v,
  label: v,
}));
const GEOPROPERTIES = ['location', 'observationSpace', 'operationSpace'].map((v) => ({ value: v, label: v }));
// representation of current values (format, CIM 009 6.3.7); '' = normalized
const REPRESENTATIONS = [
  { value: '', label: 'Normalized', description: 'Every attribute with its type, unit and timestamps' },
  { value: 'concise', label: 'Concise', description: 'Lossless, shorter' },
  { value: 'keyValues', label: 'keyValues', description: 'Plain values: no units, no timestamps' },
];

const toOptions = (values: string[]): Array<SelectableValue<string>> => values.map((v) => ({ value: v, label: v }));
const joined = (v: Array<SelectableValue<string>>) =>
  v
    .map((o) => o.value!)
    .filter(Boolean)
    .join(',');

/** GeoJSON coordinates as the editor accepts them: a JSON array, or a template variable. */
export const coordinatesValid = (c?: string): boolean => {
  if (!c?.trim() || c.includes('$')) {
    return true; // empty: nothing is sent yet; a variable is checked by the broker
  }
  try {
    return Array.isArray(JSON.parse(c));
  } catch {
    return false;
  }
};

/** near;maxDistance==2000 → ['maxDistance', 2000] */
export function parseNear(georel?: string): [string, number] {
  const m = georel?.match(/^near;\s*(maxDistance|minDistance)\s*==\s*([\d.]+)/i);
  return m
    ? [m[1].toLowerCase() === 'mindistance' ? 'minDistance' : 'maxDistance', parseFloat(m[2])]
    : ['maxDistance', 1000];
}

type Errors = React.Dispatch<React.SetStateAction<Record<string, string>>>;

const clearError = (what: string) => (errors: Record<string, string>) => {
  const { [what]: _, ...rest } = errors;
  return rest;
};

/**
 * Sets a lookup's result, or `empty` and the reason it failed (shown under the editor). The returned
 * function drops a late answer, so a slow lookup for a previous type cannot overwrite the current one.
 */
function lookup<T>(what: string, request: Promise<T>, set: (v: T) => void, empty: T, setErrors: Errors): () => void {
  let current = true;
  request.then(
    (v) => {
      if (!current) {
        return;
      }
      set(v);
      setErrors(clearError(what));
    },
    (err) => {
      if (!current) {
        return;
      }
      set(empty);
      setErrors((e) => ({
        ...e,
        [what]: `Could not load ${what}: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  );
  return () => {
    current = false;
  };
}

/** Settings outside the main rows; the collapsed Options button lists the ones that are set. */
const optionSummary = (q: NgsildQuery, queryType: NgsildQueryType): string =>
  [
    q.idPattern && `id pattern ${q.idPattern}`,
    q.limit && `limit ${q.limit}`,
    q.customQuery && `q ${q.customQuery}`,
    q.scopeQuery && `scope ${q.scopeQuery}`,
    q.lang && `lang ${q.lang}`,
    q.entityName && `name ${q.entityName}`,
    queryType === NgsildQueryType.TEMPORAL && q.timeProperty && q.timeProperty !== 'observedAt' && q.timeProperty,
    queryType === NgsildQueryType.TEMPORAL && q.lastN && `last ${q.lastN}`,
    queryType === NgsildQueryType.ENTITY && q.ngsildOptions?.length && q.ngsildOptions.join(', '),
    q.georel && `geo ${q.georel.split(';')[0]}`,
  ]
    .filter(Boolean)
    .join(' · ');

export function QueryEditor({ query, datasource, onChange, onRunQuery, range, data }: Props) {
  const q: NgsildQuery = { ...DEFAULT_QUERY, ...query };
  const queryType = queryTypeForValue(q.queryType) ?? NgsildQueryType.TEMPORAL;
  const [types, setTypes] = useState<EntityType[]>([]);
  const [allAttributes, setAllAttributes] = useState<string[]>([]);
  // entity ids of the type they were loaded for; ids of another type are stale
  const [loadedIds, setLoadedIds] = useState<{ type: string; ids: string[] }>({ type: '', ids: [] });
  // why a lookup failed (auth, tenant, URL); empty dropdowns alone look like an empty broker
  const [lookupErrors, setLookupErrors] = useState<Record<string, string>>({});

  const summary = optionSummary(q, queryType);
  const [optionsOpen, setOptionsOpen] = useState(!!summary);
  const uid = useId();

  useEffect(() => {
    const cancelTypes = lookup('entity types', datasource.getTypes(), setTypes, [], setLookupErrors);
    const cancelAttrs = lookup('attributes', datasource.getAttributeNames(), setAllAttributes, [], setLookupErrors);
    return () => {
      cancelTypes();
      cancelAttrs();
    };
  }, [datasource]);

  const typeKey = q.entityType ?? '';
  useEffect(() => {
    if (!typeKey || typeKey.includes('$')) {
      return;
    }
    const ids = datasource
      .fetchEntities(
        { refId: 'editor', queryType: NgsildQueryType.ENTITY, entityType: typeKey, limit: 100 },
        undefined,
        ['id']
      )
      .then(({ entities }) => ({ type: typeKey, ids: entities.map((e) => e.id) }));
    return lookup('entity ids', ids, setLoadedIds, { type: typeKey, ids: [] }, setLookupErrors);
  }, [datasource, typeKey]);
  const entityIds = loadedIds.type === typeKey ? loadedIds.ids : [];

  const selectedTypes = splitList(typeKey);
  // a typo in a custom type returns nothing; say so before the query runs
  const unknownTypes =
    types.length > 0 ? selectedTypes.filter((t) => !t.includes('$') && !types.some((x) => x.typeName === t)) : [];
  const ofType = types.filter((t) => selectedTypes.includes(t.typeName)).flatMap((t) => t.attributeNames ?? []);
  const attributeOptions = toOptions([...new Set(ofType.length > 0 ? ofType : allAttributes)].sort());

  const update = (patch: Partial<NgsildQuery>, run = true) => {
    onChange({ ...q, ...patch });
    if (run) {
      onRunQuery();
    }
  };
  const textField = (key: keyof NgsildQuery, placeholder: string, width = 40) => (
    <Input
      id={`ngsild-${String(key)}-${q.refId}`}
      width={width}
      placeholder={placeholder}
      value={(q[key] as string | undefined) ?? ''}
      onChange={(e) => update({ [key]: e.currentTarget.value }, false)}
      onBlur={() => onRunQuery()}
    />
  );
  const numberField = (key: 'limit' | 'lastN' | 'graphDepth', placeholder: string) => (
    <Input
      id={`ngsild-${key}-${q.refId}`}
      type="number"
      min={1}
      width={12}
      placeholder={placeholder}
      value={q[key] ?? ''}
      onChange={(e) => {
        const n = parseInt(e.currentTarget.value, 10);
        update({ [key]: Number.isFinite(n) && n > 0 ? n : undefined }, false);
      }}
      onBlur={() => onRunQuery()}
    />
  );

  const namePattern = namePatternFromValue(q.namePattern);
  const entityName = q.entityName || (q.useLongEntityName ? 'id' : 'id_short');
  const nameOptions = [
    { value: 'id_short', label: 'id (short)' },
    { value: 'id', label: 'id' },
    ...attributeOptions.filter((o) => o.value !== 'id'),
  ];
  const methods = splitList(q.aggrMethod);
  const period = q.aggrPeriodDuration ?? '';
  const periodInvalid = !!period && period !== AUTO_PERIOD && !period.includes('$') && !isIsoDuration(period);
  const [nearKind, nearDistance] = parseNear(q.georel);
  const georelBase = q.georel?.split(';')[0] || '';
  // the text while typing, so clearing the box does not turn into 0 m
  const [distanceDraft, setDistanceDraft] = useState<string>();
  // an id lookup error is about a literal type; it does not apply once the type is empty or a variable
  const errors = Object.entries(lookupErrors)
    .filter(([what]) => what !== 'entity ids' || (typeKey && !typeKey.includes('$')))
    .map(([, message]) => message);

  const ready = hasSelector(q);
  const r = ready
    ? datasource.previewRequest(q, range?.from.valueOf(), range?.to.valueOf(), data?.request?.intervalMs)
    : undefined;
  const preview = r && `GET /ngsi-ld/v1${r.path}?${decodeURIComponent(toQueryString(r.params))}`;
  const representation = q.ngsildOptions?.find((o) => o === 'keyValues' || o === 'concise') ?? '';
  const sysAttrs = !!q.ngsildOptions?.includes('sysAttrs');
  const setOptions = (rep: string, sys: boolean) =>
    update({ ngsildOptions: [rep, sys ? 'sysAttrs' : ''].filter(Boolean) });
  const tableFormat = queryType === NgsildQueryType.ENTITY && q.format === 'table';

  const entityNameField = (
    <InlineField label="Entity name" labelWidth={LW} tooltip="Short id, full id, or the attribute holding the name">
      <Select
        inputId={`ngsild-entity-name-${q.refId}`}
        width={24}
        allowCustomValue
        options={nameOptions}
        value={{ value: entityName, label: nameOptions.find((o) => o.value === entityName)?.label ?? entityName }}
        onChange={(v) => update({ entityName: v.value })}
      />
    </InlineField>
  );
  const colorField = (label: string, key: 'primaryArcColor' | 'secondaryArcColor', fallback: string) => {
    const color = q[key] || fallback;
    return (
      <InlineField label={label} labelWidth={LW}>
        <ColorPicker color={color} onChange={(c) => update({ [key]: c })}>
          {({ ref, showColorPicker, hideColorPicker }) => (
            <Button
              ref={ref}
              variant="secondary"
              aria-label={`${label}: ${color}`}
              onClick={showColorPicker}
              onMouseLeave={hideColorPicker}
            >
              <span style={{ display: 'inline-block', width: 16, height: 16, borderRadius: 2, background: color }} />
            </Button>
          )}
        </ColorPicker>
      </InlineField>
    );
  };

  const graphAttrs = (
    key: 'primaryNodeAttributes' | 'secondaryNodeAttributes' | 'arcColorNodeAttributes',
    label: string,
    tooltip: string
  ) => (
    <InlineField label={label} labelWidth={LW} tooltip={tooltip}>
      <MultiSelect
        inputId={`ngsild-${key}-${q.refId}`}
        width={40}
        allowCustomValue
        options={attributeOptions}
        value={q[key]?.[''] ?? []}
        onChange={(v) => {
          const list = v.map((o) => o.value!).filter(Boolean);
          update({ [key]: list.length > 0 ? { ...(q[key] ?? {}), '': list } : undefined });
        }}
      />
    </InlineField>
  );

  return (
    <Stack direction="column" gap={0}>
      <InlineFieldRow>
        <InlineField label="Query type" labelWidth={LW}>
          <RadioButtonGroup
            aria-label="Query type"
            options={QUERY_TYPES}
            value={queryType}
            onChange={(v) => update({ queryType: v })}
          />
        </InlineField>
      </InlineFieldRow>

      <InlineFieldRow>
        <InlineField
          label="Entity type"
          labelWidth={LW}
          tooltip="One or more types, comma separated; template variables allowed"
          invalid={unknownTypes.length > 0}
          error={`Unknown to the broker: ${unknownTypes.join(', ')}`}
        >
          <MultiSelect
            inputId={`ngsild-type-${q.refId}`}
            width={30}
            allowCustomValue
            options={types.map((t) => ({ value: t.typeName, label: shortId(t.typeName), description: t.typeName }))}
            value={toOptions(splitList(q.entityType))}
            // literal ids may belong to a removed type; adding a type or a template variable keeps them
            onChange={(v) => {
              const next = splitList(joined(v));
              const removed = selectedTypes.some((t) => !next.includes(t));
              update({
                entityType: joined(v),
                entityId: removed && !q.entityId?.includes('$') ? undefined : q.entityId,
              });
            }}
          />
        </InlineField>
        <InlineField label="Entity id" labelWidth={LW} tooltip="One or more ids; template variables allowed">
          <MultiSelect
            inputId={`ngsild-id-${q.refId}`}
            width={44}
            allowCustomValue
            options={toOptions(entityIds)}
            value={toOptions(splitList(q.entityId))}
            onChange={(v) => update({ entityId: joined(v) })}
          />
        </InlineField>
      </InlineFieldRow>

      <InlineFieldRow>
        <InlineField
          label="Attributes"
          labelWidth={LW}
          tooltip="attrs: only entities that have at least one of these attributes, reduced to them; empty = all"
        >
          <MultiSelect
            inputId={`ngsild-attrs-${q.refId}`}
            width={60}
            allowCustomValue
            options={attributeOptions}
            value={q.attributes ?? []}
            onChange={(v) => update({ attributes: v.map((o) => o.value!).filter(Boolean) })}
          />
        </InlineField>
      </InlineFieldRow>

      {queryType === NgsildQueryType.TEMPORAL && (
        <InlineFieldRow>
          <InlineField label="Aggregation" labelWidth={LW} tooltip="aggrMethods; empty = raw values">
            <MultiSelect
              inputId={`ngsild-aggr-${q.refId}`}
              width={30}
              options={toOptions([...AGGREGATION_METHODS])}
              value={methods}
              onChange={(v) =>
                update({
                  aggrMethod: v.map((o) => o.value).join(',') || undefined,
                  // one bucket for the whole range is a single dot; start with the panel interval
                  ...(methods.length === 0 && q.aggrPeriodDuration === undefined
                    ? { aggrPeriodDuration: AUTO_PERIOD }
                    : {}),
                })
              }
            />
          </InlineField>
          {methods.length > 0 && (
            <InlineField
              label="Period"
              labelWidth={LW}
              invalid={periodInvalid}
              error="ISO 8601 duration, e.g. PT1H"
              tooltip="aggrPeriodDuration"
            >
              <Select
                inputId={`ngsild-period-${q.refId}`}
                width={18}
                allowCustomValue
                options={PERIODS}
                value={PERIODS.find((p) => p.value === period) ?? { value: period, label: period }}
                onChange={(v) => update({ aggrPeriodDuration: v.value })}
              />
            </InlineField>
          )}
        </InlineFieldRow>
      )}

      {queryType === NgsildQueryType.ENTITY && (
        <InlineFieldRow>
          <InlineField
            label="Format"
            labelWidth={LW}
            tooltip="Time series: a frame per attribute (stat, gauge). Table: a row per entity."
          >
            <RadioButtonGroup<EntityFormat>
              aria-label="Format"
              options={[
                { value: 'timeseries', label: 'Time series' },
                { value: 'table', label: 'Table' },
              ]}
              value={q.format ?? 'timeseries'}
              onChange={(v) => update({ format: v })}
            />
          </InlineField>
        </InlineFieldRow>
      )}

      {queryType === NgsildQueryType.GEO && (
        <InlineFieldRow>
          <InlineField
            label="Location"
            labelWidth={LW}
            tooltip="Point: one marker per entity, lines and polygons at their centre. Shape: the GeoJSON geometry as it is."
          >
            <RadioButtonGroup<GeoLocation>
              aria-label="Location"
              options={[
                { value: 'point', label: 'Point' },
                { value: 'shape', label: 'Shape' },
              ]}
              value={q.geoLocation ?? 'point'}
              onChange={(v) => update({ geoLocation: v })}
            />
          </InlineField>
          {entityNameField}
        </InlineFieldRow>
      )}

      {queryType === NgsildQueryType.NODE_GRAPH && (
        <>
          <InlineFieldRow>
            {entityNameField}
            <InlineField label="Depth" labelWidth={LW} tooltip="Relationship hops to follow (default 4)">
              {numberField('graphDepth', '4')}
            </InlineField>
          </InlineFieldRow>
          <InlineFieldRow>
            {graphAttrs(
              'primaryNodeAttributes',
              'Main stat',
              'Attribute shown in the node; the first one present is used'
            )}
            {graphAttrs('secondaryNodeAttributes', 'Secondary stat', 'Attribute shown below the main stat')}
          </InlineFieldRow>
          <InlineFieldRow>
            {graphAttrs(
              'arcColorNodeAttributes',
              'Arc value',
              'Attribute with values in [0, 1] that fills the node arc'
            )}
            <InlineField label="Complement label" labelWidth={LW}>
              {textField('arcColorComplementLabel', 'rest', 16)}
            </InlineField>
            {colorField('Arc colour', 'primaryArcColor', 'green')}
            {colorField('Complement colour', 'secondaryArcColor', 'red')}
          </InlineFieldRow>
        </>
      )}

      <Stack direction="row" gap={1} alignItems="center">
        <Button
          variant="secondary"
          fill="text"
          size="sm"
          icon={optionsOpen ? 'angle-down' : 'angle-right'}
          aria-expanded={optionsOpen}
          aria-controls={`${uid}-options`}
          onClick={() => setOptionsOpen(!optionsOpen)}
        >
          Options
        </Button>
        {!optionsOpen && summary && (
          <Text variant="bodySmall" color="secondary">
            {summary}
          </Text>
        )}
      </Stack>

      {optionsOpen && (
        <div id={`${uid}-options`}>
          <InlineFieldRow>
            <InlineField label="Id pattern" labelWidth={LW} tooltip="Regular expression over entity ids (idPattern)">
              {textField('idPattern', 'urn:ngsi-ld:Sensor:.*', 24)}
            </InlineField>
            <InlineField label="Limit" labelWidth={LW} tooltip="Maximum number of entities; fetched in pages">
              {numberField('limit', '1000')}
            </InlineField>
          </InlineFieldRow>

          <InlineFieldRow>
            <InlineField
              label="Query (q)"
              labelWidth={LW}
              tooltip='NGSI-LD query language, e.g. pm10>40;address[addressLocality]=="Helsinki". Multi-value variables: ${var:doublequote}'
            >
              {textField('customQuery', 'pm10>40;isOnline==true', 44)}
            </InlineField>
            <InlineField label="Scope" labelWidth={LW} tooltip="Scope query (scopeQ), e.g. /Helsinki/# or /A,/B">
              {textField('scopeQuery', '/City/#', 20)}
            </InlineField>
            <InlineField
              label="Language"
              labelWidth={LW}
              tooltip="lang: picks the text of LanguageProperty values, e.g. fi, sv, en"
            >
              {textField('lang', 'en', 8)}
            </InlineField>
          </InlineFieldRow>

          {(queryType === NgsildQueryType.TEMPORAL || (queryType === NgsildQueryType.ENTITY && !tableFormat)) && (
            <InlineFieldRow>
              <InlineField label="Series name" labelWidth={LW}>
                <Select
                  inputId={`ngsild-name-pattern-${q.refId}`}
                  width={20}
                  options={NAME_PATTERNS}
                  value={namePattern}
                  onChange={(v) => update({ namePattern: v.value })}
                />
              </InlineField>
              {namePattern !== NamePattern.ATTRIBUTE && entityNameField}
            </InlineFieldRow>
          )}

          {queryType === NgsildQueryType.TEMPORAL && (
            <InlineFieldRow>
              <InlineField
                label="Time property"
                labelWidth={LW}
                tooltip="The time the instances are placed at; deletedAt shows 1 per deletion"
              >
                <Select
                  inputId={`ngsild-timeproperty-${q.refId}`}
                  width={16}
                  options={TIME_PROPERTIES}
                  value={q.timeProperty ?? 'observedAt'}
                  onChange={(v) => update({ timeProperty: v.value })}
                />
              </InlineField>
              <InlineField label="Last N" labelWidth={LW} tooltip="Only the newest N instances per attribute (lastN)">
                {numberField('lastN', 'all')}
              </InlineField>
            </InlineFieldRow>
          )}

          {queryType === NgsildQueryType.ENTITY && (
            <InlineFieldRow>
              <InlineField label="Representation" labelWidth={LW} tooltip="format (CIM 009 6.3.7)">
                <RadioButtonGroup
                  aria-label="Representation"
                  options={REPRESENTATIONS}
                  value={representation}
                  onChange={(v) => setOptions(v, sysAttrs)}
                />
              </InlineField>
              <InlineField label="System attributes" labelWidth={LW} tooltip="sysAttrs: createdAt and modifiedAt">
                <InlineSwitch
                  id={`ngsild-sysattrs-${q.refId}`}
                  value={sysAttrs}
                  onChange={(e) => setOptions(representation, e.currentTarget.checked)}
                />
              </InlineField>
            </InlineFieldRow>
          )}

          <InlineFieldRow>
            <InlineField label="Geo filter" labelWidth={LW} tooltip="Geo-query (georel), CIM 009 4.10">
              <Select
                inputId={`ngsild-georel-${q.refId}`}
                width={16}
                isClearable
                options={GEORELS}
                value={georelBase || null}
                onChange={(v) =>
                  update({
                    georel: !v?.value ? undefined : v.value === 'near' ? `near;${nearKind}==${nearDistance}` : v.value,
                    geometry: v?.value ? q.geometry || 'Point' : undefined,
                  })
                }
              />
            </InlineField>
            {georelBase === 'near' && (
              <InlineField label="Distance" labelWidth={LW}>
                <Stack gap={0}>
                  <Select
                    inputId={`ngsild-near-kind-${q.refId}`}
                    aria-label="Distance kind"
                    width={16}
                    options={[
                      { value: 'maxDistance', label: 'max distance' },
                      { value: 'minDistance', label: 'min distance' },
                    ]}
                    value={nearKind}
                    onChange={(v) => update({ georel: `near;${v.value}==${nearDistance}` })}
                  />
                  <Input
                    aria-label="Distance in metres"
                    type="number"
                    min={0}
                    width={12}
                    suffix="m"
                    value={distanceDraft ?? nearDistance}
                    onChange={(e) => {
                      const text = e.currentTarget.value;
                      setDistanceDraft(text);
                      const n = parseFloat(text);
                      if (n > 0) {
                        update({ georel: `near;${nearKind}==${n}` }, false);
                      }
                    }}
                    onBlur={() => {
                      setDistanceDraft(undefined);
                      onRunQuery();
                    }}
                  />
                </Stack>
              </InlineField>
            )}
            {georelBase && (
              <>
                <InlineField label="Geometry" labelWidth={LW}>
                  <Select
                    inputId={`ngsild-geometry-${q.refId}`}
                    width={16}
                    allowCustomValue
                    options={GEOMETRIES}
                    value={q.geometry || 'Point'}
                    onChange={(v) => update({ geometry: v.value })}
                  />
                </InlineField>
                <InlineField
                  label="Coordinates"
                  labelWidth={LW}
                  tooltip="GeoJSON coordinates, longitude first, e.g. [24.94,60.17]; the geo filter applies once they are set"
                  invalid={!coordinatesValid(q.coordinates)}
                  error="A JSON array, e.g. [24.94,60.17]"
                >
                  {textField('coordinates', '[24.94,60.17]', 30)}
                </InlineField>
              </>
            )}
            {(georelBase || queryType === NgsildQueryType.GEO) && (
              <InlineField label="Geo property" labelWidth={LW}>
                <Select
                  inputId={`ngsild-geoproperty-${q.refId}`}
                  width={18}
                  allowCustomValue
                  options={GEOPROPERTIES}
                  value={q.geoproperty || 'location'}
                  onChange={(v) => update({ geoproperty: v.value })}
                />
              </InlineField>
            )}
          </InlineFieldRow>
        </div>
      )}

      <div role="status">
        {errors.map((message) => (
          <Text key={message} variant="bodySmall" color="warning">
            {message}
          </Text>
        ))}
      </div>
      {preview ? (
        <Text variant="bodySmall" color="secondary">
          {/* a long URL wraps instead of widening the editor */}
          <code data-testid="ngsild-request-preview" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {preview}
          </code>
        </Text>
      ) : (
        <Text variant="bodySmall" color="secondary">
          Select an entity type, entity id or attribute (or a pattern, q or geo filter under Options) to run the query.
        </Text>
      )}
    </Stack>
  );
}
