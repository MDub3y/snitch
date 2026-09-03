import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebTools } from '../src/tools/web.js';
import { stripHtml } from '../src/tools/web.js';
import type { ToolContext } from '../src/tools/types.js';

const ctx: ToolContext = { cwd: '.' };
const tool = createWebTools()[0]!;

describe('stripHtml', () => {
  it('drops scripts, styles and tags, keeps the text', () => {
    const html = `<html><head><title>t</title><style>b{color:red}</style></head>
      <body><script>alert(1)</script><h1>Hello</h1><p>a &amp; b &lt;ok&gt;</p><!-- gone --></body></html>`;
    const text = stripHtml(html);
    expect(text).toContain('Hello');
    expect(text).toContain('a & b <ok>');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('gone');
    expect(text).not.toContain('<h1>');
  });

  it('turns block-level boundaries into newlines', () => {
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });
});

describe('fetch_url', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html');
        res.end(`<html><body><h1>Local Page</h1><script>bad()</script><p>readable ${'x'.repeat(6000)}</p></body></html>`);
      } else if (req.url === '/plain') {
        res.setHeader('content-type', 'text/plain');
        res.end('just plain text');
      } else if (req.url === '/binary') {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([0x89, 0x50]));
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('is read-only', () => {
    expect(tool.requiresApproval).toBe(false);
  });

  it('fetches a page, strips it to text, and truncates', async () => {
    const result = await tool.execute({ url: `${base}/page` }, ctx);
    expect(result).toContain('Local Page');
    expect(result).toContain('readable');
    expect(result).not.toContain('bad()');
    expect(result).toContain('(truncated at 5000 characters)');
    expect(result.length).toBeLessThan(5100);
  });

  it('passes plain text through untouched', async () => {
    expect(await tool.execute({ url: `${base}/plain` }, ctx)).toBe('just plain text');
  });

  it('reports HTTP errors, binary content, and bad URLs as tool errors', async () => {
    await expect(tool.execute({ url: `${base}/missing` }, ctx)).rejects.toThrow(/HTTP 404/);
    await expect(tool.execute({ url: `${base}/binary` }, ctx)).rejects.toThrow(/binary content/);
    await expect(tool.execute({ url: 'not a url' }, ctx)).rejects.toThrow(/not a valid URL/);
    await expect(tool.execute({ url: 'ftp://example.com/x' }, ctx)).rejects.toThrow(/only http/);
  });
});
