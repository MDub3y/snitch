import type { LLMProvider } from '../llm/types.js';
import type { History } from './history.js';

const KEEP_RECENT = 6;

/**
 * Compacts a long conversation: the model summarizes everything except the
 * most recent messages, and History swaps the old messages for the summary.
 * Returns the summary, or '' when there was nothing worth compacting.
 * Distinct from toMessages() trimming: trimming silently DROPS old context at
 * send time; compaction PRESERVES it in condensed form.
 */
export async function compactHistory(provider: LLMProvider, history: History, signal?: AbortSignal): Promise<string> {
  const transcript = history.transcript(KEEP_RECENT);
  if (!transcript.trim()) return '';

  let summary = '';
  const stream = provider.chat({
    messages: [
      {
        role: 'system',
        content: 'You summarize coding-agent conversations. Be factual, specific and dense. No preamble.',
      },
      {
        role: 'user',
        content: `Summarize this conversation so a coding agent can continue it seamlessly. Keep: the user's goals and constraints, decisions made, files created or changed and how, current state, and what remains to be done.\n\n${transcript}`,
      },
    ],
    signal,
  });
  for await (const event of stream) {
    if (event.type === 'text') summary += event.delta;
  }

  summary = summary.trim();
  if (summary) history.compact(summary, KEEP_RECENT);
  return summary;
}
