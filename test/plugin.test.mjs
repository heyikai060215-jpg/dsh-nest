import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';

/** 关系表落在 $DSH_HOME 下；测试里指到一个临时目录。 */
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nest-home-'));
process.env.DSH_HOME = TEST_HOME;
after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * 重写关系表（每个用例开始前调一次，避免互相污染）。
 * @param {Record<string,string>} parents 子 → 父
 */
function resetRelations(parents = {}) {
  const dir = path.join(TEST_HOME, 'dsh-nest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relations.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), parents }, null, 2), 'utf8');
}

beforeEach(() => {
  resetRelations();
});

/**
 * 造一个假 agent：followup 往日志里塞一条 user/message，再（可延迟地）回一条
 * assistant/message；whenIdle 等到那条回复落地才 resolve。
 * @param {{id: string, events?: Array<object>, reply?: string, delayMs?: number, neverIdle?: boolean}} options 参数
 * @returns {object} 假 agent
 */
function makeFakeAgent(options) {
  const log = [...(options.events ?? [])];
  const idleWaiters = [];
  let busy = false;
  const session = {
    header: { id: options.id },
    get seq() {
      return log.length;
    },
    snapshotEvents: () => log,
  };
  const agent = {
    id: options.id,
    session,
    status: 'idle',
    messages: [],
    followup(message) {
      agent.messages.push(message);
      busy = true;
      agent.status = 'running';
      log.push({ type: 'user/message', seq: log.length, time: 1, data: { message } });
      if (options.neverIdle === true) return;
      setTimeout(() => {
        log.push(options.error === undefined
          ? {
            type: 'assistant/message',
            seq: log.length,
            time: 2,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: options.reply ?? '好的' }] } },
          }
          : {
            type: 'turn/end',
            seq: log.length,
            time: 2,
            data: { reason: { kind: 'error', error: { message: options.error } } },
          });
        busy = false;
        agent.status = 'idle';
        for (const wake of idleWaiters.splice(0)) wake();
      }, options.delayMs ?? 0);
    },
    whenIdle() {
      if (!busy) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
  return agent;
}

/**
 * 一份够用的假 Context：tools / agents / sessionQuery / effect / logger。
 * @param {{sessions?: Array<object>, live?: Map<string, object>, cold?: Map<string, object>}} options 夹具
 * @returns {object} 夹具
 */
function makeHarness(options = {}) {
  const sessions = options.sessions ?? [];
  const live = options.live ?? new Map();
  const cold = options.cold ?? new Map();
  const tools = new Map();
  const effects = [];
  const resumes = [];
  const resumeOptions = [];
  const disposals = [];
  const byId = new Map(sessions.map((session) => [session.header.id, session]));
  const records = sessions.map((session) => ({ header: session.header, live: live.has(session.header.id), persisted: true }));

  const services = {
    sessionQuery: {
      async listSessions() {
        return records;
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => {
          const session = byId.get(id);
          return {
            sessionId: id,
            status: 'fulfilled',
            value: {
              session: session.header,
              ...(session.title === undefined
                ? {}
                : { title: { title: session.title, messageSeqs: [0], source: { kind: 'provider' }, eventSeq: 1, updatedAt: 1 } }),
            },
          };
        });
      },
      async readSession(id) {
        const session = byId.get(id) ?? cold.get(id);
        if (session === undefined) throw new Error(`session ${id} not found`);
        return { session: session.header ?? { id }, inheritedEventCount: 0, events: session.events ?? [] };
      },
    },
  };

  const routes = [];
  services.webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: services.webServer,
    get(name) {
      return services[name];
    },
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback(ctx);
      return { dispose() {} };
    },
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    agents: {
      get(id) {
        return live.get(id);
      },
      async resume(options) {
        const resumeSessionId = options.resumeSessionId;
        if (live.has(resumeSessionId)) throw new Error(`session "${resumeSessionId}" already exists`);
        const spec = cold.get(resumeSessionId);
        if (spec === undefined) throw new Error(`session "${resumeSessionId}" not found`);
        const agent = makeFakeAgent({ id: resumeSessionId, ...spec });
        live.set(resumeSessionId, agent);
        resumes.push(resumeSessionId);
        resumeOptions.push(options);
        return {
          agent,
          dispose: async () => {
            disposals.push(resumeSessionId);
            live.delete(resumeSessionId);
          },
        };
      },
    },
  };
  return { ctx, tools, effects, live, cold, resumes, resumeOptions, disposals, services, routes };
}

const PARENT = { id: 'parent-1', session: { header: { id: 'parent-1' } } };

const OTHER = {
  header: { id: 'session-other', createdAt: 1700000000000, cwd: 'D:/work' },
  title: '别处的活',
};

test('apply 只挂列表与访问两个工具；卸载时全部撤掉', () => {
  const harness = makeHarness({ sessions: [OTHER] });
  apply(harness.ctx, { enabled: true });
  assert.deepEqual([...harness.tools.keys()].sort(), ['nest_ask_session', 'nest_list_sessions']);

  for (const dispose of harness.effects) dispose();
  assert.equal(harness.tools.size, 0);
});

