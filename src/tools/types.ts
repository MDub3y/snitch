export interface ToolContext {
  /** All relative tool paths resolve against this. */
  cwd: string;
  signal?: AbortSignal;
}

/** A tool failure whose message goes back to the model as the tool result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<Args = any> {
  name: string;
  description: string;
  /** JSON Schema for the arguments, serialized into the OpenAI tools payload. */
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
  /** Human-readable summary shown on the approval card (e.g. a diff). */
  preview?(args: Args, context: ToolContext): string | Promise<string>;
  execute(args: Args, context: ToolContext): Promise<string>;
}
