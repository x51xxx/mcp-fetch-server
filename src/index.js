#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FetchError, fetch as impersonatedFetch } from '@trishchuk/fetch';
import { z } from 'zod';

// Keep tool-return payloads well under context-busting size, independent of
// the library's own (much larger) default cap.
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TEXT_CONTENT_TYPE_RE = /^(text\/|application\/(json|xml|javascript|xhtml\+xml)|.*\+(json|xml))/i;

/**
 * Drains a streamed response body up to `cap` bytes. Reads one chunk past the
 * cap so `truncated` is only true when the body genuinely had more to give,
 * then cancels the transfer.
 */
async function readCapped(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };

  const chunks = [];
  let total = 0;
  let truncated = false;
  let drained = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value?.byteLength) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > cap) {
        truncated = true;
        break;
      }
    }
  } finally {
    // Release the connection whenever the body was left unread — after
    // truncating, and after a mid-body read error.
    if (!drained) await reader.cancel().catch(() => {});
  }

  return { bytes: Buffer.concat(chunks, Math.min(total, cap)), truncated };
}

const server = new McpServer({ name: 'mcp-fetch-server', version: '0.1.0' });

server.registerTool(
  'fetch',
  {
    title: 'Fetch',
    description:
      'HTTP fetch backed by @trishchuk/fetch: a curl-impersonate-style client that emulates a real ' +
      'browser TLS/HTTP2 fingerprint (JA3/JA4, ClientHello, ALPN) so requests are not flagged by ' +
      "fingerprint-based bot detection (Cloudflare, DataDome, PerimeterX, etc.) the way Node's default " +
      'HTTP client is. Use it for GET/POST/etc. against sites that block or challenge plain scrapers.',
    inputSchema: {
      url: z.string().url().describe('Absolute URL to request.'),
      method: z.string().default('GET').describe('HTTP method.'),
      headers: z.record(z.string()).optional().describe('Request headers.'),
      body: z.string().optional().describe('Request body, sent as UTF-8 text (e.g. JSON string, form-encoded string).'),
      impersonate: z
        .string()
        .optional()
        .describe(
          'Browser fingerprint profile, e.g. "chrome_147", "safari_26", "random". Defaults to the library default.',
        ),
      platform: z
        .enum(['windows', 'macos', 'linux', 'android', 'ios'])
        .optional()
        .describe('Declared OS for the fingerprint.'),
      proxy: z.string().optional().describe('Proxy URL: http://, https://, or socks5://, optionally with user:pass@.'),
      session: z
        .string()
        .optional()
        .describe(
          'Opaque session id. Reusing it across calls keeps the same underlying client and cookie jar (e.g. to stay logged in).',
        ),
      resolve: z
        .record(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe(
          'Hostname-to-IP pinning, e.g. { "example.com": "192.0.2.1" }. Useful to pin DNS for SSRF-safety or A/B hosts.',
        ),
      redirect: z.enum(['follow', 'manual', 'error']).optional().describe('Redirect handling. Defaults to "follow".'),
      httpVersion: z.enum(['http1', 'http2']).optional().describe('Force HTTP/1.1 or HTTP/2 instead of negotiating.'),
      tlsMinVersion: z.enum(['1.0', '1.1', '1.2', '1.3']).optional(),
      tlsMaxVersion: z.enum(['1.0', '1.1', '1.2', '1.3']).optional(),
      timeoutMs: z.number().int().positive().optional().describe('Request deadline in milliseconds.'),
      maxResponseBytes: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_MAX_RESPONSE_BYTES)
        .optional()
        .describe(
          `Response body cap in bytes (max ${DEFAULT_MAX_RESPONSE_BYTES}, i.e. ${DEFAULT_MAX_RESPONSE_BYTES / (1024 * 1024)}MB, to keep tool output usable). A larger body is truncated to this size and flagged with "truncated": true, not rejected.`,
        ),
      encoding: z
        .enum(['auto', 'text', 'base64'])
        .default('auto')
        .describe('How to return the body: "auto" picks text for text-like content-types and base64 otherwise.'),
    },
  },
  async ({
    url,
    method,
    headers,
    body,
    impersonate,
    platform,
    proxy,
    session,
    resolve,
    redirect,
    httpVersion,
    tlsMinVersion,
    tlsMaxVersion,
    timeoutMs,
    maxResponseBytes,
    encoding,
  }) => {
    const cappedMaxResponseBytes = Math.min(maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES);

    try {
      const res = await impersonatedFetch(url, {
        method,
        headers,
        body,
        impersonate,
        platform,
        proxy,
        session,
        resolve,
        redirect,
        httpVersion,
        tlsMinVersion,
        tlsMaxVersion,
        timeoutMs,
        // No maxResponseBytes here on purpose: the library treats it as a hard
        // error cap (RESPONSE_TOO_LARGE), which would yield zero content for an
        // oversized page. We stream and truncate instead — see readCapped.
        stream: true,
      });

      const contentType = res.headers.get('content-type') || '';
      const { bytes, truncated } = await readCapped(res, cappedMaxResponseBytes);
      const useText = encoding === 'text' || (encoding === 'auto' && TEXT_CONTENT_TYPE_RE.test(contentType));

      const payload = {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        url: res.url,
        redirected: res.redirected,
        headers: Object.fromEntries(res.headers.entries()),
        bodyEncoding: useText ? 'text' : 'base64',
        body: useText
          ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
          : Buffer.from(bytes).toString('base64'),
        truncated,
      };

      // A completed HTTP exchange is a successful tool call, whatever the
      // status: a 404 body is still useful, and a 3xx under redirect:"manual"
      // is exactly what the caller asked for. `ok` in the payload carries the
      // HTTP outcome.
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err) {
      const isFetchError = err instanceof FetchError;
      const payload = {
        error: true,
        code: isFetchError ? err.code : 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
      };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('mcp-fetch-server failed to start:', err);
  process.exit(1);
});
