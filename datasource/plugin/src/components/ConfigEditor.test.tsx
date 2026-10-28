import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DataSourceSettings } from '@grafana/data';

import { ConfigEditor } from './ConfigEditor';
import { NgsildSecureJsonData, NgsildSourceOptions } from '../types';

type Options = DataSourceSettings<NgsildSourceOptions, NgsildSecureJsonData>;

const base = (patch: Partial<Options> = {}): Options =>
  ({ url: '', basicAuth: false, jsonData: {}, secureJsonFields: {}, ...patch }) as Options;

function setup(options: Options) {
  const onOptionsChange = jest.fn();
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  const last = (): Options => onOptionsChange.mock.calls.at(-1)[0];
  return { onOptionsChange, last };
}

const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });

describe('ConfigEditor', () => {
  it('strips a trailing /ngsi-ld/v1 and whitespace from the broker URL', () => {
    const { last } = setup(base());
    type('ngsild-url', ' http://antares:9090/ngsi-ld/v1/ ');
    expect(last().url).toBe('http://antares:9090');
  });

  it('writes context and tenant into jsonData without touching other keys', () => {
    const { last } = setup(base({ jsonData: { pageSize: 50 } }));
    type('ngsild-context', 'https://ctx/c.jsonld');
    expect(last().jsonData).toEqual({ pageSize: 50, contextUrl: 'https://ctx/c.jsonld' });
    type('ngsild-tenant', 't1');
    expect(last().jsonData.tenant).toBe('t1');
    expect(document.getElementById('ngsild-tenant-path')).toBeNull(); // Orion-LD only, not offered
  });

  it.each([
    ['250', 250],
    ['0', undefined],
    ['-5', undefined],
    ['', undefined],
    ['abc', undefined],
  ])('page size %j is stored as %j', (input, stored) => {
    const { last } = setup(base({ jsonData: { pageSize: 10 } }));
    type('ngsild-page-size', input);
    expect(last().jsonData.pageSize).toBe(stored);
  });

  it('stores max temporal pages as a positive integer', () => {
    const { last } = setup(base());
    type('ngsild-max-pages', '1000');
    expect(last().jsonData.maxTemporalPages).toBe(1000);
  });

  it('shows no credential fields without authentication', () => {
    setup(base());
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked();
    expect(document.getElementById('ngsild-basic-user')).toBeNull();
    expect(document.getElementById('ngsild-token-url')).toBeNull();
    expect(document.getElementById('ngsild-header-name')).toBeNull();
  });

  it('switches to basic auth and edits user and password', () => {
    const { last } = setup(base({ basicAuth: true, basicAuthUser: 'u' }));
    expect(screen.getByRole('radio', { name: 'Basic auth' })).toBeChecked();
    type('ngsild-basic-user', 'admin');
    expect(last().basicAuthUser).toBe('admin');
    type('ngsild-basic-password', 'pw');
    expect(last().secureJsonData).toEqual({ basicAuthPassword: 'pw' });
  });

  it('selects OAuth: sets authType, clears basic auth and the header', () => {
    const { last } = setup(base({ basicAuth: true, jsonData: { httpHeaderName1: 'X' } }));
    fireEvent.click(screen.getByRole('radio', { name: 'OAuth2 client credentials' }));
    expect(last().basicAuth).toBe(false);
    expect(last().jsonData.authType).toBe('oauth');
    expect(last().jsonData).not.toHaveProperty('httpHeaderName1');
  });

  it('edits the OAuth token URL, client id and client secret', () => {
    const { last } = setup(base({ jsonData: { authType: 'oauth' } }));
    type('ngsild-token-url', 'https://kc/token');
    expect(last().jsonData.tokenUrl).toBe('https://kc/token');
    type('ngsild-client-id', 'grafana');
    expect(last().secureJsonData?.clientId).toBe('grafana');
    type('ngsild-client-secret', 's3cret');
    expect(last().secureJsonData?.clientSecret).toBe('s3cret');
  });

  it('resets a configured secret so it can be replaced', () => {
    const { last } = setup(base({ jsonData: { authType: 'oauth' }, secureJsonFields: { clientSecret: true } }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset' })[0]);
    expect(last().secureJsonFields.clientSecret).toBe(false);
    expect(last().secureJsonData?.clientSecret).toBe('');
  });

  it('selects a header: defaults its name to Authorization and keeps an existing name', () => {
    const { last } = setup(base({ jsonData: { authType: 'oauth' } }));
    fireEvent.click(screen.getByRole('radio', { name: 'API key / Bearer header' }));
    expect(last().jsonData).toMatchObject({ httpHeaderName1: 'Authorization', authType: undefined });
    expect(last().basicAuth).toBe(false);
  });

  it('edits the header name (trimmed) and value', () => {
    const { last } = setup(base({ jsonData: { httpHeaderName1: 'Authorization' } }));
    expect(screen.getByRole('radio', { name: 'API key / Bearer header' })).toBeChecked();
    type('ngsild-header-name', ' X-Api-Key ');
    expect(last().jsonData.httpHeaderName1).toBe('X-Api-Key');
    type('ngsild-header-value', 'Bearer abc');
    expect(last().secureJsonData).toEqual({ httpHeaderValue1: 'Bearer abc' });
  });

  it('switching back to none removes the header and authType', () => {
    const { last } = setup(base({ jsonData: { httpHeaderName1: 'Authorization' } }));
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(last().jsonData).not.toHaveProperty('httpHeaderName1');
    expect(last().jsonData.authType).toBeUndefined();
    expect(last().basicAuth).toBe(false);
  });

  it('selects forwarding of the OAuth identity and clears the other modes', () => {
    const { last } = setup(base({ basicAuth: true, jsonData: { authType: 'oauth', httpHeaderName1: 'X' } }));
    fireEvent.click(screen.getByRole('radio', { name: 'Forward OAuth identity' }));
    expect(last().jsonData.oauthPassThru).toBe(true);
    expect(last().jsonData.authType).toBeUndefined();
    expect(last().jsonData).not.toHaveProperty('httpHeaderName1');
    expect(last().basicAuth).toBe(false);
  });

  it('shows a forwarding data source as such and turns forwarding off with another mode', () => {
    const { last } = setup(base({ jsonData: { oauthPassThru: true } }));
    expect(screen.getByRole('radio', { name: 'Forward OAuth identity' })).toBeChecked();
    expect(screen.getByText(/signed-in user/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Basic auth' }));
    expect(last().jsonData.oauthPassThru).toBe(false);
    expect(last().basicAuth).toBe(true);
  });

  it('offers paging settings and no broker compatibility switches (Antares only)', () => {
    setup(base());
    expect(screen.getByText('Paging')).toBeInTheDocument();
    expect(screen.queryByText('Broker compatibility')).toBeNull();
    expect(document.getElementById('ngsild-format-param')).toBeNull();
    expect(document.getElementById('ngsild-temporal-rep')).toBeNull();
  });
});
