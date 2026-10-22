# 需求：LLM 请求客户端身份改写（Client Identity Rewrite）

> 状态：已实现（宿主 + 客户端），单元/集成测试通过，待真实 GUI 手动验收
> 实现记录与本文的差异见 §13
> 目标插件：`dsh-toolbox`（可作为独立 feature 模块）
> 撰写依据：对 DSH 0.2.x 运行时的源码核对 + 对 `agentrouter.org` 的实测（2026-10-22）

---

## 1. 背景

部分第三方 LLM 中转站按**客户端指纹**放行，只接受官方 CLI 的 `User-Agent`，其余客户端一律拒绝。以 `agentrouter.org` 为例：

```text
GET https://agentrouter.org/v1/models
{ "error": { "message": "unauthorized client detected, contact support ..." },
  "type": "unauthorized_client_error" }
```

实测结论（同一地址、同一台机器，仅换 UA）：

| 客户端 UA | `/v1/models` 结果 |
| --- | --- |
| `curl/8.9.1` / `CherryStudio/1.4.6` / `Chrome/131` | 401 `unauthorized client detected` |
| `claude-cli/1.0.60 (external, cli)` | 401 `未提供令牌` → 已进入正常鉴权层 |

说明：**拦截发生在鉴权之前，与 API key 无关**。DSH 自身的归属 UA 不在放行名单内，所以 key 和地址都填对也永远 401；而 DSH 对 401 统一追加 `; check the API key`，提示具有误导性。

### 1.1 为什么不能在配置层解决

DSH 的模型发现函数（`dsh-llm-pi-ai` 的 `discoverModels`）构造请求头的顺序是：

```js
const headers = new Headers(stored?.headers);           // ① provider profile 的 headers
headers.set("accept", "application/json");
headers.set("authorization", `Bearer ${apiKey}`);
for (const [name, value] of Object.entries(attributionHeaders()))
  headers.set(name, value);                             // ② 宿主归属 UA，最后写入 → 覆盖 ①
response = await fetch(url, { method: "GET", headers });
```

`attributionHeaders()` 的实现是 `return { "user-agent": userAgent(identity) }`。

**结论：任何在 header 合并层工作的方案（provider profile `headers`、按模型附加 header 的插件）都改不掉 `User-Agent`。** 只有拦截最终的 `fetch` 调用才有效。

### 1.2 现有替代方案的问题

| 方案 | 问题 |
| --- | --- |
| 本地反代进程（已有 `agentrouter-proxy.js`） | 需要常驻一个进程，与 DSH 生命周期不一致 |
| `dsh-provider-rate-limit` | 机制正确（包装 `globalThis.fetch`），但**默认开启 10 req/min 限流**，会误伤正常对话；且配置卡片挂在被禁用的插件页，用户无法调参 |
| `dsh-custom-headers` / `dsh-model-think-level` | 仅在 header 层注入，`User-Agent` 被宿主覆盖，对本站无效 |

**本需求的定位：只做“请求身份改写”这一件事，不夹带限流、重试等副作用。**

---

## 2. 目标与非目标

### 目标

1. 按**请求 URL 匹配规则**，在请求离开进程前改写 `User-Agent`，并可附加静态请求头。
2. 同时覆盖**模型发现请求**（`{baseURL}/models`）与**对话请求**（`{baseURL}/chat/completions` 等）。
3. 未命中的请求**零行为变化**，不引入任何限流、延迟、重试。
4. 配置可在设置页可视化编辑、持久化、热生效。
5. 卸载/关闭后立即恢复原状，不残留包装。

### 非目标

- 不做限流、令牌桶、并发控制、重试、退避。
- 不修改 `Authorization` / `x-api-key` 等凭据头。
- 不改 `app.asar`、不改 provider profile 的 `headers`。
- 不实现网络层代理（CONNECT/系统代理），沿用宿主既有的出网方式。
- 不处理 `localhost` / 内网地址（未命中即放行）。

---

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| 身份规则（identity rule） | 一条「URL 匹配 + UA 覆盖 + 静态头」的配置项 |
| 归属头（attribution headers） | DSH 主动写入的客户端标识，目前只有 `user-agent` |
| 加载器 id（loader id） | 插件在 `cordis.patch.yml` 里 `insert` 的 `id`，用于 patch 层定位，**不等于 npm 包名** |

---

## 4. 用户故事与验收场景

**US-1** 作为用户，我想让 AgentRouter 这个 provider 正常工作，而不必额外跑一个反代进程。