test('enabled=false 时什么都不挂', () => {
  const harness = makeHarness();
  apply(harness.ctx, { enabled: false });
  assert.equal(harness.tools.size, 0);
  assert.equal(harness.effects.length, 0);
});

test('nest_list_sessions 给模型一份可选的会话清单，并标出当前会话', async () => {
  const harness = makeHarness({
    sessions: [{ header: { id: 'session-a', createdAt: 1793169275866 }, title: '帮我写插件' }, OTHER],
  });
  apply(harness.ctx, { enabled: true });
  const text = await harness.tools.get('nest_list_sessions').execute({}, { agent: PARENT });
  assert.match(text, /session-a/);
  assert.match(text, /帮我写插件/);
  assert.match(text, /nest_ask_session/);
});

test('访问没开着的会话：临时唤醒它、投进去、等回答、然后还回去', async () => {
  const harness = makeHarness({
    sessions: [OTHER],
    cold: new Map([['session-other', { reply: '我这边已经弄完了' }]]),
  });
  apply(harness.ctx, { enabled: true });

  const result = await harness.tools.get('nest_ask_session').execute(
    { session: '别处的活', message: '你那边进展如何？' },
    { agent: PARENT },
  );

  assert.equal(result.status, 'idle');
  assert.equal(result.reply, '我这边已经弄完了');
  assert.equal(result.sessionId, 'session-other');
  assert.deepEqual(harness.resumes, ['session-other']);
  assert.deepEqual(harness.disposals, ['session-other']);
  // 问完就还回去了：那个会话不再被我们占着
  assert.equal(harness.live.has('session-other'), false);
});

test('投进去的消息带 agent-message 来源，并写明是谁在问', async () => {
  const harness = makeHarness({
    sessions: [OTHER],
    cold: new Map([['session-other', { reply: '收到' }]]),
  });
  apply(harness.ctx, { enabled: true });

  // 用一个在追问后不立刻被放回去的路径观察投递内容：neverIdle 让它一直跑，消息留在活 agent 上
  harness.cold.set('session-other', { reply: '收到', neverIdle: true });
  const pending = harness.tools.get('nest_ask_session').execute(
    { session: 'session-other', message: '帮我看一下那个 bug', wait_seconds: 0.05 },
    { agent: PARENT },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const delivered = harness.live.get('session-other').messages[0];
  await pending;

  assert.equal(delivered.source.kind, 'agent-message');
  assert.equal(delivered.source.form, 'relay');
  assert.equal(delivered.source.senderSessionId, 'parent-1');
  assert.match(delivered.content[0].text, /Agent parent-1 sent a message/);
  assert.equal(delivered.content[1].text, '帮我看一下那个 bug');
});

test('会话已经开着就复用，不 resume 也不收回去', async () => {
  const liveAgent = makeFakeAgent({ id: 'session-other', reply: '我一直开着呢' });
  const harness = makeHarness({
    sessions: [OTHER],
    live: new Map([['session-other', liveAgent]]),
  });
  apply(harness.ctx, { enabled: true });

  const result = await harness.tools.get('nest_ask_session').execute(
    { session: 'session-other', message: '在吗' },
    { agent: PARENT },
  );
  assert.equal(result.reply, '我一直开着呢');
  assert.deepEqual(harness.resumes, []);
  assert.deepEqual(harness.disposals, []);
});

test('超时就返回 running，并把它留着跑完再还回去', async () => {
  const harness = makeHarness({
    sessions: [OTHER],
    cold: new Map([['session-other', { reply: '慢活', neverIdle: true }]]),
  });
  apply(harness.ctx, { enabled: true });

  const result = await harness.tools.get('nest_ask_session').execute(
    { session: 'session-other', message: '慢慢做', wait_seconds: 0.05 },
    { agent: PARENT },
  );
  assert.equal(result.status, 'running');
  assert.equal(result.reply, '');
  assert.deepEqual(harness.disposals, []); // 还没跑完，不掐断它
  assert.equal(harness.live.has('session-other'), true);

  for (const dispose of harness.effects) dispose();
  assert.deepEqual(harness.disposals, ['session-other']);
});

test('不能访问当前会话自己', async () => {
  const harness = makeHarness({ sessions: [{ header: { id: 'parent-1', createdAt: 1 }, title: '我自己' }] });
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ session: 'parent-1', message: '在吗' }, { agent: PARENT }),
    /不能访问当前会话自己/,
  );
});

test('不能访问当前会话的祖先（会互相等成死锁）', async () => {
  const harness = makeHarness({
    sessions: [
      { header: { id: 'grandparent', createdAt: 1 }, title: '爷爷' },
      { header: { id: 'parent-1', createdAt: 2, parentSession: 'grandparent' }, title: '爸爸' },
    ],
  });
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ session: '爷爷', message: '在吗' }, { agent: PARENT }),
    /死锁/,
  );
});

