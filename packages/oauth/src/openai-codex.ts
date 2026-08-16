/**
 * OpenAI Codex subscription OAuth and its maintained model snapshot.
 *
 * The device-code protocol follows Pi's MIT-licensed OpenAI Codex provider.
 * Model churn is isolated in `openai-codex-models.json`; authentication and
 * config provisioning consume that data without embedding model ids.
 */

import { z } from 'zod';

import catalogJson from './openai-codex-models.json' with { type: 'json' };
import { OAuthConnectionError, OAuthError, OAuthUnauthorizedError } from './errors';
import {
  applyManagedApiKeyProviderModels,
  type ManagedKimiCodeApplyResult,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
} from './managed-kimi-code';
import type { DevicePollResult } from './oauth';
import type { DeviceAuthorization, OAuthFlowConfig, TokenInfo } from './types';
import { isRecord } from './utils';

export const OPENAI_CODEX_PROVIDER_NAME = 'openai-codex';
export const OPENAI_CODEX_OAUTH_KEY = 'oauth/openai-codex';
export const OPENAI_CODEX_OAUTH_HOST = 'https://auth.openai.com';
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_CODEX_OAUTH_HOST}/codex/device`;

const OPENAI_CODEX_DEVICE_REDIRECT_URL = `${OPENAI_CODEX_OAUTH_HOST}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS = 15 * 60;
const OPENAI_CODEX_ACCOUNT_CLAIM = 'https://api.openai.com/auth';

export const OPENAI_CODEX_FLOW_CONFIG: OAuthFlowConfig = {
  name: OPENAI_CODEX_PROVIDER_NAME,
  oauthHost: OPENAI_CODEX_OAUTH_HOST,
  clientId: OPENAI_CODEX_CLIENT_ID,
};

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  maxContextSize: z.number().int().positive(),
  maxOutputSize: z.number().int().positive(),
  capabilities: z.array(z.string().min(1)),
  supportEfforts: z.array(z.string().min(1)).optional(),
  defaultEffort: z.string().min(1).optional(),
});

const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultModel: z.string().min(1),
    provider: z.object({ baseUrl: z.url() }),
    models: z.array(modelSchema).min(1),
  })
  .superRefine((catalog, context) => {
    if (!catalog.models.some((model) => model.id === catalog.defaultModel)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultModel'],
        message: 'defaultModel must reference a model in the catalog',
      });
    }
  });

export type OpenAICodexCatalog = z.infer<typeof catalogSchema>;
export type OpenAICodexModel = z.infer<typeof modelSchema>;

const OPENAI_CODEX_CATALOG = catalogSchema.parse(catalogJson);

export interface OpenAICodexRequestAuth {
  readonly apiKey: string;
  readonly headers: Record<string, string>;
  readonly sessionAffinity: 'openai-codex';
}

export interface OpenAICodexConfigApplyOptions {
  readonly preserveDefaultModel?: boolean | undefined;
}

interface DeviceState {
  readonly deviceAuthId: string;
  readonly userCode: string;
}

export function openAICodexCatalog(): OpenAICodexCatalog {
  return structuredClone(OPENAI_CODEX_CATALOG);
}

export function openAICodexOAuthRef(): ManagedKimiOAuthRef {
  return {
    storage: 'file',
    key: OPENAI_CODEX_OAUTH_KEY,
    oauthHost: OPENAI_CODEX_OAUTH_HOST,
  };
}

