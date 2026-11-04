# Responses 条目 id 剥离（修复 Azure 多资源 400）

> 目标读者：在本仓库实现该功能的会话。实施前请先读 `AGENTS.md` 与 `docs/request-identity.md`。
>
> 本需求是 request-identity 的第二类「请求改写」：现有能力改**请求头**，本需求改**请求体**。

## 1. 问题

### 1.1 现象

使用 AgentRouter 的 `gpt-5.6-sol` / `gpt-6.1-sol` 等模型时，多轮对话（第二轮及以后）会随机整轮失败：

```json
{
  "message": "The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [hub-] [trace_id=3898b0410313acf4c6041b37dd9fc232]",
  "type": "invalid_request_error"
}
```

### 1.2 根因

1. 这类模型（`api: openai-responses`）挂在**多个 Azure OpenAI 资源**上做负载均衡，每个请求随机落到其中一个资源。
2. Responses API 的历史条目是「有归属」的：`input[]` 里的每个 item 带顶层 `id`（`msg_…` / `rs_…` / `fc_…`）。**带 id 意味着「引用」**，Azure 收到后会拿这个 id 去**自己**的存储里查。
3. 上一轮的条目属于资源 A，这一轮被路由到资源 B → B 查到自己库里没有、或查到属于别的资源 → 400。
4. 响应里 `resp_` 后面那段前缀就是上游资源指纹，同一资源下多轮保持不变。

### 1.3 为什么 `store: false` 挡不住

DSH 的 `openai-responses` 适配器本来就发 `store: false`（不让我们存），但 id 是**响应方给的**：`convertResponsesMessages` 会把上一轮输出原样回填进 `input` ——

- 文本块：`id` 取自 `textSignature` 里上游给的 item id；
- 思考块：`JSON.parse(block.thinkingSignature)` 整条 `{type:"reasoning", id:rs_…, encrypted_content:…}` 直接 push；
- 工具调用：`{type:"function_call", call_id, id:fc_…}`。

Azure 只看到请求里带着 id，就去查自己的库，与我们要不要存无关。

### 1.4 实测证据（2026-11-04，真实 key）

| 实验 | 结果 |
| --- | --- |
| 两轮对话，ids 原样回填 | turn1 资源 `_073884c7781fe0fb` → turn2 被切走 → **400 原样复现** |
| gpt-5.6-sol 连续 7 轮同资源 | 第 8 轮被切 → **400** |
| gpt-6.1-sol 连续对话 | 第 2 轮就被切 → **400** |
| gpt-6-astra 连续 5 轮 | 没被切（运气，不是单通道保证） |
| **ids 剥离后连走 8 轮** | 8 轮落在 **8 个不同资源** → **全部 200** |
| **ids 剥离 + 工具调用往返 6 轮** | 6 轮 **6 个不同资源** → **全部 200**（`call_id`、`encrypted_content` 保留） |

结论：**条目级 `id` 只是 Azure 的存储引用，剥离后条目作为内联内容发送，任何资源都吃；`call_id` 才是工具关联的关键，必须保留。**

## 2. 目标与非目标

**目标**

- 在现有 `globalThis.fetch` 补丁里，按规则对出站 `POST …/responses` 的 JSON 请求体做「剥离条目 id」改写。
- 默认关闭，零规则零影响；配置、UI、统计、测试齐备。

**非目标**

- 不改 `previous_response_id`（DSH 的 HTTP 路径不发它；websocket/codex 传输不在覆盖范围）。
- 不处理 `/v1/chat/completions`、`/v1/messages`（它们的条目语义不同）。
- 不重写 `tools`、`instructions`、`model` 等其它字段。
- 不做响应体重写，绝不碰 `Response` 对象。

## 3. 行为规格

