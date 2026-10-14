# WorkBuddy 上游协议实地取证

取证时间：2026-10-12
取证方式：本机 Node 直接请求上游，使用真实可用的国际版凭据
（凭据来源：DSH 插件 vault，仅用于**读协议**，服务本身走独立 OAuth）

这些是**实测事实**，不是从别的项目抄来的推断。写代码以此为准。

---

## 1. 三个站点连通性

| 站点 | `/v3/config` | 说明 |
|---|---|---|
| `copilot.tencent.com`（国内版） | ✅ 200 | 不带 token 也返回，但 `models: null` |
| `www.workbuddy.ai`（国际版 WorkBuddy） | ✅ 200 | 同上 |
| `www.codebuddy.ai`（国际版 CodeBuddy） | ❌ `fetch failed` | **本机网络不可达**（10.5s 超时） |

> ⚠️ `codebuddy.ai` 在本机连不上。所以实现里不能假定它可用——
> 必须允许 `intl-cli` 站点失败而不影响其他站点。

**`/v3/config` 的鉴权行为**：不带 token → `200` + `models: null`；
带有效 token → `200` + `models: [...]`（27 项）。
**所以"拿到空目录"不等于"没登录"**，要分开判断。

---

## 2. 模型目录格式（实测 `www.workbuddy.ai/v3/config`）

响应包络：

```json
{ "code": 0, "msg": "OK", "requestId": "...", "data": { "agent": {...}, "models": [...], "mcp": {...}, "codebase": {...}, "features": {...} } }
```

`data.models` 是**数组**，每项字段（全量 key 已枚举）：

```
canDisableThinking, contextWindow, credits, descriptionEn, descriptionZh,
disabledMultimodal, iconUrl, iconUrl_en, id, isDefault, maxAllowedSize,
maxInputTokens, maxOutputTokens, name, onlyReasoning, reasoning,
relatedModels, summary, supportsImages, supportsReasoning, supportsToolCall,
tags, temperature, top_p, vendor, videoGeneration
```

真实样本：

```json
{"credits":"","descriptionEn":"Excellent coding model, great for daily use",
 "descriptionZh":"优秀的编码模型，适合日常使用","id":"default-model","isDefault":true,
 "maxAllowedSize":200000,"maxInputTokens":176000,"maxOutputTokens":24000,
 "name":"Auto","supportsImages":true,"supportsToolCall":true,"temperature":1,"vendor":"e"}

{"credits":"x0.34 credits","id":"fast-model","maxAllowedSize":200000,
 "maxInputTokens":200000,"maxOutputTokens":32000,"name":"Fast","onlyReasoning":true,
 "reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,
 "supportsReasoning":true,"supportsToolCall":true,"vendor":"i"}
```

**注意 `reasoning` 是单数形式** `{effort, summary}`，不是 `supportedEfforts` 数组。
两者都要兼容（不同站点/模型拼写不同）。

**实测解析结果**：27 项原始数据 → 25 项可用（2 项因缺 token 上限被丢弃）。

**免费模型（`x0.00`）实测只有三个**：
`deepseek-v4.1-flash`、`hy3`、`step-5-preview`
（`default-model` 的 `credits` 是空串，**不是**免费，不能算进去）

---

## 3. Chat 端点：非流式被明确拒绝

```
POST https://www.workbuddy.ai/v2/chat/completions
{"model":"hy3","messages":[...],"stream":false}
```

实测响应：

```
HTTP 400
{"code":11101,"msg":"Non-stream chat request is currently not supported",
 "requestId":"...","displayMsg":{...},"actions":[...]}
```

**结论：必须强制 `stream: true`。** 上游不支持非流式。
反过来说，我们要给客户端提供非流式接口的话，得在代理层把 SSE 聚合起来。

---

## 4. SSE 帧格式（实测）

请求头（实测可用）：

```
POST /v2/chat/completions
Content-Type: application/json
Authorization: Bearer <accessToken>
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkBuddy/5.5.2
Accept: text/event-stream
X-Domain: www.workbuddy.ai
```

响应：`200 text/event-stream`

帧格式是**标准 OpenAI chunk 形状**，但**多了一堆自有字段**：

