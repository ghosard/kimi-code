/**
 * `kimi login` — drive an OAuth login flow outside the TUI.
 * The `authMethods.terminal-auth.args=['login']` (legacy `_meta` path)
 * advertised by the ACP server points clients at this entry point. The
 * first-class ACP `args=['--login']` path enters the same flow via
 * `kimi acp --login`.
 */

import type { Command } from 'commander';
import {
  KIMI_CODE_PROVIDER_NAME,
  OPENAI_CODEX_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';

import { parseRegionFlag, runLoginFlow } from './login-flow';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description('Authenticate with Kimi Code or OpenAI Codex.')
    .argument('[provider]', 'kimi-code or openai-codex', 'kimi-code')
    .option('--method <method>', 'OpenAI Codex login method: browser or device-code')
    .option(
      '--region <region>',
      'Kimi Code login region: "mainland-cn" (kimi.com) or "global" (kimi.ai).',
    )
    .action(
      async (
        provider: string,
        opts: { readonly method?: string; readonly region?: string },
      ) => {
        const providerName =
          provider === 'kimi-code'
            ? KIMI_CODE_PROVIDER_NAME
            : provider === OPENAI_CODEX_PROVIDER_NAME
              ? OPENAI_CODEX_PROVIDER_NAME
              : undefined;
        if (providerName === undefined) {
          throw new Error(`Unknown OAuth provider "${provider}".`);
        }
        const method = opts.method;
        if (method !== undefined && method !== 'browser' && method !== 'device-code') {
          throw new Error(`Unknown OpenAI Codex login method "${method}".`);
        }
        if (providerName !== OPENAI_CODEX_PROVIDER_NAME && method !== undefined) {
          throw new Error('--method is only supported for openai-codex.');
        }
        if (providerName === OPENAI_CODEX_PROVIDER_NAME && opts.region !== undefined) {
          throw new Error('--region is only supported for kimi-code.');
        }
        await runLoginFlow({
          providerName,
          loginMethod: method,
          region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
        });
      },
    );
}
