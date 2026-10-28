import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DataSourceInstanceSettings, dateTime, TimeRange } from '@grafana/data';
import { TemplateSrv } from '@grafana/runtime';

import { parseNear, QueryEditor } from './QueryEditor';
import { NgsildDataSource } from '../datasource';
import { NgsildQuery, NgsildQueryType, NgsildSourceOptions } from '../types';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: jest.fn() }),
  getTemplateSrv: () => ({ replace: (v: string) => v }),
}));

const RANGE = { from: dateTime(Date.UTC(2026, 0, 1)), to: dateTime(Date.UTC(2026, 0, 2)) } as TimeRange;

function makeDs() {
  const settings = {
    url: 'http://grafana/proxy',
    jsonData: {},
  } as unknown as DataSourceInstanceSettings<NgsildSourceOptions>;
  const ds = new NgsildDataSource(settings, { replace: (v?: string) => v ?? '' } as unknown as TemplateSrv);
  jest.spyOn(ds, 'getTypes').mockResolvedValue([
    { id: 'urn:t:AirQualityObserved', typeName: 'AirQualityObserved', attributeNames: ['pm10', 'name'] },
    { id: 'urn:t:Device', typeName: 'Device', attributeNames: ['battery'] },
  ]);
  jest.spyOn(ds, 'getAttributeNames').mockResolvedValue(['pm10', 'name', 'battery']);
  jest
    .spyOn(ds, 'fetchEntities')
    .mockResolvedValue({ entities: [{ id: 'urn:x:1', type: 'AirQualityObserved' }], notices: [] });
  return ds;
}

