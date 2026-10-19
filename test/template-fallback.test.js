// 规则模板兜底（B+A 的 A）测试。
//
// 这条路径在模型不可达时兜住用户体验，是「降级」而非「出错」的关键：
// 用户点了增强，最坏也应该拿到一份带完整字段的模板，而不是一条报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { templateFallback, SYSTEM_PROMPT } from '../index.js';

test('草稿被嵌进 # 任务，多个字段骨架齐全', () => {
  const out = templateFallback('帮我写一个登录接口');
  assert.match(out, /^# 任务\n/);
  assert.match(out, /帮我写一个登录接口/);
  for (const section of ['## 角色', '## 背景', '## 要求', '## 输出格式']) {
    assert.ok(out.includes(section), `缺少 ${section}`);
  }
});

test('占位提示存在，让用户知道哪几处要自己补', () => {
  const out = templateFallback('整理周报');
  // 不编造内容 → 必须留下占位而不是留空
  assert.match(out, /（请指定执行者身份/);
  assert.match(out, /（请补充任务的背景信息/);
});

test('空草稿 / 纯空白 / 缺参都不炸，给出可编辑的空模板', () => {
  for (const input of ['', '   \n\t ', undefined, null]) {
    const out = templateFallback(input);
    assert.match(out, /^# 任务\n/);
    assert.match(out, /（未提供）/);
  }
});

test('多行草稿只取前三行做摘要，避免模板头部变成长篇', () => {
  const out = templateFallback('第一行\n第二行\n第三行\n第四行\n第五行');
  assert.ok(out.includes('第一行 第二行 第三行'));
  assert.ok(!out.includes('第四行'));
});

test('落款留空不注入 markdown 代码块包裹', () => {
  const out = templateFallback('x');
  assert.ok(!out.startsWith('```'));
  assert.ok(!out.trimEnd().endsWith('```'));
});

test('系统提示词钉死四条硬约束', () => {
  // 这四条是「增强而非重写」的护栏，改动会实质改变产品行为，值得钉住。
  assert.match(SYSTEM_PROMPT, /只做增强/);
  assert.match(SYSTEM_PROMPT, /不要回答草稿本身的内容/);
  assert.match(SYSTEM_PROMPT, /不要编造草稿中不存在的事实/);
  assert.match(SYSTEM_PROMPT, /直接输出增强后的提示词正文/);
});
