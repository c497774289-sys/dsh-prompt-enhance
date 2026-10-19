// HTTP 处理器契约测试。
//
// 覆盖顺序：方法 → 来源 → 请求体 → 草稿非空 → 模型成功 / 模型失败降级。
// 假 req/res 用 async iterable 模拟 IncomingMessage，只断言状态码与 payload 形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleEnhance } from '../index.js';

/** 造一个最小 IncomingMessage：headers + POST body + on('close')。 */
function makeReq({ method = 'POST', host = '127.0.0.1:19387', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  const req = {
    method,
    headers: host === undefined ? {} : { host },
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
  return req;
}

/** 造一个最小 ServerResponse，收集 writeHead 参数与 body。 */
function makeRes() {
  const res = {
    status: null,
    headers: null,
    payload: null,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    end(text) { res.writableEnded = true; res.payload = text ? JSON.parse(text) : null; },
    on() {},
  };
  return res;
}

/** 假 llm：stream() 返回一个 async iterable。 */
function makeLlm({ chunks = [], throws = null }) {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options);
      const self = this;
      return (async function* () {
        if (throws) throw throws;
        for (const c of chunks) yield c;
      })();
    },
  };
}

const ok = (payload) => payload && payload.ok === true;

test('非 POST 一律 405，模型根本不被调用', async () => {
  const llm = makeLlm({ chunks: [{ type: 'text-delta', text: 'x' }] });
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = makeRes();
    await handleEnhance(makeReq({ method, body: '{"text":"hi"}' }), res, { llm });
    assert.equal(res.status, 405, `${method} 应拒`);
  }
  assert.equal(llm.calls.length, 0);
});

test('外部 Host 一律 403（trust fence 被绕过后唯一的门）', async () => {
  const llm = makeLlm({ chunks: [] });
  const res = makeRes();
  await handleEnhance(makeReq({ host: 'evil.example.com', body: '{"text":"hi"}' }), res, { llm });
  assert.equal(res.status, 403);
  assert.equal(llm.calls.length, 0);
});

test('空 body / 坏 JSON / 空草稿分别落到 200/400/400', async () => {
  const llm = makeLlm({ chunks: [] });

  // 空 body → readJson 返回 {} → text 不是 string → empty draft
  let res = makeRes();
  await handleEnhance(makeReq({ body: undefined }), res, { llm });
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /empty draft/);

  // 坏 JSON
  res = makeRes();
  await handleEnhance(makeReq({ body: '{not json' }), res, { llm });
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /invalid JSON/);

  // 合法 JSON 但草稿空白
  res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"   \\n "}' }), res, { llm });
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /empty draft/);

  // text 类型不对
  res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":42}' }), res, { llm });
  assert.equal(res.status, 400);
  assert.equal(llm.calls.length, 0);
});

test('模型成功：累积 text-delta 并原样返回', async () => {
  const llm = makeLlm({
    chunks: [
      { type: 'text-delta', text: '# 角色\n' },
      { type: 'text-delta', text: '资深工程师\n' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"写个登录"}' }), res, { llm });

  assert.equal(res.status, 200);
  assert.equal(res.payload.source, 'model');
  // 前后空白被 trim（进输入框的文本不该带首尾换行）
  assert.equal(res.payload.enhanced, '# 角色\n资深工程师');
  assert.equal(res.payload.usage.outputTokens, 20);

  // 没传 route 时走兜底路由（本机 desktop profile 的默认模型）
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'deepseek-account');
  assert.equal(llm.calls[0].model, 'deepseek-flash');
  assert.equal(llm.calls[0].messages[0].role, 'system');
  assert.equal(llm.calls[0].messages[1].role, 'user');
  // ★ content 必须是「block 数组」，不能是裸字符串 ★
  // DeepSeek 适配器把消息转 wire 时执行 message.content.flatMap(...)，
  // 传字符串会抛 TypeError，并被包成 "DeepSeek Messages transport failed"
  // → 每次点击都静默降级成规则模板（2026-10-19 实际故障）。
  assert.ok(Array.isArray(llm.calls[0].messages[1].content), 'user content 必须是 block 数组');
  assert.deepEqual(llm.calls[0].messages[1].content, [{ type: 'text', text: '写个登录' }]);
  assert.ok(Array.isArray(llm.calls[0].messages[0].content), 'system content 必须是 block 数组');
  assert.equal(llm.calls[0].messages[0].content[0].type, 'text');
});

test('模型抛错：降级为模板，仍返回 200', async () => {
  const llm = makeLlm({ throws: new Error('gateway down') });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"写个登录"}' }), res, { llm });

  assert.equal(res.status, 200);
  assert.equal(res.payload.source, 'fallback');
  assert.match(res.payload.enhanced, /^# 任务/);
  assert.match(res.payload.enhanced, /写个登录/);
  assert.match(res.payload.reason, /gateway down/);
});

test('模型返回空文本：走 fallback-empty，不把空结果当成增强成功', async () => {
  const llm = makeLlm({
    chunks: [
      { type: 'text-delta', text: '   ' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"写个登录"}' }), res, { llm });
  assert.equal(res.status, 200);
  assert.equal(res.payload.source, 'fallback-empty');
  assert.match(res.payload.enhanced, /^# 任务/);
});

test('模型报 error kind：抛错并降级（不把错误当成功）', async () => {
  const llm = makeLlm({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }],
  });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"写个登录"}' }), res, { llm });
  assert.equal(res.status, 200);
  assert.equal(res.payload.source, 'fallback');
  assert.match(res.payload.reason, /rate limited/);
});

test('响应头禁缓存 + JSON content-type', async () => {
  const llm = makeLlm({ chunks: [{ type: 'text-delta', text: '增强后' }] });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"x"}' }), res, { llm });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-type'], /application\/json/);
});

test('显式 route：按 agentDefaultModel 当前选择的 provider/model 走', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', text: 'ok' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"写个登录"}' }), res, {
    llm,
    route: { provider: 'deepseek-account', model: 'deepseek-pro' },
  });

  assert.equal(res.status, 200);
  assert.equal(llm.calls[0].provider, 'deepseek-account');
  assert.equal(llm.calls[0].model, 'deepseek-pro', '换模型后增强必须跟着换');
});

test('模型失败：reason 带上 adapter 错误码，便于区分 QUOTA / TRANSPORT / INVALID_REQUEST', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'finish', reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } } },
  ] });
  const res = makeRes();
  await handleEnhance(makeReq({ body: '{"text":"写个登录"}' }), res, { llm });

  assert.equal(res.payload.source, 'fallback');
  assert.match(res.payload.reason, /TRANSPORT/);
});

test('route 里的 reasoningEffort 会透传；非法值不传（否则适配器抛 UNSUPPORTED_REASONING_EFFORT）', async () => {
  const llm = makeLlm({ chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] });
  await handleEnhance(makeReq({ body: '{"text":"a"}' }), makeRes(), {
    llm,
    route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  });
  assert.equal(llm.calls[0].reasoningEffort, 'high');

  const llm2 = makeLlm({ chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] });
  await handleEnhance(makeReq({ body: '{"text":"a"}' }), makeRes(), {
    llm: llm2,
    route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'ultra' },
  });
  assert.equal(llm2.calls[0].reasoningEffort, undefined);
});
