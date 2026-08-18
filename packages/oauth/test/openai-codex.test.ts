import { describe, expect, it, vi } from 'vitest';

import {
  applyOpenAICodexConfig,
  applyOpenAICodexLogoutConfig,
  loginOpenAICodexBrowser,
  openAICodexAccountId,
  openAICodexCatalog,
  openAICodexRequestAuth,
  OPENAI_CODEX_FLOW_CONFIG,
  OPENAI_CODEX_BROWSER_REDIRECT_URL,
  OPENAI_CODEX_PROVIDER_NAME,
  pollOpenAICodexDeviceToken,
  refreshOpenAICodexToken,
  requestOpenAICodexDeviceAuthorization,
  type ManagedKimiConfigShape,
} from '../src';

function accessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('OpenAI Codex model catalog', () => {
  it('provisions and removes the provider from the maintained JSON snapshot', () => {
    const config: ManagedKimiConfigShape = {
      providers: { custom: { type: 'kimi', apiKey: 'sk-custom' } },
      models: {
        custom: {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = applyOpenAICodexConfig(config);
    const catalog = openAICodexCatalog();

    expect(result.defaultModel).toBe(`${OPENAI_CODEX_PROVIDER_NAME}/${catalog.defaultModel}`);
    expect(config.providers[OPENAI_CODEX_PROVIDER_NAME]).toMatchObject({
      type: 'openai_responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      oauth: {
        storage: 'file',
        key: 'oauth/openai-codex',
        oauthHost: 'https://auth.openai.com',
      },
    });
    expect(config.models?.['openai-codex/gpt-5.6-sol']).toMatchObject({
      provider: OPENAI_CODEX_PROVIDER_NAME,
      maxContextSize: 272000,
      maxOutputSize: 128000,
      supportEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });

    applyOpenAICodexLogoutConfig(config);
    expect(config.providers[OPENAI_CODEX_PROVIDER_NAME]).toBeUndefined();
    expect(config.models?.['openai-codex/gpt-5.6-sol']).toBeUndefined();
    expect(config.models?.['custom']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
  });
});

describe('OpenAI Codex request auth', () => {
  it('derives the ChatGPT account header from the access-token JWT', () => {
    const token = accessToken('acct-test');
    expect(openAICodexAccountId(token)).toBe('acct-test');
    expect(openAICodexRequestAuth(token)).toEqual({
      apiKey: token,
      sessionAffinity: 'openai-codex',
      headers: {
        'chatgpt-account-id': 'acct-test',
        originator: 'kimi-code',
        'OpenAI-Beta': 'responses=experimental',
      },
    });
  });
});

describe('OpenAI Codex browser OAuth', () => {
  it('uses authorization-code PKCE and accepts a pasted redirect URL', async () => {
    const jwt = accessToken('acct-browser');
    let openedUrl: string | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe('https://auth.openai.com/oauth/token');
      const body = new URLSearchParams(init?.body as URLSearchParams);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('browser-code');
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.get('redirect_uri')).toBe(OPENAI_CODEX_BROWSER_REDIRECT_URL);
      return Response.json({
        access_token: jwt,
        refresh_token: 'refresh-browser',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    });

    await expect(
      loginOpenAICodexBrowser({
        fetchImpl: fetchMock,
        onAuthorizationUrl: ({ authorizationUrl }) => {
          openedUrl = authorizationUrl;
        },
        onManualCode: async ({ authorizationUrl, redirectUri, signal }) => {
          expect(signal.aborted).toBe(false);
          const state = new URL(authorizationUrl).searchParams.get('state');
          return `${redirectUri}?code=browser-code&state=${state}`;
        },
      }),
    ).resolves.toMatchObject({
      accessToken: jwt,
      refreshToken: 'refresh-browser',
      expiresIn: 3600,
    });

    const authorization = new URL(openedUrl!);
    expect(authorization.origin + authorization.pathname).toBe(
      'https://auth.openai.com/oauth/authorize',
    );
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      OPENAI_CODEX_BROWSER_REDIRECT_URL,
    );
    expect(authorization.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(authorization.searchParams.get('originator')).toBe('kimi-code');
  });

  it('rejects a pasted redirect URL with a mismatched OAuth state', async () => {
    await expect(
      loginOpenAICodexBrowser({
        onManualCode: async ({ redirectUri }) =>
          `${redirectUri}?code=browser-code&state=wrong-state`,
      }),
    ).rejects.toThrow('state mismatch');
  });
});

describe('OpenAI Codex device OAuth', () => {
  it('requests a device code, exchanges approval, and refreshes tokens', async () => {
    const jwt = accessToken('acct-device');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        return Response.json({ authorization_code: 'auth-code', code_verifier: 'verifier' });
      }
      if (url.endsWith('/oauth/token')) {
        const body = new URLSearchParams(init?.body as string);
        return Response.json({
          access_token: jwt,
          refresh_token:
            body.get('grant_type') === 'refresh_token' ? 'refresh-2' : 'refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const device = await requestOpenAICodexDeviceAuthorization(
      OPENAI_CODEX_FLOW_CONFIG,
      fetchMock,
    );
    expect(device).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
      interval: 1,
    });

    const polled = await pollOpenAICodexDeviceToken(
      OPENAI_CODEX_FLOW_CONFIG,
      device.deviceCode,
      fetchMock,
    );
    expect(polled).toMatchObject({
      kind: 'success',
      token: { accessToken: jwt, refreshToken: 'refresh-1', expiresIn: 3600 },
    });

    await expect(
      refreshOpenAICodexToken(
        OPENAI_CODEX_FLOW_CONFIG,
        'refresh-1',
        undefined,
        fetchMock,
      ),
    ).resolves.toMatchObject({ accessToken: jwt, refreshToken: 'refresh-2' });
  });
});