test('对不上多个会话时报歧义，并列出候选', async () => {
  const harness = makeHarness({
    sessions: [
      { header: { id: 'session-a1', createdAt: 1 }, title: '帮我写插件' },
      { header: { id: 'session-a2', createdAt: 2 }, title: '帮我改插件' },
    ],
  });
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ session: '帮我', message: 'x' }, { agent: PARENT }),
    (error) => {
      assert.match(error.message, /不止一个/);
      assert.match(error.message, /session-a1/);
      assert.match(error.message, /session-a2/);
      return true;
    },
  );
});

test('找不到会话时给出可操作的提示', async () => {
  const harness = makeHarness({ sessions: [OTHER] });
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ session: '不存在', message: 'x' }, { agent: PARENT }),
    /没找到和「不存在」对得上的会话/,
  );
});

test('唤不醒会话时把原因带出来', async () => {
  const harness = makeHarness({ sessions: [OTHER] }); // cold 里没有它 → resume 抛
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ session: 'session-other', message: 'x' }, { agent: PARENT }),
    /唤不醒会话 session-other/,
  );
});

test('同一目标会话的并发访问排队，不会两个一起 resume', async () => {
  const harness = makeHarness({
    sessions: [OTHER],
    cold: new Map([['session-other', { reply: '一次一个', delayMs: 20 }]]),
  });
  apply(harness.ctx, { enabled: true });
  const tool = harness.tools.get('nest_ask_session');
  const results = await Promise.all([
    tool.execute({ session: 'session-other', message: '一' }, { agent: PARENT }),
    tool.execute({ session: 'session-other', message: '二' }, { agent: PARENT }),
  ]);
  assert.equal(harness.resumes.length, 2);
  assert.deepEqual(results.map((result) => result.status), ['idle', 'idle']);
  assert.equal(harness.live.has('session-other'), false);
});

test('省略 session 时，就问面板里挂给当前会话的那个子会话', async () => {
  resetRelations({ 'session-other': 'parent-1' });
  const harness = makeHarness({
    sessions: [OTHER],
    cold: new Map([['session-other', { reply: '我是你的子会话' }]]),
  });
  apply(harness.ctx, { enabled: true });

  const result = await harness.tools.get('nest_ask_session').execute(
    { message: '在吗' },
    { agent: PARENT },
  );
  assert.equal(result.sessionId, 'session-other');
  assert.equal(result.reply, '我是你的子会话');
  assert.deepEqual(harness.resumes, ['session-other']);
});

test('挂了多个子会话时，省略 session 会要求点名', async () => {
  resetRelations({ 'session-other': 'parent-1', 'session-third': 'parent-1' });
  const harness = makeHarness({
    sessions: [OTHER, { header: { id: 'session-third', createdAt: 1 }, title: '第三个' }],
  });
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ message: '在吗' }, { agent: PARENT }),
    (error) => {
      assert.match(error.message, /2 个子会话/);
      assert.match(error.message, /session-other/);
      assert.match(error.message, /session-third/);
      return true;
    },
  );
});

test('没有子会话又省略 session 时，指去面板里设一个', async () => {
  const harness = makeHarness({ sessions: [OTHER] });
  apply(harness.ctx, { enabled: true });
  await assert.rejects(
    () => harness.tools.get('nest_ask_session').execute({ message: '在吗' }, { agent: PARENT }),
    /设置 → 会话从属/,
  );
});

test('nest_list_sessions 标出关系表里的上级和下级', async () => {
  resetRelations({ 'session-other': 'parent-1' });
  const harness = makeHarness({ sessions: [OTHER] });
  apply(harness.ctx, { enabled: true });
  const text = await harness.tools.get('nest_list_sessions').execute({}, { agent: PARENT });
  assert.match(text, /归在「parent-1」下/);
});

test('唤醒时带上目标会话最后一次请求的路由（提示词里的 {{model}} 才有值）', async () => {
  const target = {
    header: { id: 'session-other', createdAt: 1 },
    title: '带路由的会话',
    events: [
      { type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' } } } },
    ],
  };
  const harness = makeHarness({
    sessions: [target],
    cold: new Map([['session-other', { reply: '好' }]]),
  });
  apply(harness.ctx, { enabled: true });
  await harness.tools.get('nest_ask_session').execute({ session: 'session-other', message: '在吗' }, { agent: PARENT });
  assert.deepEqual(harness.resumeOptions[0].agentOptions, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  });
});

test('它这一轮报错时说清楚原因，而不是回一个空字符串', async () => {
  const harness = makeHarness({
    sessions: [OTHER],
    cold: new Map([['session-other', { error: 'prompt variable "{{model}}" has no value' }]]),
  });
  apply(harness.ctx, { enabled: true });
  const result = await harness.tools.get('nest_ask_session').execute(
    { session: 'session-other', message: '在吗' },
    { agent: PARENT },
  );
  assert.equal(result.status, 'error');
  assert.match(result.reply, /has no value/);
});


