import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('wires the tower control tools into the default profile', () => {
    const agent = profile('agent');
    expect(agent.tools).toContain('TowerInit');
    expect(agent.tools).toContain('TowerStatus');
    expect(agent.tools).toContain('TowerTeardown');
  });

  it('caps the default profile delegation at non-spawning profiles', () => {
    const agent = profile('agent');
    expect(agent.subagents).toEqual(['coder', 'explore', 'plan']);
  });

  it('configures subagent summary policy without minChars and without length penalty prompt', () => {
    const coder = profile('coder');
    expect(coder.summaryPolicy).toBeDefined();
    expect(coder.summaryPolicy?.retries).toBe(1);
    expect(coder.summaryPolicy?.continuationPrompt).toContain(
      'Your previous response did not include a textual summary.',
    );
    expect('minChars' in (coder.summaryPolicy ?? {})).toBe(false);

    const coderPrompt = coder.systemPrompt({ cwd: '/test' });
    expect(coderPrompt).toContain('Your final message is the entire handoff');
    expect(coderPrompt).not.toContain('too brief');
    expect(coderPrompt).not.toContain('sentence or two');

    const explore = profile('explore');
    expect(explore.summaryPolicy).toEqual(coder.summaryPolicy);
  });
});
