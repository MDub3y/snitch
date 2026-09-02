import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent } from '../../src/llm/types.js';

/** Scripted provider: each chat() call plays the next turn's events. */
export class FakeProvider implements LLMProvider {
  readonly model = 'fake/model';
  readonly capabilities = { nativeTools: true, streaming: true };
  readonly seenMessages: ChatMessage[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    this.seenMessages.push(structuredClone(options.messages));
    const turn = this.turns.shift();
    if (!turn) throw new Error('FakeProvider ran out of scripted turns');
    for (const event of turn) {
      options.signal?.throwIfAborted();
      yield event;
    }
  }
}

export function textTurn(...deltas: string[]): StreamEvent[] {
  return [...deltas.map((delta) => ({ type: 'text', delta }) as const), { type: 'done', finishReason: 'stop' }];
}

export function toolTurn(calls: { id: string; name: string; args: string }[]): StreamEvent[] {
  return [
    ...calls.map(
      (call) =>
        ({
          type: 'tool_call',
          call: { id: call.id, type: 'function', function: { name: call.name, arguments: call.args } },
        }) as const,
    ),
    { type: 'done', finishReason: 'tool_calls' },
  ];
}
