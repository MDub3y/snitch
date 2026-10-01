import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../src/llm/openrouter.js';
import type { StreamEvent } from '../src/llm/types.js';

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function sseResponse(): Response {
  return new Response(new Blob(['data: [DONE]\n']).stream(), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouterProvider wire dialects', () => {
  async function capture(flavor: 'openrouter' | 'openai' | undefined, baseUrl?: string) {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return sseResponse();
    });
    const provider = new OpenRouterProvider({
      apiKey: 'key-12345678',
      model: 'm',
      ...(flavor ? { flavor } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    const body = JSON.parse(captured!.init.body as string);
    const headers = captured!.init.headers as Record<string, string>;
    return { url: captured!.url, body, headers };
  }

  it('openrouter flavor (default): usage param, X-Title header, openrouter.ai base', async () => {
    const { url, body, headers } = await capture(undefined);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body.usage).toEqual({ include: true });
    expect(body.stream_options).toBeUndefined();
    expect(headers['X-Title']).toBe('Snitch');
  });

  it('openai flavor: stream_options instead of the OpenRouter-only usage param, no X-Title', async () => {
    const { body, headers } = await capture('openai', 'https://api.openai.com/v1');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.usage).toBeUndefined();
    expect(headers['X-Title']).toBeUndefined();
  });

  it('openai flavor 401 names OPENAI_API_KEY', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }));
    const provider = new OpenRouterProvider({ apiKey: 'bad-12345678', model: 'm', flavor: 'openai' });
    await expect(collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow(
      /OpenAI rejected the API key.*OPENAI_API_KEY/,
    );
  });
});
