/**
 * dsh-prompt-enhance 宿主半边。
 *
 * 职责：
 *  1. 注册 exact 路由 /prompt-enhance，客户端按钮 POST 草稿进来，这里调模型增强后返回。
 *  2. exact 路由绕过了 DSH 的 trust fence，必须自带回环守卫（抄 dsh-cockpit）。
 *  3. 模型走 Harness 自己的 llm 服务，provider/model 取 agentDefaultModel 的当前选择
 *     （用户换模型，增强也跟着换）。
 *  4. 模型不可达时走规则模板兜底（B+A 的 A）。
 */

/**
 * agentDefaultModel 服务缺失时的兜底路由（与本机 desktop profile 的
 * `agent-default-model` 条目一致）。正常情况下不会用到。
 */
const FALLBACK_ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash' };

/** 宿主认这四个 reasoningEffort 值，其它值会让适配器抛 UNSUPPORTED_REASONING_EFFORT。 */
const REASONING_EFFORTS = new Set(['off', 'low', 'high', 'max']);

/**
 * 上下文注入预算（用户 2026-10-19 拍板）。
 * 长对话里「接着说」「按上面说的继续」这类草稿，光看自己一句是补不出来的，
 * 必须把最近几轮对话一起给模型，否则增强结果会偏离上下文。
 */
export const CONTEXT_DEFAULTS = Object.freeze({
  maxMessages: 6,
  perMessageChars: 600,
  totalChars: 3000,
});

/** 请求来源是否为 loopback。exact 路由绕过了 DSH 的围栏，这里必须自己判。 */
export function isLoopbackAuthority(req) {
  const raw = String((req && req.headers && req.headers.host) || '');
  if (!raw) return false;

  // 端口剥离必须区分 IPv6：`::1` 里的 `:1` 不是端口。
  let name = raw;
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end > 0) name = name.slice(1, end);
  } else {
    const first = name.indexOf(':');
    if (first > 0 && name.indexOf(':', first + 1) === -1) name = name.slice(0, first);
  }

  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/** 读请求体上限（抄 OFM 的 readJson 惯例：显式 cap，防止无限缓冲）。 */
const MAX_BODY_BYTES = 65536;

/** 读并解析 JSON body；空 body 合法（返回 {}）。 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let text;
  try {
    text = Buffer.concat(chunks).toString('utf8');
    return JSON.parse(text);
  } catch (error) {
    const bad = new Error(`invalid JSON body (${(error && error.message) || error})`);
    bad.status = 400;
    throw bad;
  }
}

function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/**
 * 增强指令（系统提示词）。要求模型做「语义增强」：
 * 保留原意、不添加不存在的信息，把短句扩写为带角色/目标/约束/输出格式的结构化提示词。
 */
export const SYSTEM_PROMPT = [
  '你是提示词增强助手。用户会给你一段原始提示词草稿，你的任务是把它扩写为一份结构化、信息完整的高质量提示词。',
  '',
  '硬性要求：',
  '1. 只做增强，不要改变用户的原始意图，不要回答草稿本身的内容。',
  '2. 不要编造草稿中不存在的事实、数据或约束；信息不足时用占位提示（如「（此处补充…）」）。',
  '3. 输出为可直接使用的提示词正文，用 markdown 结构化组织，建议包含：角色定位、任务目标、背景补充、约束条件、输出格式要求。',
  '4. 保留草稿中的全部关键信息，补全其隐含的上下文与边界。',
  '5. 直接输出增强后的提示词正文，不要任何前言、解释或代码块包裹。',
].join('\n');

/**
 * 规则模板兜底（B+A 的 A）。模型不可达时，把草稿套进结构化骨架，
 * 让用户至少得到一份「带完整字段的提示词模板」，并知道哪几处需要自己补。
 */
