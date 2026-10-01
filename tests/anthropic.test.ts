import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, parseAnthropicChunks, toAnthropicMessages } from '../src/llm/anthropic.js';
import type { ChatMessage, StreamEvent } from '../src/llm/types.js';

function sseStream(events: { event: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Blob([text]).stream() as ReadableStream<Uint8Array>;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('toAnthropicMessages', () => {
  it('extracts system, converts tool calls and results, and merges consecutive roles', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'read a file' },
      {
        role: 'assistant',
        content: 'reading',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
          { id: 'c2', type: 'function', function: { name: 'glob', arguments: 'not json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: bad args' },
    ];
    const { system, messages } = toAnthropicMessages(history);

    expect(system).toBe('be helpful');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'read a file' }] });
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'c2', name: 'glob', input: {} }, // malformed args degrade to {}
    ]);
    // the two consecutive tool results merge into one user turn (API requires alternation)
    expect(messages[2]!.role).toBe('user');
    expect(messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'file contents' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'Error: bad args' },
    ]);
  });
});

describe('parseAnthropicChunks', () => {
  it('yields text deltas, accumulates tool input across deltas, and maps stop reasons', async () => {
    const body = sseStream([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 42 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop' } },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop' } },
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const events = await collect(parseAnthropicChunks(body));
    expect(events).toEqual([
      { type: 'text', delta: 'hi ' },
      { type: 'text', delta: 'there' },
      {
        type: 'tool_call',
        call: { id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      },
      { type: 'usage', usage: { promptTokens: 42, completionTokens: 7 } },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('maps end_turn to stop and max_tokens to length', async () => {
    const make = (stopReason: string) =>
      collect(
        parseAnthropicChunks(
          sseStream([{ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason } } }]),
        ),
      );
    expect((await make('end_turn')).at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect((await make('max_tokens')).at(-1)).toEqual({ type: 'done', finishReason: 'length' });
  });

  it('throws on a mid-stream error event', async () => {
    const body = sseStream([
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]);
    await expect(collect(parseAnthropicChunks(body))).rejects.toThrow(/Overloaded/);
  });
});

describe('AnthropicProvider requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the Messages API shape with the right headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(sseStream([{ event: 'message_stop', data: { type: 'message_stop' } }]), { status: 200 });
    });

    const provider = new AnthropicProvider({ apiKey: 'ant-key-12345', model: 'claude-sonnet-4-5' });
    await collect(
      provider.chat({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        tools: [{ type: 'function', function: { name: 'glob', description: 'find files', parameters: { type: 'object' } } }],
      }),
    );

    const { url, init } = captured!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ant-key-12345');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('sys');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([{ name: 'glob', description: 'find files', input_schema: { type: 'object' } }]);
  });

  it('turns a 401 into a clear ANTHROPIC_API_KEY message', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }));
    const provider = new AnthropicProvider({ apiKey: 'bad-key-12345', model: 'claude-sonnet-4-5' });
    await expect(collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