| 编号 | 要求 |
| --- | --- |
| FR-1 | 仅当命中的规则 `stripResponsesItemIds === true` 时生效；默认 `false`。 |
| FR-2 | 仅 `POST` + `content-type` 含 `application/json` + 请求体可解析为 JSON 且 `body.input` 是数组。任一不满足 → **原样转发原始参数**（保持现不变量：未匹配/不可改时把 `input`、`init` 原封不动传给 native）。 |
| FR-3 | 只删 `body.input[]` 每个 item 的**顶层** `id`；其它字段（`type`/`role`/`content`/`status`/`call_id`/`encrypted_content`/`summary`/`arguments`…）原样保留，键顺序不做保证。 |
| FR-4 | `item.type === 'item_reference'` 的条目**跳过**（它只有 id，删了就废），并计入 `skipped`。 |
| FR-5 | 只有真的删掉了 ≥1 个 id 才重建请求；`stripped === 0` 时按 FR-2 原样转发。 |
| FR-6 | 重建请求必须：保留 method/url/signal/credentials/redirect；沿用原 headers 并经现有 UA/自定义头规则改写；**删除 `content-length`**；body 非空时补 `duplex: 'half'`。 |
| FR-7 | 幂等：重复剥离同一 body 不再产生变化（第二次 `stripped === 0`）。 |
| FR-8 | 请求体超过上限（建议 8 MiB）→ 不读、不改、原样转发，`diagnostics` 打开时 warn 一次。 |
| FR-9 | 请求体内容不得进入日志与统计。统计只允许计数（`strippedItems`）。 |

## 4. 配置

`index.js` 的 `IdentityRule` 增加一个字段（`src/identity-core.js#sanitizeRule` 同步归一化）：

```js
const IdentityRule = z.object({
  id: z.string().required(),
  enabled: z.boolean().default(true),
  urlPattern: z.string().required(),
  userAgent: z.string().default(''),
  headers: z
    .array(z.object({ name: z.string().required(), value: z.string().default('') }))
    .default([]),
  /**
   * OpenAI Responses：转发前剥掉 input[] 每个条目的顶层 id。
   * 用于上游把同一模型挂在多个 Azure OpenAI 资源上、条目 id 跨资源不可引用的场景。
   */
  stripResponsesItemIds: z.boolean().default(false),
  note: z.string().default(''),
})
```

profile 侧写法：

```yaml
- id: dsh-toolbox
  name: dsh-toolbox
  config:
    identity:
      enabled: true
      rules:
        - id: agentrouter-org
          enabled: true
          urlPattern: agentrouter.org
          userAgent: pi (win32 10.0.26100; x64)
          stripResponsesItemIds: true
          headers: []
```

`sanitizeRule` 里补一行：`stripResponsesItemIds: source.stripResponsesItemIds === true`（与 `enabled` 同风格，缺省 false，不接受真值字符串）。

## 5. 实现

### 5.1 `src/identity-core.js`：新增纯函数

保持该模块「无依赖、可三处复用（host / 浏览器 / 测试）」的性质。

```js
/** 请求体重写上限；超过则不读改写。 */
export const BODY_LIMITS = Object.freeze({ maxJsonBodyBytes: 8 * 1024 * 1024 })

/**
 * 剥离 OpenAI Responses 请求体里 input[] 各条目的顶层 id。
 *
 * @param {string} raw 原始请求体文本
 * @returns {{ text: string, stripped: number, skipped: number }}
 *   `stripped === 0` 时 `text` 原样返回（调用方据此走「不重建请求」快路径）。
 */
export function stripResponsesItemIds(raw) {
  const unchanged = { text: raw, stripped: 0, skipped: 0 }
  if (typeof raw !== 'string' || raw.length === 0) return unchanged
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return unchanged
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.input)) return unchanged

  let stripped = 0
  let skipped = 0
  const input = body.input.map((item) => {
    if (item === null || typeof item !== 'object') return item
    if (!Object.hasOwn(item, 'id')) return item
    if (item.type === 'item_reference') {
      skipped += 1
      return item
    }
    const { id: _id, ...rest } = item
    stripped += 1
    return rest
  })
  if (stripped === 0) return { text: raw, stripped: 0, skipped }
  return { text: JSON.stringify({ ...body, input }), stripped, skipped }
}
```

### 5.2 `src/identity-patch.js`：接线

三条硬约束：**异步化**、**先 clone 再读**、**删 content-length**。

