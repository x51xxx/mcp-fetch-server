// End-to-end smoke tests: they spawn the real MCP server over stdio and drive it
// with an MCP client, against a local HTTP server — no network access needed.

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const BODY_1K = 'a'.repeat(1000);
const BINARY = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f]);

let origin;
let httpServer;
let client;
const drips = new Set();

before(async () => {
  httpServer = http.createServer((req, res) => {
    const path = req.url;
    if (path === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(BODY_1K);
    } else if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('b'.repeat(10_000));
    } else if (path === '/binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(BINARY);
    } else if (path === '/redirect') {
      res.writeHead(302, { location: '/text' });
      res.end();
    } else if (path === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const timer = setInterval(() => res.write('x'.repeat(16)), 200);
      drips.add(timer);
      res.on('close', () => {
        clearInterval(timer);
        drips.delete(timer);
      });
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    }
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${httpServer.address().port}`;

  client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
});

after(async () => {
  await client?.close();
  for (const timer of drips) clearInterval(timer);
  await new Promise((resolve) => httpServer.close(resolve));
});

async function call(args) {
  const result = await client.callTool({ name: 'fetch', arguments: args });
  return { isError: result.isError ?? false, payload: JSON.parse(result.content[0].text) };
}

test('returns a text body with metadata', async () => {
  const { isError, payload } = await call({ url: `${origin}/text` });
  assert.equal(isError, false);
  assert.equal(payload.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.bodyEncoding, 'text');
  assert.equal(payload.body, BODY_1K);
  assert.equal(payload.truncated, false);
  assert.equal(payload.headers['content-type'], 'text/plain; charset=utf-8');
});

test('truncates an oversized body instead of failing', async () => {
  const { isError, payload } = await call({ url: `${origin}/big`, maxResponseBytes: 4096 });
  assert.equal(isError, false);
  assert.equal(payload.status, 200);
  assert.equal(Buffer.byteLength(payload.body), 4096);
  assert.equal(payload.truncated, true);
});

test('a body exactly at the cap is not flagged as truncated', async () => {
  const { payload } = await call({ url: `${origin}/text`, maxResponseBytes: BODY_1K.length });
  assert.equal(payload.body, BODY_1K);
  assert.equal(payload.truncated, false);
});

test('a 404 is a successful tool call', async () => {
  const { isError, payload } = await call({ url: `${origin}/missing` });
  assert.equal(isError, false);
  assert.equal(payload.status, 404);
  assert.equal(payload.ok, false);
  assert.equal(payload.body, 'nope');
});

test('redirect: manual surfaces the 3xx without erroring', async () => {
  const { isError, payload } = await call({ url: `${origin}/redirect`, redirect: 'manual' });
  assert.equal(isError, false);
  assert.equal(payload.status, 302);
  assert.equal(payload.redirected, false);
  assert.equal(payload.headers.location, '/text');
});

test('redirect: follow lands on the target', async () => {
  const { payload } = await call({ url: `${origin}/redirect` });
  assert.equal(payload.status, 200);
  assert.equal(payload.redirected, true);
  assert.equal(payload.body, BODY_1K);
});

test('HEAD yields an empty body', async () => {
  const { isError, payload } = await call({ url: `${origin}/text`, method: 'HEAD' });
  assert.equal(isError, false);
  assert.equal(payload.status, 200);
  assert.equal(payload.body, '');
});

test('non-text content-type comes back as base64', async () => {
  const { payload } = await call({ url: `${origin}/binary` });
  assert.equal(payload.bodyEncoding, 'base64');
  assert.deepEqual(Buffer.from(payload.body, 'base64'), BINARY);
});

test('timeoutMs bounds a slow-dripping body', async () => {
  const { isError, payload } = await call({ url: `${origin}/slow`, timeoutMs: 1000 });
  assert.equal(isError, true);
  assert.equal(payload.code, 'TIMEOUT');
});

test('a transport failure is reported as a tool error', async () => {
  const { isError, payload } = await call({ url: 'http://127.0.0.1:1/', timeoutMs: 5000 });
  assert.equal(isError, true);
  assert.equal(payload.error, true);
  assert.match(payload.code, /CONNECT|TIMEOUT/);
});
