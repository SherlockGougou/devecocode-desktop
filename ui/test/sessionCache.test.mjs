import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCache, reconcileSessionMessages } from '../test-dist/sessionCache.js';

const part = (id, text) => ({ id, text, type: 'text', sessionID: 's', messageID: 'm' });
const message = (id, parts, extra = {}) => ({ info: { id, sessionID: 's', role: 'assistant', ...extra }, parts });

test('会话缓存按工作区隔离并淘汰最久未使用的条目', () => {
  const cache = new SessionCache(2);
  const a = [message('a', [])];
  cache.set('/a', 's', a);
  cache.set('/b', 's', []);
  assert.equal(cache.get('/a', 's'), a);
  cache.set('/c', 's', []);
  assert.equal(cache.get('/b', 's'), undefined);
  assert.deepEqual(cache.get('/c', 's'), []);
  cache.delete('/a', 's');
  assert.equal(cache.get('/a', 's'), undefined);
});

test('未发生本地变化时，服务端更新和删除覆盖过期缓存', () => {
  const old = message('m', [part('p', '旧内容')]);
  const removed = message('removed', []);
  const fresh = message('m', [part('p', '服务端新内容')]);
  assert.deepEqual(reconcileSessionMessages([fresh], [old, removed], [old, removed]), [fresh]);
});

test('请求期间的新增、修改和删除不会被快照覆盖', () => {
  const oldPart = part('p', '旧内容');
  const old = message('m', [oldPart, part('remove-part', '删除')]);
  const removed = message('remove-message', []);
  const live = { info: old.info, parts: [{ ...oldPart, text: '事件新内容' }, part('new-part', '新增')] };
  const added = message('new-message', [part('new', '新消息')]);
  const snapshot = [message('m', [part('p', '快照内容'), part('remove-part', '删除'), part('server-part', '服务端新增')]), removed];
  const result = reconcileSessionMessages(snapshot, [old, removed], [live, added]);
  assert.deepEqual(result.map((item) => item.info.id), ['m', 'new-message']);
  assert.deepEqual(result[0].parts.map((item) => [item.id, item.text]), [
    ['p', '事件新内容'], ['server-part', '服务端新增'], ['new-part', '新增'],
  ]);
});

test('请求期间未修改的字段使用服务器最新值', () => {
  const original = part('p', '旧内容');
  const baseline = message('m', [original], { agent: '旧' });
  const current = { ...baseline, parts: [original, part('new', '新增')] };
  const snapshot = message('m', [part('p', '服务器内容')], { agent: '新' });
  const [result] = reconcileSessionMessages([snapshot], [baseline], [current]);
  assert.equal(result.info.agent, '新');
  assert.equal(result.parts[0].text, '服务器内容');
});
