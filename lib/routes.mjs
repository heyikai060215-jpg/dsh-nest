/**
 * 面板用的 HTTP 接口：列会话 + 读/改「谁归谁管」。
 *
 * 一个子会话可以挂在多个母会话下面，所以一次 POST 可以只是加一条、删一条，
 * 或者把某个子会话的上级整组换掉。
 *
 * 只给本机回环地址用，和 dsh-github 那些插件同一套约定（/api/<id>/...）。
 */
import { loadCatalogue } from './sessions.mjs';

export const API = {
  relations: '/api/dsh-nest/relations',
};

const MAX_BODY = 128 * 1024;

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY) return undefined;
    parts.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把会话目录 + 关系表拼成面板要的那一份数据。
 * @param {object} ctx 插件上下文
 * @param {object} store 关系表
 * @param {object} options 插件配置
 * @param {AbortSignal|undefined} signal 取消信号
 * @returns {Promise<object>} 面板数据
 */
async function panelPayload(ctx, store, options, signal) {
  const catalogue = await loadCatalogue(ctx, { titleScan: options.panelTitleScan ?? 200 }, signal);
  const { parents } = store.snapshot();
  const sessions = catalogue.sessions.map((session) => {
    const header = session.header ?? {};
    return {
      id: header.id,
      title: session.title ?? null,
      createdAt: header.createdAt ?? null,
      cwd: header.cwd ?? null,
      live: session.live === true,
      origin: header.origin ?? null,
      headerParent: header.parentSession ?? null,
      parents: parents[header.id] ?? [],
    };
  });
  return { sessions, relations: parents, updatedAt: store.snapshot().updatedAt ?? null };
}

/**
 * 装面板接口。
 * @param {{ctx: object, store: object, options: object}} dependency 依赖
 * @returns {Array<object>} webServer 路由
 */
export function makeRoutes({ ctx, store, options }) {
  return [
    {
      kind: 'exact',
      path: API.relations,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' });
          return;
        }
        if (req.method === 'GET') {
          try {
            writeJson(res, 200, await panelPayload(ctx, store, options));
          } catch (error) {
            writeJson(res, 500, { error: errorMessage(error) });
          }
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` });
          return;
        }
        const body = await readJson(req);
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const child = typeof body.child === 'string' ? body.child : undefined;
        if (child === undefined) {
          writeJson(res, 400, { error: 'expected { child: string, parent?: string|null, action?: "add"|"remove" } 或 { child, parents: string[] }' });
          return;
        }
        try {
          const catalogue = await loadCatalogue(ctx, { titleScan: 1 }, undefined);
          const known = new Set(catalogue.records.map((record) => record.header.id));
          if (!known.has(child)) throw new Error(`没有这个会话：${child}`);
          const assertKnown = (id) => {
            if (!known.has(id)) throw new Error(`没有这个会话：${id}`);
          };

          let next;
          if (Array.isArray(body.parents)) {
            for (const parent of body.parents) assertKnown(parent);
            next = store.setParents(child, body.parents);
          } else if (body.parent === null) {
            next = store.setParents(child, []);
          } else if (typeof body.parent === 'string') {
            assertKnown(body.parent);
            next = body.action === 'remove'
              ? store.removeParent(child, body.parent)
              : store.addParent(child, body.parent);
          } else {
            writeJson(res, 400, { error: 'expected parent (string | null) or parents (string[])' });
            return;
          }

          writeJson(res, 200, {
            ok: true,
            relations: next.parents,
            updatedAt: next.updatedAt,
            payload: await panelPayload(ctx, store, options),
          });
        } catch (error) {
          writeJson(res, 400, { error: errorMessage(error) });
        }
      },
    },
  ];
}
