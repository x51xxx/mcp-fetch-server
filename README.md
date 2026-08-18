# @trishchuk/mcp-fetch-server

[![npm version](https://img.shields.io/npm/v/@trishchuk/mcp-fetch-server.svg?style=flat-square)](https://www.npmjs.com/package/@trishchuk/mcp-fetch-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blueviolet.svg?style=flat-square)](https://modelcontextprotocol.io)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org)

A high-performance [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server providing an anti-bot-resilient `fetch` tool for AI agents (Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Antigravity, etc.).

Powered by [`@trishchuk/fetch`](https://github.com/x51xxx/fetch) — a native curl-impersonate-style HTTP client that accurately mimics real browser **TLS (JA3/JA4, ClientHello)** and **HTTP/2 fingerprints**.

---

## 🚀 Why this server?

Standard Node.js/Undici HTTP clients get immediately flagged and blocked by modern bot-protection systems (**Cloudflare Turnstile / Under Attack Mode, DataDome, PerimeterX / HUMAN, Akamai, Kasada, AWS WAF**).

Furthermore, standard MCP fetching tools often fail on large payloads or blow up LLM token contexts.

`@trishchuk/mcp-fetch-server` solves both problems:

1. **Realistic Browser Impersonation**: Replicates exact cipher suites, TLS extensions, ALPN order, and HTTP/2 settings frames from modern browsers (Chrome, Safari, Firefox).
2. **LLM Context-Safe Truncation**: Streams and caps response bodies at 2MB (`maxResponseBytes`). Oversized pages are cleanly truncated and flagged with `"truncated": true` rather than crashing with errors.
3. **Stateful Sessions**: Maintain cookies, login states, and connection pools across multiple agent tool calls using the `session` parameter.
4. **Smart Encoding**: Automatically detects MIME types and returns clean UTF-8 text for HTML/JSON/XML or Base64 for binary files (images, PDFs, documents).

---

## 📦 Installation & Setup

### Option 1: Run with `npx` (No installation needed)

You can run the server directly via `npx`:

```bash
npx -y @trishchuk/mcp-fetch-server
```

### Option 2: Global or Local Installation

```bash
# Global
npm install -g @trishchuk/mcp-fetch-server

# Or clone & install locally
git clone https://github.com/x51xxx/mcp-fetch-server.git
cd mcp-fetch-server
npm install
```

---

## ⚙️ MCP Client Configuration

### Claude Code

Add directly via CLI:

```bash
# Using npx (recommended)
claude mcp add fetch -- npx -y @trishchuk/mcp-fetch-server

# Or using local path
claude mcp add fetch -- node /path/to/mcp-fetch-server/src/index.js
```

### Claude Desktop

Add to your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@trishchuk/mcp-fetch-server"]
    }
  }
}
```

### Cursor / Windsurf / Antigravity (`.mcp.json`)

Create or update `.mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@trishchuk/mcp-fetch-server"]
    }
  }
}
```

---

## 🛠️ Tool Reference: `fetch`

### Input Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | *required* | Target absolute URL (e.g. `https://example.com/api`). |
| `method` | `string` | `"GET"` | HTTP method (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, etc.). |
| `headers` | `object` | `undefined` | Request headers as key-value pairs (`{"Authorization": "Bearer ..."}`). |
| `body` | `string` | `undefined` | Request body sent as UTF-8 string (JSON, form-encoded, raw text). |
| `impersonate` | `string` | `"chrome_147"` | Browser fingerprint preset (e.g. `"chrome_147"`, `"safari_26"`, `"random"`). |
| `platform` | `string` | `undefined` | Declared OS: `"windows"`, `"macos"`, `"linux"`, `"android"`, or `"ios"`. |
| `proxy` | `string` | `undefined` | Proxy URL: `http://`, `https://`, or `socks5://` (supports `user:pass@host:port`). |
| `session` | `string` | `undefined` | Session ID for sharing client connections and cookie jars across multiple calls. |
| `resolve` | `object` | `undefined` | Custom DNS pinning (e.g. `{"example.com": "1.2.3.4"}`). SSRF-safe testing. |
| `redirect` | `string` | `"follow"` | Redirect mode: `"follow"`, `"manual"`, or `"error"`. |
| `httpVersion` | `string` | `undefined` | Force protocol version: `"http1"` or `"http2"`. |
| `tlsMinVersion` | `string` | `undefined` | Minimum TLS version: `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`. |
| `tlsMaxVersion` | `string` | `undefined` | Maximum TLS version: `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`. |
| `timeoutMs` | `number` | `undefined` | Overall request timeout in milliseconds. |
| `maxResponseBytes`| `number` | `2097152` | Body limit in bytes (max 2MB). Responses exceeding this are safely truncated. |
| `encoding` | `string` | `"auto"` | Body return format: `"auto"` (text for textual MIME types, base64 for binary), `"text"`, or `"base64"`. |

---

### Response Schemas

#### 1. Successful HTTP Exchange

Any completed HTTP transfer returns a standard JSON result (including `404`, `500`, or `3xx` under `redirect: "manual"`):

```json
{
  "status": 200,
  "statusText": "OK",
  "ok": true,
  "url": "https://example.com/data",
  "redirected": false,
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=3600"
  },
  "bodyEncoding": "text",
  "body": "{\"message\": \"Hello world\"}",
  "truncated": false
}
```

#### 2. Network / Transport Failure

If the network connection fails, times out, or the URL is invalid, the tool returns `isError: true`:

```json
{
  "error": true,
  "code": "TIMEOUT",
  "message": "request timed out after 5000ms"
}
```

---

## 💡 Usage Examples for Agents

### 1. Bypass Bot Detection on Protected Target

```json
{
  "url": "https://protected-site.com/products",
  "impersonate": "chrome_147",
  "platform": "macos",
  "headers": {
    "Accept-Language": "en-US,en;q=0.9"
  }
}
```

### 2. Multi-Step Scraping with Persistent Session (Cookie Jar)

```json
// Step 1: Login / Obtain Session Cookie
{
  "url": "https://example.com/api/login",
  "method": "POST",
  "session": "agent-crawler-01",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"user\":\"admin\",\"password\":\"secret\"}"
}

// Step 2: Access protected resource (session cookies automatically preserved)
{
  "url": "https://example.com/api/dashboard",
  "session": "agent-crawler-01"
}
```

### 3. Route Through a SOCKS5 Proxy

```json
{
  "url": "https://geo-restricted.example.com",
  "proxy": "socks5://user:pass@proxy.example.com:1080",
  "impersonate": "safari_26"
}
```

### 4. Fetching Binary Assets (Images, PDFs)

```json
{
  "url": "https://example.com/report.pdf",
  "encoding": "base64"
}
```

### 5. DNS Pinning for SSRF-Safe Ingestion

```json
{
  "url": "https://internal-origin.example.com/feed",
  "resolve": {
    "internal-origin.example.com": "192.0.2.42"
  },
  "redirect": "manual"
}
```

---

## 🔬 Impersonation Presets & Fingerprints

`@trishchuk/mcp-fetch-server` supports a wide range of browser fingerprints:

- **Chrome**: `"chrome_147"`, `"chrome_131"`, `"chrome_124"`, `"chrome_116"`, etc.
- **Safari**: `"safari_26"`, `"safari_18"`, `"safari_17"`
- **Firefox**: `"firefox_133"`, `"firefox_120"`
- **Dynamic**: `"random"`, `"weighted_random"` (rotates fingerprints automatically)

---

## 📄 License

MIT © [Taras Trishchuk](https://github.com/x51xxx)
