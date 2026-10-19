// 会话上下文构建 + sessionQuery 读取的契约测试。
//
// 背景：长对话里「接着说」「按上面的继续」这类草稿，只看自己一句是补不出来的。
// 增强前必须把最近几轮 user/assistant 对话一起喂给模型（2026-10-19 用户需求）。
//
// 这里只测纯函数与读取适配层，不碰 HTTP —— 路由层用例在 enhance-route.test.js 末尾。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_DEFAULTS,
  buildConversationContext,
  readConversationContext,
} from '../index.js';

/** 造一条用户消息文档（形状与 sessionQuery.filterEvents 一致）。 */
const user = (text, seq = 0) => ({ seq, type: 'user/message', text });
/** 造一条助手消息文档。 */
const assistant = (text, seq = 0) => ({ seq, type: 'assistant/message', text });

test('只取 user/assistant 消息，工具调用与结构事件一律跳过', () => {
  const docs = [
    user('第一问', 0),
    { seq: 1, type: 'tool/call', text: 'read {"path":"x"}' },
    { seq: 2, type: 'tool/result', text: '文件内容' },
    { seq: 3, type: 'step/start', text: '' },
    assistant('第一答', 4),
    { seq: 5, type: 'request/header', text: 'envelope' },
    user('第二问', 6),
  ];
  const { text, turns } = buildConversationContext(docs);
  assert.equal(turns, 3);
  assert.match(text, /用户：第一问/);
  assert.match(text, /助手：第一答/);
  assert.match(text, /用户：第二问/);
  assert.ok(!text.includes('文件内容'), 'tool/result 不该进上下文');
  assert.ok(!text.includes('envelope'), 'request/header 不该进上下文');
});

test('默认只取最近 6 条（从最后往前算，保住最贴近草稿的那几轮）', () => {
  const docs = Array.from({ length: 12 }, (_, index) =>
    index % 2 === 0 ? user(`问${index}`, index) : assistant(`答${index}`, index));
  const { text, turns } = buildConversationContext(docs);
  assert.equal(turns, CONTEXT_DEFAULTS.maxMessages);
  assert.equal(CONTEXT_DEFAULTS.maxMessages, 6);
  assert.match(text, /问10/);
  assert.match(text, /答11/);
  assert.ok(!text.includes('问0'), '早期消息应被裁掉');
});

test('顺序保持时间正序（老的在前，新的在后）', () => {
  const { text } = buildConversationContext([user('早', 0), assistant('中', 1), user('晚', 2)]);
  assert.ok(text.indexOf('早') < text.indexOf('中'));
  assert.ok(text.indexOf('中') < text.indexOf('晚'));
});

test('单条超长消息按 perMessageChars 截断并留省略号', () => {
  const long = 'x'.repeat(2000);
  const { text } = buildConversationContext([user(long, 0)]);
  const line = text.split('\n\n')[0];
  // "用户：" 前缀 + 600 字符 + "…"
  assert.equal(line.length, '用户：'.length + CONTEXT_DEFAULTS.perMessageChars + 1);
  assert.ok(line.endsWith('…'));
});

test('总量超 totalChars 时，从最老的一条开始丢', () => {
  const docs = Array.from({ length: 6 }, (_, index) => user('y'.repeat(600), index));
  const { text, turns } = buildConversationContext(docs);
  // 每条 600 + 前缀 + 分隔，6 条必然超过 3000
  assert.ok(text.length <= CONTEXT_DEFAULTS.totalChars);
  assert.ok(turns > 0 && turns < 6, `应裁掉部分，实际 ${turns}`);
});

test('空输入 / 非法输入返回空上下文，不抛', () => {
  for (const input of [[], null, undefined, 'not-an-array', {}]) {
    const result = buildConversationContext(input);
    assert.deepEqual(result, { text: '', turns: 0 });
  }
  assert.deepEqual(buildConversationContext([user('   ', 0)]), { text: '', turns: 0 });
});

test('excludeText：草稿本身若已在日志里，不重复喂给模型', () => {
  const docs = [user('更早的问题', 0), assistant('更早的回答', 1), user('当前草稿', 2)];
  const { text, turns } = buildConversationContext(docs, { excludeText: '当前草稿' });
  assert.equal(turns, 2);
  assert.ok(!text.includes('用户：当前草稿'));
});

test('自定义预算生效（maxMessages / perMessageChars / totalChars）', () => {
  const docs = [user('a'.repeat(100), 0), assistant('b'.repeat(100), 1), user('c'.repeat(100), 2)];
  const { turns, text } = buildConversationContext(docs, {
    maxMessages: 1,
    perMessageChars: 10,
    totalChars: 1000,
  });
  assert.equal(turns, 1);
  // 取最近一条（最后一条是 c），截到 10 字符并留省略号
  assert.match(text, /用户：c{10}…/);
});

