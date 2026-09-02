import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../src/llm/retry.js';
import { ApiError } from '../src/util/errors.js';

describe('fetchWithRetry', () => {
  it('returns immediately on success', async () => {
    const doFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const response = await fetchWithRetry(doFetch, { baseDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 then succeeds, reporting via onRetry', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const doFetch = vi.fn(async () =>
      ++calls < 3 ? new Response('slow down', { status: 429 }) : new Response('ok', { status: 200 }),
    );
    const response = await fetchWithRetry(doFetch, { baseDelayMs: 1, onRetry });
    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, status: 429 });
  });

  it('honours a numeric Retry-After header', async () => {
    let calls = 0;
    const doFetch = async () =>
      ++calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : new Response('ok', { status: 200 });
    const started = Date.now();
    const response = await fetchWithRetry(doFetch, { baseDelayMs: 5000 });
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000); // used the 0s header, not 5s backoff
  });

  it('does not retry non-retryable statuses', async () => {
    const doFetch = vi.fn(async () => new Response('bad request', { status: 400 }));
    const response = await fetchWithRetry(doFetch, { baseDelayMs: 1 });
    expect(response.status).toBe(400);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError after exhausting attempts', async () => {
    const doFetch = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(fetchWithRetry(doFetch, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow(ApiError);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});
