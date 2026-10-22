# DSH Toolbox

DeepSeek Harness Web GUI 的可选工具箱。两个模块：模型选择器增强（搜索 + 可持久化、可折叠的自定义分组），以及按 URL 匹配改写本进程出站请求身份的「请求身份改写」。

这个包刻意保持通用：客户端功能注册表已为后续模块（例如消息编辑/回滚）预留位置。

## 新增能力

- **按提供方、模型名称或模型 ID 搜索。** 多个空格分隔的词按“与”关系组合；`@provider` 把某个词限定在提供方字段。
- **持久化自定义分组。** 一个模型可以属于多个组；分组顺序和折叠状态保存在本机。
- **虚拟“未分组”视图**，用于收纳未被任何自定义分组引用的模型。
- **不可删除的“全部”视图**，以及宿主原有的提供方视图。
- **提供方标题显示数量并支持折叠**；排列为“折叠图标 → 名称 → 数量”，点击整行（名称、图标或数量）即可折叠。打开菜单时默认只展开当前选中模型所在的提供方，其余提供方折叠。
- **自定义分组折叠控件位于标签栏**，不再在列表上方重复显示分组名称和数量。
- **设置标签页**，用于创建、重命名、删除、排序、折叠和填充分组，批量加入/移出，导入/导出 JSON，以及恢复默认。
- **请求身份改写**：按 URL 子串匹配改写 `User-Agent`（可附加静态请求头），同时覆盖模型发现与对话请求；默认零规则、零副作用，可在设置页增删改、排序并一键验证。
- **兼容 `dsh-model-search`**：如果该插件已经提供搜索框，DSH Toolbox 会复用它，而不是再注入一个重复的搜索框。

## 刻意不做的事

- 不修改、添加、删除或重排宿主模型记录。
- 不修改 `app.asar`，也不修改已安装的 profile。
- 不把模型配置上传到任何地方。
- 不替换 React 渲染的模型行。原生行保留自己的点击处理器，因此选择模型仍会执行 DSH 自己的切换逻辑。
- 不会把一个模型物理复制到多个 DOM 分区。一个模型可以在配置中属于多个组，但当前视图只显示它一次；在 React 持有列表的前提下，这是唯一安全的做法。

## 环境要求

- 带 Web GUI 和 `0.2.1-rc.2` 所用客户端 slot API 的 DeepSeek Harness Desktop Next。
- 开发和测试需要 Node.js 20.11+（本机使用 Node 24）。

运行时依赖只有 `@deepseek-ai/schemastery`（宿主同款配置 schema，版本 3.18.5）；`jsdom`、`react`、`react-dom` 只是用于 DOM 级测试的开发依赖。客户端 bundle 不引入任何宿主模块。

## 开发

```powershell
cd packages/dsh-toolbox
pnpm install
pnpm run check
pnpm test
```

`client.js` 由 `src/` 中可读的 ES 模块生成，因为 DSH Web 加载器为每个插件提供一个经典脚本入口。修改 `src/` 后：

```powershell
pnpm run build
pnpm run check
```

这个构建只是有意保持很小的本地转换，不是通用打包器：它会重写相对导入/导出，包装每个源模块，并生成 `window.__ModuleLoader__.load` 工厂。`client.js` 过期时，`pnpm run check` 会失败。

## 安装到 profile

当前工作区的 `desktop` profile 已通过 `plugin_manager` 以 `link:` 方式安装本包；安装结果 `application=applied`、`warnings=[]`。修改 `src/` 并重新构建后，需要重新加载客户端 bundle（禁用/启用 bundle，或重启 DSH）才能看到最新界面。

在其他 profile 中，使用与其他本地插件相同的 Loader 路径把它作为本地 bundle 安装。bundle patch 为：

```yaml
- insert:
    - id: dsh-toolbox
      name: dsh-toolbox
```

客户端声明为：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-settings-plugins",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

