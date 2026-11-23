import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { model, strategies } from './setup.mjs';

const toolName = 'select_claude_code_strategy';

export async function chooseStrategy(request, base, token) {
  let selected;
  let called = false;
  const tool = {
    name: toolName,
    label: 'Select the Claude Code routing strategy',
    description: 'Plan a Claude Code configuration with one APIHub Auto routing strategy.',
    parameters: {
      type: 'object',
      properties: { strategy: { type: 'string', enum: strategies } },
      required: ['strategy'],
      additionalProperties: false,
    },
    execute: async (_id, { strategy }) => {
      if (!strategies.includes(strategy)) throw new Error('Unknown strategy.');
      if (selected !== undefined && selected !== strategy) {
        selected = null;
      } else {
        selected = strategy;
      }
      return { content: [{ type: 'text', text: 'Strategy proposed.' }], details: {}, terminate: true };
    },
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: [
        'Interpret the user request for configuring Claude Code with the APIHub Auto virtual model.',
        'If supported, call select_claude_code_strategy once.',
        'Use optimal for balanced or unspecified, cheaper for lowest price, faster for speed, reliable for reliability.',
        'The only supported target is Claude Code CLI. Decline unsupported targets or actions.',
        'Never ask for credentials.',
      ].join(' '),
      model: {
        id: model,
        name: 'APIHub Auto',
        api: 'anthropic-messages',
        provider: 'apihub',
        baseUrl: base,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 512,
        reasoning: false,
      },
      tools: [tool],
      thinkingLevel: 'off',
    },
    toolExecution: 'sequential',
    identity: { attribution: null },
    streamFn: (agentModel, context, options) => {
      if (called) throw new Error('Agent request budget exhausted.');
      called = true;
      return streamSimple(agentModel, context, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'X-APIHub-Strategy': 'reliable' },
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)].filter(Boolean)),
        maxRetries: 0,
        maxTokens: 512,
      });
    },
  });

  try {
    await agent.prompt(request);
  } catch {
    throw new Error('Pi could not reach APIHub Auto. Check your key and gateway.');
  }
  if (agent.state.errorMessage) {
    throw new Error('Pi could not get a response from APIHub Auto. Check your key and gateway.');
  }
  if (!selected) {
    throw new Error('Pi did not propose a supported Claude Code configuration.');
  }
  return selected;
}
