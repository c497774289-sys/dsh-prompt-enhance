// 客户端半边的回归测试（在 Node 里用桩件跑浏览器模块）。
//
// 为什么必须有：按钮不出现这类故障在浏览器里只能靠肉眼发现，而它的成因往往
// 是"注册根本没发生"或"组件渲染成 null"。这两件都能在 Node 里用桩件断言。
//
// 2026-10-19 修的那次就是：模块声明 inject:['conversation']，而 conversation
// 服务对第三方插件的 fiber 不可见 → 注册回调永不执行 → 按钮永不出现。
// 现在改成零服务依赖（只用插槽下发的 useInput / inputActions），这里钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

/** 最小 React 桩：createElement 记录，hooks 走朴素实现。 */
function stubReact() {
  const state = [];
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const i = cursor++;
      if (state[i] === undefined) state[i] = initial;
      return [state[i], (next) => { state[i] = next; }];
    },
    __reset() { cursor = 0; },
    __get(i) { return state[i]; },
  };
}

/** 载入 client.js，返回 { id, module }。 */
function loadClient() {
  const source = readFileSync(CLIENT, 'utf8');
  const React = stubReact();
  const registrations = [];
  const fakeWindow = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  };
  const requireStub = (specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`client-modules: require("${specifier}") missed the module table`);
  };
  // 模块顶层只调 window.__ModuleLoader__.load，不执行 factory
  new Function('window', source)(fakeWindow);
  assert.equal(registrations.length, 1, '必须且只注册一个模块');
  const registration = registrations[0];
  return { id: registration.id, module: registration.factory(requireStub), React };
}

test('模块 id 与包名一致（模块表按 id 解析）', () => {
  const { id } = loadClient();
  const pkg = JSON.parse(readFileSync(path.join(CLIENT, '..', 'package.json'), 'utf8'));
  assert.equal(id, pkg.name);
});

test('只依赖 slots，不依赖 conversation（后者对第三方 fiber 不可见）', () => {
  const { module } = loadClient();
  assert.deepEqual(module.inject, ['slots']);
  assert.equal(typeof module.apply, 'function');
});

test('apply 把条目注册进 conversation.input.right', () => {
  const { module } = loadClient();
  const seen = { injected: [], registered: [] };

  module.apply({
    slots: {
      inject(slotName, thunk) {
        seen.injected.push(slotName);
        return thunk();
      },
      register(spec, Component) {
        seen.registered.push({ spec, Component });
        return () => {};
      },
    },
  });

  assert.deepEqual(seen.injected, ['conversation.input.right']);
  assert.equal(seen.registered.length, 1);
  const { spec } = seen.registered[0];
  assert.equal(spec.name, 'conversation.input.right');
  assert.equal(spec.id, 'prompt-enhance');
  assert.equal(typeof spec.inject, 'function');
  // 只透传 sessionId，不读任何服务
  assert.deepEqual(spec.inject('S1'), { sessionId: 'S1' });
});

test('组件能渲染出按钮，且草稿为空时禁用', () => {
  const { module, React } = loadClient();
  let Component;
  module.apply({
    slots: {
      inject: (_n, thunk) => thunk(),
      register: (spec, Comp) => { Component = Comp; return () => {}; },
    },
  });

  const useInput = (selector) => selector({ draft: '', attachmentIds: [], phase: 'plain' });
  const inputActions = { setDraft: () => {} };

  React.__reset();
  const empty = Component({ useInput, inputActions, sessionId: 'S1' });
  assert.equal(empty.type, 'button');
  assert.equal(empty.props['data-dsh-prompt-enhance'], 'enhance');
  assert.equal(empty.props.disabled, true, '空草稿时按钮应禁用');

  React.__reset();
  const filled = Component({ useInput: (sel) => sel({ draft: '写个登录' }), inputActions, sessionId: 'S1' });
  assert.equal(filled.props.disabled, false);
  assert.equal(filled.children[0], '✨');
});

test('点增强：POST 到宿主路由，成功后把结果写回草稿并记住原文', async () => {
  const { module, React } = loadClient();
  let Component;
  module.apply({
    slots: {
      inject: (_n, thunk) => thunk(),
      register: (_spec, Comp) => { Component = Comp; return () => {}; },
    },
  });

  const drafts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/prompt-enhance/enhance');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { text: '写个登录', sessionId: 'S1' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, enhanced: '# 角色\n资深工程师', source: 'model' }),
    };
  };

  try {
    const useInput = (selector) => selector({ draft: '写个登录' });
    const inputActions = { setDraft: (text) => drafts.push(text) };

    React.__reset();
    const button = Component({ useInput, inputActions, sessionId: 'S1' });
    await button.props.onClick();

    assert.deepEqual(drafts, ['# 角色\n资深工程师'], '增强结果必须写回草稿');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('增强成功后按钮变 ↩，再点一次把原文还回去', async () => {
  const { module, React } = loadClient();
  let Component;
  module.apply({
    slots: {
      inject: (_n, thunk) => thunk(),
      register: (_spec, Comp) => { Component = Comp; return () => {}; },
    },
  });

  const writes = [];
  let current = '写个登录';
  const useInput = (selector) => selector({ draft: current });
  const inputActions = { setDraft: (text) => { writes.push(text); current = text; } };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, enhanced: 'ENHANCED', source: 'model' }),
  });

  try {
    React.__reset();
    await Component({ useInput, inputActions, sessionId: 'S1' }).props.onClick();
    assert.equal(current, 'ENHANCED');

    // 草稿仍是增强结果 → 按钮应显示还原态
    React.__reset();
    const restored = Component({ useInput, inputActions, sessionId: 'S1' });
    assert.equal(restored.props['data-dsh-prompt-enhance'], 'restore');
    assert.equal(restored.children[0], '↩');

    await restored.props.onClick();
    assert.equal(current, '写个登录', '必须还原成原文');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('用户手动改过草稿后，不再显示还原（避免冲掉编辑）', async () => {
  const { module, React } = loadClient();
  let Component;
  module.apply({
    slots: {
      inject: (_n, thunk) => thunk(),
      register: (_spec, Comp) => { Component = Comp; return () => {}; },
    },
  });

  let current = '写个登录';
  const useInput = (selector) => selector({ draft: current });
  const inputActions = { setDraft: (text) => { current = text; } };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, enhanced: 'ENHANCED', source: 'model' }),
  });

  try {
    React.__reset();
    await Component({ useInput, inputActions, sessionId: 'S1' }).props.onClick();
    assert.equal(current, 'ENHANCED');

    // 用户手改
    current = 'ENHANCED 我自己改的';

    React.__reset();
    const after = Component({ useInput, inputActions, sessionId: 'S1' });
    assert.equal(after.props['data-dsh-prompt-enhance'], 'enhance', '改过草稿就不再提供还原');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('宿主返回失败时按钮不崩、草稿不动', async () => {
  const { module, React } = loadClient();
  let Component;
  module.apply({
    slots: {
      inject: (_n, thunk) => thunk(),
      register: (_spec, Comp) => { Component = Comp; return () => {}; },
    },
  });

  const writes = [];
  const useInput = (selector) => selector({ draft: '写个登录' });
  const inputActions = { setDraft: (t) => writes.push(t) };

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) });

  try {
    React.__reset();
    await Component({ useInput, inputActions, sessionId: 'S1' }).props.onClick();
    assert.deepEqual(writes, [], '失败时不许动草稿');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
