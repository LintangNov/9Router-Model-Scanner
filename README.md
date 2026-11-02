# 9Router Scanner Web UI

A local web-based health scanner for [9Router](https://github.com/9router) AI model proxies. It tests every model exposed by your local 9Router instance via `POST /v1/chat/completions` and gives you a live terminal log, per-provider circuit breaker, and a copyable list of active models.

---

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Circuit Breaker](#circuit-breaker)
- [Troubleshooting](#troubleshooting)

---

## Overview

```
Browser  <-->  server.ps1 (localhost:8080)  <-->  9Router (localhost:20128)
               |
               +-- GET  /                   serves index.html
               +-- GET  /style.css, /app.js serves static assets
               +-- GET  /api/models         proxies GET /v1/models, filters & groups
               +-- POST /api/scan-single    proxies POST /v1/chat/completions (7s timeout)
```

The PowerShell script (`server.ps1`) acts as both a static file server and a proxy. The browser never talks directly to 9Router, so no CORS issues arise regardless of your 9Router configuration.

---

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| Windows PowerShell | 5.1+ | Ships with Windows 10/11. PowerShell 7+ also works. |
| 9Router | Any | Must be running locally before loading models. |
| A modern browser | Chrome, Edge, Firefox | Any browser with ES2017+ support. |

No Node.js, Python, or external packages are required. The server uses only built-in .NET classes (`System.Net.HttpListener`) and PowerShell cmdlets.

---

## Quick Start

**1. Start 9Router** on its default address (`http://localhost:20128`).

**2. Open PowerShell** in the project directory and run:

```powershell
powershell -ExecutionPolicy Bypass -File server.ps1
```

**3. Open your browser** and navigate to:

```
http://localhost:8080
```

**4. Use the UI:**

1. Verify the **Backend** and **Router** status pills both show green.
2. Click **Load Models** to fetch and group all available models.
3. Select the providers you want to test using the chip toggles.
4. Adjust the Circuit Breaker threshold if needed (default: 10).
5. Click **Start Scan** to begin sequential health testing.
6. Watch the live terminal log and copy the active model list when done.

---

## Project Structure

```
capstone/
├── server.ps1      PowerShell HTTP server and API proxy
├── index.html      Semantic HTML5 single-page application shell
├── style.css       Dark CLI theme, CSS custom properties, responsive layout
├── app.js          ES6 async scan engine, circuit breaker, UI state machine
├── DESIGN.md       Visual identity tokens and layout specification
└── antislop.md     UI quality filter and anti-pattern rules
```

---

## Configuration

### Change the listening port

The server defaults to `http://localhost:8080/`. Pass `-ListenPrefix` to override:

```powershell
powershell -ExecutionPolicy Bypass -File server.ps1 -ListenPrefix "http://localhost:9090/"
```

The prefix must end with `/` and must be a valid `HttpListener` prefix string.

### Change the 9Router target at runtime

The **Router URL** field in the browser header accepts any base URL at runtime. The value is sent to the server as the `X-Router-Base` request header on every API call. No server restart is required when switching targets.

### API Key

Enter your bearer token in the **API Key** field. It is sent as `Authorization: Bearer <key>` on all proxied requests to 9Router. The field is masked by default; click the eye icon to reveal it.

---

## API Reference

Both endpoints are proxied through `server.ps1`. The frontend never contacts 9Router directly.

### `GET /api/models`

Fetches the model list from `{RouterBase}/v1/models`, strips the four default preset names (`heavy`, `medium`, `light`, `free`), and groups the remaining models by provider prefix (the segment before the first `/` in the model ID).

**Request headers (set automatically by the frontend):**

| Header | Description |
|---|---|
| `X-Router-Base` | Base URL of the 9Router instance. Defaults to `http://localhost:20128`. |
| `X-Api-Key` | Optional bearer token forwarded as `Authorization`. |

**Success response `200`:**

```json
{
  "providers": [
    { "provider": "gemini", "models": ["gemini/gemini-1.5-flash", "gemini/gemini-2.0-flash"] },
    { "provider": "openai", "models": ["openai/gpt-4o", "openai/gpt-4o-mini"] }
  ]
}
```

**Error responses:**

| Status | Meaning |
|---|---|
| `502` | 9Router returned a non-2xx response or a network error occurred. |
| `504` | All 3 retry attempts to 9Router timed out (20s per attempt). |

**Retry behavior:** The server retries the request up to **3 times** with a 1-second delay between attempts. A `504` is returned only after all attempts are exhausted.

---

### `POST /api/scan-single`

Sends a minimal chat completion request to `{RouterBase}/v1/chat/completions` for a single model and returns the HTTP status code.

**Request body:**

```json
{ "model": "gemini/gemini-2.0-flash" }
```

**Payload forwarded to 9Router:**

```json
{
  "model": "gemini/gemini-2.0-flash",
  "messages": [{ "role": "user", "content": "." }],
  "max_tokens": 1
}
```

**Timeout:** 7 seconds (enforced by the PowerShell `WebRequest.Timeout`).

**Success response `200`:**

```json
{ "model": "gemini/gemini-2.0-flash", "status": 200, "ok": true }
```

**Error response `200` (model failed):**

```json
{ "model": "gemini/gemini-2.0-flash", "status": 429, "ok": false }
```

```json
{ "model": "gemini/gemini-2.0-flash", "status": 0, "ok": false, "error": "timeout" }
```

Note: The outer HTTP status is always `200` when the proxy itself succeeded. The `ok` field and inner `status` code reflect the 9Router result.

---

## Circuit Breaker

The circuit breaker prevents wasting time on providers that are consistently down during a scan.

**How it works:**

- The scan runs models **sequentially** within each provider.
- A per-provider consecutive failure counter increments on every non-`200` response or timeout.
- When the counter reaches the configured **threshold**, all remaining models in that provider are skipped immediately without sending any further requests.
- The counter resets to zero on the first successful response within a provider.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| Enabled | ON | Toggle the breaker on or off. When OFF, all models are tested regardless of failure history. |
| Threshold | 10 | Number of consecutive failures before the provider is skipped. Minimum value: 1. |

**Recap panel:** Skipped providers appear in the **Skipped Providers** card with the reason `threshold reached (N consecutive failures)`.

---

## Troubleshooting

**"Failed to load models: HTTP 504"**

9Router did not respond within 20 seconds across 3 attempts. Check that 9Router is running and accessible at the configured Router URL.

**"Failed to load models: HTTP 502"**

9Router returned an error (e.g. `401 Unauthorized`). Verify your API Key is correct and that the Router URL is reachable.

**Backend / Router status shows "Offline" or "Error"**

The status pills are set by an initial connectivity check on page load. If 9Router starts after the page loads, click **Load Models** to re-probe and update the status.

**Server crashes with "Access is denied"**

`HttpListener` on Windows requires that the listen prefix is either `localhost` or registered via `netsh`. If you change the prefix to a hostname or IP other than `localhost`, run this once as Administrator:

```powershell
netsh http add urlacl url="http://+:8080/" user=Everyone
```

**"The operation has timed out" in the PowerShell console**

This is a transient 9Router cold-start delay. The server retries automatically up to 3 times. If it fails consistently, confirm 9Router is fully initialized before clicking Load Models.

**Browser shows a blank page or 404**

Ensure `server.ps1` is run from the directory that contains `index.html`, `style.css`, and `app.js`. The script resolves file paths relative to its own location using `$MyInvocation.MyCommand.Path`.