export function templateFallback(draft) {
  const text = String(draft || '').trim();
  const gist = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ') || '（未提供）';
  return [
    '# 任务',
    gist,
    '',
    '## 角色',
    '（请指定执行者身份，例如：资深工程师 / 数据分析师）',
    '',
    '## 背景',
    '（请补充任务的背景信息、使用场景与相关约束）',
    '',
    '## 要求',
    '1. （请列出必须满足的条件与验收标准）',
    '2. 输出结构清晰、可直接使用',
    '3. 信息不足时，先列出需要确认的问题',
    '',
    '## 输出格式',
    '（请指定期望的产出形式，例如：表格 / markdown 报告 / 代码 + 注释）',
  ].join('\n');
}

/** 把一条事件文档映射成发言角色；非对话事件返回 null。 */
function contextRoleOf(doc) {
  const type = doc && doc.type;
  if (type === 'user/message') return 'user';
  if (type === 'assistant/message') return 'assistant';
  const role = doc && doc.role;
  return role === 'user' || role === 'assistant' ? role : null;
}

/**
 * 把事件文本拼成给模型看的「前文对话」块。
 *
 * 从**最后一条往前**取，保证预算紧张时保住最贴近当前草稿的那几轮；
 * 每条单独截断（避免一条长回复吃满预算），总量再卡一道。
 *
 * @param {Array<{type?:string, role?:string, text?:string}>} docs
 * @param {{maxMessages?:number, perMessageChars?:number, totalChars?:number, excludeText?:string}} [options]
 * @returns {{text:string, turns:number}}
 */
export function buildConversationContext(docs, options = {}) {
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : CONTEXT_DEFAULTS.maxMessages;
  const perMessageChars = Number.isFinite(options.perMessageChars) ? options.perMessageChars : CONTEXT_DEFAULTS.perMessageChars;
  const totalChars = Number.isFinite(options.totalChars) ? options.totalChars : CONTEXT_DEFAULTS.totalChars;
  const excludeText = typeof options.excludeText === 'string' ? options.excludeText.trim() : '';
  if (!Array.isArray(docs) || maxMessages <= 0) return { text: '', turns: 0 };

  const lines = [];
  let used = 0;
  let turns = 0;
  for (let index = docs.length - 1; index >= 0 && turns < maxMessages; index -= 1) {
    const doc = docs[index];
    const role = contextRoleOf(doc);
    if (!role) continue;
    const raw = String((doc && doc.text) || '').trim();
    if (!raw) continue;
    // 草稿本身还没发出去，但如果用户是对着已发送的同一句话再点一次，别把它重复喂一遍。
    if (excludeText && role === 'user' && raw === excludeText) continue;
    let body = raw.replace(/\n{3,}/gu, '\n\n');
    if (body.length > perMessageChars) body = `${body.slice(0, perMessageChars)}…`;
    const line = `${role === 'user' ? '用户' : '助手'}：${body}`;
    if (used + line.length > totalChars) break;
    lines.unshift(line);
    used += line.length + 1;
    turns += 1;
  }
  return { text: lines.join('\n\n'), turns };
}

