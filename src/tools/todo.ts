import type { Tool } from './types.js';
import { ToolError } from './types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done'];
const MARKS: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[>]', done: '[x]' };

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(todo list cleared)';
  const doneCount = todos.filter((item) => item.status === 'done').length;
  const lines = todos.map((item) => `${MARKS[item.status]} ${item.content}`);
  return [`Todo list (${doneCount}/${todos.length} done):`, ...lines].join('\n');
}

/**
 * In-memory task planner: each call replaces the whole list. State lives in
 * the closure, so every registry (= session) gets its own list and /clear's
 * fresh registry starts empty. Nothing touches disk — no approval needed.
 */
export function createTodoTools(): Tool[] {
  let todos: TodoItem[] = [];

  const todoWrite: Tool<{ todos: TodoItem[] }> = {
    name: 'todo_write',
    description:
      'Replace your todo list for the current task. Use it to plan any task with more than a couple of steps, and update statuses as you work. Returns the rendered checklist.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full new todo list (replaces the previous one)',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What this step is' },
              status: { type: 'string', enum: [...STATUSES], description: 'Current state of this step' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    requiresApproval: false,
    async execute(args) {
      if (!Array.isArray(args.todos)) throw new ToolError('todos must be an array of {content, status} items');
      for (const item of args.todos) {
        if (typeof item?.content !== 'string' || !item.content.trim()) {
          throw new ToolError('every todo item needs a non-empty string "content"');
        }
        if (!STATUSES.includes(item.status)) {
          throw new ToolError(`invalid status "${String(item.status)}" — use pending, in_progress or done`);
        }
      }
      todos = args.todos.map((item) => ({ content: item.content, status: item.status }));
      return renderTodos(todos);
    },
  };

  return [todoWrite];
}