manifest 同时把 slots、插件设置页和 locale 客户端包列为 inject，确保本模块应用前这些服务和界面已经存在。

## 使用

1. 打开输入区的模型下拉菜单。
2. 在工具箱搜索框中输入。搜索覆盖提供方名称、提供方 ID、显示名和模型 ID。存在查询词时搜索整个目录，而不只是当前分组；清空后回到当前分组。
3. 使用标签页：
   - **全部**：所有模型；默认只展开当前选中模型所在的提供方。
   - **自定义分组**：仅显示该组的模型。
   - **未分组**：未分配给任何自定义分组的模型（启用时显示）。
   - **提供方**：宿主原有的提供方分区。
4. 提供方标题的排列为“折叠图标 → 名称 → 数量”。点击名称、图标或数量任一位置都能展开/折叠该提供方；数量表示该提供方中有多少模型匹配。
5. 自定义分组的折叠按钮位于标签栏右侧（齿轮左边），不再在列表上方显示重复的“分组名 + 数量”行。
6. 点击齿轮按钮打开 **设置 → 插件 → DSH Toolbox**（尽力而为；也可以正常打开设置后手动选择该标签页）。
7. 该标签页顶部有两个子页签：**模型分组** / **请求身份改写**，默认打开上次停留的子页签。
8. 在「模型分组」子页签中：
   - 创建、重命名、删除、拖拽或用箭头排序分组。
   - 选择一个分组，然后搜索并勾选模型来分配成员。
   - 使用“加入全部结果”/“移出全部结果”进行批量修改。
   - 设置默认打开视图，以及是否显示虚拟“未分组”分组。
   - 导出/导入 JSON，或恢复默认。
   - 清理已经无法解析的模型 key。

删除分组只删除分组成员关系，绝不会删除模型，也不会修改宿主的模型目录。

## 请求身份改写（User-Agent）

部分第三方中转站按**客户端指纹**放行，只接受官方 CLI 的 `User-Agent`，其余客户端一律 401。宿主在 `dsh-llm-pi-ai` 的模型发现与对话请求里先合并 provider `headers`、最后才写入自己的归属 UA，所以**任何 header 层插件都改不掉 UA**。本模块包装 `globalThis.fetch`，位于所有 header 合并之后，因此能同时覆盖模型发现（`{baseURL}/models`）与对话请求。

要点：

- **默认没有任何规则**：新装或未配置时不改写任何请求。`identity.enabled` 默认为 `true`，但 `rules` 为空，等价于零副作用。
- **匹配**：`urlPattern` 是大小写不敏感的子串；多条命中时取最长的 pattern（最具体优先）。只改写 `http:` / `https:`。
- **保留头**：`authorization`、`proxy-authorization`、`x-api-key`、`api-key`、`cookie`、`set-cookie`、`host`、`content-length`、`connection`、`transfer-encoding` 永远不被覆盖；保存时丢弃并在界面提示。
- **未命中零副作用**：包装把原始参数直接转交原生 fetch（引用相同），不重建 `Request`、不复制 body、不缓存 `Response`，SSE 流式行为不变。命中且带 body 时按 Node 约束补 `duplex: 'half'`。
- **热生效**：每次请求都重新读取配置引用，改规则不需要重启。
- **可还原**：停用或卸载后下一次请求即恢复宿主 UA；若另一个插件在本插件之上又包了一层 fetch，卸载只把本插件变为透明，不强行覆盖外层。

### 配置位置

DSH 0.2.x 的设置命名空间由**插件条目 id**决定，没有独立注册命名空间的接口，因此配置落在本插件条目 `dsh-toolbox` 的 `identity` 段（volatile settings），而不是 `docs/request-identity.md` 最初建议的独立 `dsh-toolbox:identity:v1`。它保存在 profile patch 的用户层，与浏览器 `localStorage` 里的分组配置互不影响。