```js
import { BODY_LIMITS, matchRule, stripResponsesItemIds, /* … */ } from './identity-core.js'

/** 读出可改写的请求体；返回 null 表示「保持原样」。 */
async function strippableBody(request) {
  if (request.method !== 'POST') return null
  if (request.body === null) return null
  const type = (request.headers.get('content-type') ?? '').toLowerCase()
  if (!type.includes('application/json')) return null
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > BODY_LIMITS.maxJsonBodyBytes) return null
  // 必须 clone：读掉的 body 无法再转发。
  const text = await request.clone().text()
  if (text.length > BODY_LIMITS.maxJsonBodyBytes) return null
  return stripResponsesItemIds(text)
}

function rewrittenRequest(request, rule, body) {
  const headers = new Headers(request.headers)
  const beforeUserAgent = headers.get('user-agent')
  if (typeof rule.userAgent === 'string' && rule.userAgent.length > 0) {
    headers.set('user-agent', rule.userAgent)
  }
  for (const header of applicableHeaders(rule)) headers.set(header.name, header.value)
  if (body !== null) headers.delete('content-length') // 长度变了，交给运行时重算
  const next = new Request(request, {
    headers,
    ...(body === null ? {} : { body, duplex: 'half' }),
  })
  return { next, beforeUserAgent, afterUserAgent: headers.get('user-agent') }
}
```

`host.wrap` 改为 `async function identityFetch(input, init)`：

```js
const request = input instanceof Request ? input : new Request(input, init)
let body = null
let stripped = 0
if (rule.stripResponsesItemIds === true) {
  const result = await strippableBody(request)
  if (result !== null && result.stripped > 0) {
    body = result.text
    stripped = result.stripped
  }
}
const rewritten = rewrittenRequest(request, rule, body)
host.stats?.record?.(
  rule.id,
  url,
  rewritten.beforeUserAgent,
  rewritten.afterUserAgent,
  Date.now(),
  { strippedItems: stripped },
)
```

异常路径保持现状：任何抛错都 `host.native.call(this, input, init)` 转发**原始**参数。

### 5.3 统计

`createIdentityStats().record` 现有签名是 `record(ruleId, url, beforeUserAgent, afterUserAgent, at = Date.now())`，第 5 个参数已经是 `at`。**不要插入到中间**，在末尾追加：

```js
record(ruleId, url, beforeUserAgent, afterUserAgent, at = Date.now(), extra = {})
```

只从 `extra` 取 `strippedItems: Number`（`Number.isFinite` 校验，负数归零），写进 `last` 与对应规则的快照里。仍是「只计数、不含内容」。

### 5.4 UI 与文案

- `src/identity-client.js`：规则编辑表单加一个 checkbox（放在「自定义请求头」之后），标签「剥离 Responses 条目 id」，副提示「多资源 Azure 网关在多轮对话报 400 时开启；会移除历史条目的 id，保留工具调用关联」。
- `src/i18n.js`：`zh` 与 `en` 两块各加两条键，zh 为键集真源：
  - `identity.field.stripItemIds`
  - `identity.field.stripItemIdsHint`
- 命中统计卡片显示 `strippedItems`（可只在该值 >0 时显示）。
- `client.js` 是生成文件：改完 `src/` 跑 `pnpm run build`。

## 6. 测试

`test/identity-core.test.js`（纯函数）

1. 正常数组：3 条 item 各去掉 id，`stripped === 3`，其余字段与值不变。
2. `input` 是字符串 → 原样返回。
3. 无 `input` 字段 → 原样返回。
4. 非法 JSON → 原样返回且不抛。
5. `item_reference` → 跳过，`skipped === 1`，该条目保留完整（含 id）。
6. 全部条目都没有 id → `stripped === 0` 且返回**同一字符串引用**（便于上层走快路径）。
7. 幂等：对结果再剥离一次 → `stripped === 0`。
8. `call_id` / `encrypted_content` / `summary` 保留。

`test/identity-patch.test.js`（fetch 补丁）

