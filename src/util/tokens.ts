/**
 * Naive token estimate used for context budgeting until a real tokenizer
 * is worth its weight: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
