/**
 * Registry of secret values (API keys, OAuth tokens) that must never appear
 * in user-facing output. config.ts registers every credential it reads;
 * SnitchError redacts its message on construction, which covers every error
 * path the UI or headless runner prints.
 */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  // Length guard: redacting very short strings would mangle unrelated text.
  if (value && value.length >= 8) secrets.add(value);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

export function clearSecretsForTest(): void {
  secrets.clear();
}