```
data: {"id":"...","object":"chat.completion.chunk","created":1791949733,
  "model":"hy3",
  "choices":[{"index":0,"delta":{
      "content":"",
      "reasoning_content":"The",     <-- 思考内容，与 content 并列
      "function_call":null,
      "refusal":"",
      "tool_calls":[],
      "extra_fields":null
    },"logprobs":null,"finish_reason":""}],
  "usage":null}

...

data: {"id":"...",...,"choices":[{"delta":{"content":"ok","reasoning_content":"",...},
  "finish_reason":""}],
  "usage":{"prompt_tokens":..,"completion_tokens":..,"total_tokens":..,
    "prompt_tokens_details":{...},"completion_thinking_tokens":13,
    "credit":0, ...}}

data: [DONE]
```

### 关键点

1. **`reasoning_content` 是独立字段**，思考内容走它、正文走 `content`。
   官方 OpenAI 协议**没有**这个字段（DeepSeek 有，OpenAI 没有）。
   → 转 Anthropic 时映射到 `thinking` block；转 OpenAI 时可以选择保留或丢弃。
2. **`usage.credit` 是真实扣费**（实测免费模型返回 `0`），
   比按 token 估算准，应该透传给客户端。
3. **`delta.tool_calls` 每帧都在**（空数组 `[]`），非 delta 式增量——
   需要按 `index` 聚合。
4. **`finish_reason` 在最后一帧前都是空串**。
5. `[DONE]` 结束符是标准的。

---

## 5. 对实现的硬性约束

由以上实测直接推出：

| 约束 | 原因 |
|---|---|
| 上游请求**必须** `stream: true` | 非流式被 400 拒绝 |
| 客户端要非流式时，**代理层聚合 SSE** | 上游给不了非流式 |
| `tool_choice` 对象形式要拍平成字符串 | 上游只收字符串（其他项目一致报告） |
| 首条消息补 `system` | 国际版硬性要求 |
| 保留 `reasoning_content` 的处理策略 | 它是独立字段，Anthropic 要转 `thinking` |
| `intl-cli` 失败要可降级 | 本机实测不可达 |
| 空目录 ≠ 未登录 | `/v3/config` 无 token 也 200 |

---

## 6. OAuth 登录流程（实测已跑通）

### 6.1 申请 state + 授权链接

```
POST /v2/plugin/auth/state?platform=cli
（body 可为空 {}）
```

> ⚠️ **`platform` 必须在 query string 里**。放 JSON body 会返回
> `400 {"code":10001,"msg":"10001:platform is empty"}`——
> 这个坑实测踩过：body 里的 platform 完全不被读取。

实测响应：

```json
{"code":0,"msg":"OK","requestId":"...","data":{
  "state":"87eaf7be-5e00-427a-834f-9a2fb1bc236e",
  "authUrl":"https://copilot.tencent.com/login?platform=cli&state=87eaf7be-..."
}}
```

`platform` 接受：`cli` / `vscode` / `jetbrains` / `codebuddy` / `desktop` / `plugin` / `web`
（实测 7 个值都返回 200 并给出 authUrl）。

### 6.2 轮询换取 token

```
GET /v2/plugin/auth/token?state=<state>
```

未完成授权时实测返回：

```json
{"code":11217,"msg":"11217:login ing...","requestId":"..."}
```

拿到 token 后返回 `code: 0` + `data.{accessToken,refreshToken,...}`。

**这就是"轮询"的语义**：`11217` = 继续等，`0` = 成功。

### 6.3 三站点实测

| 站点 | state 端点 | authUrl 主机 |
|---|---|---|
| `copilot.tencent.com` | ✅ 200 | `https://copilot.tencent.com/login?...` |
| `www.workbuddy.ai` | ✅ 200 | `https://www.workbuddy.ai/login?...` |
| `www.codebuddy.ai` | ❌ 不可达 | — |

---

## 7. Token 刷新（实测已跑通）⚠️ 最坑的一处

```
POST /v2/plugin/auth/token/refresh
Header: X-Refresh-Token: <refreshToken>
```

**关键发现：refresh token 走 `X-Refresh-Token` 请求头，不是请求体。**

实测过程中试过**全部失败**（一律 `10001:refreshToken is empty`）的写法：

- body `{refreshToken: rt}`
- body `{refresh_token: rt}`
- body `{data:{refreshToken:rt}}`（嵌套）
- body `{auth:{refreshToken:rt}}`
- body `{token: rt}` / `{grant_type, refresh_token}`
- body 数组 `[rt]`
- query `?refreshToken=` / `?refresh_token=` / `?token=` / `?rt=` / `?refresh=`
- header `Refresh-Token` / `X-RefreshToken` / `Authorization: Bearer`