export function applyOpenAICodexConfig(
  config: ManagedKimiConfigShape,
  options: OpenAICodexConfigApplyOptions = {},
): ManagedKimiCodeApplyResult {
  const catalog = OPENAI_CODEX_CATALOG;
  const models = catalog.models.map(toManagedModelInfo);
  applyManagedApiKeyProviderModels(
    config,
    OPENAI_CODEX_PROVIDER_NAME,
    models,
    `${OPENAI_CODEX_PROVIDER_NAME}/`,
  );

  config.providers[OPENAI_CODEX_PROVIDER_NAME] = {
    type: 'openai_responses',
    baseUrl: catalog.provider.baseUrl,
    apiKey: '',
    oauth: openAICodexOAuthRef(),
  };

  const configuredDefault = config.defaultModel;
  const canPreserveDefault =
    options.preserveDefaultModel === true &&
    configuredDefault !== undefined &&
    config.models?.[configuredDefault] !== undefined;
  const selectedModel = canPreserveDefault
    ? configuredDefault
    : `${OPENAI_CODEX_PROVIDER_NAME}/${catalog.defaultModel}`;
  const selected = catalog.models.find(
    (model) => `${OPENAI_CODEX_PROVIDER_NAME}/${model.id}` === selectedModel,
  );
  config.defaultModel = selectedModel;
  config.thinking = {
    ...config.thinking,
    enabled: selected?.capabilities.includes('thinking') ?? config.thinking?.enabled ?? false,
    effort: selected?.defaultEffort ?? config.thinking?.effort,
  };

  return {
    defaultModel: selectedModel,
    defaultThinking: config.thinking.enabled ?? false,
  };
}

export function applyOpenAICodexLogoutConfig(config: ManagedKimiConfigShape): void {
  delete config.providers[OPENAI_CODEX_PROVIDER_NAME];
  const removed = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (!isRecord(model) || model['provider'] !== OPENAI_CODEX_PROVIDER_NAME) continue;
    delete config.models?.[alias];
    removed.add(alias);
  }
  if (config.defaultModel !== undefined && removed.has(config.defaultModel)) {
    config.defaultModel = undefined;
    config.thinking = undefined;
  }
  if (config['defaultProvider'] === OPENAI_CODEX_PROVIDER_NAME) {
    config['defaultProvider'] = undefined;
  }
}

export function openAICodexRequestAuth(accessToken: string): OpenAICodexRequestAuth {
  const accountId = openAICodexAccountId(accessToken);
  if (accountId === undefined) {
    throw new OAuthUnauthorizedError('OpenAI Codex token does not contain a ChatGPT account id.');
  }
  return {
    apiKey: accessToken,
    sessionAffinity: 'openai-codex',
    headers: {
      'chatgpt-account-id': accountId,
      originator: 'kimi-code',
      'OpenAI-Beta': 'responses=experimental',
    },
  };
}

