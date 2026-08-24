import { describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentPromptService, type PromptHandle } from '#/agent/prompt/prompt';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { runAgentTurn, AGENT_RUN_PROMPT_ORIGIN } from '#/session/subagent/runAgentTurn';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';

function createTurn(
  id: number,
  result: TurnResult = { type: 'completed', steps: 1, truncated: false },
): Turn {
  return {
    id,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result: Promise.resolve(result),
    cancel: () => true,
  };
}

function createMockAgentHandle(options: {
  readonly onEnqueue?: (message: unknown) => Turn;
  readonly onRetry?: () => Turn;
  readonly getMessages: () => readonly ContextMessage[];
  readonly onCancel?: (turnId?: number, reason?: unknown) => void;
}): IAgentScopeHandle {
  const promptService: Partial<IAgentPromptService> = {
    enqueue: vi.fn(async (opts) => {
      const turn = options.onEnqueue?.(opts.message) ?? createTurn(1);
      const handle: PromptHandle = {
        id: 'prompt-1',
        userMessageId: 'msg-1',
        createdAt: new Date().toISOString(),
        state: 'completed',
        message: opts.message,
        launched: Promise.resolve(turn),
        completion: Promise.resolve({
          promptId: 'prompt-1',
          result: { type: 'completed', steps: 1, truncated: false },
          state: 'completed',
        }),
      };
      return handle;
    }),
    retry: vi.fn(async () => {
      return options.onRetry?.() ?? createTurn(2);
    }),
  };

  const loopService: Partial<IAgentLoopService> = {
    cancel: vi.fn((turnId?: number, reason?: unknown) => {
      options.onCancel?.(turnId, reason);
      return true;
    }),
  };

  const memoryService: Partial<IAgentContextMemoryService> = {
    get: vi.fn(() => options.getMessages()),
  };

  return {
    id: 'agent-child-1',
    kind: LifecycleScope.Agent,
    accessor: {
      get: (token: unknown) => {
        if (token === IAgentPromptService) return promptService as IAgentPromptService;
        if (token === IAgentLoopService) return loopService as IAgentLoopService;
        if (token === IAgentContextMemoryService) return memoryService as IAgentContextMemoryService;
        return undefined;
      },
    } as IAgentScopeHandle['accessor'],
    dispose: () => {},
  };
}

describe('runAgentTurn', () => {
  it('returns short non-empty response directly without continuation request', async () => {
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'do work' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
      },
    ];

    const onEnqueue = vi.fn(() => createTurn(1));
    const target = createMockAgentHandle({
      onEnqueue,
      getMessages: () => messages,
    });

    const summaryPolicy: AgentProfileSummaryPolicy = {
      continuationPrompt: 'Please provide a textual summary.',
      retries: 1,
    };

    const handle = await runAgentTurn(
      target,
      { kind: 'prompt', prompt: 'do work' },
      { signal: new AbortController().signal, summaryPolicy },
    );

    expect(handle.agentId).toBe('agent-child-1');
    const result = await handle.completion;
    expect(result.summary).toBe('done');
    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onEnqueue).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'do work' }],
      toolCalls: [],
      origin: AGENT_RUN_PROMPT_ORIGIN,
    });
  });

  it('prompts once for summary when first turn has no textual summary, and returns the continuation summary', async () => {
    let callCount = 0;
    const messages: ContextMessage[] = [];

    const onEnqueue = vi.fn((_message: unknown) => {
      callCount++;
      if (callCount === 1) {
        messages.push(
          {
            role: 'user',
            content: [{ type: 'text', text: 'investigate' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          {
            role: 'assistant',
            content: [],
            toolCalls: [],
          },
        );
        return createTurn(1);
      }

      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the summary of the investigation.' }],
        toolCalls: [],
      });
      return createTurn(2);
    });

    const target = createMockAgentHandle({
      onEnqueue,
      getMessages: () => messages,
    });

    const summaryPolicy: AgentProfileSummaryPolicy = {
      continuationPrompt:
        'Your previous response did not include a textual summary. Please provide a concise textual summary that includes:\n\n1. Specific technical details and implementations\n2. Detailed findings and analysis\n3. All important information that the parent agent should know',
      retries: 1,
    };

    const handle = await runAgentTurn(
      target,
      { kind: 'prompt', prompt: 'investigate' },
      { signal: new AbortController().signal, summaryPolicy },
    );

    const result = await handle.completion;
    expect(result.summary).toBe('Here is the summary of the investigation.');
    expect(onEnqueue).toHaveBeenCalledTimes(2);
    expect(onEnqueue).toHaveBeenNthCalledWith(1, {
      role: 'user',
      content: [{ type: 'text', text: 'investigate' }],
      toolCalls: [],
      origin: AGENT_RUN_PROMPT_ORIGIN,
    });
    expect(onEnqueue).toHaveBeenNthCalledWith(2, {
      role: 'user',
      content: [{ type: 'text', text: summaryPolicy.continuationPrompt }],
      toolCalls: [],
      origin: AGENT_RUN_PROMPT_ORIGIN,
    });
  });

  it('stops retrying when continuation retries are exhausted without textual summary', async () => {
    let callCount = 0;
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'task' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [],
      },
    ];

    const onEnqueue = vi.fn(() => {
      callCount++;
      return createTurn(callCount);
    });

    const target = createMockAgentHandle({
      onEnqueue,
      getMessages: () => messages,
    });

    const summaryPolicy: AgentProfileSummaryPolicy = {
      continuationPrompt: 'Please provide a textual summary.',
      retries: 1,
    };

    const handle = await runAgentTurn(
      target,
      { kind: 'prompt', prompt: 'task' },
      { signal: new AbortController().signal, summaryPolicy },
    );

    const result = await handle.completion;
    expect(result.summary).toBe('');
    expect(onEnqueue).toHaveBeenCalledTimes(2);
  });

  it('returns summary directly when summaryPolicy is undefined', async () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'quick done' }],
        toolCalls: [],
      },
    ];

    const onEnqueue = vi.fn(() => createTurn(1));
    const target = createMockAgentHandle({
      onEnqueue,
      getMessages: () => messages,
    });

    const handle = await runAgentTurn(
      target,
      { kind: 'prompt', prompt: 'quick task' },
      { signal: new AbortController().signal },
    );

    const result = await handle.completion;
    expect(result.summary).toBe('quick done');
    expect(onEnqueue).toHaveBeenCalledTimes(1);
  });

  it('supports retry request kind', async () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'retried result' }],
        toolCalls: [],
      },
    ];

    const onRetry = vi.fn(() => createTurn(2));
    const target = createMockAgentHandle({
      onRetry,
      getMessages: () => messages,
    });

    const handle = await runAgentTurn(
      target,
      { kind: 'retry' },
      { signal: new AbortController().signal },
    );

    const result = await handle.completion;
    expect(result.summary).toBe('retried result');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