- 给定：provider `agentrouter`，`baseURL = https://agentrouter.org/v1`，已保存 key
- 当：配置身份规则 `{ urlPattern: "agentrouter.org", userAgent: "claude-cli/1.0.60 (external, cli)" }`
- 则：点「获取可用模型」返回模型列表，不再出现 `unauthorized client detected`

**US-2** 对话路径同样生效：选中该 provider 的模型发一句话能正常返回。

**US-3** 未配置规则时，其它 provider（`deepseek-account`、`stepfun`、`intern`、`w`）的行为与未安装插件时完全一致。

**US-4** 关闭总开关或删除规则后，下一次请求即恢复宿主 UA，无需重启。

**US-5** 我能在设置页里看到每条规则命中了哪些 URL，并一键验证。

---

## 5. 功能需求

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-1 | 规则包含 `id`、`urlPattern`（必填）、`userAgent`（可选）、`headers`（可选 kv 列表）、`enabled`（默认 true） | P0 |
| FR-2 | URL 匹配使用**大小写不敏感的子串匹配**；多条命中时取 `urlPattern` 最长者（最具体优先） | P0 |
| FR-3 | 注入点为包装 `globalThis.fetch`；改写后的请求必须保留原 `method`、`body`、`signal`、`redirect`、`duplex` | P0 |
| FR-4 | 关闭开关 / 删除规则 / 卸载插件后，下一次请求立即恢复原 UA | P0 |
| FR-5 | 安装具备幂等性：重复加载不叠加包装（`Symbol.for` 标记 + 校验 `globalThis.fetch === 自己的 wrap`） | P0 |
| FR-6 | 规则**每次请求实时读取**，改配置无需重启 | P0 |
| FR-7 | 设置页提供规则的增删改、启用开关、上下排序 | P1 |
| FR-8 | 设置页可从 provider 列表一键生成规则：选 provider → 从它的 `baseURL` 取 host 作为 `urlPattern` | P1 |
| FR-9 | 提供「测试」按钮：用当前规则对目标 `{baseURL}/models` 发一次真实请求，显示状态码与响应体前 200 字符 | P1 |
| FR-10 | 诊断日志（默认关闭）：记录命中的 host、改写前后的 UA；**不得记录 header 值中含 `authorization`/`key` 的内容** | P2 |
| FR-11 | 禁止覆盖 `authorization`、`x-api-key`、`content-length`、`host`；命中这些名字时丢弃该条自定义头并在 UI 上提示 | P0 |
| FR-12 | 所有被改写的请求默认只允许 `http:` / `https:`；其它协议直接放行 | P1 |

---

## 6. 数据模型

使用 Schemastery（与宿主一致），配置命名空间建议 `dsh-toolbox:identity:v1`。

```js
import Schema from '@deepseek-ai/schemastery';

const IdentityHeader = Schema.object({
  name: Schema.string().required(),   // 请求头名，保存时归一化为小写
  value: Schema.string().required(),
});

const IdentityRule = Schema.object({
  id: Schema.string().required(),     // UI 内唯一，大小写不敏感
  enabled: Schema.boolean().default(true),
  urlPattern: Schema.string().required(), // 子串匹配，例如 "agentrouter.org"
  userAgent: Schema.string().default(''),
  headers: Schema.array(IdentityHeader).default([]),
  note: Schema.string().default(''),  // 可选备注，例如 "AgentRouter 指纹放行"
});

export const IdentityConfig = Schema.object({
  enabled: Schema.boolean().default(true), // 总开关，false 时完全不包装 fetch
  rules: Schema.array(IdentityRule).default([]),
});
```

示例持久化配置：

```yaml
dsh-toolbox:identity:v1:
  enabled: true
  rules:
    - id: agentrouter
      enabled: true
      urlPattern: agentrouter.org
      userAgent: claude-cli/1.0.60 (external, cli)
      headers: []
      note: AgentRouter 只放行官方 CLI 指纹
```

---

## 7. 技术方案

### 7.1 注入点

包装宿主进程内的 `globalThis.fetch`。理由：

- DSH 的模型发现直接调用全局 `fetch`（见 §1.1 引用的 `discoverModels`），对话请求在同一进程内同样经过它；
- 包装发生在**所有 header 合并之后**，因此能覆盖 `attributionHeaders()` 写入的 UA；
- 不需要改动任何 provider 配置，天然对「手写 provider」「自定义 baseURL」都生效。

### 7.2 匹配

