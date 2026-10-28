import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRelationsStore, descendantIds, wouldCycle } from '../lib/relations.mjs';
import { makeRoutes } from '../lib/routes.mjs';

/** 一个临时目录，用完删掉。 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nest-test-'));
}

test('关系表：设置、清除、落盘、重新读回来', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'relations.json');
  const store = createRelationsStore({ file });
  assert.deepEqual(store.snapshot().parents, {});

  store.setParent('child-b', 'parent-a');
  assert.deepEqual(store.snapshot().parents, { 'child-b': 'parent-a' });
  assert.equal(fs.existsSync(file), true);

  const again = createRelationsStore({ file });
  assert.deepEqual(again.snapshot().parents, { 'child-b': 'parent-a' });

  again.setParent('child-b', null);
  assert.deepEqual(again.snapshot().parents, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关系表：坏 JSON / 空文件都当成空表，不炸', () => {
  const dir = tempDir();
  const file = path.join(dir, 'relations.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.deepEqual(createRelationsStore({ file }).snapshot().parents, {});
  fs.writeFileSync(file, '', 'utf8');
  assert.deepEqual(createRelationsStore({ file }).snapshot().parents, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关系表：不能挂到自己下面，也不能绕成环', () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  assert.throws(() => store.setParent('a', 'a'), /自己/);
  store.setParent('b', 'a');
  store.setParent('c', 'b');
  assert.throws(() => store.setParent('a', 'c'), /环/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wouldCycle 走父链判断，且对已有环不会死循环', () => {
  const parents = { b: 'a', c: 'b' };
  assert.equal(wouldCycle(parents, 'a', 'c'), true);
  assert.equal(wouldCycle(parents, 'd', 'c'), false);
  assert.equal(wouldCycle({ x: 'y', y: 'x' }, 'z', 'x'), true);
});

test('descendantIds 只算真正的下级', () => {
  const parents = { b: 'a', c: 'b', d: 'other' };
  assert.deepEqual([...descendantIds(parents, 'a')].sort(), ['b', 'c']);
  assert.deepEqual([...descendantIds(parents, 'd')], []);
});

/** 造一个假的 req：既能当请求对象，也能被 for await 读 body。 */
function fakeRequest({ method = 'GET', url = '/api/dsh-nest/relations', body, remote = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 造一个假的 res，把写出去的东西收集起来。 */
function fakeResponse() {
  const state = { status: 0, headers: undefined, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(text) {
      state.body = text;
    },
  };
}

/** 一个只有会话目录的假 ctx。 */
function fakeCtx(sessions) {
  const byId = new Map(sessions.map((session) => [session.header.id, session]));
  return {
    get(name) {
      if (name !== 'sessionQuery') return undefined;
      return {
        async listSessions() {
          return sessions.map((session) => ({ header: session.header, live: false, persisted: true }));
        },
        async readTitleSnapshots(ids) {
          return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: byId.get(id).header, title: { title: byId.get(id).title } } }));
        },
      };
    },
  };
}

const SESSIONS = [
  { header: { id: 'session-alpha', createdAt: 1793169275866, cwd: 'D:/work' }, title: '写插件' },
  { header: { id: 'session-beta', createdAt: 1793169275000, cwd: 'D:/work' }, title: '测试插件' },
];

test('GET /api/dsh-nest/relations 给面板：会话 + 每个人现在的上级', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.setParent('session-beta', 'session-alpha');
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: { panelTitleScan: 50 } });
  const res = fakeResponse();
  await route.handler(fakeRequest(), res);
  assert.equal(res.state.status, 200);
  const payload = JSON.parse(res.state.body);
  assert.equal(payload.sessions.length, 2);
  assert.equal(payload.sessions.find((session) => session.id === 'session-beta').parent, 'session-alpha');
  assert.equal(payload.sessions.find((session) => session.id === 'session-beta').title, '测试插件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 改关系：成功返回最新面板数据', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });
  const res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parent: 'session-alpha' } }), res);
  assert.equal(res.state.status, 200);
  const payload = JSON.parse(res.state.body);
  assert.equal(payload.parents['session-beta'], 'session-alpha');
  assert.equal(store.snapshot().parents['session-beta'], 'session-alpha');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 清除关系（parent: null）', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.setParent('session-beta', 'session-alpha');
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });
  const res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parent: null } }), res);
  assert.equal(res.state.status, 200);
  assert.deepEqual(JSON.parse(res.state.body).parents, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 拒绝不存在的会话 / 缺字段 / 成环', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.setParent('session-beta', 'session-alpha');
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });

  let res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'nope', parent: 'session-alpha' } }), res);
  assert.equal(res.state.status, 400);
  assert.match(JSON.parse(res.state.body).error, /没有这个会话/);

  res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta' } }), res);
  assert.equal(res.state.status, 400);

  res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-alpha', parent: 'session-beta' } }), res);
  assert.equal(res.state.status, 400);
  assert.match(JSON.parse(res.state.body).error, /环/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非本机回环地址一律 403', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });
  const res = fakeResponse();
  await route.handler(fakeRequest({ remote: '10.0.0.7' }), res);
  assert.equal(res.state.status, 403);
  fs.rmSync(dir, { recursive: true, force: true });
});
