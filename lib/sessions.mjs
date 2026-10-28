/**
 * 会话目录：列会话 + 认标题。面板和工具共用同一份，保证两边看到的是同一拨候选。
 */

/**
 * 取会话查询服务，没有就给一句能看懂的错。
 * @param {object} ctx 插件上下文
 * @returns {object} sessionQuery 服务
 */
export function sessionQueryOf(ctx) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) {
    throw new Error('巢需要 sessionQuery 服务才能读会话历史（这个 DSH 组合里没挂 @deepseek-ai/dsh-session-query）');
  }
  return query;
}

/**
 * 从 readTitleSnapshots 的一条结果里抠出标题文字。
 *
 * 这个服务返回的 `value.title` 是「标题快照」对象（`{title, messageSeqs, source, ...}`），
 * 不是字符串。两种形状都认。
 * @param {{status?: string, value?: {title?: unknown}}} result 单条标题结果
 * @returns {string | undefined} 标题文字
 */
export function titleOf(result) {
  if (result?.status !== 'fulfilled') return undefined;
  const title = result.value?.title;
  if (typeof title === 'string') return title;
  if (typeof title?.title === 'string') return title.title;
  return undefined;
}

/**
 * 读一批会话记录 + 标题。
 * @param {object} ctx 插件上下文
 * @param {{titleScan?: number}} options 配置
 * @param {AbortSignal|undefined} signal 取消信号
 * @returns {Promise<{records: Array<object>, sessions: Array<{header: object, title?: string, live?: boolean}>}>}
 */
export async function loadCatalogue(ctx, options = {}, signal) {
  const query = sessionQueryOf(ctx);
  const records = await query.listSessions(signal);
  const scanLimit = Number.isFinite(options.titleScan) ? Math.trunc(options.titleScan) : 60;
  const scan = Math.min(records.length, Math.max(1, scanLimit));
  const window = records.slice(0, scan);
  const titles = new Map();
  if (window.length > 0) {
    const results = await query.readTitleSnapshots(window.map((record) => record.header.id), signal);
    for (const result of results) {
      const title = titleOf(result);
      if (title !== undefined) titles.set(result.sessionId, title);
    }
  }
  return {
    records,
    sessions: window.map((record) => ({ ...record, title: titles.get(record.header.id) })),
  };
}
