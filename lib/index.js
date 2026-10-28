/**
 * 巢 · dsh-nest —— 让一个会话像「一个 agent」那样被另一个会话访问。
 *
 * 两半：
 *   1. 设置里的「会话从属」面板（client.js + /api/dsh-nest/relations）——
 *      用下拉框给会话挑上级，谁也不用手打会话 id；
 *   2. `nest_ask_session` —— 原地唤醒目标会话、投一句话、等回答。
 *      省略 `session` 时就直接问「我的子会话」（面板里设的那些）。
 *
 * 关系表是**逻辑**的：只决定谁能访问谁，绝不动会话自己的日志/header。
 *
 * @module dsh-nest
 */
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import {
  ancestorIds,
  assistantTextAfter,
  formatSessionList,
  normalize,
  resolveTarget,
  turnFailureAfter,
} from './core.mjs';
import { loadCatalogue, sessionQueryOf } from './sessions.mjs';
import { createRelationsStore } from './relations.mjs';
import { makeRoutes } from './routes.mjs';

const name = 'nest';
const inject = ['tools', 'agents'];

const TOOL_LIST = 'nest_list_sessions';
const TOOL_ASK = 'nest_ask_session';

const Config = z.object({
  enabled: z.boolean().default(true),
  /** 列会话时最多给模型看多少条。 */
  maxListed: z.number().default(25),
  /** 为了按标题搜，最多读多少条会话的标题（每条要读一遍日志，太大就慢）。 */
  titleScan: z.number().default(60),
  /** 等对方回话最多等多少秒；超时就先返回「还在跑」。 */
  askTimeoutSeconds: z.number().default(180),
  /** 面板里一次最多列多少条会话（也是读标题的上限）。 */
  panelTitleScan: z.number().default(200),
});

/** DSH 家目录：关系表放这儿，别塞进 node_modules。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 同一目标会话上的访问排队执行，避免两个工具调用同时去 resume 同一个会话。 */
function createSerializer() {
  const tails = new Map();
  return function serialized(key, task) {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    tails.set(key, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  };
}

/**
 * 等对方 idle：正常结束、超时、被取消都返回，不抛。
 * @param {{whenIdle: () => Promise<void>}} agent 目标 agent
 * @param {number} waitMs 最多等多久（毫秒）
 * @param {AbortSignal|undefined} signal 调用方取消信号
 * @returns {Promise<boolean>} 是否在超时前跑完
 */
function waitForIdle(agent, waitMs, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, waitMs));
    const onAbort = () => finish(false);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => agent.whenIdle())
      .then(() => finish(true), () => finish(true));
  });
}

