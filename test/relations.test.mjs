import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRelationsStore, descendantIds, normalizeRelations, wouldCycle } from '../lib/relations.mjs';
import { makeRoutes } from '../lib/routes.mjs';

/** 一个临时目录，用完删掉。 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nest-test-'));
}

test('关系表：一个子会话可以挂多个上级，加/去/清都落盘', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'relations.json');
  const store = createRelationsStore({ file });
  assert.deepEqual(store.snapshot().parents, {});

  store.addParent('child-b', 'parent-a');
  store.addParent('child-b', 'parent-c');
  store.addParent('child-b', 'parent-a'); // 重复加是幂等的
  assert.deepEqual(store.snapshot().parents['child-b'], ['parent-a', 'parent-c']);
  assert.equal(fs.existsSync(file), true);

  const again = createRelationsStore({ file });
  assert.deepEqual(again.snapshot().parents['child-b'], ['parent-a', 'parent-c']);

  again.removeParent('child-b', 'parent-a');
  assert.deepEqual(again.snapshot().parents['child-b'], ['parent-c']);

  again.removeParent('child-b', 'parent-c');
  assert.deepEqual(again.snapshot().parents, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关系表：setParents 整组替换，空数组等于清空', () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.addParent('b', 'a');
  store.setParents('b', ['x', 'y']);
  assert.deepEqual(store.snapshot().parents['b'], ['x', 'y']);
  store.setParents('b', []);
  assert.deepEqual(store.snapshot().parents, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关系表：v1 的单字符串上级会被读成数组', () => {
  const dir = tempDir();
  const file = path.join(dir, 'relations.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, parents: { b: 'a' } }), 'utf8');
  const store = createRelationsStore({ file });
  assert.deepEqual(store.snapshot().parents, { b: ['a'] });
  store.addParent('b', 'c');
  assert.deepEqual(store.snapshot().parents['b'], ['a', 'c']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
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

test('关系表：不能挂到自己下面，也不能绕成环（多上级下也一样）', () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  assert.throws(() => store.addParent('a', 'a'), /自己/);
  store.addParent('b', 'a');
  store.addParent('c', 'b');
  assert.throws(() => store.addParent('a', 'c'), /环/);
  // b 有两个上级也不影响判环
  store.addParent('c', 'zzz');
  assert.throws(() => store.addParent('a', 'c'), /环/);
  // 给已经有上级的子会话再加一个无关上级是允许的
  store.addParent('b', 'other');
  assert.deepEqual(store.snapshot().parents['b'], ['a', 'other']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeRelations 丢掉空值、自环和重复项', () => {
  const normalized = normalizeRelations({
    parents: {
      a: ['b', 'b', 'a', '', null],
      c: 'd',
      e: [],
    },
  });
  assert.deepEqual(normalized.parents, { a: ['b'], c: ['d'] });
  assert.equal(normalized.version, 2);
});

test('descendantIds 按多上级的图算下级', () => {
  const parents = { b: ['a'], c: ['a', 'b'], d: ['other'] };
  assert.deepEqual([...descendantIds(parents, 'a')].sort(), ['b', 'c']);
  assert.deepEqual([...descendantIds(parents, 'd')], []);
});

test('wouldCycle 按图判，不会因为表里别处有个环就卡死', () => {
  const parents = { b: ['a'], c: ['b'] };
  assert.equal(wouldCycle(parents, 'a', 'c'), true);
  assert.equal(wouldCycle(parents, 'd', 'c'), false);
  // 表里别处已经坏成一个环：往无关的会话上挂不该被牵连，也不能死循环
  assert.equal(wouldCycle({ x: ['y'], y: ['x'] }, 'z', 'x'), false);
  assert.equal(wouldCycle({ x: ['y'], y: ['x'] }, 'y', 'x'), true);
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
  { header: { id: 'session-gamma', createdAt: 1793169274000, cwd: 'D:/work' }, title: '发布插件' },
];

test('GET 给面板：会话 + 每个会话的上级列表', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.addParent('session-beta', 'session-alpha');
  store.addParent('session-beta', 'session-gamma');
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: { panelTitleScan: 50 } });
  const res = fakeResponse();
  await route.handler(fakeRequest(), res);
  assert.equal(res.state.status, 200);
  const payload = JSON.parse(res.state.body);
  assert.equal(payload.sessions.length, 3);
  const beta = payload.sessions.find((session) => session.id === 'session-beta');
  assert.deepEqual(beta.parents, ['session-alpha', 'session-gamma']);
  assert.equal(beta.title, '测试插件');
  assert.deepEqual(payload.relations['session-beta'], ['session-alpha', 'session-gamma']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 加一条关系：另一个母会话也能访问同一个子会话', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });

  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parent: 'session-alpha' } }), fakeResponse());
  const res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parent: 'session-gamma' } }), res);
  assert.equal(res.state.status, 200);
  assert.deepEqual(JSON.parse(res.state.body).relations['session-beta'], ['session-alpha', 'session-gamma']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 去掉一条关系（action: remove）', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.addParent('session-beta', 'session-alpha');
  store.addParent('session-beta', 'session-gamma');
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });
  const res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parent: 'session-alpha', action: 'remove' } }), res);
  assert.equal(res.state.status, 200);
  assert.deepEqual(JSON.parse(res.state.body).relations['session-beta'], ['session-gamma']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 整组替换（parents）和清空（parent: null）', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  const [route] = makeRoutes({ ctx: fakeCtx(SESSIONS), store, options: {} });

  let res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parents: ['session-alpha', 'session-gamma'] } }), res);
  assert.deepEqual(JSON.parse(res.state.body).relations['session-beta'], ['session-alpha', 'session-gamma']);

  res = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', body: { child: 'session-beta', parent: null } }), res);
  assert.equal(res.state.status, 200);
  assert.deepEqual(JSON.parse(res.state.body).relations, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST 拒绝不存在的会话 / 缺字段 / 成环', async () => {
  const dir = tempDir();
  const store = createRelationsStore({ file: path.join(dir, 'relations.json') });
  store.addParent('session-beta', 'session-alpha');
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