```js
const RESERVED = new Set(['authorization', 'x-api-key', 'content-length', 'host', 'connection']);

function matchRule(url, rules) {
  const lower = url.toLowerCase();
  let best;
  for (const rule of rules) {
    if (!rule.enabled || !rule.urlPattern) continue;
    if (!lower.includes(rule.urlPattern.toLowerCase())) continue;
    if (!best || rule.urlPattern.length > best.urlPattern.length) best = rule;
  }
  return best;
}
```

### 7.3 包装与清理

```js
const MARK = Symbol.for('dsh-toolbox.identity-fetch');
const store = (globalThis[MARK] ??= { wrap: null, native: null });

export function installIdentityPatch(readConfig) {
  // 幂等：已经是我们自己的包装，只更新读取器
  if (store.wrap && globalThis.fetch === store.wrap) return () => {};

  const native = globalThis.fetch;
  const wrap = async function identityFetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const config = readConfig();
    const rule = config?.enabled === false ? undefined : matchRule(request.url, config?.rules ?? []);
    if (!rule) return native(input, init);          // 未命中：完全不碰，原样转发

    let url;
    try { url = new URL(request.url); } catch { return native(input, init); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return native(input, init);

    const headers = new Headers(request.headers);
    if (rule.userAgent) headers.set('user-agent', rule.userAgent);
    for (const h of rule.headers ?? []) {
      const name = h.name.toLowerCase();
      if (RESERVED.has(name)) continue;             // 凭据/分帧头一律不碰
      headers.set(name, h.value);
    }

    // 带 body 的 Request 在 Node 中重建时必须声明 duplex
    const next = new Request(request, {
      headers,
      ...(request.body === null ? {} : { duplex: 'half' }),
    });
    return native(next);
  };

  store.native = native;
  store.wrap = wrap;
  globalThis.fetch = wrap;

  return () => {
    if (globalThis.fetch === wrap) globalThis.fetch = native;
    if (store.wrap === wrap) { store.wrap = null; store.native = null; }
  };
}
```

要点：

- `input` 可能是 `Request` 也可能是 `(url, init)`，统一成 `Request` 再判断；
- **未命中的分支必须走 `native(input, init)` 原样调用**，不要先 `new Request` 再转发——那会改变流式语义；
- 不改 `authorization`，模型发现仍然走宿主写入的 `Bearer <key>`；
- 不要缓存 `Response` / 读取 body，直接返回 `native(...)` 的 Promise，保证 SSE 流式不被打断。

### 7.4 多插件共存

若另一个插件（如限流插件）也包装了 `fetch`：

- 各自用不同 `Symbol.for` 键记录自己的 wrap；
- 卸载时**只在 `globalThis.fetch === 自己的 wrap` 时才恢复**，否则说明外层还有别人的包装，只清空自身状态，不强行还原。

---

## 8. 必须遵守的约束（踩坑清单）

| # | 约束 | 依据 |
| --- | --- | --- |
| C-1 | 不要在 provider profile 的 `headers` 里设 `user-agent`，也不要指望模型级 header 插件 | `discoverModels` 最后才 `set` 归属头，会覆盖 |
| C-2 | UA 必须逐字像官方 CLI，包含版本号与括号部分 | 实测 `claude-cli/1.0.60 (external, cli)` 通过；仅写 `claude-cli` 未验证 |
| C-3 | 不要用 `fetch` 的 `options.headers` 传 UA 到适配器层 | 适配器与宿主各有一层 header 合并，位置不同、行为不同 |
| C-4 | 不要在包装内 `await native(...)` 后再 `res.clone()` | 破坏流式；直接返回原生 Promise |
| C-5 | 重建 `Request` 时必须补 `duplex: 'half'`（body 非空时） | Node 18+ 的 `Request` 约束 |
| C-6 | 宿主通过系统代理出网（本机 `http_proxy=127.0.0.1:7890`）；插件**不需要**处理网络层 | 实测 curl 经代理可达，Node 直连会 ETIMEDOUT |
| C-7 | 配置读取必须实时（每次请求调用 `readConfig()`），不要在安装时快照 | 用户改配置后要求“下一次请求生效” |
| C-8 | 默认不启用任何规则 | 装插件即改变请求行为是上次事故的根因 |

---

## 9. UI 需求

### 9.1 位置

注册在 **`settings.plugins.tab`**（与 `dsh-toolbox` 现有模块相同）。