test('readConversationContext：服务缺失 / sessionId 缺失时直接返回空，不调用任何方法', async () => {
  let called = 0;
  const spy = {
    readSurface() { called += 1; return { events: [] }; },
    filterEvents() { called += 1; return []; },
  };

  assert.deepEqual(await readConversationContext(undefined, 's1'), { text: '', turns: 0 });
  assert.deepEqual(await readConversationContext({}, 's1'), { text: '', turns: 0 });
  assert.deepEqual(await readConversationContext(spy, undefined), { text: '', turns: 0 });
  assert.deepEqual(await readConversationContext(spy, ''), { text: '', turns: 0 });
  assert.equal(called, 0);
});

test('readSurface 路径：系统注入的假用户消息要丢掉，只留真人输入', async () => {
  // 真实日志（2026-10-19 实测）里 user/message 的 data.source.kind 有：
  // user / agent-instructions / runtime-context / skill-catalog / time-context
  const spy = {
    async readSurface() {
      return {
        events: [
          { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '真人第一问' }], source: { kind: 'user' } } },
          { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>整份 skill catalog</system-reminder>' }], source: { kind: 'skill-catalog', form: 'catalog' } } },
          { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. ...' }], source: { kind: 'runtime-context', form: 'snapshot' } } },
          { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'time-context', form: 'snapshot' } } },
          { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '真人第一答' }] } } },
          { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: '真人第二问（老日志无 source 字段）' }] } },
        ],
      };
    },
  };
  const { text, turns } = await readConversationContext(spy, 's1', { maxMessages: 10 });
  assert.equal(turns, 3, '只有真人第一问 / 真人第一答 / 真人第二问');
  assert.match(text, /真人第一问/);
  assert.match(text, /真人第一答/);
  assert.match(text, /真人第二问/);
  assert.ok(!text.includes('skill catalog'), 'skill-catalog 注入必须过滤');
  assert.ok(!text.includes('runtime context'), 'runtime-context 注入必须过滤');
  assert.ok(!text.includes('Time sampled'), 'time-context 注入必须过滤');
});

test('readConversationContext：优先 readSurface，且只取 text block（tool-call 的入参不能进上下文）', async () => {
  let filterCalls = 0;
  const spy = {
    async readSurface(sessionId) {
      assert.equal(sessionId, 'session-1');
      return {
        events: [
          { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '我要做硬件驾驶舱' }] } },
          {
            seq: 1,
            type: 'assistant/message',
            data: {
              message: {
                content: [
                  { type: 'text', text: '先拆成三层' },
                  { type: 'tool-call', name: 'edit', arguments: '{"file_path":"a.md","old_string":"秘密文件"}' },
                  { type: 'reasoning', text: '思考过程不该出现' },
                ],
              },
            },
          },
          { seq: 2, type: 'tool/call', data: { name: 'read', arguments: '{"path":"x"}' } },
          { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '再补一句' }] } } },
        ],
      };
    },
    async filterEvents() { filterCalls += 1; return []; },
  };

  const { text, turns } = await readConversationContext(spy, 'session-1', { maxMessages: 10 });
  assert.equal(filterCalls, 0, 'readSurface 成功时不该再走 filterEvents');
  assert.equal(turns, 3);
  assert.match(text, /用户：我要做硬件驾驶舱/);
  assert.match(text, /助手：先拆成三层/);
  assert.ok(!text.includes('a.md'), 'tool-call 入参不能进上下文');
  assert.ok(!text.includes('思考过程'), 'reasoning 块不能进上下文');
});

test('readConversationContext：readSurface 失败时退回 filterEvents（带 surface=current）', async () => {
  const calls = [];
  const spy = {
    async readSurface() { throw new Error('SESSION_QUERY_PERSISTENCE_FAILED'); },
    async filterEvents(sessionId, filters) {
      calls.push({ sessionId, filters });
      return [user('问', 0), assistant('答', 1)];
    },
  };
  const { text, turns } = await readConversationContext(spy, 'session-1');
  assert.equal(turns, 2);
  assert.match(text, /用户：问/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filters[0], { kind: 'type', values: ['user/message', 'assistant/message'] });
  assert.deepEqual(calls[0].filters[1], { kind: 'surface', values: ['current'] });
});

test('readConversationContext：带 surface 过滤查空时，退回不带 surface 再查一次', async () => {
  const calls = [];
  const spy = {
    async readSurface() { throw new Error('not persisted'); },
    async filterEvents(sessionId, filters) {
      calls.push(filters);
      // 第一次（带 surface=current）空，第二次（纯 type）有数据
      return filters.some((filter) => filter.kind === 'surface')
        ? []
        : [user('历史问', 0), assistant('历史答', 1)];
    },
  };
  const { turns } = await readConversationContext(spy, 'session-1');
  assert.equal(calls.length, 2);
  assert.equal(turns, 2);
});

test('readConversationContext：两条读取通道都抛错时静默返回空（上下文绝不能拖垮增强）', async () => {
  const spy = {
    async readSurface() { throw new Error('SESSION_QUERY_SESSION_NOT_FOUND'); },
    async filterEvents() { throw new Error('SESSION_QUERY_SESSION_NOT_FOUND'); },
  };
  assert.deepEqual(await readConversationContext(spy, 'session-1'), { text: '', turns: 0 });
});
