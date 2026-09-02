import { describe, expect, it } from 'vitest';
import { OpenRouterProvider, parseSSE, ToolCallAccumulator } from '../src/llm/openrouter.js';
import type { StreamEvent } from '../src/llm/types.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('parseSSE', () => {
  it('yields data payloads and stops at [DONE]', async () => {
    const payloads = await collect(
      parseSSE(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"never":true}\n\n'])),
    );
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles events split across arbitrary chunk boundaries', async () => {
    const event = 'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n';
    const chunks = [event.slice(0, 3), event.slice(3, 17), event.slice(17, 18), event.slice(18)];
    const payloads = await collect(parseSSE(streamOf(chunks)));
    expect(payloads).toEqual(['{"choices":[{"delta":{"content":"hello world"}}]}']);
  });

  it('handles CRLF line endings and ignores comment lines', async () => {
    const payloads = await collect(parseSSE(streamOf([': keep-alive\r\ndata: {"x":1}\r\n\r\ndata: [DONE]\r\n'])));
    expect(payloads).toEqual(['{"x":1}']);
  });
});

describe('ToolCallAccumulator', () => {
  it('reassembles fragmented arguments and preserves index order', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 1, id: 'call_b', function: { name: 'grep', arguments: '{"pat' } });
    acc.add({ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":' } });
    acc.add({ index: 0, function: { arguments: '"a.ts"}' } });
    acc.add({ index: 1, function: { arguments: 'tern":"x"}' } });

    expect(acc.drain()).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
    ]);
    expect(acc.drain()).toEqual([]);
  });
});

describe('OpenRouterProvider', () => {
  function providerWithResponse(body: ReadableStream<Uint8Array>): OpenRouterProvider {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test/model' });
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    return provider;
  }

  it('streams text deltas then usage and done', async () => {
    const provider = providerWithResponse(
      streamOf([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.000001}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(events).toEqual<StreamEvent[]>([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'usage', usage: { promptTokens: 5, completionTokens: 2, cost: 0.000001 } },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('accumulates streamed tool-call deltas into complete calls', async () => {
    const provider = providerWithResponse(
      streamOf([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"hi.txt\\","}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(events).toEqual<StreamEvent[]>([
      {
        type: 'tool_call',
        call: {
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"hi.txt","content":"hi"}' },
        },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('turns a 401 into a clear API-key error', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'bad-key', model: 'test/model' });
    globalThis.fetch = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as typeof fetch;
    await expect(collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(
      /API key/,
    );
  });
});