```yaml
dsh-toolbox:
  identity:
    enabled: true
    diagnostics: false
    rules:
      - id: agentrouter
        enabled: true
        urlPattern: agentrouter.org
        userAgent: claude-cli/1.0.60 (external, cli)
        headers: []
        note: AgentRouter 只放行官方 CLI 指纹
```

### 设置页

`设置 → 插件 → DSH Toolbox` 的「请求身份改写」卡片支持：总开关、规则增删改与上下排序、单条启用/停用、保留头提示、从 provider 一键生成规则（取 `baseURL` 的 host）、诊断日志开关，以及「测试」按钮。测试会真实发一次**不带凭据**的 `GET`，显示状态码、响应前 200 字符，以及宿主原始 UA 与改写后 UA——这两者在包装内就地抓取，因此能自证。

判定方式：直连仍返回 `unauthorized client detected` 表示仍被指纹拦截；返回 `未提供令牌` / `无效的令牌` 说明已进入上游鉴权层，UA 改写已生效。

### 宿主接口

静态客户端没有 `host.call` 通道，因此通过两个同源 HTTP 路由读写：

- `GET|POST /api/dsh-toolbox.identity`：读取/写入身份配置；响应包含 `revision`、`providers` 与命中统计。
- `POST /api/dsh-toolbox.identity-test`：执行一次真实探测。

两个路由只接受 **loopback Host**，且带 `Origin` 时必须与 Host 相同（防 DNS rebinding 与跨站写入）。

### 生效时机

宿主半侧在 DSH 启动时加载，修改插件宿主代码后需重启 DSH；客户端 bundle 需重新加载（禁用/启用 bundle 或刷新页面）。设置页在宿主半侧未就绪时会明确提示，而不是静默失败。

## 分组语义

- **全部**视图是虚拟的，不能删除。
- 自定义分组按 `order` 排序；拖拽和箭头按钮会重新编号。
- 一个模型可以被多个自定义分组引用。
- “未分组”是虚拟的，只包含未被任何自定义分组引用的模型。
- 打开菜单时只展开当前选中模型所在的提供方；没有选中模型或选中模型不在当前视图时，展开第一个有匹配的提供方。
- 搜索时忽略提供方折叠以展示全部匹配结果；清空搜索后恢复之前的折叠状态。
- 当提供方标题被设置隐藏时（自定义分组且 `preserveProviderGroups=false`），提供方折叠会被禁用，避免出现没有标题可点开、模型却被隐藏的情况。
- 失效的模型 key 会保留并标记为“模型已不存在”，直到你明确清理。这样即使提供方修改了 ID，也不会静默丢失配置。
- 折叠自定义分组会持久化其 `collapsed` 标志；折叠按钮在标签栏。提供方折叠只在当前会话内有效。

## 数据与限制

配置和最近一次观察到的模型目录保存在带命名空间的 `localStorage` key 中：

- `dsh-toolbox:v1`：分组配置，JSON 版本 1。
- `dsh-toolbox:catalog:v1`：最近一次观察到的模型目录，供模型菜单关闭时的设置页使用。

导入校验严格，且在任何写入之前执行：

- 最大 256 KiB。
- 最多 64 个分组。
- 每组最多 5,000 个模型 key。
- 分组名称最多 80 个字符。
- 未知字段、重复分组 ID、保留 ID、错误类型和更高版本的配置都会被拒绝。
- 模型 key 会被规范化、去重并限制长度；导入失败会保留原有配置。

目录缓存只是便利设施。插件永远不会重写宿主的模型配置或凭据。

请求身份改写的配置**不**放在 `localStorage`，而是 profile patch 的 `dsh-toolbox.identity` 段。服务端与设置页使用同一套校验：

