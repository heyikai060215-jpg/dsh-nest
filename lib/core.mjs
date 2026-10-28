/**
 * 巢（dsh-nest）的纯函数部分：不碰上下文、不碰服务，方便单独测试。
 *
 * 这里只做四件事：
 *   1. 把会话列表排成给人看的一行行文字；
 *   2. 按 id / 标题片段挑目标会话（唯一匹配才算数）；
 *   3. 算血缘（谁是谁的祖先），防止互相访问绕成等待环；
 *   4. 从会话日志里捞出「这一问之后」的回答文字。
 */

/** 归一化标题/查询串：全角空格、连续空白、大小写都不计较。 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 在会话记录里找目标。
 *
 * 规则依次是：id 完全相等 → id 片段唯一 → 标题片段唯一。任何一步命中多个就报「有歧义」，
 * 让调用方自己挑 —— 替用户猜一个错会话的代价比多问一句大得多。
 *
 * @param {Array<{header: {id: string}, title?: string}>} sessions 会话记录
 * @param {string} query 用户/模型给的 id 或标题片段
 * @returns {{kind: 'exact'|'match', session: object} | {kind: 'none'} | {kind: 'ambiguous', matches: Array}}
 */
export function resolveTarget(sessions, query) {
  const needle = normalize(query);
  if (needle.length === 0) return { kind: 'none' };

  const exact = sessions.find((session) => normalize(session.header?.id) === needle);
  if (exact !== undefined) return { kind: 'exact', session: exact };

  const byId = sessions.filter((session) => normalize(session.header?.id).includes(needle));
  if (byId.length === 1) return { kind: 'match', session: byId[0] };
  if (byId.length > 1) return { kind: 'ambiguous', matches: byId };

  const byTitle = sessions.filter((session) => normalize(session.title).includes(needle));
  if (byTitle.length === 1) return { kind: 'match', session: byTitle[0] };
  if (byTitle.length > 1) return { kind: 'ambiguous', matches: byTitle };
  return { kind: 'none' };
}

/**
 * 沿 `parentSession` 往上走，返回给定会话的全部祖先 id（最近的在前，含环路保护）。
 * 用来拒绝「去问自己的上级」—— 两边互相等会直接卡死。
 *
 * @param {Map<string, {header: {id: string, parentSession?: string}}>} byId 会话索引
 * @param {string} sessionId 起点
 * @returns {string[]} 祖先 id
 */
export function ancestorIds(byId, sessionId) {
  const chain = [];
  const seen = new Set([sessionId]);
  let cursor = byId.get(sessionId)?.header?.parentSession;
  while (typeof cursor === 'string' && !seen.has(cursor)) {
    chain.push(cursor);
    seen.add(cursor);
    cursor = byId.get(cursor)?.header?.parentSession;
  }
  return chain;
}

/**
 * 从会话日志里取「`afterSeq` 之后、最后一条带文字的助手消息」。
 *
 * 一条助手消息里通常混着 reasoning / text / tool-call 三种块。这里只留 text，
 * 并且从后往前找第一条真的有文字的 —— 最后那条如果只有工具调用，就继续往前找。
 *
 * @param {Array<object>} events 会话事件日志
 * @param {number} afterSeq 只认 seq 大于它的消息
 * @returns {string | undefined} 回答文字；没有就 undefined
 */
export function assistantTextAfter(events, afterSeq = -1) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const seq = typeof event?.seq === 'number' ? event.seq : index;
    if (seq <= afterSeq) break;
    if (event?.type !== 'assistant/message') continue;
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * 看 `afterSeq` 之后最后一轮是怎么结束的：失败的原因（有的话）。
 *
 * 被访问的会话可能一开口就报错（比如它自己的提示词组装缺变量）。那种情况下它不会
 * 产出任何回答文字，光返回空字符串等于把错误吞了，所以这里把原因也捞出来。
 *
 * @param {Array<object>} events 会话事件日志
 * @param {number} afterSeq 只认 seq 大于它的事件
 * @returns {string | undefined} 失败原因；正常结束或还没结束就 undefined
 */
export function turnFailureAfter(events, afterSeq = -1) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const seq = typeof event?.seq === 'number' ? event.seq : index;
    if (seq <= afterSeq) break;
    if (event?.type !== 'turn/end') continue;
    const reason = event?.data?.reason;
    if (reason === undefined || reason?.kind === 'completed') return undefined;
    if (reason?.kind === 'error') return reason?.error?.message ?? '它这一轮报错了（没有给出原因）';
    if (reason?.kind === 'max-tokens') return '它这一轮把 token 用完了，话没说完';
    if (reason?.kind === 'refusal') return '它拒绝了这次任务';
    if (reason?.kind === 'aborted') return '它这一轮被中止了';
    return `它这一轮异常结束（${String(reason?.kind ?? 'unknown')}）`;
  }
  return undefined;
}

/** 本地时间 `MM-DD HH:mm`，给人看的那种。 */
export function formatMoment(ms) {
  if (!Number.isFinite(ms)) return '未知时间';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把一批会话排成列表文字。
 *
 * @param {Array<{header: object, title?: string, live?: boolean}>} sessions 已排好序的会话
 * @param {{currentId?: string, limit?: number, query?: string, parents?: Record<string,string>, labelOf?: (id: string) => string}} view 展示参数
 * @returns {{text: string, shown: Array}} 文字与真正展示出来的记录
 */
export function formatSessionList(sessions, view = {}) {
  const { currentId, limit = 25, query, parents = {}, labelOf } = view;
  const label = (id) => (typeof labelOf === 'function' ? labelOf(id) : id);
  const parentCount = new Map();
  for (const list of Object.values(parents)) {
    for (const parent of Array.isArray(list) ? list : [list]) {
      if (typeof parent === 'string') parentCount.set(parent, (parentCount.get(parent) ?? 0) + 1);
    }
  }
  const shown = sessions.slice(0, Math.max(0, limit));
  if (shown.length === 0) {
    return {
      text: query ? `没有找到和「${query}」对得上的会话。` : '这台机器上还没有别的会话。',
      shown,
    };
  }
  const lines = shown.map((session) => {
    const header = session.header ?? {};
    const marks = [];
    if (header.id === currentId) marks.push('当前会话');
    if (header.origin === 'subagent') marks.push('子会话');
    if (header.parentSession !== undefined && header.origin !== 'subagent') marks.push('有上级');
    if (session.live === true) marks.push('开着');
    const logicalParents = parents[header.id];
    if (Array.isArray(logicalParents) && logicalParents.length > 0) {
      marks.push(`归在${logicalParents.map((id) => `「${label(id)}」`).join('')}下`);
    }
    if (parentCount.has(header.id)) marks.push(`${parentCount.get(header.id)} 个下级`);
    const title = session.title ?? '(还没起标题)';
    return `- \`${header.id}\` · ${title} · 创建于 ${formatMoment(header.createdAt)}${marks.length > 0 ? ` · ${marks.join(' / ')}` : ''}`;
  });
  const head = query
    ? `和「${query}」对得上的会话（${shown.length} 条，新的在前）：`
    : `最近的会话（${shown.length} 条，新的在前）：`;
  return {
    text: `${head}\n${lines.join('\n')}\n\n用 \`nest_ask_session\` 去访问其中某个会话：` +
      '它在「设置 → 会话从属」里挂在你下面时，连 `session` 都可以不填，直接问「我的子会话」。',
    shown,
  };
}
