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

- **B 模型语义增强**：宿主半边调 Harness 自己的 `llm` 服务，**模型不写死**——
  读 `agentDefaultModel` 的 `currentSelection()` 跟随用户当前选的模型
  （profile 里配的是 `deepseek-account` / `deepseek-flash`），读不到才退
  `deepseek-account` / `deepseek-flash` 兜底。**不要写死 OFM 的免费模型**：
  `mimo-v2.6-flash-free` 属 OpenCode 免费通道，DSH 里调用必报
  `OpenCode's free tier can only be used from within OpenCode`。
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
3. ~~插件侧正路：`ctx.inject(['conversation'], ...)`~~ —— **这条是错的，别照抄**。
   `conversation` 服务由 `dsh-client-ui-conversation` 在**它自己的 fiber** 上
   `provide`，第三方插件是兄弟节点，永远拿不到；cordis 对缺失依赖只是不执行回调、
   **零报错**，症状就是按钮静默不出现。
   **真正可用的通道是插槽下发的标准 kit**：`conv-client.js:19710-19726` 的
   `ctx.uiSession.provide({ hooks:['conversation','input'], props:['inputActions'], ... })`
   让每个条目白拿到 `useInput(selector)`（源 `shell.state`）与 `inputActions`
   （= `shell.actions`，含 `setDraft`）。所以注册只要 `inject: ['slots']`。
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

## 会话上下文（2026-10-19 新增）

长对话里「接着说」「按上面的继续」这类草稿，只看自己一句是补不出来的。现在增强前会
从宿主 `sessionQuery` 读**最近 6 条** user/assistant 消息（每条 ≤600 字符、总计 ≤3000）
一起喂给模型，prompt 分两节：`## 前文对话（供理解上下文，不要复述，也不要照抄）` +
`## 当前草稿（待增强）`。

- 读取优先 `readSurface`（拿当前模型面事件本体，压缩/替换已折叠），失败退 `filterEvents`，
  再失败静默空上下文——**上下文是加分项，绝不能拖垮增强**。
- 文本抽取自己按 text block 做：宿主 `extractSessionEventText` 会把 `tool/call` 的
  `name + arguments` 也拼进去（实测 assistant 消息里混进整段 edit 的 file_path/diff）。
- **必须按 `data.source.kind` 过滤假用户消息**：`user/message` 里混着
  `agent-instructions` / `runtime-context` / `skill-catalog` / `time-context` 等系统注入
  （实测 skill catalog 单条 **35557 字符**），真人输入是 `kind === 'user'`。不过滤的话
  几万字噪声会把真正的对话挤出预算（实测同一会话：过滤前 6 条 / 2233 字符且全是噪声，
  过滤后 4 条 / 1361 字符）。`plugin:meow-memory` 这类记忆注入同样要丢。
- 响应里回传 `contextTurns`，按钮 tooltip 显示「含最近 N 条上下文」，前端 `console.info` 一行。

## 测试

```
pnpm test     # node --test test/*.test.js，51 项
```

覆盖：回环守卫（含 IPv6 与域名混淆）、模板兜底骨架、路由 405/403/400/降级全分支、
模型路由跟随 agentDefaultModel、上下文预算/截断/取最近/注入过滤/双通道降级、
客户端注册与三态交互、apply 接线（含 cordis 服务访问回归）。

> 跑测试必须 `node --test test/*.test.js`：Node 24 传目录（`node --test test/`）会
> 报 `pass 0 / fail 1`，是参数用法问题，不是用例坏了。