async function setup(query: Partial<NgsildQuery> = {}, ds = makeDs(), intervalMs?: number) {
  const onChange = jest.fn();
  const onRunQuery = jest.fn();
  const q = { refId: 'A', ...query } as NgsildQuery;
  const data = intervalMs ? ({ request: { intervalMs } } as any) : undefined;
  const view = render(
    <QueryEditor query={q} datasource={ds} onChange={onChange} onRunQuery={onRunQuery} range={RANGE} data={data} />
  );
  await act(async () => undefined); // let the type/attribute lookups settle
  const last = (): NgsildQuery => onChange.mock.calls.at(-1)[0];
  return { ds, onChange, onRunQuery, last, view };
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const openOptions = () => fireEvent.click(screen.getByRole('button', { name: 'Options' }));
/** Opens a Grafana Select by its input id and picks the option with `label`. */
function pick(id: string, label: string) {
  fireEvent.keyDown(input(id), { key: 'ArrowDown' });
  fireEvent.click(screen.getByText(label, { selector: 'span' }));
}

describe('parseNear', () => {
  it.each([
    [undefined, ['maxDistance', 1000]],
    ['', ['maxDistance', 1000]],
    ['within', ['maxDistance', 1000]],
    ['near;maxDistance==2000', ['maxDistance', 2000]],
    ['near; minDistance == 12.5', ['minDistance', 12.5]],
    ['near;MINDISTANCE==3', ['minDistance', 3]],
    ['near;maxDistance==', ['maxDistance', 1000]],
  ])('%j -> %j', (georel, expected) => expect(parseNear(georel)).toEqual(expected));
});

describe('QueryEditor', () => {
  it('defaults to a temporal query and previews its request', async () => {
    await setup({ entityType: 'AirQualityObserved', attributes: ['pm10'] });
    expect(screen.getByRole('radio', { name: 'Temporal' })).toBeChecked();
    expect(screen.getByTestId('ngsild-request-preview').textContent).toBe(
      'GET /ngsi-ld/v1/temporal/entities?type=AirQualityObserved&attrs=pm10&format=temporalValues' +
        '&timerel=between&timeAt=2026-01-01T00:00:00.000Z&endTimeAt=2026-01-02T00:00:00.000Z&limit=1000'
    );
  });

  it('switches the query type and runs the query', async () => {
    const { last, onRunQuery } = await setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Current value' }));
    expect(last().queryType).toBe(NgsildQueryType.ENTITY);
    expect(onRunQuery).toHaveBeenCalledTimes(1);
  });

  it('reads a legacy query type and shows its fields', async () => {
    await setup({ queryType: 'entities' });
    expect(screen.getByRole('radio', { name: 'Current value' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Table' })).toBeInTheDocument();
  });

  it('loads entity ids of the selected type, limited to 100', async () => {
    const { ds } = await setup({ entityType: 'AirQualityObserved' });
    expect(ds.fetchEntities).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'AirQualityObserved', limit: 100 }),
      undefined,
      ['id']
    );
  });

  it('offers the loaded ids only for the type they were loaded for', async () => {
    const ds = makeDs();
    const { view, onChange, onRunQuery } = await setup({ entityType: 'AirQualityObserved' }, ds);
    fireEvent.keyDown(input('ngsild-id-A'), { key: 'ArrowDown' });
    expect(screen.getByText('urn:x:1', { selector: 'span' })).toBeInTheDocument();
    view.rerender(
      <QueryEditor
        query={{ refId: 'A', entityType: '$type' }}
        datasource={ds}
        onChange={onChange}
        onRunQuery={onRunQuery}
        range={RANGE}
      />
    );
    fireEvent.keyDown(input('ngsild-id-A'), { key: 'ArrowDown' });
    expect(screen.queryByText('urn:x:1', { selector: 'span' })).toBeNull();
  });

  it('does not look up entities for a template variable or an empty type', async () => {
    const { ds } = await setup({ entityType: '$type' });
    expect(ds.fetchEntities).not.toHaveBeenCalled();
    const empty = await setup({}, makeDs());
    expect(empty.ds.fetchEntities).not.toHaveBeenCalled();
  });

  it('keeps working when the broker lookups fail', async () => {
    const ds = makeDs();
    (ds.getTypes as jest.Mock).mockRejectedValue(new Error('down'));
    (ds.getAttributeNames as jest.Mock).mockRejectedValue(new Error('down'));
    (ds.fetchEntities as jest.Mock).mockRejectedValue(new Error('down'));
    await setup({ entityType: 'AirQualityObserved' }, ds);
    expect(screen.getByRole('radio', { name: 'Temporal' })).toBeInTheDocument();
  });

  it('says why a lookup failed instead of showing empty dropdowns', async () => {
    const ds = makeDs();
    (ds.getTypes as jest.Mock).mockRejectedValue(new Error('403 Forbidden: RBAC: access denied'));
    (ds.fetchEntities as jest.Mock).mockRejectedValue(new Error('400: bad type'));
    await setup({ entityType: 'AirQualityObserved' }, ds);
    expect(screen.getByText('Could not load entity types: 403 Forbidden: RBAC: access denied')).toBeInTheDocument();
    expect(screen.getByText('Could not load entity ids: 400: bad type')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load attributes/)).toBeNull();
  });

  it('picks an entity type and keeps the selected ids', async () => {
    const { last, onRunQuery } = await setup({ entityType: 'AirQualityObserved', entityId: 'urn:x:1' });
    pick('ngsild-type-A', 'Device');
    expect(last()).toMatchObject({ entityType: 'AirQualityObserved,Device', entityId: 'urn:x:1' });
    expect(onRunQuery).toHaveBeenCalled();
  });

  it('clears literal ids when a type is removed', async () => {
    const { last } = await setup({ entityType: 'Device', entityId: 'urn:x:old' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]); // the Device chip
    expect(last()).toMatchObject({ entityType: '', entityId: undefined });
  });

  it('flags a custom entity type the broker does not know', async () => {
    await setup({ entityType: 'AirQualityObserved,NoSuchType' });
    expect(screen.getByText('Unknown to the broker: NoSuchType')).toBeInTheDocument();
  });

  it('ignores loaded ids that answer after the type changed', async () => {
    const ds = makeDs();
    let answerOld: (v: any) => void = () => undefined;
    (ds.fetchEntities as jest.Mock)
      .mockReturnValueOnce(new Promise((r) => (answerOld = r)))
      .mockResolvedValueOnce({ entities: [{ id: 'urn:device:1', type: 'Device' }], notices: [] });
    const { view, onChange, onRunQuery } = await setup({ entityType: 'AirQualityObserved' }, ds);
    view.rerender(
      <QueryEditor
        query={{ refId: 'A', entityType: 'Device' } as NgsildQuery}
        datasource={ds}
        onChange={onChange}
        onRunQuery={onRunQuery}
        range={RANGE}
      />
    );
    await act(async () => answerOld({ entities: [{ id: 'urn:x:late', type: 'AirQualityObserved' }], notices: [] }));
    fireEvent.keyDown(input('ngsild-id-A'), { key: 'ArrowDown' });
    expect(screen.getByText('urn:device:1', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('urn:x:late', { selector: 'span' })).toBeNull();
  });

  it('drops an id lookup error once the type is a variable', async () => {
    const ds = makeDs();
    (ds.fetchEntities as jest.Mock).mockRejectedValue(new Error('400: bad type'));
    const { view, onChange, onRunQuery } = await setup({ entityType: 'Bad' }, ds);
    expect(screen.getByText('Could not load entity ids: 400: bad type')).toBeInTheDocument();
    view.rerender(
      <QueryEditor
        query={{ refId: 'A', entityType: '$type' } as NgsildQuery}
        datasource={ds}
        onChange={onChange}
        onRunQuery={onRunQuery}
        range={RANGE}
      />
    );
    expect(screen.queryByText(/Could not load entity ids/)).toBeNull();
  });

  it('adds a second entity type and keeps an entity id variable', async () => {
    const { last } = await setup({ entityType: 'AirQualityObserved', entityId: '$station' });
    pick('ngsild-type-A', 'Device');
    expect(last()).toMatchObject({ entityType: 'AirQualityObserved,Device', entityId: '$station' });
  });

  it('selects several entity ids', async () => {
    const { last } = await setup({ entityType: 'AirQualityObserved', entityId: 'urn:x:0' });
    fireEvent.keyDown(input('ngsild-id-A'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByText('urn:x:1', { selector: 'span' }));
    expect(last().entityId).toBe('urn:x:0,urn:x:1');
  });

  it('offers only the attributes of the selected type', async () => {
    await setup({ entityType: 'Device' });
    fireEvent.keyDown(input('ngsild-attrs-A'), { key: 'ArrowDown' });
    expect(screen.getByText('battery', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('pm10', { selector: 'span' })).toBeNull();
  });

  it('offers every attribute when the type is unknown', async () => {
    await setup({ entityType: 'Unknown' });
    fireEvent.keyDown(input('ngsild-attrs-A'), { key: 'ArrowDown' });
    expect(screen.getByText('pm10', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('battery', { selector: 'span' })).toBeInTheDocument();
  });

  it('edits a text field without running, and runs on blur', async () => {
    const { last, onRunQuery } = await setup();
    openOptions();
    fireEvent.change(input('ngsild-customQuery-A'), { target: { value: 'pm10>40' } });
    expect(last().customQuery).toBe('pm10>40');
    expect(onRunQuery).not.toHaveBeenCalled();
    fireEvent.blur(input('ngsild-customQuery-A'));
    expect(onRunQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['25', 25],
    ['0', undefined],
    ['-3', undefined],
    ['', undefined],
  ])('limit %j is stored as %j', async (value, stored) => {
    const { last } = await setup({ limit: 5 });
    fireEvent.change(input('ngsild-limit-A'), { target: { value } });
    expect(last().limit).toBe(stored);
  });

  it('shows the period only with an aggregation method and flags an invalid duration', async () => {
    const plain = await setup();
    expect(input('ngsild-period-A')).toBeNull();
    plain.view.unmount();

    await setup({ aggrMethod: 'avg', aggrPeriodDuration: 'one hour' });
    expect(screen.getByText('ISO 8601 duration, e.g. PT1H')).toBeInTheDocument();
  });

  it('accepts a valid period, auto and a template variable', async () => {
    for (const period of ['PT1H', 'auto', '$period']) {
      const { view } = await setup({ aggrMethod: 'avg', aggrPeriodDuration: period });
      expect(screen.queryByText('ISO 8601 duration, e.g. PT1H')).toBeNull();
      view.unmount();
    }
  });

  it('starts an aggregation with the auto period, but keeps a chosen one', async () => {
    const fresh = await setup();
    pick('ngsild-aggr-A', 'avg');
    expect(fresh.last()).toMatchObject({ aggrMethod: 'avg', aggrPeriodDuration: 'auto' });
    fresh.view.unmount();
    const chosen = await setup({ aggrPeriodDuration: '' }); // "whole range", picked before
    pick('ngsild-aggr-A', 'avg');
    expect(chosen.last().aggrPeriodDuration).toBe('');
  });

  it('removes the aggregation when the last method is cleared', async () => {
    const { last } = await setup({ aggrMethod: 'avg' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(last().aggrMethod).toBeUndefined();
  });

  it('stores lastN as a positive integer', async () => {
    const { last } = await setup();
    openOptions();
    fireEvent.change(input('ngsild-lastN-A'), { target: { value: '12' } });
    expect(last().lastN).toBe(12);
  });

  it('builds a near geo filter with a default distance and Point geometry', async () => {
    const { last } = await setup();
    openOptions();
    pick('ngsild-georel-A', 'near');
    expect(last()).toMatchObject({ georel: 'near;maxDistance==1000', geometry: 'Point' });
  });

  it('edits the near distance, keeping its kind', async () => {
    const { last, onRunQuery } = await setup({ georel: 'near;minDistance==5', geometry: 'Point' });
    fireEvent.change(screen.getByLabelText('Distance in metres'), { target: { value: '250' } });
    expect(last().georel).toBe('near;minDistance==250');
    // an empty or partial number keeps the last distance instead of querying 0 m
    for (const value of ['', 'x', '0']) {
      fireEvent.change(screen.getByLabelText('Distance in metres'), { target: { value } });
      expect(last().georel).toBe('near;minDistance==250');
    }
    expect(screen.getByLabelText('Distance in metres')).toHaveValue(0); // the typed text stays
    expect(onRunQuery).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText('Distance in metres'));
    expect(onRunQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['[19.1,48.7]', false],
    ['[[[1,2],[3,4],[1,2]]]', false],
    ['$coords', false],
    ['', false],
    ['19.1,48.7', true],
    ['[19.1,', true],
    ['{"a":1}', true],
  ])('marks coordinates %j invalid: %s', async (coordinates, invalid) => {
    await setup({ georel: 'within', coordinates });
    expect(!!screen.queryByText('A JSON array, e.g. [24.94,60.17]')).toBe(invalid);
  });

  it('keeps the geometry when switching to another georel', async () => {
    const { last } = await setup({ georel: 'near;maxDistance==10', geometry: 'Polygon' });
    pick('ngsild-georel-A', 'within');
    expect(last()).toMatchObject({ georel: 'within', geometry: 'Polygon' });
  });

  it('hides geometry fields without a geo filter except the geo property of a geo query', async () => {
    const { view } = await setup();
    expect(input('ngsild-geometry-A')).toBeNull();
    expect(input('ngsild-geoproperty-A')).toBeNull();
    view.unmount();
    await setup({ queryType: NgsildQueryType.GEO });
    openOptions();
    expect(input('ngsild-geometry-A')).toBeNull();
    expect(input('ngsild-geoproperty-A')).not.toBeNull();
  });

  it('draws geo entities as points by default, or as shapes', async () => {
    const { last, view } = await setup({ queryType: NgsildQueryType.GEO });
    expect(screen.getByRole('radio', { name: 'Point' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Shape' }));
    expect(last().geoLocation).toBe('shape');
    view.unmount();
    await setup();
    expect(screen.queryByRole('radio', { name: 'Shape' })).toBeNull(); // geo queries only
  });

  it('labels every input by its visible label', async () => {
    await setup({ queryType: NgsildQueryType.NODE_GRAPH, primaryArcColor: 'blue' });
    openOptions();
    expect(screen.getByLabelText('Query (q)')).toBe(input('ngsild-customQuery-A'));
    expect(screen.getByLabelText('Depth')).toBe(input('ngsild-graphDepth-A'));
    expect(screen.queryByLabelText('customQuery')).toBeNull();
    // colour pickers say what they colour, not only the colour
    expect(screen.getByRole('button', { name: 'Arc colour: blue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complement colour: red' })).toBeInTheDocument();
  });

  it('names every radio group', async () => {
    const { view } = await setup({ queryType: NgsildQueryType.ENTITY, ngsildOptions: ['concise'] });
    expect(screen.getByRole('radiogroup', { name: 'Query type' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Format' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Representation' })).toBeInTheDocument();
    view.unmount();
    await setup({ queryType: NgsildQueryType.GEO });
    expect(screen.getByRole('radiogroup', { name: 'Location' })).toBeInTheDocument();
  });

  it('chooses one representation and the sysAttrs flag separately', async () => {
    const { last } = await setup({ queryType: NgsildQueryType.ENTITY, ngsildOptions: ['keyValues'] });
    fireEvent.click(screen.getByRole('radio', { name: 'Concise' }));
    expect(last().ngsildOptions).toEqual(['concise']);
    fireEvent.click(screen.getByLabelText('System attributes'));
    expect(last().ngsildOptions).toEqual(['keyValues', 'sysAttrs']);
    fireEvent.click(screen.getByRole('radio', { name: 'Normalized' }));
    expect(last().ngsildOptions).toEqual([]);
  });

  it('hides series and entity naming for table output, which uses neither', async () => {
    const { view } = await setup({ queryType: NgsildQueryType.ENTITY, format: 'table', lang: 'en' });
    expect(input('ngsild-name-pattern-A')).toBeNull();
    expect(input('ngsild-entity-name-A')).toBeNull();
    view.unmount();
    await setup({ queryType: NgsildQueryType.ENTITY, lang: 'en' });
    expect(input('ngsild-name-pattern-A')).not.toBeNull();
  });

  it('keeps advanced settings under Options and lists the ones in use', async () => {
    const { view } = await setup({ entityType: 'AirQualityObserved' });
    expect(input('ngsild-customQuery-A')).toBeNull();
    expect(screen.getByRole('button', { name: 'Options' })).toHaveAttribute('aria-expanded', 'false');
    openOptions();
    expect(input('ngsild-customQuery-A')).not.toBeNull();
    view.unmount();
    // a query with settings there opens with them shown; collapsed, the summary names them
    await setup({ entityType: 'AirQualityObserved', lang: 'en', limit: 5 });
    expect(input('ngsild-lang-A')).toHaveValue('en');
    openOptions();
    expect(screen.getByText('limit 5 · lang en')).toBeInTheDocument();
  });

  it('asks for a selector instead of previewing a request that is never sent', async () => {
    const { view } = await setup();
    expect(screen.queryByTestId('ngsild-request-preview')).toBeNull();
    expect(screen.getByText(/Select an entity type, entity id or attribute/)).toBeInTheDocument();
    view.unmount();
    await setup({ idPattern: 'urn:x:.*' });
    expect(screen.getByTestId('ngsild-request-preview').textContent).toContain('idPattern=urn:x:.*');
  });

  it('previews the auto aggregation period from the panel interval', async () => {
    await setup({ entityType: 'AirQualityObserved', aggrMethod: 'avg', aggrPeriodDuration: 'auto' }, makeDs(), 300_000);
    expect(screen.getByTestId('ngsild-request-preview').textContent).toContain('aggrPeriodDuration=PT300S');
  });

  it('previews a geo query with the location among the attributes', async () => {
    await setup({ queryType: NgsildQueryType.GEO, entityType: 'AirQualityObserved', attributes: ['pm10'] });
    expect(screen.getByTestId('ngsild-request-preview').textContent).toContain('attrs=pm10,location');
  });

  it('previews a node graph without the attrs it does not send', async () => {
    await setup({ queryType: NgsildQueryType.NODE_GRAPH, entityType: 'AirQualityObserved', attributes: ['pm10'] });
    expect(screen.getByTestId('ngsild-request-preview').textContent).not.toContain('attrs=');
  });

  it('announces lookup errors to screen readers', async () => {
    const ds = makeDs();
    (ds.getTypes as jest.Mock).mockRejectedValue(new Error('down'));
    await setup({}, ds);
    expect(screen.getByRole('status')).toHaveTextContent('Could not load entity types: down');
  });

  it('selects the table format of a current value query', async () => {
    const { last } = await setup({ queryType: NgsildQueryType.ENTITY });
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(last().format).toBe('table');
  });

  it('hides the entity name when series are named by attribute only', async () => {
    await setup({ namePattern: 'attribute' });
    expect(input('ngsild-entity-name-A')).toBeNull();
  });

  it('maps the deprecated long entity name flag to id', async () => {
    await setup({ useLongEntityName: true });
    openOptions();
    expect(screen.getAllByText('id', { exact: true }).length).toBeGreaterThan(0);
  });

  it('edits node graph depth and stats', async () => {
    const { last } = await setup({ queryType: NgsildQueryType.NODE_GRAPH, entityType: 'AirQualityObserved' });
    fireEvent.change(input('ngsild-graphDepth-A'), { target: { value: '2' } });
    expect(last().graphDepth).toBe(2);
    pick('ngsild-primaryNodeAttributes-A', 'pm10');
    expect(last().primaryNodeAttributes).toEqual({ '': ['pm10'] });
  });

  it('removes a node stat entry when its last attribute is cleared', async () => {
    const { last } = await setup({ queryType: NgsildQueryType.NODE_GRAPH, primaryNodeAttributes: { '': ['pm10'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(last().primaryNodeAttributes).toBeUndefined();
  });
});
