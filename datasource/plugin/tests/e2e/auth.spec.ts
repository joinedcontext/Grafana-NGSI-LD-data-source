import { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '@grafana/plugin-e2e';

// Needs the auth stack (docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d) and
// NGSILD_AUTH=1. Data sources: auth/grafana/datasources.yml; gateway rules: auth/envoy/envoy.yaml.
test.skip(!process.env.NGSILD_AUTH, 'needs the auth stack (NGSILD_AUTH=1)');

const GRAFANA = process.env.GRAFANA_URL || 'http://localhost:3000';

/** Explore with one current-value table query of the station names. */
const exploreUrl = (uid: string) =>
  '/explore?schemaVersion=1&panes=' +
  encodeURIComponent(
    JSON.stringify({
      a: {
        datasource: uid,
        queries: [
          {
            refId: 'A',
            datasource: { type: 'ngsild-grafana-datasource', uid },
            queryType: 'entity',
            format: 'table',
            entityType: 'AirQualityObserved',
            attributes: ['name'],
            lang: 'en',
          },
        ],
        range: { from: 'now-2d', to: 'now' },
      },
    })
  );

test.describe('Save & test through the gateway', () => {
  for (const [uid, mode] of [
    ['ngsild_oauth', 'OAuth2 client credentials'],
    ['ngsild_basic', 'basic auth'],
    ['ngsild_apikey', 'API key header'],
  ]) {
    test(`succeeds with ${mode}`, async ({ gotoDataSourceConfigPage }) => {
      const configPage = await gotoDataSourceConfigPage(uid);
      await expect(configPage.saveAndTest({ path: '/ngsi-ld/v1/temporal/entities' })).toBeOK();
      await expect(configPage).toHaveAlert('success', { hasText: /\d+ entity type\(s\)\. Temporal API available\./ });
    });
  }

  for (const [uid, reason] of [
    ['ngsild_gateway_none', 'no credentials'],
    ['ngsild_oauth_bad_secret', 'a wrong client secret'],
    ['ngsild_oauth_no_role', 'a client without the reader role'],
    ['ngsild_basic_bad', 'a wrong password'],
    ['ngsild_apikey_bad', 'a wrong API key'],
  ]) {
    test(`reports refused credentials with ${reason}`, async ({ gotoDataSourceConfigPage }) => {
      const configPage = await gotoDataSourceConfigPage(uid);
      await configPage.saveAndTest({ path: '/ngsi-ld/v1/types' });
      await expect(configPage).toHaveAlert('error', {
        hasText: /The NGSI-LD API refused the credentials .*Check the authentication settings\./,
      });
    });
  }
});

test('an OAuth2 data source answers queries in Explore', async ({ page }) => {
  await page.goto(exploreUrl('ngsild_oauth'));
  await expect(page.getByText('Mannerheimintie').first()).toBeVisible({ timeout: 30_000 });
});

const entity = { id: 'urn:ngsi-ld:Test:1', type: 'Test' };
const post = (request: APIRequestContext, path: string) =>
  request.post(path, { data: entity, headers: { 'Content-Type': 'application/json' } });

test('the OAuth route adds no token to a write', async ({ request }) => {
  // plugin.json limits the route to GET, so the gateway sees a POST without a token
  const res = await post(request, '/api/datasources/proxy/uid/ngsild_oauth/oauth/ngsi-ld/v1/entities');
  expect(res.ok()).toBe(false);
  expect(await res.text()).not.toContain(entity.id);
  const read = await request.get(`/api/datasources/proxy/uid/ngsild_oauth/oauth/ngsi-ld/v1/entities/${entity.id}`);
  expect(read.status()).toBe(404); // nothing was written
});

for (const uid of ['ngsild_basic', 'ngsild_apikey']) {
  test(`the gateway keeps ${uid} read-only`, async ({ request }) => {
    const res = await post(request, `/api/datasources/proxy/uid/${uid}/ngsi-ld/v1/entities`);
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain('RBAC: access denied');
  });
}

/** A fresh browser signed in to Grafana through Keycloak. */
async function signIn(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: GRAFANA, storageState: undefined });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByText('Sign in with Keycloak').click();
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(user);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.href.startsWith(GRAFANA) && !url.pathname.startsWith('/login'));
  return page;
}

test.describe('Forward OAuth identity', () => {
  test('alice, with the reader role, reads through her own token', async ({ browser }) => {
    const page = await signIn(browser, 'alice');
    const res = await page.request.get('/api/datasources/proxy/uid/ngsild_forward/ngsi-ld/v1/types');
    expect(res.status()).toBe(200);
    expect((await res.json()).typeList).toContain('AirQualityObserved');
    await page.goto(exploreUrl('ngsild_forward'));
    await expect(page.getByText('Mannerheimintie').first()).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });

  test('bob, without the role, is refused and sees why', async ({ browser }) => {
    const page = await signIn(browser, 'bob');
    const res = await page.request.get('/api/datasources/proxy/uid/ngsild_forward/ngsi-ld/v1/types');
    expect(res.status()).toBe(403);
    await page.goto(exploreUrl('ngsild_forward'));
    await expect(page.getByText(/RBAC: access denied/).first()).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });
});