9. 规则 `stripResponsesItemIds: true` + POST `/v1/responses`，带 id 的 body → 转发出去的 `Request` body 里没有条目 id，UA 同时被改写，`content-length` 与原值不等。
10. 规则为 `false` → native 收到的是**同一个** `Request` 实例（现有不变量不能被破坏）。
11. GET `/v1/models` → 不动 body。
12. `content-type: text/plain` 的 POST → 不动。
13. body 不可解析 → 原样转发，不抛。
14. `input` 里混有 `item_reference` → 该条保留，其它剥离。
15. 超上限 body → 原样转发（可用小 `BODY_LIMITS` 覆盖或注入上限测）。

`test/identity-host.test.js`

16. 配置往返：`sanitizeIdentityConfig` 接受并回显 `stripResponsesItemIds`，缺省 false，字符串 `'true'` 不生效。

## 7. 验收

```bash
pnpm run build
pnpm run check
pnpm test
```

手工验收（真实 AgentRouter key）：

1. profile 里给 `agentrouter.org` 规则加 `stripResponsesItemIds: true`，开启 `identity.enabled`。
2. DSH 里用 `gpt-6.1-sol`（最容易切资源，第 2 轮就会跨资源）连续对话 ≥ 8 轮，含一次工具调用。
3. 期望：全程无 `different Azure OpenAI resource`；`/v1/models` 拉取正常；SSE 流式输出不受影响。
4. 关闭该字段再跑同样对话 → 应能复现 400（证明改写确实起作用，而不是运气）。

## 8. 风险与坑

| 编号 | 坑 | 处置 |
| --- | --- | --- |
| C-1 | 顺手把 `call_id` 也删了 → 工具结果对不上 | 只删条目顶层 `id`，测试用例 8 兜底 |
| C-2 | 读 `request.body` 后原请求不可再用 | 必须先 `request.clone()` 再读；异常则转发**原始**参数 |
| C-3 | 改了 body 没删 `content-length` → 上游截断/挂起 | `headers.delete('content-length')` |
| C-4 | 把 `Request` 的 headers 直接改（`request.headers` 只读） | 用 `new Headers(request.headers)` 再重建 |
| C-5 | 大 body 全量读入内存 | 先看 `content-length`，再看实际长度，双阈值 8 MiB |
| C-6 | 日志/统计里泄露对话内容 | 只记 `strippedItems` 计数与规则 id |
| C-7 | 异步化破坏调用方时序 | wrapper 返回 Promise 即可；未匹配路径仍是同步直通（`return host.native.call(...)`） |
| C-8 | 规则命中但 provider 不是 Responses，body 无 `input` | FR-2 的 `Array.isArray(body.input)` 判据即可放过 |
| C-9 | 其它 provider 也被同一 `urlPattern` 命中 | 剥离对无 `input` 数组的 body 是 no-op，天然安全 |

## 9. 附录：独立验证脚本

不依赖插件，直接验证「剥离后跨资源可用」。放到临时目录跑，`AGENTROUTER_KEY` 用环境变量传：

```js
const KEY = process.env.AGENTROUTER_KEY
const URL = 'https://agentrouter.org/v1/responses'
const H = {
  'user-agent': 'pi (win32 10.0.26100; x64)',
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
}

async function post(body) {
  const r = await fetch(URL, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const s = await r.text()
  try { return { status: r.status, json: JSON.parse(s) } } catch { return { status: r.status, text: s } }
}

const strip = (items) => items.map(({ id, ...rest }) => rest)
const history = [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with one word: alpha' }] }]

for (let turn = 1; turn <= 8; turn += 1) {
  const r = await post({ model: 'gpt-6.1-sol', input: history, max_output_tokens: 300, store: false })
  if (r.status !== 200) {
    console.log(`turn ${turn}: ${r.status} ${String(r.json?.error?.message ?? '').slice(0, 120)}`)
    break
  }
  const items = r.json.output ?? []
  // 资源指纹：resp_ 后的前缀，同一上游资源内保持不变
  console.log(`turn ${turn}: 200 resource=${r.json.id.slice(4, 13)}`)
  history.push(...strip(items), { role: 'user', content: [{ type: 'input_text', text: `turn ${turn + 1}` }] })
}
```