/** 只取消息里的 text block —— tool-call / 图片 / 推理块一律不要（它们会把上下文变成代码噪声）。 */
function messageTextOf(event) {
  const type = event && event.type;
  let content;
  if (type === 'user/message') {
    // user/message 里混着大量「系统注入的假用户消息」：workspace 规约(agent-instructions)、
    // 运行时快照(runtime-context)、整份 skill catalog(skill-catalog，实测单条 35557 字符)、
    // 时间戳(time-context)。它们带 data.source.kind，真人输入是 kind === 'user'。
    // 不过滤的话，上下文里会塞进几万字噪声，把真正的对话挤出预算。
    const source = event.data && event.data.source;
    if (source && source.kind && source.kind !== 'user') return '';
    content = event.data && event.data.content;
  } else if (type === 'assistant/message') content = event.data && event.data.message && event.data.message.content;
  else return '';
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 从宿主 sessionQuery 读当前会话最近的消息，构建上下文。
 *
 * 优先 `readSurface`（返回当前模型面的事件本体，已经做过压缩/替换折叠，
 * 不会把同一句话读两遍），文本抽取自己按 text block 做 —— 因为宿主
 * `filterEvents` 的 `extractSessionEventText` 会**把 tool-call 的参数也拼进去**
 * （实测 assistant 消息里会混进整段 edit 的 file_path/diff），那些东西进上下文只有坏处。
 *
 * `readSurface` 不可用时退回 `filterEvents`（只按类型筛），最后一道是静默空上下文 ——
 * 上下文是加分项，绝不能因为它让增强整体失败。
 *
 * @param {{readSurface?:Function, filterEvents?:Function}|null|undefined} sessionQuery
 * @param {string} sessionId
 * @param {object} [options] 透传 buildConversationContext 的预算
 * @returns {Promise<{text:string, turns:number}>}
 */
export async function readConversationContext(sessionQuery, sessionId, options = {}) {
  if (!sessionQuery || typeof sessionId !== 'string' || !sessionId) return { text: '', turns: 0 };
  const finish = (docs) => {
    try {
      return buildConversationContext(docs, options);
    } catch {
      return { text: '', turns: 0 };
    }
  };

  if (typeof sessionQuery.readSurface === 'function') {
    try {
      const surface = await sessionQuery.readSurface(sessionId);
      const events = surface && Array.isArray(surface.events) ? surface.events : [];
      const docs = [];
      for (const event of events) {
        const text = messageTextOf(event);
        if (text) docs.push({ type: event.type, text });
      }
      return finish(docs);
    } catch {
      // 落盘读取失败（会话还没持久化 / 日志损坏），继续走 filterEvents。
    }
  }

  if (typeof sessionQuery.filterEvents !== 'function') return { text: '', turns: 0 };
  const types = ['user/message', 'assistant/message'];
  let docs = null;
  try {
    // surface=current 用来排掉被压缩/替换掉的旧版本，避免同一句话出现两遍。
    docs = await sessionQuery.filterEvents(sessionId, [
      { kind: 'type', values: types },
      { kind: 'surface', values: ['current'] },
    ]);
  } catch {
    return { text: '', turns: 0 };
  }
  if (!Array.isArray(docs) || docs.length === 0) {
    // 有些历史日志没有 surface 元数据，会被判成 log-only —— 这时退回不带 surface 的查询。
    try {
      docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'type', values: types }]);
    } catch {
      return { text: '', turns: 0 };
    }
  }
  return finish(docs);
}

/**
 * 拼给模型的 user 消息正文：有上下文就先放「前文对话」，再放「当前草稿」。
 * 明确告诉模型「不要复述上下文」，否则它容易把前文抄进增强结果里。
 */
function composeUserPrompt(draft, context) {
  const body = String(draft || '');
  const contextText = context && typeof context.text === 'string' ? context.text.trim() : '';
  if (!contextText) return body;
  return [
    '## 前文对话（供理解上下文，不要复述，也不要照抄）',
    '',
    contextText,
    '',
    '## 当前草稿（待增强）',
    '',
    body,
  ].join('\n');
}

/**
 * 调 Harness 的 llm 服务做语义增强。
 *
 * ★ provider/model 不能再写死 ★（2026-10-19 修）
 *   之前写死 `provider:'our-free-model' / model:'mimo-v2.6-flash-free'`，实测该通道
 *   返回：`模型返回错误：OpenCode's free tier can only be used from within OpenCode`，
 *   每个请求都静默降级成模板。现在改成用 `agentDefaultModel.currentSelection()`
 *   取用户在模型选择器里设定的那一个（本机为 deepseek-account / deepseek-flash）。
 *
 * @param {object} llm - Harness llm 服务
 * @param {string} draft - 用户原始草稿
 * @param {{signal?:AbortSignal, route?:{provider:string, model:string}, context?:{text:string, turns:number}}} options
 * @returns {Promise<{text:string, usage:object|null}>}
 */