export function openAICodexAccountId(accessToken: string): string | undefined {
  try {
    const payloadPart = accessToken.split('.')[1];
    if (payloadPart === undefined) return undefined;
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (!isRecord(payload)) return undefined;
    const claim = payload[OPENAI_CODEX_ACCOUNT_CLAIM];
    if (!isRecord(claim)) return undefined;
    const accountId = claim['chatgpt_account_id'];
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export async function requestOpenAICodexDeviceAuthorization(
  _config: OAuthFlowConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchJson(
    fetchImpl,
    `${OPENAI_CODEX_OAUTH_HOST}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    },
  );
  if (!response.ok) {
    const detail = response.text.length > 0 ? `: ${response.text}` : '';
    throw new OAuthError(
      `OpenAI Codex device code request failed (HTTP ${response.status})${detail}`,
    );
  }

  const deviceAuthId = response.data['device_auth_id'];
  const userCode = response.data['user_code'];
  const interval = Number(response.data['interval']);
  if (
    typeof deviceAuthId !== 'string' ||
    deviceAuthId.length === 0 ||
    typeof userCode !== 'string' ||
    userCode.length === 0 ||
    !Number.isFinite(interval) ||
    interval < 0
  ) {
    throw new OAuthError('Invalid OpenAI Codex device code response.');
  }

  return {
    userCode,
    deviceCode: JSON.stringify({ deviceAuthId, userCode } satisfies DeviceState),
    verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    verificationUriComplete: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    expiresIn: OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS,
    interval,
  };
}

export async function pollOpenAICodexDeviceToken(
  _config: OAuthFlowConfig,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DevicePollResult> {
  const device = parseDeviceState(deviceCode);
  const response = await fetchJson(
    fetchImpl,
    `${OPENAI_CODEX_OAUTH_HOST}/api/accounts/deviceauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
    },
  );

  if (response.ok) {
    const authorizationCode = response.data['authorization_code'];
    const codeVerifier = response.data['code_verifier'];
    if (typeof authorizationCode !== 'string' || typeof codeVerifier !== 'string') {
      throw new OAuthError('Invalid OpenAI Codex device token response.');
    }
    return {
      kind: 'success',
      token: await exchangeOpenAICodexAuthorizationCode(
        authorizationCode,
        codeVerifier,
        fetchImpl,
      ),
    };
  }

  const errorCode = readOpenAIErrorCode(response.data);
  if (
    response.status === 403 ||
    response.status === 404 ||
    errorCode === 'deviceauth_authorization_pending'
  ) {
    return { kind: 'pending', errorCode: 'authorization_pending', description: '' };
  }
  if (errorCode === 'slow_down') {
    return { kind: 'pending', errorCode: 'slow_down', description: '' };
  }
  throw new OAuthError(
    `OpenAI Codex device authorization failed (HTTP ${response.status})${
      response.text.length > 0 ? `: ${response.text}` : ''
    }`,
  );
}

export async function refreshOpenAICodexToken(
  _config: OAuthFlowConfig,
  refreshToken: string,
  _options: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenInfo> {
  return requestOpenAICodexToken(
    fetchImpl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
    'refresh',
  );
}

function toManagedModelInfo(model: OpenAICodexModel): ManagedKimiCodeModelInfo {
  return {
    id: model.id,
    contextLength: model.maxContextSize,
    maxOutputSize: model.maxOutputSize,
    supportsReasoning: model.capabilities.includes('thinking'),
    supportsImageIn: model.capabilities.includes('image_in'),
    supportsVideoIn: model.capabilities.includes('video_in'),
    supportsToolUse: model.capabilities.includes('tool_use'),
    supportEfforts: model.supportEfforts,
    defaultEffort: model.defaultEffort,
    displayName: model.displayName,
  };
}

function parseDeviceState(deviceCode: string): DeviceState {
  try {
    const value: unknown = JSON.parse(deviceCode);
    if (
      isRecord(value) &&
      typeof value['deviceAuthId'] === 'string' &&
      typeof value['userCode'] === 'string'
    ) {
      return { deviceAuthId: value['deviceAuthId'], userCode: value['userCode'] };
    }
  } catch {
    // Fall through to the stable protocol error below.
  }
  throw new OAuthError('Invalid OpenAI Codex device state.');
}

async function exchangeOpenAICodexAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: typeof fetch,
): Promise<TokenInfo> {
  return requestOpenAICodexToken(
    fetchImpl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URL,
    }),
    'exchange',
  );
}

async function requestOpenAICodexToken(
  fetchImpl: typeof fetch,
  body: URLSearchParams,
  operation: 'exchange' | 'refresh',
): Promise<TokenInfo> {
  const response = await fetchJson(fetchImpl, `${OPENAI_CODEX_OAUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const message = `OpenAI Codex token ${operation} failed (HTTP ${response.status})${
      response.text.length > 0 ? `: ${response.text}` : ''
    }`;
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.data['error'] === 'invalid_grant'
    ) {
      throw new OAuthUnauthorizedError(message);
    }
    throw new OAuthError(message);
  }

  const accessToken = response.data['access_token'];
  const nextRefreshToken = response.data['refresh_token'];
  const expiresIn = Number(response.data['expires_in']);
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof nextRefreshToken !== 'string' ||
    nextRefreshToken.length === 0 ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new OAuthError(`OpenAI Codex token ${operation} response is missing required fields.`);
  }
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: typeof response.data['scope'] === 'string' ? response.data['scope'] : '',
    tokenType:
      typeof response.data['token_type'] === 'string' ? response.data['token_type'] : 'Bearer',
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly data: Record<string, unknown>;
  readonly text: string;
}> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new OAuthConnectionError(
      `OpenAI Codex OAuth request to ${url} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) data = parsed;
    } catch {
      // Error messages retain the original response text.
    }
  }
  return { ok: response.ok, status: response.status, data, text };
}

function readOpenAIErrorCode(data: Record<string, unknown>): string | undefined {
  const error = data['error'];
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'];
  return undefined;
}
