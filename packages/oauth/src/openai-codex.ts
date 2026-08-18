/**
 * OpenAI Codex subscription OAuth and its maintained model snapshot.
 *
 * The browser and device-code protocols follow Pi's MIT-licensed OpenAI
 * Codex provider.
 * Model churn is isolated in `openai-codex-models.json`; authentication and
 * config provisioning consume that data without embedding model ids.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

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
export const OPENAI_CODEX_BROWSER_REDIRECT_URL = 'http://localhost:1455/auth/callback';

const OPENAI_CODEX_DEVICE_REDIRECT_URL = `${OPENAI_CODEX_OAUTH_HOST}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS = 15 * 60;
const OPENAI_CODEX_BROWSER_TIMEOUT_MS = 15 * 60 * 1000;
const OPENAI_CODEX_BROWSER_SCOPE = 'openid profile email offline_access';
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

export type OpenAICodexLoginMethod = 'browser' | 'device-code';

export interface OpenAICodexBrowserAuthorization {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
}

export interface OpenAICodexBrowserLoginOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly onAuthorizationUrl?: (
    authorization: OpenAICodexBrowserAuthorization,
  ) => Promise<void> | void;
  readonly onManualCode?: (
    authorization: OpenAICodexBrowserAuthorization & { readonly signal: AbortSignal },
  ) => Promise<string | undefined>;
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

/**
 * Authenticate a ChatGPT subscription with OAuth authorization-code + PKCE.
 *
 * The registered callback is fixed at localhost:1455 to match Codex CLI
 * clients. A caller may additionally accept a pasted redirect URL/code, which
 * keeps the flow usable when the callback port is occupied or forwarded from
 * another machine.
 */
