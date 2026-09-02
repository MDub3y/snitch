import { ApiError } from '../util/errors.js';
import type { RetryInfo } from './types.js';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: RetryInfo) => void;
}

function retryDelayMs(response: Response, attempt: number, base: number, max: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, max);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), max);
  }
  const backoff = base * 2 ** (attempt - 1);
  return Math.min(backoff + Math.random() * backoff * 0.25, max);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `doFetch` until it returns an ok (or non-retryable) response.
 * Retries cover errors returned before the stream starts; mid-stream
 * failures surface to the caller.
 */
export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> {
  const { maxAttempts = 4, baseDelayMs = 1000, maxDelayMs = 30_000, signal, onRetry } = options;

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await doFetch();
    if (response.ok || !RETRYABLE_STATUSES.has(response.status)) return response;

    lastStatus = response.status;
    lastBody = await response.text().catch(() => '');
    if (attempt === maxAttempts) break;

    const delayMs = retryDelayMs(response, attempt, baseDelayMs, maxDelayMs);
    onRetry?.({ attempt, maxAttempts, delayMs, status: response.status });
    await sleep(delayMs, signal);
  }

  throw new ApiError(
    lastStatus,
    `API request failed with status ${lastStatus} after ${maxAttempts} attempts${lastBody ? `: ${lastBody.slice(0, 300)}` : ''}`,
  );
}
