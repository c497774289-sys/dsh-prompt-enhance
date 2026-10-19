// 回环守卫测试。
//
// 为什么这条最重要：exact 路由绕过了 DSH 的 /api 信任围栏（trust fence），
// 匿名 curl 也能摸到这个 handler。守卫是这条路上唯一的门。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLoopbackAuthority } from '../index.js';

const req = (host) => ({ headers: host === undefined ? {} : { host } });

test('接受 localhost / 127.0.0.1 / ::1（含端口）', () => {
  assert.equal(isLoopbackAuthority(req('localhost')), true);
  assert.equal(isLoopbackAuthority(req('localhost:19387')), true);
  assert.equal(isLoopbackAuthority(req('127.0.0.1')), true);
  assert.equal(isLoopbackAuthority(req('127.0.0.1:19387')), true);
  assert.equal(isLoopbackAuthority(req('::1')), true);
  assert.equal(isLoopbackAuthority(req('[::1]:19387')), true);
});

test('拒绝外部 Host', () => {
  assert.equal(isLoopbackAuthority(req('evil.example.com')), false);
  assert.equal(isLoopbackAuthority(req('evil.example.com:19387')), false);
  // 短斜杠劫持典型形态：攻击者域名里塞一个点分隔的 127.0.0.1
  assert.equal(isLoopbackAuthority(req('127.0.0.1.evil.com')), false);
});

test('拒绝缺失 Host 与畸形输入', () => {
  assert.equal(isLoopbackAuthority(req(undefined)), false);
  assert.equal(isLoopbackAuthority({ headers: {} }), false);
  assert.equal(isLoopbackAuthority({}), false);
  assert.equal(isLoopbackAuthority(null), false);
  // 空串与纯端口都不该过
  assert.equal(isLoopbackAuthority(req('')), false);
  assert.equal(isLoopbackAuthority(req(':19387')), false);
});

test('IPv6 的冒号不能被当成端口切掉', () => {
  // 若把第一个冒号当端口分隔，`::1` 会被切成空串 → 误判为拒绝。
  // 守卫必须在 `[::1]` 与裸 `::1` 两种形态下都认出来。
  assert.equal(isLoopbackAuthority(req('::1')), true);
  assert.equal(isLoopbackAuthority(req('[::1]')), true);
  // 多段 IPv6（非回环）必须拒绝，且不能因切分误伤
  assert.equal(isLoopbackAuthority(req('[2001:db8::1]:19387')), false);
});
