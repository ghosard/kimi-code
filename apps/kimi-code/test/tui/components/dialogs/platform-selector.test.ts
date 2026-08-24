import { describe, expect, it, vi } from 'vitest';

import { PlatformSelectorComponent } from '#/tui/components/dialogs/platform-selector';

const ANSI = /\u001B\[[0-9;]*m/g;

describe('PlatformSelectorComponent', () => {
  it('offers Kimi Code and OpenAI Codex OAuth login', () => {
    const selector = new PlatformSelectorComponent({
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const text = selector.render(120).join('\n').replaceAll(ANSI, '');

    expect(text).toContain('Kimi Code (kimi.com/code)');
    expect(text).toContain('Kimi Code (kimi.ai/code)');
    expect(text).toContain('OpenAI Codex (ChatGPT OAuth)');
  });
});
