/**
 * Shared login flow used by both `kimi login` (top-level subcommand) and
 * `kimi acp --login` (the first-class ACP terminal-auth entry point). ACP and
 * Kimi Code keep using device-code auth; OpenAI Codex defaults to browser
 * OAuth. Exiting the process is part of the contract — callers MUST treat the
 * returned promise as `Promise<never>`.
 */

import { createInterface } from 'node:readline/promises';

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import {
  KIMI_CODE_PROVIDER_NAME,
  OPENAI_CODEX_PROVIDER_NAME,
  type OpenAICodexLoginMethod,
} from '@moonshot-ai/kimi-code-oauth';

import { createKimiCodeHostIdentity } from '#/cli/version';
import { openUrl } from '#/utils/open-url';

export async function runLoginFlow(
  providerName: string = KIMI_CODE_PROVIDER_NAME,
  requestedMethod?: OpenAICodexLoginMethod,
): Promise<never> {
  const providerLabel =
    providerName === OPENAI_CODEX_PROVIDER_NAME ? 'OpenAI Codex' : 'Kimi Code';
  const loginMethod =
    providerName === OPENAI_CODEX_PROVIDER_NAME ? requestedMethod ?? 'browser' : 'device-code';
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    const result = await harness.auth.login(providerName, {
      signal: controller.signal,
      loginMethod,
      onAuthorizationUrl: ({ authorizationUrl, redirectUri }) => {
        process.stderr.write(
          [
            '',
            `Opening browser for ${providerLabel} login: ${authorizationUrl}`,
            `Waiting for the callback at ${redirectUri}...`,
            '',
          ].join('\n'),
        );
        try {
          openUrl(authorizationUrl);
        } catch {
          // Best effort only: the URL has already been printed.
        }
      },
      onManualCode:
        loginMethod === 'browser' && process.stdin.isTTY
          ? ({ redirectUri, signal }) => promptForOpenAICodexRedirect(redirectUri, signal)
          : undefined,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
        process.stderr.write(
          [
            '',
            `Opening browser for ${providerLabel} device login: ${url}`,
            `If the browser did not open, paste the URL above and enter code: ${data.userCode}`,
            data.expiresIn !== null && data.expiresIn !== undefined
              ? `Code expires in ${data.expiresIn}s.`
              : undefined,
            'Waiting for authorization to complete...',
            '',
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        );
        try {
          openUrl(url);
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    process.stderr.write(`Logged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}

async function promptForOpenAICodexRedirect(
  redirectUri: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await readline.question(
      `Complete login in the browser, or paste the authorization code / redirect URL here\n(${redirectUri}): `,
      { signal },
    );
  } catch (error) {
    if (signal.aborted) return undefined;
    throw error;
  } finally {
    readline.close();
  }
}