async function callModel(llm, draft, { signal, route, context } = {}) {
  // ★ content 必须是 block 数组 ★（2026-10-19 修，本次故障根因）
  // 之前传裸字符串 `content: '...'`，而 DeepSeek 适配器转 wire 时执行
  // `message.content.some(...)` / `message.content.flatMap(...)`，
  // 字符串上没这些方法 → TypeError → 被适配器包成
  // "DeepSeek Messages transport failed"（code TRANSPORT），
  // 于是每次点击都静默降级成规则模板。宿主只认 `[{type:'text',text}]`。
  const messages = [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: composeUserPrompt(draft, context) }] },
  ];
  const target = route && route.provider && route.model
    ? route
    : { provider: FALLBACK_ROUTE.provider, model: FALLBACK_ROUTE.model };
  const stream = llm.stream({
    provider: target.provider,
    model: target.model,
    ...REASONING_EFFORTS.has(target.reasoningEffort) ? { reasoningEffort: target.reasoningEffort } : {},
    messages,
    signal,
  });

  let text = '';
  let usage = null;
  for await (const chunk of stream) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk && chunk.type === 'usage' && chunk.usage) {
      usage = chunk.usage;
    } else if (chunk && chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind;
      if (kind === 'error') {
        // 宿主 normalizeLlmFailure 只保留 message + code，cause 链在适配器里就被丢了。
        // 把 code 也带出来——TRANSPORT / QUOTA / INVALID_REQUEST / UNKNOWN_MODEL
        // 一眼就能判断是协议问题、额度问题还是模型名问题。
        const failure = (chunk.reason && chunk.reason.failure) || {};
        const code = failure.code ? `[${failure.code}]` : '';
        throw new Error(`模型返回错误${code}：${failure.message || kind}`);
      }
    }
  }
  return { text: text.trim(), usage };
}

/**
 * 请求处理器。抽成顶层函数（而非 apply 里的闭包）是为了能在 Node 里直接单测：
 * 传假 req/res 与假 llm，就能覆盖 405/403/400/降级全部分支。
 *
 * @param {object} deps
 * @param {object} deps.llm - Harness llm 服务（llm.stream）
 * @param {{provider:string, model:string}} [deps.route] - 走哪个 provider/model
 * @param {object} [deps.sessionQuery] - 可选：读会话历史的宿主服务
 * @param {(msg:string)=>void} [deps.logger]
 */
export async function handleEnhance(req, res, { llm, route, logger = console, sessionQuery, contextOptions } = {}) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  if (!isLoopbackAuthority(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status === 413 ? 413 : 400, { ok: false, error: `bad request: ${String((error && error.message) || error)}` });
    return;
  }

  const draft = typeof payload.text === 'string' ? payload.text : '';
  if (!draft.trim()) {
    sendJson(res, 400, { ok: false, error: 'empty draft' });
    return;
  }

  // 上下文是加分项：读不到 / 服务没装 / 会话还没落盘，一律当「没有上下文」继续。
  let context = { text: '', turns: 0 };
  if (typeof payload.sessionId === 'string' && payload.sessionId) {
    try {
      context = await readConversationContext(sessionQuery, payload.sessionId, {
        ...contextOptions,
        excludeText: draft.trim(),
      });
    } catch {
      context = { text: '', turns: 0 };
    }
  }

  const controller = new AbortController();
  // 客户端断开时取消模型调用，避免悬挂流。
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  try {
    const { text, usage } = await callModel(llm, draft, { signal: controller.signal, route, context });
    if (!text) {
      sendJson(res, 200, {
        ok: true,
        enhanced: templateFallback(draft),
        source: 'fallback-empty',
        contextTurns: context.turns,
      });
      return;
    }
    sendJson(res, 200, { ok: true, enhanced: text, source: 'model', usage, contextTurns: context.turns });
  } catch (error) {
    if (controller.signal.aborted) return; // 客户端已断开，不再回写
    logger.warn?.(`prompt-enhance: 模型调用失败，降级模板 — ${String((error && error.message) || error)}`);
    sendJson(res, 200, {
      ok: true,
      enhanced: templateFallback(draft),
      source: 'fallback',
      reason: String((error && error.message) || error),
      contextTurns: context.turns,
    });
  }
}

