import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ancestorIds,
  assistantTextAfter,
  formatSessionList,
  normalize,
  resolveTarget,
  turnFailureAfter,
} from '../lib/core.mjs';

/**
 * 造一条助手消息事件。
 * @param {number} seq 序号
 * @param {Array<object>} blocks content 块
 * @returns {object} 事件
 */
function assistantEvent(seq, blocks) {
  return { type: 'assistant/message', seq, time: 1700000000000 + seq, data: { message: { role: 'assistant', content: blocks } } };
}

test('normalize 抹平全角空格、连续空白与大小写', () => {
  assert.equal(normalize('  Hello\u3000  World  '), 'hello world');
  assert.equal(normalize(undefined), '');
});

test('resolveTarget：id 精确 > id 片段唯一 > 标题片段唯一 > 歧义 > 找不到', () => {
  const sessions = [
    { header: { id: 'session-aaa' }, title: '帮我把插件写完' },
    { header: { id: 'session-bbb' }, title: '帮我看看这个 bug' },
    { header: { id: 'session-ccc' }, title: '无关的会话' },
  ];
  assert.equal(resolveTarget(sessions, 'session-AAA').kind, 'exact');
  assert.equal(resolveTarget(sessions, 'session-aa').session.header.id, 'session-aaa');
  assert.equal(resolveTarget(sessions, '无关').session.header.id, 'session-ccc');
  assert.equal(resolveTarget(sessions, '帮我把插件').session.header.id, 'session-aaa');
  const ambiguous = resolveTarget(sessions, '帮我');
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.equal(ambiguous.matches.length, 2);
  assert.equal(resolveTarget(sessions, '完全不存在的').kind, 'none');
  assert.equal(resolveTarget(sessions, '   ').kind, 'none');
});

test('resolveTarget 的 id 优先于标题：id 片段命中两个时报歧义，不再退到标题', () => {
  const sessions = [
    { header: { id: 'session-aa1' }, title: 'x' },
    { header: { id: 'session-aa2' }, title: 'y' },
  ];
  assert.equal(resolveTarget(sessions, 'aa').kind, 'ambiguous');
});

test('ancestorIds 顺着 parentSession 往上走，且不会因为环卡死', () => {
  const byId = new Map([
    ['root', { header: { id: 'root' } }],
    ['mid', { header: { id: 'mid', parentSession: 'root' } }],
    ['leaf', { header: { id: 'leaf', parentSession: 'mid' } }],
    ['loop-a', { header: { id: 'loop-a', parentSession: 'loop-b' } }],
    ['loop-b', { header: { id: 'loop-b', parentSession: 'loop-a' } }],
  ]);
  assert.deepEqual(ancestorIds(byId, 'leaf'), ['mid', 'root']);
  assert.deepEqual(ancestorIds(byId, 'root'), []);
  assert.equal(ancestorIds(byId, 'loop-a').length, 1);
});

test('assistantTextAfter 只取 afterSeq 之后最后一条带文字的助手消息', () => {
  const events = [
    assistantEvent(0, [{ type: 'text', text: '早先的回答' }]),
    assistantEvent(1, [{ type: 'reasoning', text: '想一想' }]),
    assistantEvent(2, [{ type: 'reasoning', text: '再想' }, { type: 'text', text: '这一轮的回答' }]),
  ];
  assert.equal(assistantTextAfter(events, 1), '这一轮的回答');
  assert.equal(assistantTextAfter(events, 2), undefined);
  assert.equal(assistantTextAfter(events, -1), '这一轮的回答');
});

test('assistantTextAfter 跳过只有工具调用的助手消息，往前找真正的文字', () => {
  const events = [
    assistantEvent(0, [{ type: 'text', text: '先看一眼' }]),
    assistantEvent(1, [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }]),
  ];
  assert.equal(assistantTextAfter(events, -1), '先看一眼');
});

test('assistantTextAfter 容忍非数组 / 缺字段', () => {
  assert.equal(assistantTextAfter(undefined, -1), undefined);
  assert.equal(assistantTextAfter([{ type: 'assistant/message', seq: 0 }], -1), undefined);
});

test('turnFailureAfter 把失败原因捞出来，正常结束不吭声', () => {
  const ok = [{ type: 'turn/end', seq: 0, time: 1, data: { reason: { kind: 'completed' } } }];
  assert.equal(turnFailureAfter(ok, -1), undefined);
  assert.equal(turnFailureAfter([], -1), undefined);
  assert.equal(turnFailureAfter(undefined, -1), undefined);

  const failed = [{ type: 'turn/end', seq: 0, time: 1, data: { reason: { kind: 'error', error: { message: '组装缺 {{model}}' } } } }];
  assert.match(turnFailureAfter(failed, -1), /组装缺/);

  const aborted = [{ type: 'turn/end', seq: 0, time: 1, data: { reason: { kind: 'aborted' } } }];
  assert.match(turnFailureAfter(aborted, -1), /中止/);

  // 只看 afterSeq 之后的那一轮
  assert.equal(turnFailureAfter(failed, 0), undefined);
});

test('formatSessionList 标出当前会话与开着的会话，并按 limit 截断', () => {
  const sessions = [
    { header: { id: 'session-1', createdAt: 1793169275866, origin: 'subagent', parentSession: 'session-0' }, title: '接过来的活', live: true },
    { header: { id: 'session-2', createdAt: 1793169275866 }, title: '当前这个' },
  ];
  const { text, shown } = formatSessionList(sessions, { currentId: 'session-2', limit: 5 });
  assert.equal(shown.length, 2);
  assert.match(text, /session-1/);
  assert.match(text, /子会话/);
  assert.match(text, /开着/);
  assert.match(text, /当前会话/);
  assert.match(text, /nest_ask_session/);
  assert.equal(formatSessionList(sessions, { limit: 1 }).shown.length, 1);
  assert.match(formatSessionList([], {}).text, /还没有别的会话/);
});

test('formatSessionList 把多个上级和下级都标出来', () => {
  const sessions = [
    { header: { id: 'kid', createdAt: 2 }, title: '子会话' },
    { header: { id: 'mom-a', createdAt: 1 }, title: '妈 A' },
    { header: { id: 'mom-b', createdAt: 1 }, title: '妈 B' },
  ];
  const { text } = formatSessionList(sessions, {
    parents: { kid: ['mom-a', 'mom-b'] },
    labelOf: (id) => (id === 'mom-a' ? '妈 A' : id === 'mom-b' ? '妈 B' : id),
  });
  assert.match(text, /归在「妈 A」「妈 B」下/);
  assert.match(text, /1 个下级/);
});
