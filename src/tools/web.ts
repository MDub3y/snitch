import type { Tool } from './types.js';
import { ToolError } from './types.js';

const MAX_RESULT_CHARS = 5000;
const MAX_BODY_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Strips HTML down to readable text: drops script/style/head, tags, comments; decodes common entities. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|head|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

interface FetchArgs {
  url: string;
}

const fetchUrl: Tool<FetchArgs> = {
  name: 'fetch_url',
  description:
    'HTTP GET a URL and return its content as readable text (HTML is stripped to text, truncated to a few thousand characters). Use full URLs including the scheme.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch' },
    },
    required: ['url'],
  },
  requiresApproval: false,
  async execute(args, context) {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      throw new ToolError(`not a valid URL: ${args.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ToolError(`only http(s) URLs are supported, got ${url.protocol}`);
    }

    const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (context.signal) signals.push(context.signal);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any(signals),
        headers: { 'User-Agent': 'snitch-agent', Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5' },
      });
    } catch (error) {
      throw new ToolError(`fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (/\b(image|video|audio|font|zip|octet-stream|pdf)\b/i.test(contentType)) {
      throw new ToolError(`cannot read binary content (${contentType}) as text`);
    }

    let body = await response.text();
    if (body.length > MAX_BODY_BYTES) body = body.slice(0, MAX_BODY_BYTES);

    const text = /html/i.test(contentType) || /^\s*</.test(body) ? stripHtml(body) : body.trim();
    if (!text) return '(the page had no readable text)';
    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n(truncated at ${MAX_RESULT_CHARS} characters)`
      : text;
  },
};

export function createWebTools(): Tool[] {
  return [fetchUrl];
}
