import { createDataFrame, DataFrame, FieldType, NodeGraphDataFrameFieldNames as F } from '@grafana/data';

import { attributeNames, Entity, getValue, instances, isRelationship, relationshipTargets } from './ngsildTypes';
import { NgsildQuery } from './types';
import { entityLabel, shortId } from './frames';
import { unitSymbol } from './units';

export const DEFAULT_GRAPH_DEPTH = 4;

/** Loads entities by id; used to follow relationships whose targets are not in the result yet. */
export type EntityLoader = (ids: string[]) => Promise<Entity[]>;

const typeOf = (e: Entity): string => (Array.isArray(e.type) ? e.type[0] : e.type);

/** First of the configured attributes (per type, else the "" default) that the entity carries. */
function statAttribute(e: Entity, config?: Record<string, string[]>): string | undefined {
  const attrs = config?.[typeOf(e)] ?? config?.[''];
  return attrs?.find((a) => a in e);
}

function statValue(
  e: Entity,
  config: Record<string, string[]> | undefined,
  q: NgsildQuery,
  withUnit: boolean
): unknown {
  const attr = statAttribute(e, config);
  if (!attr) {
    return null;
  }
  const inst: any = instances(e[attr])[0];
  const v = getValue(inst, q.lang);
  if (withUnit && typeof v === 'number' && inst?.unitCode) {
    const sym = unitSymbol(inst.unitCode);
    return sym ? `${v}${sym.startsWith('°') ? '' : ' '}${sym}` : v;
  }
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : (v ?? null);
}

/** Adds the targets of relationships, breadth first, up to `depth` hops and `maxNodes` entities. */
export async function resolveRelated(
  entities: Entity[],
  load: EntityLoader,
  depth: number,
  maxNodes = Infinity
): Promise<Entity[]> {
  const all = new Map(entities.slice(0, maxNodes).map((e) => [e.id, e]));
  let frontier = [...all.values()];
  for (let hop = 0; hop < depth && frontier.length > 0 && all.size < maxNodes; hop++) {
    const missing = new Set<string>();
    for (const e of frontier) {
      for (const attr of attributeNames(e)) {
        instances(e[attr])
          .filter(isRelationship)
          .flatMap(relationshipTargets)
          .forEach((id) => !all.has(id) && missing.add(id));
      }
    }
    if (missing.size === 0) {
      break;
    }
    frontier = (await load([...missing].slice(0, maxNodes - all.size))).filter((e) => !all.has(e.id));
    frontier.forEach((e) => all.set(e.id, e));
  }
  return [...all.values()];
}

/** Node and edge frames for the node graph panel. */
export function toNodeGraph(entities: Entity[], q: NgsildQuery): DataFrame[] {
  const ids = new Set(entities.map((e) => e.id));
  const meta = { preferredVisualisationType: 'nodeGraph' as const };

  const nodeFields: any[] = [
    { name: F.id, type: FieldType.string, values: entities.map((e) => e.id) },
    { name: F.title, type: FieldType.string, values: entities.map((e) => entityLabel(e, q)) },
    {
      name: F.subTitle,
      type: FieldType.string,
      values: entities.map((e) => {
        const t = shortId(typeOf(e));
        return entityLabel(e, q).includes(t) ? '' : t;
      }),
    },
  ];
  // named after the attribute when every node shows the same one, else generically
  const statField = (name: string, label: string, config?: Record<string, string[]>) => {
    const attrs = new Set(entities.map((e) => statAttribute(e, config)).filter(Boolean));
    return {
      name,
      type: FieldType.string,
      values: entities.map((e) => {
        const v = statValue(e, config, q, true);
        return v === null ? null : String(v);
      }),
      config: { displayName: attrs.size === 1 ? [...attrs][0] : label },
    };
  };
  if (q.primaryNodeAttributes) {
    nodeFields.push(statField(F.mainStat, 'Main stat', q.primaryNodeAttributes));
  }
  if (q.secondaryNodeAttributes) {
    nodeFields.push(statField(F.secondaryStat, 'Secondary stat', q.secondaryNodeAttributes));
  }
  if (q.arcColorNodeAttributes) {
    const arc = entities.map((e) => {
      const v = Number(statValue(e, q.arcColorNodeAttributes, q, false));
      return statAttribute(e, q.arcColorNodeAttributes) && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN;
    });
    const sample = entities.find((e) => statAttribute(e, q.arcColorNodeAttributes));
    const attr = sample ? statAttribute(sample, q.arcColorNodeAttributes)! : 'value';
    nodeFields.push(
      {
        name: F.arc + 'zone1',
        type: FieldType.number,
        values: arc.map((v) => (Number.isFinite(v) ? v : 0)),
        config: { displayName: attr, color: { mode: 'fixed', fixedColor: q.primaryArcColor || 'green' } },
      },
      {
        name: F.arc + 'zone2',
        type: FieldType.number,
        values: arc.map((v) => (Number.isFinite(v) ? 1 - v : 0)),
        config: {
          displayName: q.arcColorComplementLabel || '~' + attr,
          color: { mode: 'fixed', fixedColor: q.secondaryArcColor || 'red' },
        },
      }
    );
    if (arc.some((v) => !Number.isFinite(v))) {
      nodeFields.push({
        name: F.arc + 'neutral',
        type: FieldType.number,
        values: arc.map((v) => (Number.isFinite(v) ? 0 : 1)),
        config: { displayName: 'n.a.', color: { mode: 'fixed', fixedColor: 'gray' } },
      });
    }
  }

  const edges: Array<[string, string, string]> = [];
  for (const e of entities) {
    for (const attr of attributeNames(e)) {
      for (const target of instances(e[attr]).filter(isRelationship).flatMap(relationshipTargets)) {
        if (ids.has(target)) {
          edges.push([e.id, target, attr]);
        }
      }
    }
  }
  return [
    createDataFrame({ refId: q.refId, name: 'nodes', meta, fields: nodeFields }),
    createDataFrame({
      refId: q.refId,
      name: 'edges',
      meta,
      fields: [
        { name: F.id, type: FieldType.string, values: edges.map(([s, t, a], i) => `${s}__${a}__${t}__${i}`) },
        { name: F.source, type: FieldType.string, values: edges.map(([s]) => s) },
        { name: F.target, type: FieldType.string, values: edges.map(([, t]) => t) },
        { name: F.mainStat, type: FieldType.string, values: edges.map(([, , a]) => a) },
      ],
    }),
  ];
}