export function apply(ctx, config) {
  // `ctx` 是插件自身 fiber 的上下文：只有自身 inject 声明的服务能直接读，
  // 未声明的（这里主要是 llm）读了会抛 `cannot get property "llm" without inject`。
  // 而 handler 是每请求执行的，不能把取 llm 的动作放在 handler 里 —— 那会让
  // 每一个请求都在 webserver 的 catch 里变成裸 400（无 body、无 content-type）。
  // logger 是 cordis mixin，任何 ctx 上都可安全读。
  const logger = ctx.logger || console;
  // 惰性兜底：inject 回调可能在加载早期就过了（llm 已到位但 fiber 尚在 reload），
  // 到时候再用 reflector 读一次。两条路都失败就返回 null，让 handler 走模板降级。
  const readLlm = () => {
    try {
      const viaReflect = ctx.reflect?.get('llm', false);
      if (viaReflect) return viaReflect;
    } catch { /* reflect 不在或服务不存在，继续走 inject 快照 */ }
    return llmSnapshot;
  };

  let llmSnapshot = null;
  /** 当前默认模型路由；随 agentDefaultModel 变化而更新。 */
  let routeSnapshot = null;
  const readRoute = () => {
    try {
      const service = ctx.reflect?.get('agentDefaultModel', false);
      const selection = service?.currentSelection?.();
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
      }
    } catch { /* 服务没装或还没就绪，走兜底 */ }
    return routeSnapshot;
  };

  /**
   * sessionQuery 也是可选依赖（没有它 = 不带上下文增强，功能照常）。
   * 绝对不能塞进 `ctx.inject(['llm','webServer'])` 的必需数组 ——
   * cordis 对缺失依赖的处理是「inject 回调永不执行」，那样连路由都不会挂载。
   */
  let querySnapshot = null;
  const readQuery = () => {
    try {
      const viaReflect = ctx.reflect?.get('sessionQuery', false);
      if (viaReflect) return viaReflect;
    } catch { /* 服务不存在 */ }
    return querySnapshot;
  };

  const routeBase = '/prompt-enhance';

  const handler = (req, res) =>
    handleEnhance(req, res, {
      llm: readLlm(),
      route: readRoute(),
      sessionQuery: readQuery(),
      logger,
    });

  ctx.inject(['llm', 'webServer'], (scoped) => {
    llmSnapshot = scoped.llm ?? null;
    // agentDefaultModel 是可选依赖：没有它也能跑（走 FALLBACK_ROUTE），
    // 所以单独 inject 一次，失败不影响路由注册。
    const disposeRoute = (() => {
      try {
        return ctx.inject(['agentDefaultModel'], (withModel) => {
          const sync = () => {
            try {
              const selection = withModel.agentDefaultModel?.currentSelection?.();
              if (selection && selection.provider && selection.model) {
                routeSnapshot = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
              }
            } catch { /* 读失败保持上一次 */ }
          };
          sync();
          return () => {};
        });
      } catch { return () => {}; }
    })();
    const disposers = [
      disposeRoute,
      (() => {
        try {
          return ctx.inject(['sessionQuery'], (withQuery) => {
            querySnapshot = withQuery.sessionQuery ?? null;
            return () => { querySnapshot = null; };
          });
        } catch { return () => {}; }
      })(),
      scoped.webServer.register({ kind: 'exact', path: `${routeBase}/enhance`, handler }),
    ];
    logger.info?.('prompt-enhance: 路由已挂载 POST /prompt-enhance/enhance');
    return () => {
      llmSnapshot = null;
      routeSnapshot = null;
      querySnapshot = null;
      for (const dispose of disposers) {
        try { dispose?.(); } catch { /* 注销失败不影响卸载 */ }
      }
    };
  });
}