const apply = (ctx, config) => {
  const options = {
    enabled: true,
    maxListed: 25,
    titleScan: 60,
    askTimeoutSeconds: 180,
    panelTitleScan: 200,
    ...(config ?? {}),
  };
  if (options.enabled === false) return undefined;

  const store = createRelationsStore({ file: path.join(dshHome(), 'dsh-nest', 'relations.json') });

  /** 我们自己 resume 出来、还没还回去的 handle（按会话 id）。 */
  const owned = new Map();
  const serialized = createSerializer();

  ctx.effect(() => () => {
    for (const handle of owned.values()) {
      void Promise.resolve(handle.dispose()).catch(() => undefined);
    }
    owned.clear();
  }, 'nest: release owned agents');

  // 面板接口（没有 webServer 的组合里就跳过，工具照常能用）
  ctx.inject(['webServer'], (webCtx) => {
    const routes = makeRoutes({ ctx: webCtx, store, options });
    routes.push({
      kind: 'exact',
      path: '/api/dsh-nest/client-status',
      handler: (req, res) => {
        const remote = req.socket?.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'forbidden: loopback-only' }));
          return;
        }
        const modules = webCtx.get('clientModules');
        const probe = String(req.url ?? '').includes('probe=1');
        const reset = String(req.url ?? '').includes('reset=1');
        const errors = [];
        if (modules !== undefined && (probe || reset)) {
          try {
            // 首次加载时若 package.json 还没写 dsh.client，缓存里会留下一个 null，
            // 之后就不再重新识别；这个开关把缓存清掉、强制重新识别一次。
            if (reset) modules.pkgMeta?.clear();
            modules.dirty?.add('dsh-nest');
            modules.flush?.((error) => errors.push(String(error?.message ?? error)));
          } catch (error) {
            errors.push(String(error));
          }
        }
        const graph = modules?.graph?.();
        const rows = graph?.entries ?? [];
        const row = rows.find((entry) => entry.id === 'dsh-nest');
        const payload = {
          hasService: modules !== undefined,
          present: row !== undefined,
          clientPath: modules?.clientPath?.('dsh-nest') ?? null,
          bundle: row?.url ?? null,
          rows: rows.length,
          errors,
        };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      },
    });
    webCtx.effect(() => {
      const disposers = routes.map((route) => webCtx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'nest: panel routes');
  });

  /**
   * 读目标会话最后一次请求用的路由，用来在 resume 时显式告诉宿主模型是谁。
   * 有些会话（比如本身是子智能体的）被当独立会话唤醒时，提示词组装需要 `{{model}}`，
   * 不给路由它就没值，第一轮会直接报 UNKNOWN。
   * @param {string} targetId 目标会话
   * @param {AbortSignal|undefined} signal 取消信号
   * @returns {Promise<{provider?: string, model?: string, reasoningEffort?: string} | undefined>} 路由
   */
  async function routeOf(targetId, signal) {
    try {
      const query = sessionQueryOf(ctx);
      const loaded = await query.readSession(targetId);
      for (let index = loaded.events.length - 1; index >= 0; index -= 1) {
        const event = loaded.events[index];
        if (event?.type !== 'request/header') continue;
        const config = event?.data?.header?.config;
        if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return undefined;
        return {
          provider: config.provider,
          model: config.model,
          ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
        };
      }
    } catch (error) {
      ctx.logger?.warn(`nest: 读 ${targetId} 的路由失败（照旧唤醒）：${String(error)}`);
    }
    signal?.throwIfAborted?.();
    return undefined;
  }

  /**
   * 等它真的开始跑（seq 前进或状态变 running）。刚投完消息时 agent 可能还躺在 idle 上，
   * 直接 whenIdle() 会立刻返回、拿到一个空回答。
   * @param {object} agent 目标 agent
   * @param {number} before 投递前的 seq
   * @param {number} waitMs 最多等多久
   * @returns {Promise<boolean>} 是否观察到它开工
   */
  async function waitForStart(agent, before, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (agent.session.seq > before || agent.status === 'running') return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  /**
   * 访问一次：唤醒（或复用）目标会话、投一句话、等回答。
   * @param {object} parent 发起方 agent
   * @param {string} targetId 目标会话 id
   * @param {string} text 要说的话
   * @param {number} waitMs 最多等多久
   * @param {AbortSignal|undefined} signal 调用方取消信号
   * @returns {Promise<{finished: boolean, reply: string | undefined, failure: string | undefined, elapsed: number}>}
   */
  async function askOnce(parent, targetId, text, waitMs, signal) {
    let handle;
    let agent = ctx.agents.get(targetId);
    if (agent === undefined) {
      const route = await routeOf(targetId, signal);
      try {
        handle = await ctx.agents.resume({
          resumeSessionId: targetId,
          ...(route === undefined ? {} : { agentOptions: route }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw new Error(`唤不醒会话 ${targetId}（可能它正在别的窗口里开着，或者日志读不出来）：${error instanceof Error ? error.message : String(error)}`);
      }
      agent = handle.agent;
      owned.set(targetId, handle);
    }

    const before = agent.session.seq;
    // 和 DSH 自己的相邻 agent 消息同一种来源标记，对方历史里能看出是谁在问。
    // 这里手搓 UserMessage（id + role + content + source），等价于 dsh-llm 的
    // createUserMessage —— 少一个跨包 import，插件就少一条装不上的理由。
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [
        { type: 'text', text: `Agent ${parent.id} sent a message: ` },
        { type: 'text', text },
      ],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: parent.id },
    });

    const startedAt = Date.now();
    await waitForStart(agent, before, Math.min(5000, waitMs));
    const finished = await waitForIdle(agent, Math.max(0, waitMs - (Date.now() - startedAt)), signal);
    const elapsed = (Date.now() - startedAt) / 1000;
    const events = agent.session.snapshotEvents();
    const reply = assistantTextAfter(events, before);
    const failure = finished && reply === undefined ? turnFailureAfter(events, before) : undefined;

    if (handle !== undefined) {
      if (finished || signal?.aborted === true) {
        owned.delete(targetId);
        await Promise.resolve(handle.dispose()).catch((error) => {
          ctx.logger?.warn(`nest: 释放会话 ${targetId} 失败：${String(error)}`);
        });
      } else {
        // 还在跑：先让它跑完再还回去，别把它的回合掐断。
        void agent.whenIdle().then(
          () => {
            owned.delete(targetId);
            return handle.dispose();
          },
          () => {
            owned.delete(targetId);
            return handle.dispose();
          },
        ).catch(() => undefined);
      }
    }

    return { finished, reply, failure, elapsed };
  }

  const listTool = defineTool({
    name: TOOL_LIST,
    description:
      'List DSH sessions on this machine, newest first, so you can choose one to talk to. '
      + 'Returns each session id, its title, when it was created, whether it is the current session, a subagent session, or open right now, '
      + 'and the logical parent set for it in the Nest panel. '
      + 'Pass `query` to narrow by an id fragment or a title fragment; the match is literal (case and whitespace insensitive). '
      + 'Use this before `nest_ask_session` when you do not already know the exact session id.',
    parameters: {
      query: {
        type: 'string',
        description: 'Optional literal fragment of a session id or title to filter by.',
      },
      limit: {
        type: 'number',
        description: 'How many sessions to show. Defaults to the plugin setting (25).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('nest_list_sessions 需要调用方 agent（exec.agent 是空的）');
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.trunc(args.limit) : Math.trunc(options.maxListed) || 25;
      const catalogue = await loadCatalogue(ctx, { ...options, titleScan: Math.max(options.titleScan, limit * 2) }, exec.signal);
      const needle = normalize(args.query);
      const filtered = needle.length === 0
        ? catalogue.sessions
        : catalogue.sessions.filter((session) => normalize(session.header?.id).includes(needle) || normalize(session.title).includes(needle));
      const { parents } = store.snapshot();
      const labelOf = (id) => catalogue.sessions.find((session) => session.header.id === id)?.title ?? id;
      return formatSessionList(filtered, {
        currentId: parent.session.header.id,
        parents,
        labelOf,
        limit,
        ...(args.query === undefined ? {} : { query: args.query }),
      }).text;
    },
  });

  const askTool = defineTool({
    name: TOOL_ASK,
    description:
      'Talk to another DSH session as if it were an agent: wake it (or reuse it if it is already open), deliver `message` into its inbox, '
      + 'wait for it to go idle, and return its reply. The target session continues in place — its own history grows with this exchange, '
      + 'nothing is copied, and it keeps its own model, tools and working directory. The message is recorded with an agent-message source '
      + 'naming you as the sender. '
      + 'Omit `session` to talk to your own logical child: the Nest settings panel assigns those, and an omission works only when exactly one '
      + 'child is assigned (otherwise the error lists them). '
      + 'If it does not finish within `wait_seconds` you get status "running" instead, and it is left to finish; ask again later to read the answer. '
      + 'You cannot talk to yourself or to one of your ancestors (that would deadlock).',
    parameters: {
      session: {
        type: 'string',
        description: 'Session id, or a literal fragment of its title/id that matches exactly one session. Omit to use your own logical child from the Nest panel.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'What to say to that session. It does not see your conversation, so make the message self-contained.',
      },
      wait_seconds: {
        type: 'number',
        description: 'How long to wait for its answer before returning status "running". Defaults to the plugin setting (180), capped at 900.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          reply: { type: 'string', required: true },
          waitedSeconds: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'idle'
          ? `会话 ${value.sessionId} 回了（${value.waitedSeconds}s）：\n${value.reply}`
          : value.status === 'error'
            ? `会话 ${value.sessionId} 这一轮没答上来（${value.waitedSeconds}s）：${value.reply}`
            : `会话 ${value.sessionId} 还在跑（已等 ${value.waitedSeconds}s），先不等了${value.reply.length > 0 ? `；它目前说到：\n${value.reply}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('nest_ask_session 需要调用方 agent（exec.agent 是空的）');
      const parentId = parent.session.header.id;

      const catalogue = await loadCatalogue(ctx, { ...options, titleScan: Math.max(options.titleScan, 120) }, exec.signal);
      const { parents } = store.snapshot();

      /** 面板里挂给当前会话的下级（一个子会话可以同时挂在多个母会话下面）。 */
      const childIds = Object.keys(parents).filter((child) => (parents[child] ?? []).includes(parentId));

      let targetId;
      let targetTitle;
      if (args.session === undefined || String(args.session).trim().length === 0) {
        if (childIds.length === 0) {
          throw new Error('当前会话在巢面板里还没有子会话：打开「设置 → 会话从属」给某个会话挑一个上级，或者直接传 session');
        }
        if (childIds.length > 1) {
          const lines = childIds
            .map((id) => `- \`${id}\` · ${catalogue.sessions.find((session) => session.header.id === id)?.title ?? '(无标题)'}`)
            .join('\n');
          throw new Error(`当前会话有 ${childIds.length} 个子会话，得点名一个：\n${lines}`);
        }
        targetId = childIds[0];
        targetTitle = catalogue.sessions.find((session) => session.header.id === targetId)?.title;
      } else {
        let resolved = resolveTarget(catalogue.sessions, args.session);
        if (resolved.kind === 'none') {
          // 标题读不到的老会话：至少让 id 完全相等 / id 片段唯一也能命中。
          const byIdOnly = catalogue.records.map((record) => ({ header: record.header }));
          const fallback = resolveTarget(byIdOnly, args.session);
          if (fallback.kind === 'exact' || fallback.kind === 'match') {
            const hit = catalogue.sessions.find((session) => session.header.id === fallback.session.header.id);
            resolved = { kind: fallback.kind, session: hit ?? fallback.session };
          }
        }
        if (resolved.kind === 'none') {
          throw new Error(`没找到和「${args.session}」对得上的会话；先用 ${TOOL_LIST} 看看有哪些（标题要一字不差的一段才认得出来）`);
        }
        if (resolved.kind === 'ambiguous') {
          const lines = resolved.matches.slice(0, 8).map((session) => `- \`${session.header.id}\` · ${session.title ?? '(无标题)'}`);
          throw new Error(`「${args.session}」对上了不止一个会话，换成更精确的 id 或标题片段：\n${lines.join('\n')}`);
        }
        targetId = resolved.session.header.id;
        targetTitle = resolved.session.title;
      }

      if (targetId === parentId) throw new Error('不能访问当前会话自己（会自己等自己）');

      const byId = new Map(catalogue.records.map((session) => [session.header.id, session]));
      if (ancestorIds(byId, parentId).includes(targetId)) {
        throw new Error(`「${targetTitle ?? targetId}」是当前会话的上级（祖先），去问它会互相等成死锁`);
      }

      const configuredWait = Number.isFinite(args.wait_seconds) && args.wait_seconds > 0
        ? args.wait_seconds
        : options.askTimeoutSeconds;
      const waitSeconds = Math.min(Math.max(configuredWait, 0.05), 900);

      const outcome = await serialized(targetId, () => askOnce(
        parent,
        targetId,
        String(args.message),
        waitSeconds * 1000,
        exec.signal,
      ));

      const status = outcome.finished
        ? outcome.failure === undefined ? 'idle' : 'error'
        : 'running';

      return {
        sessionId: targetId,
        status,
        reply: outcome.reply ?? outcome.failure ?? '',
        waitedSeconds: Number(outcome.elapsed.toFixed(1)),
      };
    },
  });

  ctx.effect(() => {
    const disposers = [listTool, askTool].map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'nest: tools');

  return undefined;
};

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
