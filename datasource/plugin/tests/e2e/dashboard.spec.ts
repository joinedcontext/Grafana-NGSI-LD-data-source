import { expect, test } from '@grafana/plugin-e2e';

// volumes/dashboards/sample-city.json on the seed dataset
const DASHBOARD = { uid: 'ngsild-sample-city' };

test('every panel of the sample dashboard renders without an error', async ({ gotoDashboardPage }) => {
  const dashboardPage = await gotoDashboardPage(DASHBOARD);
  await expect(dashboardPage.getPanelByTitle('Stations (current values)').data).toContainText([
    'urn:ngsi-ld:AirQualityObserved:HEL-01',
  ]);
  await expect(dashboardPage).not.toHavePanelErrors();
});

test('the station table lists the seeded stations by name, in the query attribute order', async ({
  gotoDashboardPage,
}) => {
  const dashboardPage = await gotoDashboardPage(DASHBOARD);
  const table = dashboardPage.getPanelByTitle('Stations (current values)');
  await expect(table.data).toContainText(['urn:ngsi-ld:AirQualityObserved:HEL-01', 'Mannerheimintie']);
  await expect(table.fieldNames).toContainText(['entity id', 'name', 'pm10', 'temperature', 'isOnline']);
});

test('the query editor previews the broker request and follows the query type', async ({ gotoPanelEditPage, page }) => {
  const panelEditPage = await gotoPanelEditPage({ dashboard: DASHBOARD, id: '1' });
  const preview = page.getByTestId('ngsild-request-preview');
  await expect(preview).toContainText('GET /ngsi-ld/v1/temporal/entities?');
  await expect(preview).toContainText(
    'type=AirQualityObserved&attrs=pm10,pm25,name&lang=en&format=temporalValues&timerel=between'
  );
  // the long URL wraps inside the editor instead of widening the page
  expect((await preview.boundingBox())!.width).toBeLessThan(page.viewportSize()!.width);
  await panelEditPage.getQueryEditorRow('A').getByRole('radio', { name: 'Current value' }).check({ force: true });
  await expect(preview).toContainText('GET /ngsi-ld/v1/entities?');
  await expect(preview).not.toContainText('timerel');
});

test('a temporal query names every station series by its name', async ({ gotoPanelEditPage }) => {
  const panelEditPage = await gotoPanelEditPage({ dashboard: DASHBOARD, id: '1' });
  await panelEditPage.toggleTableView();
  await expect(panelEditPage.panel.fieldNames).toContainText(['Time', 'Mannerheimintie:pm10']);
});

test('an aggregated temporal query names every series by station and method', async ({ gotoPanelEditPage, page }) => {
  const panelEditPage = await gotoPanelEditPage({ dashboard: DASHBOARD, id: '2' });
  const preview = page.getByTestId('ngsild-request-preview');
  await expect(preview).toContainText('attrs=no2,name&lang=en&format=aggregatedValues&timerel=between');
  await expect(preview).toContainText('aggrMethods=avg,max&aggrPeriodDuration=PT6H');
  await panelEditPage.toggleTableView();
  // the aggregated answer carries no name; the plugin takes it from the current entity
  await expect(panelEditPage.panel.fieldNames).toContainText(['Time', 'Mannerheimintie:no2 (avg)']);
  await expect(panelEditPage).not.toHaveAlert('error');
});
