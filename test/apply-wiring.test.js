// apply(ctx) 接线冒烟。
//
// 为什么值得测：路由没注册成功 = 按钮点了也发不出请求，而且是"静默失败"
// （组件照样渲染，只是 fetch 404）。这个测试用假 ctx 把 apply 跑一遍，
// 断言它向 llm/webServer 注入、注册了正确的 exact 路由、并且给出了 cleanup。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

function fakeCtx() {
  const seen = {
    injected: [],
    registered: [],
    disposed: [],
    logs: [],
  };
  const ctx = {
    logger: {
      info: (m) => seen.logs.push(['info', m]),
      warn: (m) => seen.logs.push(['warn', m]),
    },
    llm: { stream() { throw new Error('unused'); } },
    inject(names, fn) {
      seen.injected.push([...names]);
      const scoped = {
        agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
        webServer: {
          register(spec) {
            seen.registered.push(spec);
            return () => seen.disposed.push(spec.path);
          },
        },
      };
      return fn(scoped);
    },
  };
  return { ctx, seen };
}

test('apply 注入 llm + webServer，注册 POST /prompt-enhance/enhance 的 exact 路由', () => {
  const { ctx, seen } = fakeCtx();
  apply(ctx, {});

  // 第一次注入是必需依赖，第二次是可选依赖（agentDefaultModel，缺了就走兜底路由）。
  assert.deepEqual(seen.injected, [['llm', 'webServer'], ['agentDefaultModel']]);
  assert.equal(seen.registered.length, 1);

  const spec = seen.registered[0];
  assert.equal(spec.kind, 'exact');
  assert.equal(spec.path, '/prompt-enhance/enhance');
  assert.equal(typeof spec.handler, 'function');
});

test('inject 回调返回 cleanup，cleanup 会注销掉注册的路由', () => {
  const { ctx, seen } = fakeCtx();
  let cleanup;
  // 让 ctx.inject 把 cleanup 透出来（fakeCtx 默认丢弃它）
  ctx.inject = (names, fn) => {
    cleanup = fn({
      webServer: {
        register(spec) {
          seen.registered.push(spec);
          return () => seen.disposed.push(spec.path);
        },
      },
    });
    seen.injected.push([...names]);
    return cleanup;
  };

  apply(ctx, {});

  assert.equal(typeof cleanup, 'function', '必须提供注销函数，否则插件卸载后路由还在');
  cleanup();
  assert.deepEqual(seen.disposed, ['/prompt-enhance/enhance']);
});

test('apply 无参数也能跑（config 不传时用默认值）', () => {
  const { ctx, seen } = fakeCtx();
  apply(ctx);
  assert.equal(seen.registered.length, 1);
});

// 2026-10-16 回归：handler 里曾经写 `llm: ctx.llm`，而 ctx 是插件外层 fiber 的
// 上下文，`llm` 只声明在 inject 回调的 scoped 参数上。cordis 对未声明服务的
// 读取是 throw（cannot get property "llm" without inject），不是 undefined ——
// 于是每个请求都在 webserver 的 catch 里变成裸 400（空 body、无 content-type），
// 按钮点了没有任何反馈。这个测试用会抛的 getter 模拟 cordis 的代理语义，
// 断言 handler 仍能拿到 llm 并正常降级，而不是抛异常。
test('handler 不通过外层 ctx 读 llm（cordis 会抛，实测踩过）', async () => {
  const { ctx, seen } = fakeCtx();
  let capturedHandler;
  ctx.inject = (names, fn) => {
    const scoped = {
      llm: { stream() { throw new Error('模型不可达'); } },
      webServer: {
        register(spec) { capturedHandler = spec.handler; return () => {}; },
      },
    };
    fn(scoped);
    seen.injected.push([...names]);
  };
  apply(ctx, {});

  // 让 ctx.llm 像 cordis 代理一样：未声明 inject 的服务，读就抛
  Object.defineProperty(ctx, 'llm', {
    get() { throw new Error('cannot get property "llm" without inject'); },
  });

  const chunks = [Buffer.from('{"text":"写个登录"}', 'utf8')];
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  const res = {
    status: null, writableEnded: false,
    on() {},
    writeHead(s) { this.status = s; },
    end(b) { this.body = b; this.writableEnded = true; },
  };
  await capturedHandler(req, res);

  // 关键断言：不抛异常、有 JSON body、状态是 200（模型失败走模板降级）
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, 'fallback');
});
