import { expect, test } from '@grafana/plugin-e2e';

// The provisioned data source of the compose stack, pointing at the bundled Antares broker.
const UID = 'ngsild_1';

test('Save & test reports the broker, its types and the temporal API', async ({ gotoDataSourceConfigPage }) => {
  const configPage = await gotoDataSourceConfigPage(UID);
  await expect(configPage.saveAndTest({ path: '/ngsi-ld/v1/temporal/entities' })).toBeOK();
  await expect(configPage).toHaveAlert('success', {
    hasText: /NGSI-LD broker reachable: \d+ entity type\(s\)\. Temporal API available\./,
  });
});

test('Save & test reports an unreachable broker', async ({ createDataSourceConfigPage, page }) => {
  const configPage = await createDataSourceConfigPage({ type: 'ngsild-grafana-datasource' });
  await page.locator('#ngsild-url').fill('http://antares:1');
  await configPage.saveAndTest({ path: '/ngsi-ld/v1/types' });
  await expect(configPage).toHaveAlert('error', { hasText: /Cannot reach the NGSI-LD API/ });
});