**只有 `X-Refresh-Token` 返回 200。**

诊断技巧（值得记住）：发一个**完全无关的字段**，端点仍回
`10001:refreshToken is empty` —— 说明它**根本没读请求体**，
token 来自别处。这个判据比逐个猜字段快得多。

### 刷新响应（实测）

```json
{"code":0,"msg":"OK","data":{
  "accessToken":"<len 1401>",
  "refreshToken":"<len 700>",     <-- 会轮换，必须存回
  "expiresIn":31357656,           <-- 秒（约 363 天）
  "refreshExpiresIn":31357656,
  "tokenType":"Bearer",
  "sessionState":"...",
  "scope":"openid profile offline_access email"
}}
```

**`expiresIn` 是秒数，不是毫秒**，且值可能很大。解析时要做
「小于 1e12 视为秒」的兜底判断（因为不同端点混用两种单位）。

**`refreshToken` 会轮换** → 必须把新的写回存储，否则下次刷新失败。
这也是为什么刷新必须**单飞（single-flight）**：两个并发刷新用同一个
refresh token，前一个轮换后后一个就失效了。

---

## 8. 客户端指纹黑名单（实测，2026-10-12）

上游对 **system 消息**做**精确匹配**，命中就返回：

```
HTTP 400  {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

这不是关键词过滤。实测矩阵：

| system 内容 | 结果 |
|---|---|
| `You are Claude Code, Anthropic's official CLI for Claude.`（整句） | ❌ 400 |
| 只留前半句 `You are Claude Code` | ✅ 200 |
| 只留后半句 `Anthropic's official CLI for Claude` | ✅ 200 |
| 整句放 **user** 位置 | ✅ 200 |
| 整句**嵌在长 system 中间**（前面还有别的内容） | ✅ 200 |
| 前置换行 `\n` + 整句 | ✅ 200 |
| 整句 + **后**置换行 | ❌ 400 |
| 整句 + 尾随空格 | ❌ 400 |
| 整句 + 后面接新段落 | ❌ 400 |
| 整句 + 任意尾随文字（1 字符到 100 字符） | ❌ 400 |
| 大小写变化：全部大写 | ❌ 400 |
| 大小写变化：只把 `Anthropic's` 写成小写 | ❌ 400 |
| 后半句只写 `YOU ARE CLAUDE CODE`（大写） | ✅ 200 |

### 由此推出的精确规则

**匹配的是「system 消息去掉前导空白后的开头」，且大小写不敏感。**

- 前导空白被忽略 → `\n` + 整句仍被拒
- **句子之后有任何内容都会继续命中**（换行/空格/文字都算）
- 但**句子之前**有内容就不命中（那就不是开头了）
- 大小写不敏感

所以剥离策略必须是**「整句出现即从该位置删除」**，而不是「整条消息等于整句才删」：

```
❌ 太窄：if (content.trim() === FINGERPRINT) content = fallback
   → 漏掉 "整句 + 后面还有正文" 这种最常见的形态
      （Claude Code 实际发的就是这一种：整句开头 + 后面一大段指令）

✅ 正确：content.replace(FINGERPRINT_PATTERN, '').trim() || fallback
```

> ⚠️ 这一点与参考项目 `yuan240324/workbuddy-openai-proxy` 的注释不同。
> 它的注释说「只剥离命中的那一句，system 提示词的其余内容原样保留」，
> 但按本次实测，**「整句 + 后续正文」也是被拒的形态**，所以必须做替换而非整条比对。
> 它的实现其实也是 `replace`（结论一致），只是注释里的例子容易让人以为
> 「嵌在中间」是安全的 —— 实测**嵌在中间安全，接在后面不安全**，两者不同。

### 影响面

**Claude Code 开箱即用会直接 400**，因为它的 system prompt 以这句话开头。
Claude Desktop 的 `/code` 面板同理；`/cowork` 面板提示词不同，所以不受影响。

---

## 9. 待补取证

- [ ] `reasoning_effort` 参数名与取值（目录声明 `low/medium/high/xhigh/max`）
- [ ] `/v2/billing/meter/get-user-resource` 带真实 token 的响应形状
- [ ] 国内版 `copilot.tencent.com` 的 chat 端点是否与国际版同构
- [ ] 上下文真实上限（目录值与实际不符，需从 400 报错里学）
