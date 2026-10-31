import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  mapStopReason,
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
  type AnthropicLike,
  type AnthropicStream,
} from '../src/llm/anthropic.js';
import type { ChatMessage, StreamEvent } from '../src/llm/types.js';

describe('Anthropic translation', () => {
  it('concatenates system turns into top-level system', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'extra' },
    ];
    expect(toAnthropicSystem(messages)).toBe('persona\n\nextra');
    expect(toAnthropicSystem([{ role: 'user', content: 'hi' }])).toBeUndefined();
  });

  it('maps assistant tool_calls to tool_use blocks and merges consecutive tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'scan' },
      {
        role: 'assistant',
        content: 'calling tools',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.rs"}' } },
          { id: 't2', type: 'function', function: { name: 'grep', arguments: '{"q":"unwrap"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'contents of a.rs' },
      { role: 'tool', tool_call_id: 't2', content: 'match line 10' },
    ];
    const out = toAnthropicMessages(messages);
    // user, assistant(text+2 tool_use), user(2 tool_result merged)
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'user', content: 'scan' });

    const assistant = out[1]!;
    expect(assistant.role).toBe('assistant');
    const blocks = assistant.content as Array<{ type: string; name?: string; input?: unknown }>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'calling tools' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.rs' } });
    expect(blocks[2]).toMatchObject({ type: 'tool_use', id: 't2', name: 'grep' });

    const toolTurn = out[2]!;
    expect(toolTurn.role).toBe('user');
    const results = toolTurn.content as Array<{ type: string; tool_use_id: string }>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(results[1]).toMatchObject({ type: 'tool_result', tool_use_id: 't2' });
  });

  it('tolerates malformed tool-call arguments by passing an empty object', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: 'not json' } }] },
    ]);
    const blocks = out[0]!.content as Array<{ type: string; input?: unknown }>;
    expect(blocks[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('maps tool specs and stop reasons', () => {
    const tools = toAnthropicTools([
      { type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } },
    ]);
    expect(tools).toEqual([{ name: 'read_file', description: 'read a file', input_schema: { type: 'object' } }]);
    expect(toAnthropicTools([])).toBeUndefined();

    expect(mapStopReason('tool_use')).toBe('tool_calls');
    expect(mapStopReason('max_tokens')).toBe('length');
    expect(mapStopReason('end_turn')).toBe('stop');
    expect(mapStopReason(null)).toBe('stop');
  });
});

/** Minimal fake of the SDK's stream: scripted events + a finalMessage. */
function fakeClient(events: unknown[], finalMessage: unknown): AnthropicLike {
  const stream: AnthropicStream = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event as never;
    },
    async finalMessage() {
      return finalMessage as never;
    },
  };
  return { messages: { stream: () => stream } };
}

describe('AnthropicProvider.chat', () => {
  it('streams text, then emits tool calls, usage and done from the final message', async () => {
    const client = fakeClient(
      [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Look' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ing...' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'ignored' } },
      ],
      {
        content: [
          { type: 'text', text: 'Looking...' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'main.rs' } },
        ],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
        stop_reason: 'tool_use',
      },
    );

    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', client });
    const events: StreamEvent[] = [];
    for await (const event of provider.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }

    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('Looking...');

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect((toolCall as { call: { function: { name: string; arguments: string } } }).call.function).toEqual({
      name: 'read_file',
      arguments: '{"path":"main.rs"}',
    });

    const usage = events.find((e) => e.type === 'usage') as { usage: { promptTokens: number; completionTokens: number } };
    expect(usage.usage.promptTokens).toBe(105); // input + cache_read
    expect(usage.usage.completionTokens).toBe(20);

    const done = events.find((e) => e.type === 'done') as { finishReason: string };
    expect(done.finishReason).toBe('tool_calls');
  });

  it('reports a plain end_turn with no tool calls', async () => {
    const client = fakeClient([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } }], {
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 10, output_tokens: 2 },
      stop_reason: 'end_turn',
    });
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', client });
    const events: StreamEvent[] = [];
    for await (const event of provider.chat({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect((events.find((e) => e.type === 'done') as { finishReason: string }).finishReason).toBe('stop');
  });
});
