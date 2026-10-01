import { describe, expect, it } from 'vitest';
import { flattenToPrompt, SubscriptionProvider, type QueryFn } from '../src/llm/subscription.js';
import type { StreamEvent } from '../src/llm/types.js';

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('flattenToPrompt', () => {
  it('splits system out and renders the transcript as labeled sections', () => {
    const { system, prompt } = flattenToPrompt([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'do a thing' },
      { role: 'assistant', content: 'working on it' },
      { role: 'tool', tool_call_id: 'c1', content: 'tool output' },
      { role: 'user', content: 'continue' },
    ]);
    expect(system).toBe('be helpful');
    expect(prompt).toBe('[user]\ndo a thing\n\n[assistant]\nworking on it\n\n[tool result]\ntool output\n\n[user]\ncontinue');
  });
});

describe('SubscriptionProvider', () => {
  const sdkRun = (messages: unknown[]): QueryFn => {
    return async function* () {
      yield* messages as never[];
    };
  };

  it('passes a tools-disabled single-turn query and scrubs ANTHROPIC_API_KEY from the SDK env', async () => {
    let capturedOptions: Record<string, unknown> = {};
    let capturedPrompt = '';
    const queryFn: QueryFn = ({ prompt, options }) => {
      capturedPrompt = prompt;
      capturedOptions = options;
      return sdkRun([{ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }])({
        prompt,
        options,
      });
    };

    const provider = new SubscriptionProvider({
      model: 'claude-sonnet-4-5',
      queryFn,
      env: { ANTHROPIC_API_KEY: 'ant-key-12345', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-12345', PATH: '/bin' },
    });
    await collect(
      provider.chat({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );

    expect(capturedPrompt).toBe('[user]\nhi');
    expect(capturedOptions['systemPrompt']).toBe('sys');
    expect(capturedOptions['allowedTools']).toEqual([]);
    expect(capturedOptions['maxTurns']).toBe(1);
    expect(capturedOptions['model']).toBe('claude-sonnet-4-5');
    const env = capturedOptions['env'] as NodeJS.ProcessEnv;
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-12345');
    expect(env['PATH']).toBe('/bin');
  });

  it('yields assistant text, usage with cost, then done', async () => {
    const queryFn = sdkRun([
      { type: 'system' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } },
      { type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const provider = new SubscriptionProvider({ model: 'claude-sonnet-4-5', queryFn, env: {} });
    const events = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(events).toEqual([
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, cost: 0 } },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('surfaces a non-success result as a clear error', async () => {
    const queryFn = sdkRun([{ type: 'result', subtype: 'error_during_execution', result: 'rate limited' }]);
    const provider = new SubscriptionProvider({ model: 'claude-sonnet-4-5', queryFn, env: {} });
    await expect(collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(
      /error_during_execution.*rate limited/,
    );
  });

  it('without the SDK installed, chat() fails with an install hint', async () => {
    // no queryFn injected — the dynamic import of the optional dependency must fail cleanly
    const provider = new SubscriptionProvider({ model: 'claude-sonnet-4-5', env: {} });
    await expect(collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(
      /npm install @anthropic-ai\/claude-agent-sdk/,
    );
  });

  it('is not a native-tools provider (must be wrapped in PromptToolAdapter)', () => {
    const provider = new SubscriptionProvider({ model: 'claude-sonnet-4-5', env: {} });
    expect(provider.capabilities.nativeTools).toBe(false);
  });
});
