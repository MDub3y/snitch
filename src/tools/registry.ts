import type { ToolSpec } from '../llm/types.js';
import { createFsTools } from './fs.js';
import { createSearchTools } from './search.js';
import { createShellTools } from './shell.js';
import { createTodoTools } from './todo.js';
import { createWebTools } from './web.js';
import type { Tool, ToolContext } from './types.js';
import { ToolError } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * A view holding only the tools that need no approval — exactly the
   * read-only ones. Plan mode runs the loop against this, so the model
   * physically cannot mutate anything while planning.
   */
  readOnlyView(): ToolRegistry {
    const view = new ToolRegistry();
    for (const tool of this.tools.values()) {
      if (!tool.requiresApproval) view.register(tool);
    }
    return view;
  }

  /** Serializes every tool into the OpenAI `tools` wire format. */
  toSpecs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  /**
   * Executes a tool by name with already-parsed args. Tool failures come back
   * as a result string (fed to the model), never as a throw — only bugs throw.
   */
  async execute(name: string, args: unknown, context: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: unknown tool "${name}". Available tools: ${this.names().join(', ')}`;
    try {
      return await tool.execute(args, context);
    } catch (error) {
      if (error instanceof ToolError) return `Error: ${error.message}`;
      return `Error: ${name} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    ...createFsTools(),
    ...createSearchTools(),
    ...createShellTools(),
    ...createTodoTools(),
    ...createWebTools(),
  ]) {
    registry.register(tool);
  }
  return registry;
}
