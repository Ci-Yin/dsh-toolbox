# 仓库指南（Repository Guidelines）

## 项目结构与模块组织

`index.js` 是宿主入口；`src/` 存放客户端模块与共享逻辑；`scripts/` 存放构建、检查脚本；`test/` 存放测试；`locale/`、`docs/` 存放文案和说明。`client.js` 为生成文件，勿手工修改。

## 构建、测试与开发命令

```bash
pnpm install       # 安装依赖
pnpm run build     # 从 src/ 生成 client.js
pnpm test          # 运行全部测试
pnpm run check     # 检查生成文件和语法
```

使用 Node.js 20.11+；修改 `src/` 后依次运行 `pnpm run build`、`pnpm run check` 和 `pnpm test`。

## 编码风格与命名规范

使用 JavaScript ES Modules，保持两空格缩进、单引号、无分号和尾随逗号。文件名用 kebab-case，变量和函数用 camelCase，配置类型用 PascalCase。优先复用宿主 API，不修改 `app.asar`。

## 测试指南

测试使用 `node:test`，DOM 场景使用 `jsdom`；文件命名为 `test/<feature>.test.js`。项目无硬性覆盖率门槛，但新功能和修复必须补回归测试。

## 提交与合并请求

提交采用 Conventional Commits，例如 `feat(workspace): 添加单列表切换`。合并请求需说明目的、改动范围、验证命令和兼容性影响；界面改动附截图或验收结果并关联 Issue。不得提交密钥、个人配置或未经验证的生成文件。
