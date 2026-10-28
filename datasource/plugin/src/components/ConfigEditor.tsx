import React, { ChangeEvent } from 'react';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { Divider, Field, FieldSet, Input, RadioButtonGroup, SecretInput, Text } from '@grafana/ui';

import { NgsildSecureJsonData, NgsildSourceOptions } from '../types';
import { DEFAULT_MAX_TEMPORAL_PAGES, DEFAULT_PAGE_SIZE } from '../datasource';

type Props = DataSourcePluginOptionsEditorProps<NgsildSourceOptions, NgsildSecureJsonData>;
type SecureKey = keyof NgsildSecureJsonData | 'basicAuthPassword' | 'httpHeaderValue1';
type AuthMode = 'none' | 'basic' | 'oauth' | 'header' | 'forward';

const AUTH_MODES = [
  { value: 'none' as const, label: 'None' },
  { value: 'basic' as const, label: 'Basic auth' },
  { value: 'oauth' as const, label: 'OAuth2 client credentials' },
  { value: 'header' as const, label: 'API key / Bearer header' },
  { value: 'forward' as const, label: 'Forward OAuth identity' },
];

const WIDTH = 50;

export function ConfigEditor({ options, onOptionsChange }: Props) {
  const { jsonData } = options;
  const secure = (options.secureJsonData ?? {}) as Record<string, string | undefined>;
  const configured = (options.secureJsonFields ?? {}) as Record<string, boolean>;
  const authMode: AuthMode =
    jsonData.authType === 'oauth'
      ? 'oauth'
      : jsonData.oauthPassThru
        ? 'forward'
        : options.basicAuth
          ? 'basic'
          : jsonData.httpHeaderName1
            ? 'header'
            : 'none';

  const setJson = (patch: Partial<NgsildSourceOptions>) =>
    onOptionsChange({ ...options, jsonData: { ...jsonData, ...patch } });
  const text = (key: keyof NgsildSourceOptions) => (e: ChangeEvent<HTMLInputElement>) =>
    setJson({ [key]: e.currentTarget.value });
  const num = (key: keyof NgsildSourceOptions) => (e: ChangeEvent<HTMLInputElement>) => {
    const n = parseInt(e.currentTarget.value, 10);
    setJson({ [key]: Number.isFinite(n) && n > 0 ? n : undefined });
  };
  const setSecret = (key: SecureKey) => (e: ChangeEvent<HTMLInputElement>) =>
    onOptionsChange({ ...options, secureJsonData: { ...secure, [key]: e.currentTarget.value } });
  const resetSecret = (key: SecureKey) => () =>
    onOptionsChange({
      ...options,
      secureJsonFields: { ...options.secureJsonFields, [key]: false },
      secureJsonData: { ...secure, [key]: '' },
    });
  const secret = (key: SecureKey, id: string, placeholder: string) => (
    <SecretInput
      id={id}
      width={WIDTH}
      isConfigured={!!configured[key]}
      value={secure[key] ?? ''}
      placeholder={placeholder}
      onChange={setSecret(key)}
      onReset={resetSecret(key)}
    />
  );

  // one mode at a time: the Grafana proxy applies every one whose setting is present
  const onAuthMode = (mode: AuthMode) => {
    const jd: NgsildSourceOptions = {
      ...jsonData,
      authType: mode === 'oauth' ? 'oauth' : undefined,
      oauthPassThru: mode === 'forward',
    };
    if (mode !== 'header') {
      delete jd.httpHeaderName1;
    } else if (!jd.httpHeaderName1) {
      jd.httpHeaderName1 = 'Authorization';
    }
    onOptionsChange({ ...options, basicAuth: mode === 'basic', jsonData: jd });
  };

  return (
    <>
      <FieldSet label="Connection">
        <Field label="Broker URL" description="Root URL of the NGSI-LD broker, without /ngsi-ld/v1." required>
          <Input
            id="ngsild-url"
            width={WIDTH}
            value={options.url ?? ''}
            placeholder="http://antares:9090"
            onChange={(e) =>
              onOptionsChange({ ...options, url: e.currentTarget.value.trim().replace(/\/ngsi-ld\/v1\/?$/, '') })
            }
          />
        </Field>
        <Field
          label="@context URL"
          description="Sent as JSON-LD Link header; leave empty for the NGSI-LD core context."
        >
          <Input
            id="ngsild-context"
            width={WIDTH}
            value={jsonData.contextUrl ?? ''}
            placeholder="https://example.org/context.jsonld"
            onChange={text('contextUrl')}
          />
        </Field>
        <Field label="Tenant" description="NGSILD-Tenant header.">
          <Input id="ngsild-tenant" width={WIDTH} value={jsonData.tenant ?? ''} onChange={text('tenant')} />
        </Field>
      </FieldSet>

      <Divider />
      <FieldSet label="Authentication">
        <Field
          label="Method"
          description="Credentials stay in Grafana; the data source proxy adds them to every broker request."
        >
          <RadioButtonGroup
            aria-label="Authentication method"
            options={AUTH_MODES}
            value={authMode}
            onChange={onAuthMode}
          />
        </Field>
        {authMode === 'basic' && (
          <>
            <Field label="User">
              <Input
                id="ngsild-basic-user"
                width={WIDTH}
                value={options.basicAuthUser ?? ''}
                onChange={(e) => onOptionsChange({ ...options, basicAuthUser: e.currentTarget.value })}
              />
            </Field>
            <Field label="Password">{secret('basicAuthPassword', 'ngsild-basic-password', 'Password')}</Field>
          </>
        )}
        {authMode === 'oauth' && (
          <>
            <Field
              label="Token URL"
              description="OAuth2 token endpoint, e.g. Keycloak .../protocol/openid-connect/token"
            >
              <Input
                id="ngsild-token-url"
                width={WIDTH}
                value={jsonData.tokenUrl ?? ''}
                placeholder="https://keycloak.example.org/realms/x/protocol/openid-connect/token"
                onChange={text('tokenUrl')}
              />
            </Field>
            <Field label="Client id">{secret('clientId', 'ngsild-client-id', 'Client id')}</Field>
            <Field label="Client secret">{secret('clientSecret', 'ngsild-client-secret', 'Client secret')}</Field>
          </>
        )}
        {authMode === 'forward' && (
          <Text element="p" color="secondary">
            The Grafana proxy sends the signed-in user&apos;s OAuth access token, so the broker decides per user. Needs
            Grafana sign-in through the identity provider the broker trusts.
          </Text>
        )}
        {authMode === 'header' && (
          <>
            <Field label="Header name">
              <Input
                id="ngsild-header-name"
                width={WIDTH}
                value={jsonData.httpHeaderName1 ?? ''}
                onChange={(e) => setJson({ httpHeaderName1: e.currentTarget.value.trim() })}
              />
            </Field>
            <Field label="Header value" description='For a bearer token: "Bearer <token>".'>
              {secret('httpHeaderValue1', 'ngsild-header-value', 'Value')}
            </Field>
          </>
        )}
      </FieldSet>

      <Divider />
      <FieldSet label="Paging">
        <Field
          label="Page size"
          description={`Entities per request (limit). Brokers refuse more than their maximum (Antares: 1000); Save & test checks it. Default ${DEFAULT_PAGE_SIZE}.`}
        >
          <Input
            id="ngsild-page-size"
            type="number"
            min={1}
            width={20}
            value={jsonData.pageSize ?? ''}
            placeholder={String(DEFAULT_PAGE_SIZE)}
            onChange={num('pageSize')}
          />
        </Field>
        <Field
          label="Max temporal pages"
          description={`Requests per temporal query when the broker answers 206 Partial Content (CIM 009 6.3.10). Default ${DEFAULT_MAX_TEMPORAL_PAGES}.`}
        >
          <Input
            id="ngsild-max-pages"
            type="number"
            min={1}
            width={20}
            value={jsonData.maxTemporalPages ?? ''}
            placeholder={String(DEFAULT_MAX_TEMPORAL_PAGES)}
            onChange={num('maxTemporalPages')}
          />
        </Field>
      </FieldSet>
    </>
  );
}
