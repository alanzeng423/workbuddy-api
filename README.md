# workbuddy-api

把 **WorkBuddy / CodeBuddy（腾讯 AI 编程助手）** 的订阅额度，转成本机可直接使用的
**OpenAI 兼容 / Anthropic 兼容 API** —— 让你能在 Claude Code、Codex CLI、
Cherry Studio、Cursor、Open WebUI 等任何支持这两种协议的客户端里复用它。

**零运行时依赖**：只需要 Node.js ≥ 18。没有 `npm install`，没有 Docker，没有 Redis。

```bash
git clone https://github.com/alanzeng423/workbuddy-api.git
cd workbuddy-api
node login.mjs      # 浏览器授权登录
node server.mjs     # 启动
```

---

## 目录

- [特性](#特性)
- [安装](#安装)
- [客户端接入](#客户端接入)
- [命令行](#命令行)
- [配置](#配置)
- [站点与模型](#站点与模型)
- [工作原理](#工作原理)
- [安全](#安全)
- [已知限制](#已知限制)
- [开发](#开发)
- [常见问题](#常见问题)

---

## 特性

- **三种协议**：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses
  （Codex CLI 需要最后一种）
- **独立登录**：走官方 OAuth 设备授权流程，**不需要预先安装 WorkBuddy 桌面 App**，
  也不读取任何其他客户端的数据 —— 因此可以直接分享给别人用
- **国内版 + 国际版并行**：两边的账号可同时在线，按模型自动路由
- **流式与非流式都支持**：上游只给流式，非流式由本服务在本地聚合
- **完整工具调用**：流式 `tool_calls` 聚合、`tool_choice` 归一、多轮回灌
- **上下文自动压缩**：撞上游上限时自动裁剪并重试，长会话不直接吃 400
- **零依赖**：只用 Node 内置模块，无供应链风险

---

## 安装

### 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 18**（用 `node --version` 确认） |
| 操作系统 | Windows / macOS / Linux |
| 账号 | 你自己有一个可用的 WorkBuddy 或 CodeBuddy 账号 |

### 方式一：git clone（推荐）

```bash
git clone https://github.com/alanzeng423/workbuddy-api.git
cd workbuddy-api
```

不需要 `npm install` —— 本项目没有任何依赖。

### 方式二：直接下载

从 [Releases](https://github.com/alanzeng423/workbuddy-api/releases) 下载源码包，
解压后进入目录即可。

### 第一步：登录

```bash
node login.mjs
```

会提示选择站点：

```
请选择要登录的站点：
  1) 国内版 (CodeBuddy CLI)  [cn-cli]
  2) 国际版 (CodeBuddy CLI)  [intl-cli]
  3) 国际版 (WorkBuddy AI)   [intl-work]
序号 (默认 1):
```

选定后会打印一条授权链接并尝试自动打开浏览器。
**在浏览器里完成授权**，终端会自动轮询并在成功后提示。

也可以直接指定站点、跳过交互：

```bash
node login.mjs --site intl-work      # 直接登录国际版
node login.mjs --site cn-cli --no-open   # 不自动开浏览器（服务器上用）
node login.mjs --list                # 查看各站点登录状态
node login.mjs --logout --site cn-cli    # 清除本地凭据
```

> **额度不通用**：国内版与国际版是两套独立账号与余额，需要分别登录。
> 想两边都能用，就各登录一次。

### 第二步：启动

```bash
node server.mjs
```

看到这样的横幅就成功了：

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

**API Key 首次启动自动生成**，保存在 `~/.workbuddy-api/config.json`。
接客户端时要用到这个 Key。

可选参数：

```bash
node server.mjs --port 9000        # 换端口
node server.mjs --host 127.0.0.1   # 换监听地址（默认就是回环）
```

### 第三步：验证

```bash
node smoke.mjs     # 端到端自检所有端点（会用免费模型，不花积分）
node ask.mjs --list
node ask.mjs hy3 "你好"
```

`smoke.mjs` 输出示例：

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

## 客户端接入

所有客户端都用相同的一组参数，只有协议和路径不同：

| 参数 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | 启动横幅里的 `sk-wb-…` |
| Model | `hy3` / `deepseek-v4.1-flash` / `glm-5.3` / …（见 `node ask.mjs --list`） |

### Claude Code / CC Switch

Claude Code 走 Anthropic 协议，填 `/v1/messages`：

```json
{
  "WorkBuddy": {
    "base_url": "http://127.0.0.1:8788/v1/messages",
    "api_key": "sk-wb-你的KEY",
    "model": "deepseek-v4.1-flash"
  }
}
```

### Codex CLI

Codex CLI 走 Responses 协议，编辑 `~/.codex/config.toml`：

```toml
[model_providers.workbuddy]
name = "WorkBuddy"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"

[profiles.workbuddy]
model = "deepseek-v4.1-flash"
model_provider = "workbuddy"
```

然后：`codex --profile workbuddy "你的任务"`

### Cherry Studio / LobeChat / NextChat / Open WebUI

添加一个 **OpenAI 兼容**的自定义供应商：

- API 地址：`http://127.0.0.1:8788/v1`
- API Key：`sk-wb-…`
- 模型：手填 `hy3` 或 `deepseek-v4.1-flash`，或让它读取模型列表

### Cursor / TraeWork / 其他 IDE

在自定义模型设置里：

- Base URL：`http://127.0.0.1:8788/v1`（若要求完整地址则填 `…/v1/chat/completions`）
- Model ID：`hy3` 等
- API Key：`sk-wb-…`

> 服务端对路径做了容错：不管客户端拼成 `/v1/v1/chat/completions` 还是
> `/v1/chat/completions/`，都能命中。

---

## 命令行

| 命令 | 作用 |
|---|---|
| `node login.mjs [--site <id>] [--no-open] [--list] [--logout]` | 登录 / 查看 / 登出 |
| `node server.mjs [--host <ip>] [--port <n>]` | 启动服务 |
| `node status.mjs [--json]` | 各站点登录态与 token 到期时间 |
| `node ask.mjs --list` | 列出模型（含积分倍率，`免费` 标记） |
| `node ask.mjs [选项] <model> "<问题>"` | 命令行提问 |
| `node smoke.mjs [--url <u>] [--key <k>]` | 端到端自检 |
| `npm test` | 单元测试（72 个，零依赖） |

`ask.mjs` 选项：

```bash
node ask.mjs hy3 "你好"                              # 默认 OpenAI 协议
node ask.mjs --stream hy3 "数到五"                    # 流式输出
node ask.mjs --protocol anthropic hy3 "你好"          # Anthropic 协议
node ask.mjs --protocol responses hy3 "你好"          # Responses 协议
node ask.mjs --url http://127.0.0.1:9000 hy3 "你好"   # 指定地址
```

---

## 配置

配置文件：`~/.workbuddy-api/config.json`（首次启动自动生成）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。**改成非回环会暴露到网络** |
| `port` | `8788` | 监听端口 |
| `apiKey` | 自动生成 | 可以是字符串，也可以是字符串数组（多个 Key 都有效） |
| `defaultSite` | `cn-cli` | 都没命中时用哪个站点 |
| `ensureSystemMessage` | `true` | 补首条 system（国际版硬性要求） |
| `defaultSystemPrompt` | `You are a helpful assistant.` | 兜底的 system 内容 |
| `stripClientFingerprint` | `true` | 剥离上游黑名单里的客户端指纹（见 [工作原理](#工作原理)） |
| `context.enabled` | `true` | 上下文超限时自动压缩 |
| `context.reserveForOutput` | `4096` | 给模型回复预留的 token |
| `context.minKeepMessages` | `4` | 至少保留最近几条消息 |
| `context.safetyRatio` | `0.95` | 按上限的 95% 算，给估算误差留余量 |
| `rateLimit.enabled` | `true` | 启用滑动窗口限流 |
| `rateLimit.windowMs` / `max` | `10000` / `600` | 每窗口每来源 IP 的请求上限 |
| `timeouts.connectMs` | `10000` | 等上游**响应头**的上限（不是总时长） |
| `timeouts.readMs` | `30000` | 上游**两帧之间**的间隔上限 |
| `upstreamRetry.attempts` | `3` | 传输层失败重试次数（HTTP 错误不重试） |

**配置写错不会崩**：类型不对会逐条警告并回退到默认值，而不是静默忽略。

环境变量：

| 变量 | 说明 |
|---|---|
| `WORKBUDDY_API_HOME` | 配置与凭据目录，默认 `~/.workbuddy-api` |

---

## 站点与模型

### 站点

| 站点 id | 说明 | 上游 |
|---|---|---|
| `cn-cli` | 国内版（CodeBuddy CLI） | `copilot.tencent.com` |
| `intl-cli` | 国际版（CodeBuddy CLI） | `www.codebuddy.ai` |
| `intl-work` | 国际版（WorkBuddy AI） | `www.workbuddy.ai` |

**额度不通用**：国内版与国际版是独立账号体系，需分别登录。

### 模型路由

客户端只写模型名即可，服务会挑一个**已登录且列出了该模型**的站点：

```
hy3                    → 自动路由
intl-work/glm-5.3      → 显式指定站点
cn-cli:hy3             → 同上（冒号也行）
```

同名模型在多个站点存在时，优先选已登录的那个。

### 免费模型

`node ask.mjs --list` 里标 `免费` 的（`x0.00`）不扣积分。
各账号可用模型不同，实际清单以 `/v1/models` 实时返回为准。

---

## 工作原理

```
客户端 (OpenAI / Anthropic / Responses)
  ↓
workbuddy-api  ── 协议转换 ── 请求整形 ── 鉴权 ── 限流
  ↓
上游 /v2/chat/completions (SSE)
```

上游是**非公开接口**，行为与官方 OpenAI 有差异。以下是**实测**得出的硬性约束
（完整取证见 [docs/upstream-protocol.md](docs/upstream-protocol.md)），
也是本项目和"直接转发"的区别所在：

| 上游实际行为 | 本项目如何处理 |
|---|---|
| **非流式请求被拒**（`400 / code 11101`） | 强制 `stream:true`；客户端的非流式请求在本地聚合 |
| **system 里的客户端指纹被拒**（`400 / code 11128`） | 剥离指纹句（见下） |
| **思考内容在 `reasoning_content`** | 转 Anthropic 时映射为 `thinking` block |
| **`tool_calls` 按 `index` 分片到达** | 按 index 聚合，否则每个分片会变成残缺的工具调用 |
| **首条必须是 system**（国际版） | 出站前自动补齐 |
| **`developer` 角色不在白名单** | 改写为 `system` |
| **`tool_choice` 只收字符串** | 对象形式自动拍平；`none` 连 tools 一起删 |
| **上下文超限，且目录里的上限偏大** | 从报错里学真实上限 + 压缩后重试 |
| **连接会被掐断**（国际版实测约 17%） | 传输层自动重试，HTTP 错误不重试 |
| **刷新 token 只认 `X-Refresh-Token` 头** | 按此实现 |
| **`expiresIn` 是秒**（且可能极大） | 做秒/毫秒兜底判断 |
| **refresh token 会轮换** | 写回；刷新流程**单飞**，防并发轮流互废 |

### 客户端指纹剥离

上游维护着一份**精确黑名单**：system 消息以特定客户端提示词**开头**就返回
`400 / code 11128 "Illegal API invocation from an unapproved channel"`。
**Claude Code 开箱即用会直接撞上**，因为它的 system prompt 正是以那句话开头的。

实测出的规则：

- 是**句首**匹配，大小写不敏感
- 前导空白被忽略
- 句子**之后**接任何内容（换行、空格、正文）**仍会被拒**
- 但句子**之前**有内容就不命中
- 只留句子的任意一半都不命中 —— 不是关键词过滤

所以剥离必须**替换句首**，而不是"整条等于该句才替换"——
后者会漏掉"指纹 + 后续正文"这种形态，也就是 Claude Code 实际发的形态。

验证：`node tools/verify-fix.mjs <credential.json>`
（会先证明未处理的请求确实被拒，再证明处理后通过）

### 上下文压缩

目录里的上下文上限**偏大**，所以策略是：

1. 已知上限时预压缩：保留 system + 最新消息，丢弃最旧，tool 调用与结果同生共死
2. 被拒时从报错里**学真实上限**，按比例收缩后重试（最多 3 次）
3. 用上游回报的真实 token 数**校准本地估算器**

两个容易踩空的点：**工具定义也占上下文**（裁剪只能动 messages，所以必须先扣掉工具那份），
以及上游报错里的数字**只当信号不当上限**（它自己就互相矛盾）。

---

## 安全

服务**只监听 `127.0.0.1`**。但回环地址**不是**信任边界 ——
你浏览器里的任何网页都能访问本机服务。因此有以下防护：

- **`Host` 必须是回环** —— 挡 DNS rebinding（攻击者域名解析到 127.0.0.1）
- **`Origin` 若是浏览器发出则必须是回环** —— 非浏览器客户端不带 Origin，放行
- **API Key 常量时间比对**（`timingSafeEqual`）—— 防逐字节试探
- **滑动窗口限流，在鉴权之前生效** —— 未授权的洪泛也能被廉价拒掉；
  key 表有硬上限，避免自身成为内存耗尽的攻击面

> 若把 `host` 改成非回环地址，服务会暴露到网络 —— 启动横幅会明确警告，
> 此时**务必**设置 API Key。

### 凭据安全

- 凭据存在 `~/.workbuddy-api/auth.<站点>.json`，权限 `0600`
- **凭据等同账号本身**：不要外传、不要提交仓库、不要放进会被打包的目录
- `.gitignore` 已排除所有凭据与配置文件
- 用 `node login.mjs --logout --site <id>` 可清除本地凭据（不影响上游账号）

---

## 已知限制

- **依赖非官方接口**。上游无文档、随时可能变更；变更后本项目可能需要跟进。
- **内容审核会误伤**：除指纹黑名单外，上游还会按内容策略拒绝（`code 11140`），
  且常被 agent system prompt 里的安全术语（`DoS`、`exploit`、`credential`、
  `sandbox` 等）触发。这是**上游的**行为，本项目只能缓解、无法消除。
- **限流按请求体积触发**（实测约 20k token 可通过、30k 被拒），不是按频率。
  长上下文会话更容易撞限流，这与"1M 上下文"的宣传不符。
- **单账号**：目前不支持多账号池与自动换号（一个站点一个登录态）。
- 仅驱动**你自己的账号**，请遵守腾讯 WorkBuddy / CodeBuddy 用户协议。

---

## 开发

```bash
git clone https://github.com/alanzeng423/workbuddy-api.git
cd workbuddy-api

npm test              # 72 个单元测试，零依赖
npm run test:native   # 用 node --test（需 Node ≥ 22.8）
node server.mjs --port 9000
```

`npm test` 用自带的轻量 runner，而不是 `node --test` 的默认模式：
后者的子进程隔离在受限环境里会被拒绝（`spawn EPERM`），自带 runner 让套件到处都能跑。

### 项目结构

```
server.mjs            服务入口（组装 + 启动横幅）
login.mjs             OAuth 登录 CLI
status.mjs            站点状态 CLI
ask.mjs               命令行提问客户端
smoke.mjs             端到端自检
run-tests.mjs         零依赖测试 runner
src/
  config.mjs          站点表 + 配置校验（容错回退）
  auth.mjs            凭据存储 + 刷新（单飞）+ token 轮换
  login.mjs           设备授权流程
  models.mjs          目录拉取 / 解析 / 缓存 / 快照回退
  upstream.mjs        出站整形、错误分类、SSE 解码、指纹剥离
  compress.mjs        上下文估算 / 裁剪 / 上限学习
  adapters.mjs        上游 chunk → 协议中立事件
  protocols.mjs       三种客户端协议的事件投影
  chat.mjs            端点 handler + 协议互转 + 站点路由
  server.mjs          HTTP 路由、入站加固、限流
docs/
  upstream-protocol.md  上游协议实地取证记录
test/                 单元测试（协议 / 配置 / 指纹 / 压缩）
tools/                可复跑的取证脚本
```

### 取证脚本

上游行为靠这些脚本确认，上游变更后可重跑：

```bash
node tools/probe-fingerprint.mjs <credential.json>   # 指纹黑名单完整矩阵
node tools/verify-fix.mjs <credential.json>          # 修复是否充分
```

---

## 常见问题

**Q：启动后客户端报 401？**
检查 API Key 是否与 `~/.workbuddy-api/config.json` 里的一致。
`/health` 是免鉴权的，可以先 `curl http://127.0.0.1:8788/health` 确认服务活着。

**Q：报「尚未登录」？**
`node login.mjs --list` 看哪个站点没登录，然后 `node login.mjs --site <id>`。
注意额度不通用，国内版登录不等于国际版可用。

**Q：Claude Code 一直 400？**
本项目默认已剥离指纹（`stripClientFingerprint: true`）。
若仍失败，用 `node tools/verify-fix.mjs` 确认上游行为是否已变更。

**Q：模型列表是空的？**
`/v3/config` 不带 token 也会返回 200 但 `models: null`，所以"空目录"不等于"没登录"。
先确认 `status.mjs` 显示已登录。

**Q：长会话中途报错？**
上游按**请求体积**限流（约 30k token 以上会被拒），与"1M 上下文"的宣传不符。
可以在配置里调小 `context.reserveForOutput`，或在客户端精简工具数量。

**Q：能同时给多台机器用吗？**
可以，但需要把 `host` 改成非回环地址，并**务必设置 API Key**。
或者用 SSH 隧道、反向代理等方式，不要直接暴露。

**Q：`codebuddy.ai` 连不上？**
国际版 CodeBuddy 站点在某些网络下不可达（实测）。这不影响 `cn-cli` 与 `intl-work`。

---

## 参考与其他项目

上游协议由**本项目的实地取证**确定（`tools/` 下是可复跑的取证脚本，
`docs/upstream-protocol.md` 是结论）。以下项目的公开资料在**问题定位**阶段
提供了方向参考，本项目未移植其代码：

- [yuan240324/workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy)（MIT）
  — 客户端指纹黑名单、目录上限偏大、工具定义占上下文、限流按体积触发这几条线索
  来自该项目。本项目对其**逐条实测复现**后才采用，并在两处得出不同结论：
  指纹匹配的**边界**（实测是"句首 + 后续内容仍命中"，而非整条等于该句），
  以及估算校准的**首样本处理**。
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）
  — DSH 插件形态与 loopback shim 入站加固思路参考。
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）
  — 最初验证了 WorkBuddy 接入的可行性。

---

## 免责声明

本项目仅供**个人学习与研究**使用，仅驱动使用者自己的账号在本机调用，
请勿用于商业用途或超出个人合理使用的场景。

使用者需自行遵守腾讯 WorkBuddy / CodeBuddy 的服务条款；
因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断）
由使用者自行承担。

本项目与腾讯、WorkBuddy、CodeBuddy、OpenAI、Anthropic 均无关联，
未获其授权或认可。

## 许可证

[MIT](LICENSE)
