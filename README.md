# dsh-prompt-enhance

输入框草稿一键扩写为结构化长提示词，可一键还原原文。

## 交互（三态，源自用户 m00498 截图确认）

| 态 | 按钮 | 行为 |
|---|---|---|
| 原始态 | ✨ 星光 | 点击 → 读当前草稿 → 请求增强 → 整段替换草稿（记住原文） |
| 增强后 | ↩ undo | 同位置变为 undo 箭头，tooltip「恢复原文」→ 草稿换回原文 |
| 请求在途 | ⋯ | 禁用，防重复点击 |

按钮挂在 `conversation.input.right`（输入框右下、模型选择器旁）。

## 架构（B + A 兜底）

- **B 模型语义增强**：宿主半边调 Harness 自己的 `llm` 服务，
  `provider: 'our-free-model'`、`model: 'mimo-v2.6-flash-free'`
  （OFM 已注册 adapter，插件直接复用免密通道，不碰它的 HTTP 转发端口）。
- **A 规则模板兜底**：模型不可达 / 返回空 / 报 error kind → 套一份带
  `# 任务 / ## 角色 / ## 背景 / ## 要求 / ## 输出格式` 的骨架模板，
  占位处提示用户自己补，并 `source: 'fallback'` 告知降级来源。
  用户点了增强，最坏也该拿到可用模板，而不是一条报错。

## 两个半边

**宿主（`index.js`）**

- 注册 exact 路由 `POST /prompt-enhance/enhance`。
- exact 路由绕过了 DSH 的 `/api` 信任围栏 → 自带 `isLoopbackAuthority` 回环守卫
  （IPv6 `[::1]` 冒号不被误当端口；`127.0.0.1.evil.com` 这类必须拒）。
- `readJson` 带 64KB 上限；客户端断开时 abort 模型流且不再回写 res。
- `handleEnhance` 抽成顶层导出，可以在 Node 里用假 req/res/llm 单测全部分支。

**客户端（`client.js`）**

- 三态按钮，`window.__ModuleLoader__.load({id, factory})` 范式。
- 按钮态判定不靠组件 state，靠**插件级 ledger Map**（sessionId → {original, enhanced}）
  与 `shell.snapshot.draft` 的比对。理由：切会话 / InputBar 重挂载会重建组件，
  内存 state 一丢用户就再也点不到「恢复原文」，原文永久丢失。
- 用户又手改草稿 → enhanced 比对不上 → 增强态自动失效，不提供还原
  （否则会把用户的编辑冲掉）。

## 踩过的坑（都在 asar 考古里，记录省得再爬）

1. **`conversation.input.right` 拿不到 keyboard**。它是 `conversation.composer.bar`
   的子插槽，`conv-client.js:17533` 的 `renderSlot("conversation.input.right", {})`
   第二参是空对象，spec 也没 inject。组件 props = `{...kit, ...injected, ...slotInjected.props, ...ownerProps}`，
   四层里没有 keyboard。
2. **keyboard（SessionInputShell）是 composer.bar inject 的私有 prop**，
   `conv-client.js:14290-14299` 注释明说 "package-internal — handed through the
   composer-bar entry's inject, never across a plugin boundary"。
3. **插件侧唯一正路**：`ctx.inject(['conversation'], ...)` 拿 ConversationController，
   `conversation.input.shell(sessionId)` 拿 shell。范式抄 `queueDockEntry`
   （`conv-client.js:15668-15697`）。shell 上的 API：`snapshot`（getter，读
   `{draft, attachmentIds, phase, draftRev}`）、`setDraft(text)`、`notify(level, text)`、
   `state`（createSnapshotStore，subscribe/getSnapshot）。
4. **shell 上没有 `sessionId` 成员**。deps 里没传，sessionId 只在
   `session.getSnapshot().sessionId`。插件要用就从 register 的 `inject:(sessionId)`
   参数闭包捕获，别去 shell 上找。
5. OFM 的 HTTP 转发端口（18899）与 DSH 主端口 `/api/*` 都不可借道
   （前者 `forward.enabled:false`，后者要浏览器会话鉴权）→ 必须走内核 `llm` 服务。

## 已知取舍

- ledger 是内存 Map，页面刷新即失。可接受：刷新后草稿已随会话持久化，
  只是不能再一键还原。
- 按钮是纯文本字符（✨ / ↩ / ⋯）而非图标组件，避免引入图标依赖；
  后续要美化可换 primitives 里的 Icon。

## 实测踩坑（2026-10-16）

**`ctx.llm` 在插件外层 fiber 上不可读，cordis 会抛异常而不是返回 undefined。**

第一版 handler 写的是 `llm: ctx.llm`，其中 `ctx` 是 `apply(ctx)` 收到的插件自身
fiber 上下文，而 `llm` 只声明在 `ctx.inject(['llm','webServer'], scoped => ...)`
的回调参数 `scoped` 上。cordis 的代理 get trap 对未声明 inject 的服务是
**throw**：`cannot get property "llm" without inject`。后果是每个请求都在
`webserver` 的 `handle(req,res).catch(...)` 里变成**裸 400**——空 body、
无 content-type，GET 也返 400。按钮点了没有任何反馈，极难从现象反推根因。

验证与修复：

- cordis 语义实查（`Context` 直连 + `ctx.plugin({inject:[]})` 嵌套）：未声明
  inject 时，**同步期读、启动后延迟读都是 THROW**；自己声明 inject 后从
  `scoped` 读则正常返回服务值。
- 修复：`llm` 改在 inject 回调内捕获为 `llmSnapshot`，handler 通过
  `readLlm()` 惰性读取（`ctx.reflect?.get('llm', false)` 兜底）。回归测试见
  `test/apply-wiring.test.js` 最后一项——用会抛的 getter 模拟 cordis 代理语义。

> 教训：**任何跨 fiber 的服务都要从 `ctx.inject` 的 scoped 参数取**，不要图省事
> 在外层 `ctx` 上直接点。cordis 的 `disabled`/`inject` 都是"跳过 apply"级别，
> 但属性读取这一层是硬抛。

## 测试

```
pnpm test     # node --test test/*.test.js，22 项
```

覆盖：回环守卫（含 IPv6 与域名混淆）、模板兜底骨架、路由 405/403/400/降级全分支、
provider 与 model 钉死、apply 接线（含 cordis 服务访问回归）。
