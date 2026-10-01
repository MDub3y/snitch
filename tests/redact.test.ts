import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, SnitchError } from '../src/util/errors.js';
import { clearSecretsForTest, redactSecrets, registerSecret } from '../src/util/redact.js';

afterEach(() => clearSecretsForTest());

describe('redactSecrets', () => {
  it('replaces every occurrence of a registered secret', () => {
    registerSecret('sk-super-secret-key');
    expect(redactSecrets('key sk-super-secret-key failed; retry with sk-super-secret-key')).toBe(
      'key [redacted] failed; retry with [redacted]',
    );
  });

  it('ignores undefined and too-short values', () => {
    registerSecret(undefined);
    registerSecret('short');
    expect(redactSecrets('short text stays')).toBe('short text stays');
  });
});

describe('error redaction', () => {
  it('SnitchError scrubs registered secrets from its message', () => {
    registerSecret('oauth-token-abcdef');
    const error = new SnitchError('upstream said: invalid token oauth-token-abcdef');
    expect(error.message).not.toContain('oauth-token-abcdef');
    expect(error.message).toContain('[redacted]');
  });

  it('ApiError (echoed response body) is scrubbed too', () => {
    registerSecret('sk-live-1234567890');
    const error = new ApiError(400, 'OpenRouter error 400: {"error":"bad key sk-live-1234567890"}');
    expect(error.message).not.toContain('sk-live-1234567890');
  });
});
