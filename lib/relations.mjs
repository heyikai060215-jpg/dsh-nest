/**
 * 巢（dsh-nest）的关系表：谁归谁管。
 *
 * 这是一张**逻辑关系**表，不是 DSH 自己的会话树 —— 它只决定妈妈会话能访问谁、
 * `nest_ask_session` 省略 `session` 时默认找谁。绝不改任何会话的日志/header。
 *
 * 一个子会话可以同时挂在**多个**母会话下面（几个母会话都能访问它）。
 *
 * 文件格式（v2，一个子会话对应一组上级）：
 *   { "version": 2, "updatedAt": 1700000000000,
 *     "parents": { "<childId>": ["<parentId>", ...] } }
 *
 * v1 是 `{ "<childId>": "<parentId>" }`（单个字符串），读进来会自动升级成数组。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 2;

/**
 * 把落盘的原始对象归一化成 v2 形状（兼容 v1 的单字符串上级）。
 * @param {unknown} raw 文件里读出来的对象
 * @returns {{version: number, updatedAt?: number, parents: Record<string, string[]>}} 归一化结果
 */
export function normalizeRelations(raw) {
  const parents = {};
  const source = raw !== null && typeof raw === 'object' ? raw.parents : undefined;
  if (source !== null && typeof source === 'object') {
    for (const [child, value] of Object.entries(source)) {
      if (typeof child !== 'string' || child.length === 0) continue;
      const list = Array.isArray(value) ? value : [value];
      const clean = [...new Set(list.filter((parent) => typeof parent === 'string' && parent.length > 0 && parent !== child))];
      if (clean.length > 0) parents[child] = clean;
    }
  }
  return {
    version: VERSION,
    ...(raw !== null && typeof raw === 'object' && typeof raw.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {}),
    parents,
  };
}

/** 由「子 → 上级列表」反查出 childrenOf：上级 → 子列表。 */
function childrenIndex(parents) {
  const childrenOf = new Map();
  for (const [child, list] of Object.entries(parents)) {
    for (const parent of list) {
      const bucket = childrenOf.get(parent) ?? [];
      bucket.push(child);
      childrenOf.set(parent, bucket);
    }
  }
  return childrenOf;
}

/**
 * 某个会话的全部下级（递归，多上级也照走），用来在下拉框里排除掉它们，免得选出环。
 * @param {Record<string, string[]>} parents 子 → 上级列表
 * @param {string} id 起点
 * @returns {Set<string>} 下级 id
 */
export function descendantIds(parents, id) {
  const childrenOf = childrenIndex(parents);
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
 * 判断「把 parent 挂成 child 的上级」会不会成环：parent 本身如果已经在 child 的下级里，就成了环。
 * @param {Record<string, string[]>} parents 子 → 上级列表
 * @param {string} child 子会话
 * @param {string} parent 目标上级
 * @returns {boolean} 是否会成环
 */
export function wouldCycle(parents, child, parent) {
  if (child === parent) return true;
  return descendantIds(parents, child).has(parent);
}

/**
 * 建立关系表存储。读失败（没有文件 / 坏 JSON / 旧格式）一律当成空表，不阻断启动。
 * @param {{file: string}} options 文件路径
 */
export function createRelationsStore(options) {
  const file = options.file;
  /** @type {{version: number, updatedAt?: number, parents: Record<string, string[]>}} */
  let state = { version: VERSION, parents: {} };
  let loaded = false;

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      state = normalizeRelations(JSON.parse(fs.readFileSync(file, 'utf8')));
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

  const commit = (parents) => {
    state = { version: VERSION, updatedAt: Date.now(), parents };
    save();
    return { ...state, parents: { ...parents } };
  };

  const assertIds = (child, parent) => {
    if (typeof child !== 'string' || child.length === 0) throw new Error('child 必须是非空字符串');
    if (typeof parent !== 'string' || parent.length === 0) throw new Error('parent 必须是非空字符串');
    if (parent === child) throw new Error('不能把会话挂到自己下面');
  };

  return {
    file,
    snapshot() {
      load();
      return { ...state, parents: Object.fromEntries(Object.entries(state.parents).map(([child, list]) => [child, [...list]])) };
    },
    reload() {
      loaded = false;
      load();
      return this.snapshot();
    },
    /**
     * 加一条「child 归 parent 管」的关系（可重复加不同上级，同一个上级重复加是幂等的）。
     * @param {string} child 子会话 id
     * @param {string} parent 上级会话 id
     * @returns {object} 最新关系表
     */
    addParent(child, parent) {
      load();
      assertIds(child, parent);
      const current = state.parents[child] ?? [];
      if (current.includes(parent)) return this.snapshot();
      if (wouldCycle(state.parents, child, parent)) {
        throw new Error('这样会绕成环：目标会话本身就在这条子链里');
      }
      const next = { ...state.parents };
      for (const [key, list] of Object.entries(next)) next[key] = [...list];
      next[child] = [...current, parent];
      return commit(next);
    },
    /**
     * 去掉一条关系；去完没有上级了就把这个子会话从表里删掉。
     * @param {string} child 子会话 id
     * @param {string} parent 上级会话 id
     * @returns {object} 最新关系表
     */
    removeParent(child, parent) {
      load();
      if (typeof child !== 'string' || child.length === 0) throw new Error('child 必须是非空字符串');
      const current = state.parents[child] ?? [];
      if (!current.includes(parent)) return this.snapshot();
      const next = { ...state.parents };
      for (const [key, list] of Object.entries(next)) next[key] = [...list];
      const remaining = current.filter((item) => item !== parent);
      if (remaining.length === 0) delete next[child];
      else next[child] = remaining;
      return commit(next);
    },
    /**
     * 一次性把这个子会话的上级设成给定列表（空数组等于清空）。
     * @param {string} child 子会话 id
     * @param {string[]} parents 上级列表
     * @returns {object} 最新关系表
     */
    setParents(child, parents) {
      load();
      if (typeof child !== 'string' || child.length === 0) throw new Error('child 必须是非空字符串');
      if (!Array.isArray(parents)) throw new Error('parents 必须是数组');
      const next = { ...state.parents };
      for (const [key, list] of Object.entries(next)) next[key] = [...list];
      const unique = [...new Set(parents)];
      for (const parent of unique) assertIds(child, parent);
      const candidate = { ...next };
      if (unique.length === 0) delete candidate[child];
      else candidate[child] = unique;
      for (const parent of unique) {
        if (wouldCycle(candidate, child, parent)) {
          throw new Error('这样会绕成环：目标会话本身就在这条子链里');
        }
      }
      return commit(candidate);
    },
  };
}
