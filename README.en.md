<p align="center">
  <b>Turn your WorkBuddy / CodeBuddy subscription into a local OpenAI / Anthropic compatible API.</b>
</p>

<p align="center">
  Use it from Claude Code, Codex CLI, Cherry Studio, Cursor, Open WebUI — any client that speaks either protocol.
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="docs/upstream-protocol.md">Protocol notes</a> ·
  <a href="LICENSE">MIT</a>
</p>

**Zero runtime dependencies** — Node.js ≥ 18 is all you need. No `npm install`, no Docker, no Redis.

```bash
git clone https://github.com/alanzeng423/workbuddy-api.git
cd workbuddy-api
node login.mjs      # browser authorization
node server.mjs     # start
```

---

## Contents

- [Features](#features)
- [Install](#install)
- [Connecting clients](#connecting-clients)
- [CLI](#cli)
- [Configuration](#configuration)
- [Sites and models](#sites-and-models)
- [How it works](#how-it-works)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Development](#development)
- [FAQ](#faq)

---

## Features

- **Three protocols**: OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses
  (Codex CLI needs the last one)
- **Independent login**: uses the official OAuth device-authorization flow. It does **not**
  require the WorkBuddy desktop app, and does not read any other client's data — so it can be
  shared with other people as-is
- **Domestic + International side by side**: both regions can be signed in at once, routed by model
- **Streaming and non-streaming**: the upstream only produces streams, so non-streaming
  responses are assembled locally
- **Full tool calling**: streamed `tool_calls` aggregation, `tool_choice` normalization,
  multi-turn round-trips
- **Automatic context compression**: trims and retries when the upstream limit is hit, so long
  sessions do not die on a raw 400
- **Zero dependencies**: Node built-ins only, no supply-chain surface

---

## Install

### Requirements

| Item | Requirement |
|---|---|
| Node.js | **≥ 18** (check with `node --version`) |
| OS | Windows / macOS / Linux |
| Account | Your own working WorkBuddy or CodeBuddy account |

### Option 1: git clone (recommended)

```bash
git clone https://github.com/alanzeng423/workbuddy-api.git
cd workbuddy-api
```

There is no `npm install` step — this project has no dependencies.

### Option 2: download

Grab a source archive and unpack it.

### Step 1: Sign in

```bash
node login.mjs
```

You will be asked which site to sign in to:

```
请选择要登录的站点：
  1) 国内版 (CodeBuddy CLI)  [cn-cli]
  2) 国际版 (CodeBuddy CLI)  [intl-cli]
  3) 国际版 (WorkBuddy AI)   [intl-work]
序号 (默认 1):
```

An authorization URL is printed and your browser is opened automatically.
**Complete the authorization in the browser**; the terminal polls and confirms on success.

You can also skip the prompt:

```bash
node login.mjs --site intl-work          # sign in to a specific site
node login.mjs --site cn-cli --no-open   # do not open a browser (for servers)
node login.mjs --list                    # show sign-in state
node login.mjs --logout --site cn-cli    # remove the local credential
```

> **Quota is not shared** between regions. The domestic and international products are
> separate account systems with separate balances, so sign in to each one you want to use.

### Step 2: Start

```bash
node server.mjs
```

You should see a banner like this:

```
  workbuddy-api  ·  把 WorkBuddy / CodeBuddy 额度转成本机 API

  监听地址 : http://127.0.0.1:8788   （仅本机可达）
  API Key  : sk-wb-1a2b3c4d…（完整值见 ~/.workbuddy-api/config.json）

  可用端点 :
    POST http://127.0.0.1:8788/v1/chat/completions   OpenAI 兼容
    POST http://127.0.0.1:8788/v1/messages           Anthropic Messages
    POST http://127.0.0.1:8788/v1/responses          OpenAI Responses (Codex CLI)
    GET  http://127.0.0.1:8788/v1/models             模型清单
    GET  http://127.0.0.1:8788/health                健康检查（免鉴权）

  站点登录状态 :
    ✅ intl-work   your@email.com
```

**The API key is generated on first start** and stored in `~/.workbuddy-api/config.json`.
You will need it when connecting a client.

Optional flags:

```bash
node server.mjs --port 9000        # different port
node server.mjs --host 127.0.0.1   # different bind address (loopback is the default)
```

### Step 3: Verify

```bash
node smoke.mjs     # end-to-end check of every endpoint (uses a free model, costs nothing)
node ask.mjs --list
node ask.mjs hy3 "hello"
```

Example `smoke.mjs` output:

```
  [传输层]
  ✅ /health  — 已登录: intl-work
  ✅ 错误 API Key 被拒绝 (401)
  [模型清单]
  ✅ /v1/models  — 25 个模型，免费 3 个
  [协议端点]  使用模型: deepseek-v4.1-flash (免费)
  ✅ OpenAI 非流式    ✅ OpenAI 流式
  ✅ Anthropic 非流式 ✅ Anthropic 流式
  ✅ Responses 流式   ✅ 工具调用
  结果: 10 通过, 0 失败, 0 跳过
```

---

## Connecting clients

Every client uses the same three values; only the protocol and path differ:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | the `sk-wb-…` value from the startup banner |
| Model | `hy3` / `deepseek-v4.1-flash` / `glm-5.3` / … (see `node ask.mjs --list`) |

### Claude Code / CC Switch

Claude Code speaks the Anthropic protocol, so use `/v1/messages`:

```json
{
  "WorkBuddy": {
    "base_url": "http://127.0.0.1:8788/v1/messages",
    "api_key": "sk-wb-YOUR_KEY",
    "model": "deepseek-v4.1-flash"
  }
}
```

### Codex CLI

Codex CLI speaks the Responses protocol. Edit `~/.codex/config.toml`:

```toml
[model_providers.workbuddy]
name = "WorkBuddy"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"

[profiles.workbuddy]
model = "deepseek-v4.1-flash"
model_provider = "workbuddy"
```

Then run: `codex --profile workbuddy "your task"`

### Cherry Studio / LobeChat / NextChat / Open WebUI

Add an **OpenAI-compatible** custom provider:

- API address: `http://127.0.0.1:8788/v1`
- API key: `sk-wb-…`
- Model: type `hy3` or `deepseek-v4.1-flash` manually, or let it read the model list

### Cursor / TraeWork / other IDEs

In the custom-model settings:

- Base URL: `http://127.0.0.1:8788/v1` (use `…/v1/chat/completions` if a full URL is required)
- Model ID: `hy3`, etc.
- API key: `sk-wb-…`

> Path handling is forgiving: whether a client builds `/v1/v1/chat/completions` or
> `/v1/chat/completions/`, it still resolves.

---

## CLI

| Command | Purpose |
|---|---|
| `node login.mjs [--site <id>] [--no-open] [--list] [--logout]` | Sign in / inspect / sign out |
| `node server.mjs [--host <ip>] [--port <n>]` | Start the service |
| `node status.mjs [--json]` | Per-site sign-in state and token expiry |
| `node ask.mjs --list` | List models with their credit multipliers |
| `node ask.mjs [options] <model> "<prompt>"` | Ask from the command line |
| `node smoke.mjs [--url <u>] [--key <k>]` | End-to-end self-check |
| `npm test` | Unit tests (72, zero dependencies) |

`ask.mjs` options:

```bash
node ask.mjs hy3 "hello"                              # OpenAI protocol (default)
node ask.mjs --stream hy3 "count to five"             # streamed output
node ask.mjs --protocol anthropic hy3 "hello"         # Anthropic protocol
node ask.mjs --protocol responses hy3 "hello"         # Responses protocol
node ask.mjs --url http://127.0.0.1:9000 hy3 "hello"  # different address
```

---

## Configuration

Config file: `~/.workbuddy-api/config.json` (created on first start)

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Bind address. **A non-loopback value exposes the service to the network** |
| `port` | `8788` | Bind port |
| `apiKey` | generated | A string, or an array of strings (every key in the array is valid) |
| `defaultSite` | `cn-cli` | Fallback site when nothing else matches |
| `ensureSystemMessage` | `true` | Guarantee a leading system message (required by the international gateway) |
| `defaultSystemPrompt` | `You are a helpful assistant.` | Fallback system content |
| `stripClientFingerprint` | `true` | Strip client fingerprints the upstream blacklists (see [How it works](#how-it-works)) |
| `context.enabled` | `true` | Compress when the context limit is exceeded |
| `context.reserveForOutput` | `4096` | Tokens reserved for the model's reply |
| `context.minKeepMessages` | `4` | Minimum recent messages to keep |
| `context.safetyRatio` | `0.95` | Budget at 95% of the limit, to absorb estimation error |
| `rateLimit.enabled` | `true` | Enable sliding-window rate limiting |
| `rateLimit.windowMs` / `max` | `10000` / `600` | Requests per window per source IP |
| `timeouts.connectMs` | `10000` | Ceiling on waiting for response **headers** (not total time) |
| `timeouts.readMs` | `30000` | Ceiling on the gap **between stream frames** |
| `upstreamRetry.attempts` | `3` | Transport-failure retries (HTTP errors are never retried) |

**A broken config will not crash the service**: a wrong type produces a warning and falls back
to the default, rather than being silently ignored.

Environment variables:

| Variable | Meaning |
|---|---|
| `WORKBUDDY_API_HOME` | Config and credential directory, default `~/.workbuddy-api` |

---

## Sites and models

### Sites

| Site id | Description | Upstream |
|---|---|---|
| `cn-cli` | Domestic (CodeBuddy CLI) | `copilot.tencent.com` |
| `intl-cli` | International (CodeBuddy CLI) | `www.codebuddy.ai` |
| `intl-work` | International (WorkBuddy AI) | `www.workbuddy.ai` |

**Quota is not shared** between regions — they are separate account systems, so sign in to each.

### Model routing

A client only needs the model name; the service picks a signed-in site that actually lists it:

```
hy3                    → auto-routed
intl-work/glm-5.3      → site pinned explicitly
cn-cli:hy3             → same, with a colon
```

When the same model id exists on several sites, a signed-in one is preferred.

### Free models

Models marked `免费` (`x0.00`) in `node ask.mjs --list` cost nothing.
The available set depends on your account, so treat `/v1/models` as the source of truth.

---

## How it works

```
Client (OpenAI / Anthropic / Responses)
  ↓
workbuddy-api  ── protocol conversion ── request shaping ── auth ── rate limit
  ↓
Upstream /v2/chat/completions (SSE)
```

The upstream is an **undocumented private API** whose behaviour differs from official OpenAI.
Everything below was **measured** against the live gateway (full evidence in
[docs/upstream-protocol.md](docs/upstream-protocol.md)). This is what separates this project
from a plain passthrough:

| Upstream behaviour | What this project does |
|---|---|
| **Non-streaming is refused** (`400 / code 11101`) | Forces `stream: true`; assembles non-streaming replies locally |
| **Client fingerprints in `system` are refused** (`400 / code 11128`) | Strips the fingerprint sentence (see below) |
| **Thinking text arrives in `reasoning_content`** | Mapped to an Anthropic `thinking` block |
| **`tool_calls` arrive as `index`-keyed fragments** | Aggregated by index; otherwise each fragment becomes a broken call |
| **The first message must be `system`** (international) | Inserted before sending |
| **`developer` is not in the role whitelist** | Rewritten to `system` |
| **`tool_choice` only accepts a string** | Object forms flattened; `none` also drops the tool definitions |
| **Context limit exceeded, and the catalog's limit is too high** | Learns the real limit from the rejection, compresses, and retries |
| **Connections get dropped** (~17% measured on the international gateway) | Transport-level retry; HTTP errors are never retried |
| **Token refresh only reads `X-Refresh-Token`** | Implemented accordingly |
| **`expiresIn` is in seconds** (and can be huge) | Seconds/milliseconds heuristic |
| **The refresh token rotates** | Persisted; refresh is **single-flight** so concurrent refreshes cannot invalidate each other |

### Client fingerprint stripping

The gateway keeps an **exact blacklist**: if a system message *begins* with certain
client-identifying sentences, it returns
`400 / code 11128 "Illegal API invocation from an unapproved channel"`.
**Claude Code hits this out of the box**, because its system prompt opens with that sentence.

The measured rule:

- Matching is at the **start** of the message, case-insensitive
- Leading whitespace is ignored
- **Anything following** the sentence (newline, space, body text) **still matches**
- But content **before** it does not match
- Keeping either **half** of the sentence does not match — so it is not a keyword filter

Stripping therefore has to **replace the sentence at the start**, not compare the whole message
against it. The latter would miss the "fingerprint followed by real instructions" shape — which
is exactly what Claude Code sends.

Verify with: `node tools/verify-fix.mjs <credential.json>`
(it first proves the unprepared request really is refused, then that the prepared one succeeds)

### Context compression

The catalog over-reports the context limit, so the strategy is:

1. When the limit is known, pre-compress: keep the system message plus the newest turns, drop
   oldest first, and keep each tool call together with its result
2. On rejection, **learn the real limit** from the error, shrink proportionally, and retry (up to 3 times)
3. **Calibrate** the local estimator using the token count the upstream reports

Two easy traps: **tool definitions consume the same budget** (only messages can be trimmed, so
their share is subtracted first), and the number in the upstream's error is **a signal, not a
ceiling** — it contradicts itself.

---

## Security

The service **only listens on `127.0.0.1`**. But loopback is **not** a trust boundary — any page
in your browser can reach a local service. Hence:

- **`Host` must be loopback** — defeats DNS rebinding (an attacker domain resolving to 127.0.0.1)
- **`Origin` must be loopback when a browser sends one** — non-browser clients send none and pass
- **Constant-time API-key comparison** (`timingSafeEqual`) — no byte-by-byte probing
- **Sliding-window rate limiting applied before authentication** — an unauthorized flood is
  rejected cheaply; the key map is hard-capped so it cannot become a memory-exhaustion vector itself

> Changing `host` to a non-loopback address exposes the service — the startup banner says so
> explicitly. In that case **set an API key**.

### Credential safety

- Credentials live in `~/.workbuddy-api/auth.<site>.json` with mode `0600`
- **A credential is equivalent to the account**: do not share it, commit it, or place it in a
  directory that gets packaged
- `.gitignore` excludes every credential and config file
- `node login.mjs --logout --site <id>` removes the local credential (it does not affect the
  upstream account)

---

## Known limitations

- **Depends on a private API.** It is undocumented and can change at any time; this project may
  need to follow suit.
- **Content moderation causes false positives.** Beyond the fingerprint blacklist, the upstream
  also refuses by content policy (`code 11140`), frequently triggered by security terminology in
  an agent's system prompt (`DoS`, `exploit`, `credential`, `sandbox`, …). This is **upstream**
  behaviour — this project can mitigate it, not remove it.
- **Rate limiting is triggered by request size** (measured: ~20k tokens passes, ~30k is refused),
  not by frequency. Long-context sessions hit it sooner, which contradicts the "1M context" marketing.
- **Single account.** There is no multi-account pool or automatic failover (one sign-in per site).
- Only drives **your own** account. Follow Tencent's WorkBuddy / CodeBuddy terms of service.

---

## Development

```bash
git clone https://github.com/alanzeng423/workbuddy-api.git
cd workbuddy-api

npm test              # 72 unit tests, zero dependencies
npm run test:native   # via node --test (needs Node >= 22.8)
node server.mjs --port 9000
```

`npm test` uses a bundled lightweight runner rather than `node --test`'s default mode: the
latter isolates each file in a child process, which is denied in confined environments
(`spawn EPERM`). The bundled runner works everywhere.

### Layout

```
server.mjs            Entry point (wiring + startup banner)
login.mjs             OAuth login CLI
status.mjs            Site status CLI
ask.mjs               Command-line client
smoke.mjs             End-to-end self-check
run-tests.mjs         Zero-dependency test runner
src/
  config.mjs          Site table + config validation (tolerant fallback)
  auth.mjs            Credential store + single-flight refresh + rotation
  login.mjs           Device-authorization flow
  models.mjs          Catalog fetch / parse / cache / snapshot fallback
  upstream.mjs        Outbound shaping, error classification, SSE, fingerprint stripping
  compress.mjs        Token estimation / fitting / limit learning
  adapters.mjs        Upstream chunks -> protocol-neutral events
  protocols.mjs       Event projection for the three client protocols
  chat.mjs            Endpoint handlers + protocol bridging + site routing
  server.mjs          HTTP routing, inbound hardening, rate limiting
docs/
  upstream-protocol.md  Measured upstream protocol record
test/                 Unit tests (protocols / config / fingerprint / compression)
tools/                Re-runnable evidence scripts
```

### Evidence scripts

Upstream behaviour was established with these; re-run them if the upstream changes:

```bash
node tools/probe-fingerprint.mjs <credential.json>   # full fingerprint matrix
node tools/verify-fix.mjs <credential.json>          # is the fix sufficient?
node tools/preflight.mjs                             # credential-leak scan before committing
```

---

## FAQ

**Client reports 401 after starting?**
Check the API key matches `~/.workbuddy-api/config.json`. `/health` needs no auth, so
`curl http://127.0.0.1:8788/health` confirms the service is up.

**"Not signed in"?**
Run `node login.mjs --list` to see which site is missing, then `node login.mjs --site <id>`.
Remember quota is not shared: a domestic sign-in does not make the international site work.

**Claude Code keeps returning 400?**
Fingerprint stripping is on by default (`stripClientFingerprint: true`). If it still fails, run
`node tools/verify-fix.mjs` to check whether the upstream behaviour has changed.

**The model list is empty?**
`/v3/config` returns 200 with `models: null` when unauthenticated, so an empty catalog does not
mean "not signed in". Confirm `status.mjs` reports a sign-in first.

**Long sessions fail midway?**
The upstream rate-limits by **request size** (roughly above 30k tokens), contradicting the "1M
context" claim. Lower `context.reserveForOutput`, or trim the number of tools the client sends.

**Can several machines share it?**
Yes, but that requires a non-loopback `host` and **an API key**. Prefer an SSH tunnel or a
reverse proxy over exposing it directly.

**`codebuddy.ai` is unreachable?**
The international CodeBuddy site is unreachable on some networks (measured). This does not
affect `cn-cli` or `intl-work`.

---

## References and related projects

The upstream protocol was established by **this project's own measurements** (`tools/` holds
re-runnable evidence scripts; `docs/upstream-protocol.md` holds the conclusions). The following
projects informed **problem localization** during development; no code was ported:

- [yuan240324/workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy) (MIT)
  — the leads on the client fingerprint blacklist, the over-reported catalog limit, tool
  definitions consuming context, and size-based rate limiting came from this project. Each was
  **reproduced by measurement** before being adopted, and two conclusions differ: the fingerprint
  matching **boundary** (measured as "start of message, and trailing content still matches",
  rather than the whole message equalling the sentence), and the **first-sample handling** in
  estimator calibration.
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) (MIT)
  — DSH plugin shape and loopback-shim inbound hardening.
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT)
  — first established that WorkBuddy could be integrated at all.

---

## Disclaimer

This project is intended for **personal study and research only**. It drives only your own
account, from your own machine. Do not use it commercially or beyond reasonable personal use.

You are responsible for complying with Tencent's WorkBuddy / CodeBuddy terms of service. Any
consequences of using this project (including but not limited to account restrictions, credit
loss, or service interruption) are yours to bear.

This project is not affiliated with, authorized by, or endorsed by Tencent, WorkBuddy,
CodeBuddy, OpenAI, or Anthropic.

## License

[MIT](LICENSE)
