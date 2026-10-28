/**
 * 巢（dsh-nest）的关系表：谁归谁管。
 *
 * 这是一张**逻辑关系**表，不是 DSH 自己的会话树 —— 它只决定妈妈会话能访问谁、
 * `nest_ask_session` 省略 `session` 时默认找谁。绝不改任何会话的日志/header。
 *
 * 文件格式：
 *   { "version": 1, "updatedAt": 1700000000000, "parents": { "<childId>": "<parentId>" } }
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

/**
 * 判断「把 child 挂到 parent 下面」会不会成环：从 parent 往上走，如果走到 child 就是环。
 * @param {Record<string, string>} parents 子 → 父
 * @param {string} child 要移动的子会话
 * @param {string} parent 目标父会话
 * @returns {boolean} 是否会成环
 */
export function wouldCycle(parents, child, parent) {
  if (child === parent) return true;
  const seen = new Set([child]);
  let cursor = parent;
  while (typeof cursor === 'string' && cursor.length > 0) {
    if (cursor === child) return true;
    if (seen.has(cursor)) return true; // 已有环：拒绝再往里挂
    seen.add(cursor);
    cursor = parents[cursor];
  }
  return false;
}

/**
 * 一个 child 的所有下级（递归），用来在下拉框里排除掉它们，免得选出一个环。
 * @param {Record<string, string>} parents 子 → 父
 * @param {string} id 起点
 * @returns {Set<string>} 下级 id
 */
export function descendantIds(parents, id) {
  const childrenOf = new Map();
  for (const [child, parent] of Object.entries(parents)) {
    if (typeof parent !== 'string') continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(child);
    childrenOf.set(parent, list);
  }
  const out = new Set();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (out.has(next)) continue;
    out.add(next);
    for (const grand of childrenOf.get(next) ?? []) stack.push(grand);
  }
  return out;
}

/**
 * 建立关系表存储。读失败（没有文件 / 坏 JSON / 旧格式）一律当成空表，不阻断启动。
 * @param {{file: string}} options 文件路径
 * @returns {{snapshot: () => {version: number, updatedAt?: number, parents: Record<string,string>}, setParent: (child: string, parent: string|null) => object, reload: () => void, file: string}}
 */
export function createRelationsStore(options) {
  const file = options.file;
  /** @type {{version: number, updatedAt?: number, parents: Record<string, string>}} */
  let state = { version: VERSION, parents: {} };
  let loaded = false;

  const normalize = (raw) => {
    const parents = {};
    const source = raw?.parents;
    if (source !== null && typeof source === 'object') {
      for (const [child, parent] of Object.entries(source)) {
        if (typeof child === 'string' && child.length > 0 && typeof parent === 'string' && parent.length > 0 && child !== parent) {
          parents[child] = parent;
        }
      }
    }
    return {
      version: VERSION,
      ...(typeof raw?.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {}),
      parents,
    };
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const text = fs.readFileSync(file, 'utf8');
      state = normalize(JSON.parse(text));
    } catch {
      state = { version: VERSION, parents: {} };
    }
  };

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  };

  return {
    file,
    snapshot() {
      load();
      return { ...state, parents: { ...state.parents } };
    },
    reload() {
      loaded = false;
      load();
      return this.snapshot();
    },
    /**
     * 设置/清除一条从属关系。parent 传 null 表示「无上级」。
     * @param {string} child 子会话 id
     * @param {string|null} parent 父会话 id
     * @returns {{version: number, updatedAt: number, parents: Record<string,string>}}
     */
    setParent(child, parent) {
      load();
      if (typeof child !== 'string' || child.length === 0) throw new Error('child 必须是非空字符串');
      if (parent !== null && (typeof parent !== 'string' || parent.length === 0)) throw new Error('parent 必须是非空字符串或 null');
      if (parent === child) throw new Error('不能把会话挂到自己下面');
      const next = { ...state.parents };
      if (parent === null) delete next[child];
      else {
        if (wouldCycle(next, child, parent)) throw new Error('这样会绕成环：目标会话本身就在这条子链里');
        next[child] = parent;
      }
      state = { version: VERSION, updatedAt: Date.now(), parents: next };
      save();
      return this.snapshot();
    },
  };
}
