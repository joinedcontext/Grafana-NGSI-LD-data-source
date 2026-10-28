// The NGSI-LD calls the demo feeds share. BROKER_URL and TENANT come from the environment.

import { pathToFileURL } from 'node:url';

export const BROKER = (process.env.BROKER_URL || 'http://localhost:9090').replace(/\/$/, '');
export const TENANT = process.env.TENANT || '';

export async function call(method, path, body, okStatuses = [200, 201, 204]) {
  const res = await fetch(BROKER + '/ngsi-ld/v1' + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(TENANT ? { 'NGSILD-Tenant': TENANT } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!okStatuses.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

/** Creates or updates entities, 100 per request; `update` keeps the attributes not sent. */
export async function upsert(entities, options = 'update') {
  for (let i = 0; i < entities.length; i += 100) {
    await call('POST', `/entityOperations/upsert?options=${options}`, entities.slice(i, i + 100));
  }
}

/** Removes an entity and its history, so a restarted feed starts clean. */
export async function purge(id) {
  await call('DELETE', `/temporal/entities/${encodeURIComponent(id)}`, undefined, [204, 404]);
  await call('DELETE', `/entities/${encodeURIComponent(id)}`, undefined, [204, 404]);
}

export async function waitForBroker(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(BROKER + '/ngsi-ld/v1/types')).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > until) {
      throw new Error('broker not reachable at ' + BROKER);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `main` when the module is the started script, not when a test imports it. */
export function isMain(url) {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}
