/**
 * dsh-nest 浏览器半边：设置 → 会话从属 面板。
 *
 * client bundle 不是 ESM，是自注册脚本（抄 dsh-bili-subagent / dsh-github 的约定）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 进设置靠 slots：
 *   slots.inject('settings.section', () => slots.register({ name, id, order, label }, () => h(Panel)))
 *
 * 面板能做的事：
 *   · 一个子会话可以挂到多个母会话下面（「＋ 挂到…」可以加，标签上的 × 去掉一条）
 *   · 每个母会话前面 ▸/▾ 折叠它的子会话
 *   · 每行一个眼睛按钮，单独隐藏/显示（折叠与隐藏记在 localStorage，刷新还在）
 */
window.__ModuleLoader__.load({
  id: 'dsh-nest',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const API = '/api/dsh-nest/relations';
    const STORAGE_KEY = 'dsh-nest:panel';

    const api = async (init) => {
      const response = await fetch(API, { credentials: 'same-origin', ...init });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}: 返回的不是 JSON`);
      }
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
      return body;
    };

    const shortId = (id) => (typeof id === 'string' && id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
    const labelOf = (session) => (session && session.title ? session.title : shortId(session ? session.id : ''));

    /** 从 localStorage 读上次的折叠/隐藏状态。 */
    function loadPrefs() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
        return {
          collapsed: new Set(Array.isArray(raw.collapsed) ? raw.collapsed : []),
          hidden: new Set(Array.isArray(raw.hidden) ? raw.hidden : []),
        };
      } catch {
        return { collapsed: new Set(), hidden: new Set() };
      }
    }

    function savePrefs(collapsed, hidden) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: [...collapsed], hidden: [...hidden] }));
      } catch {
        // 存不下就算了，不影响面板本身
      }
    }

    /** 由「子 → 上级列表」反查 childrenOf。 */
    function childrenIndex(relations) {
      const childrenOf = new Map();
      for (const [child, list] of Object.entries(relations || {})) {
        for (const parent of Array.isArray(list) ? list : [list]) {
          if (typeof parent !== 'string') continue;
          const bucket = childrenOf.get(parent) ?? [];
          bucket.push(child);
          childrenOf.set(parent, bucket);
        }
      }
      return childrenOf;
    }

    /** 某会话的全部下级（多上级也照走）。 */
    function descendantsOf(relations, id) {
      const childrenOf = childrenIndex(relations);
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
     * 排成树：根是没有上级（或上级不在本机列表里）的会话，子会话缩进；
     * 折叠起来的分支整段跳过；隐藏的会话（没打开「显示已隐藏」时）连子树一起跳过。
     */
    function flatten(sessions, relations, view) {
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const childrenOf = childrenIndex(relations);
      const roots = [];
      for (const session of sessions) {
        const parents = (relations[session.id] ?? []).filter((id) => byId.has(id));
        if (parents.length === 0) roots.push(session);
      }
      const rows = [];
      const seen = new Set();
      const markSubtree = (id) => {
        for (const child of childrenOf.get(id) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          markSubtree(child);
        }
      };
      const walk = (session, depth) => {
        if (seen.has(session.id)) return;
        seen.add(session.id);
        const hidden = view.hidden.has(session.id);
        if (hidden && !view.showHidden) {
          // 藏起来的会话连它的子树一起藏，别让子会话孤零零冒到顶层
          markSubtree(session.id);
          return;
        }
        const kids = (childrenOf.get(session.id) ?? []).map((id) => byId.get(id)).filter(Boolean);
        rows.push({ session, depth, hidden, hasChildren: kids.length > 0 });
        if (view.collapsed.has(session.id)) {
          // 折叠的分支算「已经处理过」，别再被后面那趟孤儿兜底当成根节点
          for (const child of kids) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            markSubtree(child.id);
          }
          return;
        }
        for (const child of kids) walk(child, depth + 1);
      };
      for (const root of roots) walk(root, 0);
      for (const session of sessions) if (!seen.has(session.id)) walk(session, 0);
      return rows;
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820, padding: '2px 2px 12px' },
      hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #9aa0a6)' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px',
        minWidth: 160,
        padding: '7px 9px',
        fontSize: 13,
        color: 'inherit',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        borderRadius: 7,
        outline: 'none',
      },
      button: {
        padding: '7px 12px',
        fontSize: 12.5,
        color: 'inherit',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.10))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        borderRadius: 7,
        cursor: 'pointer',
      },
      iconButton: {
        flex: 'none',
        width: 24,
        height: 24,
        padding: 0,
        fontSize: 12,
        lineHeight: '22px',
        textAlign: 'center',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 6,
        cursor: 'pointer',
        opacity: 0.75,
      },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      row: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '9px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
        background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.04))',
      },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      titleLine: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
      title: { fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 460 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: 10.5,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        color: 'var(--dsw-alias-label-secondary, #b0b0b0)',
      },
      parentsLine: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11.5,
        padding: '2px 4px 2px 8px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        maxWidth: 220,
      },
      chipText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chipRemove: {
        border: 0,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '14px',
        padding: '0 2px',
        opacity: 0.7,
      },
      select: {
        maxWidth: 190,
        padding: '4px 6px',
        fontSize: 12,
        color: 'inherit',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        borderRadius: 7,
      },
      error: { fontSize: 12, color: '#ff9b9b' },
      empty: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', padding: '10px 2px' },
    };

    function Panel() {
      const initial = useMemo(() => loadPrefs(), []);
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState('');
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');
      const [collapsed, setCollapsed] = useState(initial.collapsed);
      const [hidden, setHidden] = useState(initial.hidden);
      const [showHidden, setShowHidden] = useState(false);

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          setData(await api());
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      useEffect(() => {
        savePrefs(collapsed, hidden);
      }, [collapsed, hidden]);

      const post = useCallback(async (body, key) => {
        setSaving(key);
        setError('');
        try {
          const result = await api({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          setData(result.payload ?? result);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSaving('');
        }
      }, []);

      const addParent = (child, parent) => void post({ child, parent }, `add:${child}`);
      const removeParent = (child, parent) => void post({ child, parent, action: 'remove' }, `remove:${child}`);

      const toggleCollapsed = (id) => setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });

      const toggleHidden = (id) => setHidden((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });

      const sessions = data ? data.sessions : [];
      const relations = data ? data.relations ?? {} : {};
      const allRows = useMemo(
        () => flatten(sessions, relations, { collapsed, hidden, showHidden }),
        [sessions, relations, collapsed, hidden, showHidden],
      );
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return allRows;
        return allRows.filter(({ session }) => `${session.title ?? ''} ${session.id}`.toLowerCase().includes(needle));
      }, [allRows, query]);

      const edgeCount = Object.values(relations).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
      const hiddenCount = hidden.size;

      return h('div', { style: styles.page, 'data-dsh-nest-panel': 'true' },
        h('div', { style: styles.hint },
          '一个子会话可以同时挂在多个母会话下面（几个母会话都能访问它）。',
          h('br'),
          '这里只决定「谁能访问谁」：不动会话自己的历史，也不改 DSH 侧边栏里的会话树。'),
        h('div', { style: styles.toolbar },
          h('input', {
            style: styles.input,
            value: query,
            placeholder: '按标题 / id 过滤（不用手打 id，下面直接选）',
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', style: styles.button, onClick: () => void load(), disabled: loading },
            loading ? '读取中…' : '刷新'),
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => setCollapsed((previous) => (previous.size === 0
              ? new Set(sessions.filter((session) => (Object.values(relations).some((list) => list.includes(session.id)))).map((session) => session.id))
              : new Set())),
          }, collapsed.size === 0 ? '全部折叠' : '全部展开'),
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => setShowHidden((value) => !value),
          }, showHidden ? '收起已隐藏' : `显示已隐藏${hiddenCount > 0 ? `（${hiddenCount}）` : ''}`),
          h('span', { style: styles.hint }, `${sessions.length} 个会话 · ${edgeCount} 条关系`)),
        error.length > 0 ? h('div', { style: styles.error }, error) : null,
        loading && sessions.length === 0
          ? h('div', { style: styles.empty }, '正在读会话列表…')
          : filtered.length === 0
            ? h('div', { style: styles.empty }, sessions.length === 0 ? '这台机器上还没有会话。' : '没有匹配的会话。')
            : h('div', { style: styles.list },
              filtered.map(({ session, depth, hidden: isHidden, hasChildren }) => {
                const blocked = descendantsOf(relations, session.id);
                const options = sessions.filter((candidate) => candidate.id !== session.id && !blocked.has(candidate.id));
                const parentLabels = (relations[session.id] ?? []).map((id) => {
                  const parent = sessions.find((candidate) => candidate.id === id);
                  return { id, label: parent ? labelOf(parent) : shortId(id) };
                });
                return h('div', {
                  key: session.id,
                  style: { ...styles.row, marginLeft: depth * 18, opacity: isHidden ? 0.45 : 1 },
                },
                h('button', {
                  type: 'button',
                  title: hasChildren ? (collapsed.has(session.id) ? '展开子会话' : '折叠子会话') : undefined,
                  style: { ...styles.iconButton, visibility: hasChildren ? 'visible' : 'hidden' },
                  onClick: () => toggleCollapsed(session.id),
                }, collapsed.has(session.id) ? '▸' : '▾'),
                h('button', {
                  type: 'button',
                  title: isHidden ? '显示这个会话' : '隐藏这个会话',
                  style: styles.iconButton,
                  onClick: () => toggleHidden(session.id),
                }, isHidden ? '🙈' : '👁'),
                h('div', { style: styles.rowMain },
                  h('div', { style: styles.titleLine },
                    h('span', { style: styles.title, title: session.title ?? session.id },
                      depth > 0 ? '↳ ' : '', session.title ?? '(还没起标题)'),
                    session.live ? h('span', { style: styles.badge }, '开着') : null,
                    session.origin === 'subagent' ? h('span', { style: styles.badge }, '子会话') : null),
                  h('div', { style: styles.meta, title: session.id },
                    shortId(session.id),
                    session.cwd ? ` · ${session.cwd}` : ''),
                  h('div', { style: styles.parentsLine },
                    h('span', { style: styles.hint }, '上级'),
                    parentLabels.length === 0
                      ? h('span', { style: styles.hint }, '（无）')
                      : parentLabels.map((parent) => h('span', { key: parent.id, style: styles.chip },
                        h('span', { style: styles.chipText, title: parent.label }, parent.label),
                        h('button', {
                          type: 'button',
                          style: styles.chipRemove,
                          title: '去掉这条关系',
                          disabled: saving === `remove:${session.id}`,
                          onClick: () => removeParent(session.id, parent.id),
                        }, '×'))),
                    options.length > 0
                      ? h('select', {
                        style: styles.select,
                        value: '',
                        disabled: saving === `add:${session.id}`,
                        onChange: (event) => {
                          if (event.target.value) addParent(session.id, event.target.value);
                        },
                      },
                      h('option', { value: '' }, '＋ 挂到…'),
                      options.map((candidate) => h('option', { key: candidate.id, value: candidate.id }, labelOf(candidate))))
                      : null)));
              })));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'nest-relations', order: 34, label: '会话从属' },
          () => h(Panel),
        ));
      },
    };
  },
});