export async function loginOpenAICodexBrowser(
  options: OpenAICodexBrowserLoginOptions = {},
): Promise<TokenInfo> {
  throwIfBrowserLoginAborted(options.signal);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const authorizationUrl = createOpenAICodexAuthorizationUrl(challenge, state);
  const authorization = {
    authorizationUrl,
    redirectUri: OPENAI_CODEX_BROWSER_REDIRECT_URL,
  } satisfies OpenAICodexBrowserAuthorization;
  const callbackServer = await startOpenAICodexCallbackServer(state);
  const manualAbort = new AbortController();
  let timedOut = false;
  const cancelWait = (): void => {
    callbackServer.cancelWait();
    manualAbort.abort();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    cancelWait();
  }, OPENAI_CODEX_BROWSER_TIMEOUT_MS);
  timeout.unref();
  options.signal?.addEventListener('abort', cancelWait, { once: true });
  if (options.signal?.aborted === true) cancelWait();

  try {
    if (!callbackServer.listening && options.onManualCode === undefined) {
      const detail = callbackServer.bindError?.message;
      throw new OAuthError(
        `Unable to listen for the OpenAI OAuth callback on localhost:1455${
          detail === undefined ? '' : `: ${detail}`
        }. Retry with device-code login.`,
      );
    }

    await options.onAuthorizationUrl?.(authorization);

    let manualInput: string | undefined;
    let manualError: unknown;
    const manualPromise = options.onManualCode?.({
      ...authorization,
      signal: manualAbort.signal,
    })
      .then((input) => {
        manualInput = input;
        callbackServer.cancelWait();
      })
      .catch((error: unknown) => {
        if (!manualAbort.signal.aborted) manualError = error;
        callbackServer.cancelWait();
      });

    const callback = await callbackServer.waitForCode();
    if (callback?.kind === 'error') throw new OAuthError(callback.message);
    let code = callback?.kind === 'code' ? callback.code : undefined;

    if (code === undefined && manualPromise !== undefined) {
      await manualPromise;
      if (manualError !== undefined) {
        throw manualError instanceof Error
          ? manualError
          : new OAuthError('OpenAI browser login manual-code prompt failed.');
      }
      if (manualInput !== undefined) {
        const parsed = parseOpenAICodexAuthorizationInput(manualInput);
        if (parsed.state !== undefined && parsed.state !== state) {
          throw new OAuthError('OpenAI OAuth state mismatch.');
        }
        code = parsed.code;
      }
    }

    if (timedOut) {
      throw new OAuthError('OpenAI browser login timed out after 900s.');
    }
    throwIfBrowserLoginAborted(options.signal);
    if (code === undefined || code.length === 0) {
      throw new OAuthError('OpenAI browser login did not return an authorization code.');
    }
    return await exchangeOpenAICodexAuthorizationCode(
      code,
      verifier,
      OPENAI_CODEX_BROWSER_REDIRECT_URL,
      options.fetchImpl ?? fetch,
      options.signal,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancelWait);
    manualAbort.abort();
    await callbackServer.close();
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
        OPENAI_CODEX_DEVICE_REDIRECT_URL,
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
  redirectUri: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<TokenInfo> {
  return requestOpenAICodexToken(
    fetchImpl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
    'exchange',
    signal,
  );
}

async function requestOpenAICodexToken(
  fetchImpl: typeof fetch,
  body: URLSearchParams,
  operation: 'exchange' | 'refresh',
  signal?: AbortSignal,
): Promise<TokenInfo> {
  const response = await fetchJson(fetchImpl, `${OPENAI_CODEX_OAUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
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

function createOpenAICodexAuthorizationUrl(challenge: string, state: string): string {
  const url = new URL(`${OPENAI_CODEX_OAUTH_HOST}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', OPENAI_CODEX_BROWSER_REDIRECT_URL);
  url.searchParams.set('scope', OPENAI_CODEX_BROWSER_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'kimi-code');
  return url.toString();
}

function parseOpenAICodexAuthorizationInput(input: string): {
  readonly code?: string;
  readonly state?: string;
} {
  const value = input.trim();
  if (value.length === 0) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // Accept the compact and query-string forms used by CLI OAuth clients.
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
}

type OpenAICodexCallbackResult =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'error'; readonly message: string };

interface OpenAICodexCallbackServer {
  readonly listening: boolean;
  readonly bindError?: Error;
  readonly waitForCode: () => Promise<OpenAICodexCallbackResult | null>;
  readonly cancelWait: () => void;
  readonly close: () => Promise<void>;
}

function startOpenAICodexCallbackServer(state: string): Promise<OpenAICodexCallbackServer> {
  let settleWait: ((result: OpenAICodexCallbackResult | null) => void) | undefined;
  const waitPromise = new Promise<OpenAICodexCallbackResult | null>((resolve) => {
    let settled = false;
    settleWait = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
  });
  const server = createServer((request, response) => {
    const respond = (status: number, title: string, message: string): void => {
      response.statusCode = status;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(openAICodexCallbackHtml(title, message));
    };
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        respond(404, 'OpenAI login failed', 'Callback route not found.');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        respond(400, 'OpenAI login failed', 'OAuth state mismatch. Return to the terminal.');
        return;
      }
      const oauthError = url.searchParams.get('error');
      if (oauthError !== null) {
        respond(
          400,
          'OpenAI login failed',
          'Authorization was not completed. Return to the terminal.',
        );
        settleWait?.({
          kind: 'error',
          message: `OpenAI OAuth authorization failed: ${oauthError}`,
        });
        return;
      }
      const code = url.searchParams.get('code');
      if (code === null || code.length === 0) {
        respond(400, 'OpenAI login failed', 'Missing authorization code. Return to the terminal.');
        return;
      }
      respond(
        200,
        'OpenAI login complete',
        'Authentication completed. You can close this window.',
      );
      settleWait?.({ kind: 'code', code });
    } catch {
      respond(500, 'OpenAI login failed', 'Could not process the OAuth callback.');
    }
  });

  return new Promise((resolve) => {
    const finish = (listening: boolean, bindError?: Error): void => {
      resolve({
        listening,
        bindError,
        waitForCode: () => waitPromise,
        cancelWait: () => settleWait?.(null),
        close: async () => {
          if (!server.listening) return;
          await new Promise<void>((closeResolve) => {
            server.close(() => {
              closeResolve();
            });
          });
        },
      });
    };
    server
      .listen(1455, process.env['KIMI_CODE_OAUTH_CALLBACK_HOST'] ?? '127.0.0.1', () => {
        finish(true);
      })
      .once('error', (error: Error) => {
        settleWait?.(null);
        finish(false, error);
      });
  });
}

function openAICodexCallbackHtml(title: string, message: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width">',
    `<title>${title}</title></head><body><main><h1>${title}</h1>`,
    `<p>${message}</p></main></body></html>`,
  ].join('');
}

function throwIfBrowserLoginAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OAuthError('Login aborted by caller');
}
