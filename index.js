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
 * @param {{signal?:AbortSignal, route?:{provider:string, model:string}}} options
 * @returns {Promise<{text:string, usage:object|null}>}
 */
async function callModel(llm, draft, { signal, route } = {}) {
  // ★ content 必须是 block 数组 ★（2026-10-19 修，本次故障根因）
  // 之前传裸字符串 `content: '...'`，而 DeepSeek 适配器转 wire 时执行
  // `message.content.some(...)` / `message.content.flatMap(...)`，
  // 字符串上没这些方法 → TypeError → 被适配器包成
  // "DeepSeek Messages transport failed"（code TRANSPORT），
  // 于是每次点击都静默降级成规则模板。宿主只认 `[{type:'text',text}]`。
  const messages = [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: String(draft || '') }] },
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
 * @param {(msg:string)=>void} [deps.logger]
 */
export async function handleEnhance(req, res, { llm, route, logger = console } = {}) {
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

  const controller = new AbortController();
  // 客户端断开时取消模型调用，避免悬挂流。
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  try {
    const { text, usage } = await callModel(llm, draft, { signal: controller.signal, route });
    if (!text) {
      sendJson(res, 200, { ok: true, enhanced: templateFallback(draft), source: 'fallback-empty' });
      return;
    }
    sendJson(res, 200, { ok: true, enhanced: text, source: 'model', usage });
  } catch (error) {
    if (controller.signal.aborted) return; // 客户端已断开，不再回写
    logger.warn?.(`prompt-enhance: 模型调用失败，降级模板 — ${String((error && error.message) || error)}`);
    sendJson(res, 200, { ok: true, enhanced: templateFallback(draft), source: 'fallback', reason: String((error && error.message) || error) });
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
  const routeBase = '/prompt-enhance';

  const handler = (req, res) =>
    handleEnhance(req, res, { llm: readLlm(), route: readRoute(), logger });

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
      scoped.webServer.register({ kind: 'exact', path: `${routeBase}/enhance`, handler }),
    ];
    logger.info?.('prompt-enhance: 路由已挂载 POST /prompt-enhance/enhance');
    return () => {
      llmSnapshot = null;
      routeSnapshot = null;
      for (const dispose of disposers) {
        try { dispose?.(); } catch { /* 注销失败不影响卸载 */ }
      }
    };
  });
}