> 实现说明（2026-10-22 追加）：插件设置页内部再分为两个子页签 **模型分组** / **请求身份改写**，切换状态记录在 `localStorage` 的 `dsh-toolbox:settings-tab:v1`；两个页面始终挂载，非活动页由 CSS 隐藏，避免切换时丢失草稿或分组选择。

> **不要**依赖插件详情页的 `plugins.bundle.config` 槽位：该槽位属于插件管理页，本机 profile 已把 `web-ui-plugin-manager`、`web-ui-community-plugins` 设为 `disabled: true`，卡片没有宿主页面，用户会出现“装了但找不到配置”。

### 9.2 卡片结构

1. 总开关：`请求身份改写`（默认关）。
2. 规则列表：每行显示 `urlPattern` + UA 摘要 + 命中状态，支持 ↑↓ 排序、启用、删除。
3. 编辑区：`urlPattern`、`userAgent`、自定义头（name/value 行）、备注。
4. 从 provider 生成：下拉选 provider（数据来自 `llm-pi-ai` 的 providers），自动填 host。
5. 「测试」按钮：显示 `状态码 + 响应摘要`，并把原始 UA 与改写后 UA 一并列出，便于自证。
6. 校验：`urlPattern` 为空、`id` 重复（大小写不敏感）、头名非法（含空格/非 ASCII/保留名）时禁止保存并就地提示。

### 9.3 文案要求

- 明示风险：「此类改写用于绕过站方的客户端校验，仅对你有权使用的服务使用」。
- 明示作用域：「只影响本进程内发出的 HTTP 请求，不改宿主配置」。

---

## 10. 测试计划

| 类型 | 用例 |
| --- | --- |
| 单元 | `matchRule`：大小写、子串、最长优先、禁用规则跳过、空配置返回 `undefined` |
| 单元 | 保留头过滤：`authorization` 不被覆盖 |
| 单元 | 幂等安装：连续 `install` 两次只有一个包装；`dispose` 后 `globalThis.fetch` 严格等于原函数 |
| 集成 | 用假的 `globalThis.fetch` 断言：命中规则时 UA 被替换、未命中时**参数对象引用相同**（证明零副作用） |
| 集成 | 带 body 的 `Request` 经包装后仍可读取，且带 `duplex` |
| 集成 | 关闭总开关后 UA 恢复原值 |
| 手工 | 真实环境：`agentrouter` provider 点「获取可用模型」返回列表；对话一次成功 |

---

## 11. 验收清单

- [ ] 规则命中时，`/v1/models` 的 UA 变为配置值，返回不再是 `unauthorized client detected`
- [ ] 对话请求同样生效，流式输出不卡顿、不缓冲
- [ ] 未配置规则 / 总开关关闭时，其它 provider 行为与安装前完全一致
- [ ] 关闭开关后下一次请求即恢复，无需重启
- [ ] 卸载插件后 `globalThis.fetch === 原始 fetch`
- [ ] 设置页能完成「新建 → 排序 → 删除」全流程，且有测试按钮
- [ ] 日志中不出现任何密钥片段

---

## 12. 风险与开放问题

**风险**

- 站方随时可能升级判定（TLS 指纹、HTTP/2 指纹、追加头校验），UA 改写会失效；方案需保留「规则可删」的低耦合形态。
- 包装全局 `fetch` 影响进程内所有 HTTP 调用，必须靠 `urlPattern` 收窄；默认空规则。
- 若宿主某处在模块初始化时缓存了 `const f = fetch`，该路径不会被包装（当前代码未见此写法）。
- **pi-ai 的请求函数支持调用方注入 `options.fetch`（`const requestFetch = options.fetch ?? globalThis.fetch`）**。若 DSH 某条链路自己传了 `fetch`，该链路会绕过全局包装。实现前先在 `stream` 调用点确认 `options.fetch` 为 `undefined`；若不为空，方案需改为注入到适配器层而不是 `globalThis`。

**开放问题**

- 是否需要「按 provider id 而非 URL」配置？当前 fetch 层拿不到 provider 标识，只能靠 URL 反推，UI 侧用 provider→host 派生即可。
- 是否要支持 `user-agent` 之外的身份头（如 `x-app`、`originator`）？建议在 `headers` 里通用支持，不做特例。
- 与限流类插件同时启用时的顺序语义：外层先生效，两者互不感知；文档中说明即可。

---

## 13. 实现记录（2026-10-22）

