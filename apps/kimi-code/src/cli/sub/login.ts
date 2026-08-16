/**
 * `kimi login` — drive the OAuth device-code flow non-interactively.
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

import { runLoginFlow } from './login-flow';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description('Authenticate with Kimi Code or OpenAI Codex via a device-code flow.')
    .argument('[provider]', 'kimi-code or openai-codex', 'kimi-code')
    .action(async (provider: string) => {
      const providerName =
        provider === 'kimi-code'
          ? KIMI_CODE_PROVIDER_NAME
          : provider === OPENAI_CODEX_PROVIDER_NAME
            ? OPENAI_CODEX_PROVIDER_NAME
            : undefined;
      if (providerName === undefined) {
        throw new Error(`Unknown OAuth provider "${provider}".`);
      }
      await runLoginFlow(providerName);
    });
}
