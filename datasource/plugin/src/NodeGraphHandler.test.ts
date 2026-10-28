import { NodeGraphDataFrameFieldNames as F } from '@grafana/data';

import { resolveRelated, toNodeGraph } from './NodeGraphHandler';
import { Entity } from './ngsildTypes';
import { NgsildQuery } from './types';

const q = (patch: Partial<NgsildQuery> = {}): NgsildQuery => ({ refId: 'A', ...patch });
const field = (frame: { fields: Array<{ name: string }> }, name: string) =>
  frame.fields.find((f) => f.name === name) as any;

const station: Entity = {
  id: 'urn:ngsi-ld:AirQualityObserved:S1',
  type: 'AirQualityObserved',
  temperature: { type: 'Property', value: 21.5, unitCode: 'CEL' },
  pm10: { type: 'Property', value: 30, unitCode: 'GQ' },
  health: { type: 'Property', value: 0.8 },
  refDevice: { type: 'Relationship', object: 'urn:ngsi-ld:Device:D1' },
};
const device: Entity = {
  id: 'urn:ngsi-ld:Device:D1',
  type: 'Device',
  battery: { type: 'Property', value: 1.7 },
  locatedIn: { type: 'ListRelationship', objectList: [{ object: 'urn:ngsi-ld:Building:B1' }] },
};
const building: Entity = {
  id: 'urn:ngsi-ld:Building:B1',
  type: 'Building',
  loop: { type: 'Relationship', object: 'urn:ngsi-ld:AirQualityObserved:S1' },
};
const store = new Map([device, building].map((e) => [e.id, e]));

describe('resolveRelated', () => {
  it('follows relationships breadth first and loads each id once', async () => {
    const load = jest.fn(async (ids: string[]) => ids.flatMap((id) => (store.has(id) ? [store.get(id)!] : [])));
    const all = await resolveRelated([station], load, 4);
    expect(all.map((e) => e.id)).toEqual([station.id, device.id, building.id]);
    expect(load.mock.calls).toEqual([[[device.id]], [[building.id]]]);
  });

  it('stops at the requested depth', async () => {
    const load = jest.fn(async (ids: string[]) => ids.map((id) => store.get(id)!));
    expect((await resolveRelated([station], load, 1)).map((e) => e.id)).toEqual([station.id, device.id]);
    expect(await resolveRelated([station], load, 0)).toEqual([station]);
  });

  it('stops at maxNodes, loading no more targets than fit', async () => {
    const load = jest.fn(async (ids: string[]) => ids.map((id) => store.get(id)!));
    expect((await resolveRelated([station], load, 4, 2)).map((e) => e.id)).toEqual([station.id, device.id]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await resolveRelated([station, device, building], load, 4, 2)).toEqual([station, device]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('stops when targets do not exist', async () => {
    const load = jest.fn(async () => []);
    expect(await resolveRelated([station], load, 4)).toEqual([station]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('toNodeGraph', () => {
  const all = [station, device, building];

  it('makes a node per entity and an edge per relationship between known nodes', () => {
    const [nodes, edges] = toNodeGraph([station, device], q());
    expect(nodes.meta?.preferredVisualisationType).toBe('nodeGraph');
    expect(field(nodes, F.id).values).toEqual([station.id, device.id]);
    expect(field(nodes, F.title).values).toEqual(['S1', 'D1']);
    expect(field(nodes, F.subTitle).values).toEqual(['AirQualityObserved', 'Device']);
    expect(field(edges, F.source).values).toEqual([station.id]); // the building is not a node
    expect(field(edges, F.target).values).toEqual([device.id]);
    expect(field(edges, F.mainStat).values).toEqual(['refDevice']);
    expect(new Set(field(edges, F.id).values).size).toBe(field(edges, F.id).values.length);
  });

  it('follows list relationships and cycles without duplicate edges', () => {
    const [, edges] = toNodeGraph(all, q());
    expect(field(edges, F.mainStat).values).toEqual(['refDevice', 'locatedIn', 'loop']);
  });

  it('shows the configured stats, per type or for all, with units', () => {
    const [nodes] = toNodeGraph(
      all,
      q({
        primaryNodeAttributes: { '': ['temperature'], Device: ['battery'] },
        secondaryNodeAttributes: { '': ['pm10'] },
      })
    );
    // one string field, numbers too; nodes show different attributes, so the legend says Main stat
    expect(field(nodes, F.mainStat).values).toEqual(['21.5°C', '1.7', null]);
    expect(field(nodes, F.mainStat).config.displayName).toBe('Main stat');
    expect(field(nodes, F.secondaryStat).values).toEqual(['30 µg/m³', null, null]);
  });

  it('fills the arc from a [0,1] attribute, clamps it and greys out nodes without it', () => {
    const [nodes] = toNodeGraph(
      all,
      q({
        arcColorNodeAttributes: { '': ['health', 'battery'] },
        primaryArcColor: 'blue',
        arcColorComplementLabel: 'sick',
      })
    );
    expect(field(nodes, F.arc + 'zone1').values).toEqual([0.8, 1, 0]);
    expect(field(nodes, F.arc + 'zone1').config).toMatchObject({
      displayName: 'health',
      color: { fixedColor: 'blue' },
    });
    expect(field(nodes, F.arc + 'zone2').values.map((v: number) => +v.toFixed(2))).toEqual([0.2, 0, 0]);
    expect(field(nodes, F.arc + 'zone2').config.displayName).toBe('sick');
    expect(field(nodes, F.arc + 'neutral').values).toEqual([0, 0, 1]);
  });

  it('leaves out the neutral arc when every node has a value', () => {
    const [nodes] = toNodeGraph([station], q({ arcColorNodeAttributes: { '': ['health'] } }));
    expect(field(nodes, F.arc + 'neutral')).toBeUndefined();
  });

  it('builds empty frames for no entities', () => {
    const [nodes, edges] = toNodeGraph([], q());
    expect(nodes.length).toBe(0);
    expect(edges.length).toBe(0);
  });
});