- 最多 32 条规则，每条最多 16 个自定义头。
- `urlPattern` 200 字符、`userAgent` 300 字符、头名 64 字符、头值 1024 字符、备注 200 字符。
- 头名必须是合法 HTTP token；头值不得含控制字符；`urlPattern` / `userAgent` 不得含控制字符。
- 规则 id 不区分大小写且必须唯一；界面会从 pattern 自动生成并去重。
- 保留头在保存时被丢弃（不是拒绝），并在界面提示具体名字。

## 扩展点

`src/features.js` 中包含功能注册表：

```js
export const features = [modelGroupsFeature]
```

每个功能拥有自己的 `id`、所需 inject、设置标签页、配置 schema 元数据和 `apply(ctx, helpers)` 清理逻辑。后续模块可以直接追加，不需要修改宿主入口：

```js
export const features = [modelGroupsFeature, messageEditFeature]
```

宿主半侧（`index.js`）负责请求身份改写：导出 `Config`（`identity` 为 volatile 段），在 `apply` 中安装 fetch 包装并注册两个宿主路由。它与客户端功能注册表相互独立，新增客户端模块不需要改动宿主入口。

## 兼容性与失效模式

增强只针对原生菜单的稳定部分：

- 模型面板 `[role="menu"][id$="-models"]`；
- 提供方分区 `section[data-menu-group]`；
- 模型行 `button[role="menuitemradio"]`；
- 带 `data-provider-id` 和 `data-model-id` 的提供方/模型身份 span。

当 React 打开、刷新或过滤列表时，`MutationObserver` 会重新应用视图。如果宿主的 DOM 结构发生变化，控制器只记录一次诊断信息，并保持原生菜单不变。它从不替换菜单或 React 节点，并在菜单关闭或插件销毁时移除所有注入节点、监听器、样式和隐藏属性。

`dsh-model-search` 兼容采用检测方式（`[data-dsh-model-search]`、`[data-dsh-plugin="dsh-model-search"]`、`.dms-wrap`、`.dms-input`、`[class*="dms-"]`），不导入或调用该插件的私有 API。

## 手动验收清单

- [ ] 打开模型菜单；分别按提供方、显示名和模型 ID 搜索。
- [ ] 确认列表上方不再有“全部模型/分组名 + 数量”的重复标题行。
- [ ] 确认提供方标题顺序为“折叠图标 → 名称 → 数量”，点击名称、图标、数量都能折叠且弹窗不关闭。
- [ ] 默认只展开当前选中模型所在提供方；其余提供方显示标题和数量但折叠。
- [ ] 搜索其他提供方的模型时结果可见；清空后恢复原有折叠状态。
- [ ] 创建两个分组；把同一个模型放进两个组；切换标签页。
- [ ] 使用标签栏折叠按钮折叠自定义分组；重新打开菜单确认状态保存。
- [ ] 拖拽调整分组顺序；重新打开菜单确认顺序。
- [ ] 选择一个模型，确认宿主模型切换仍然有效。
- [ ] 删除一个分组；确认宿主模型目录中没有模型消失。
- [ ] 导出、恢复默认、导入；确认非法 JSON 会保留旧配置。
- [ ] 打开 设置 → 插件 → DSH Toolbox，重复一次分组编辑。
- [ ] 如果安装了 `dsh-model-search`，确认只出现一个搜索框。
- [ ] 禁用插件，确认原生菜单恢复原样。
- [ ] 在设置页用「从 provider 生成」创建一条 `agentrouter.org` 规则并保存。
- [ ] 点「测试」：显示状态码与改写前后的 UA；不再出现 `unauthorized client detected`。
- [ ] 在 `agentrouter` provider 上点「获取可用模型」，返回模型列表。
- [ ] 选该 provider 的模型发一句话，流式输出正常、不卡顿。
- [ ] 关闭总开关或删除规则后，下一次请求恢复宿主 UA。
- [ ] 未配置规则的其它 provider 行为与安装前完全一致。
- [ ] 停止插件（重启宿主）后 `globalThis.fetch` 恢复为原生函数。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