### 13.1 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主入口：导出 `Config`（`identity` volatile 段）、安装 fetch 包装、注册两个路由 |
| `src/identity-core.js` | 纯逻辑：匹配、校验/规范化、保留头、规则 id、命中统计（宿主、客户端、测试共用） |
| `src/identity-patch.js` | fetch 包装的安装/复用/卸载；`Symbol.for('dsh-toolbox.identity-fetch')` 幂等标记 |
| `src/identity-host.js` | 设置读写路由、真实探测路由、provider 目录、loopback/Origin 防护 |
| `src/identity-client.js` | 设置页「请求身份改写」卡片与 HTTP 客户端 |
| `test/identity-*.test.js` | 43 个用例，覆盖匹配、校验、幂等、零副作用、流式 body、路由与 UI 流程 |

### 13.2 与本文的差异

1. **配置命名空间**：DSH 0.2.x 的设置命名空间等于插件条目 id，没有独立注册接口（`dsh-settings` 的 `describe()/replace()` 都以 `entry.options.id` 为键，`write()` 还要求存在 volatile 字段）。因此配置落在 `dsh-toolbox → identity`，而不是 §6 建议的独立 `dsh-toolbox:identity:v1`。字段结构（`enabled` / `rules[]` / `id` / `urlPattern` / `userAgent` / `headers` / `note`）与 §6 一致，并新增 `diagnostics` 布尔字段实现 FR-10。
2. **总开关默认值**：§6 写 `enabled` 默认 `true`，§9.2 写「默认关」，两处冲突。实现取 §6：`enabled=true` + `rules=[]`，因此安装后**零请求被改写**，同时满足 C-8；用户新建规则即生效，不需要再手动打开总开关。
3. **保留头集合**：在 FR-11 的四个之外补入 `proxy-authorization`、`api-key`、`cookie`、`set-cookie`、`transfer-encoding`，理由与 FR-11 相同（凭据/分帧/会话头一律不碰）。
4. **写接口**：客户端是静态插件、没有 `host.call`，所以与 `dsh-provider-rate-limit` 同样采用同源 HTTP 路由（`/api/dsh-toolbox.identity` 与 `/api/dsh-toolbox.identity-test`），并复用其 loopback Host + Origin 校验。

### 13.3 §12 风险确认（已排除）

`dsh-llm-pi-ai` 的对话链路：

```js
snapshot.models.streamSimple(model, context, {
  ...profileOptions(profile, reasoning, apiKey),
  ...options.temperature === void 0 ? {} : { temperature: options.temperature },
  ...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
  ...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
  signal: watchdog.signal,
  headers: requestHeaders(profile.headers),
})
```

**没有传 `options.fetch`**，pi-ai 内部因此回落到 `globalThis.fetch`；模型发现同样直接使用全局 `fetch`。所以全局包装能覆盖两条链路，无需改注入层。

同时确认 §1.1 的覆盖顺序：`discoverModels` 先 `new Headers(stored?.headers)`、再写 `authorization`、最后 `for (const [name, value] of Object.entries(attributionHeaders())) headers.set(...)`，所以 header 层确实无法改写 UA。

### 13.4 实现细节

- **`Request` 重建**：命中且 `request.body !== null` 时补 `duplex: 'half'`；`method` / `body` / `signal` / `redirect` 由 `new Request(request, { headers })` 继承，测试用例验证了 POST body 仍可读。
- **未命中路径**：`native.call(this, input, init)` 原样转发，测试用引用相等断言（`calls[0].init === init`）。
- **卸载语义**：仅在 `globalThis.fetch === 自己的 wrap` 时还原；若外层还有别的包装，只把自己的 `active` 置 false 变为透明，不覆盖外层。测试覆盖了该场景。
- **命中统计**：只保留规则 id、请求 URL、`user-agent` 前后值（FR-10 不落任何其它头），设置页显示命中次数与 host。
- **测试按钮**：`GET {url}`、不带凭据、8 KiB 截断预览；UA 前后值由包装在改写前就地记录，按 URL 精确匹配取回，避免被并发请求污染。

### 13.5 验证

- `pnpm run check` 通过（`client.js` 与 `src/` 同步）。
- `pnpm test` 102/102 通过，其中新增 43 个身份改写用例。
- `node -e "import('./index.js')"` 通过：`Config` / `apply` / `name` 三个导出就绪，`Config({})` 解析出 `{enabled:true, diagnostics:false, rules:[]}`。
- 尚未执行：真实 GUI 内的「获取可用模型」与对话验收（需要重启 DSH 让宿主半侧加载新 `index.js`）。
