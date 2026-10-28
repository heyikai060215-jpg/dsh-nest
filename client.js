/**
 * dsh-nest 浏览器半边：设置 → 会话从属 面板。
 *
 * client bundle 不是 ESM，是自注册脚本（抄 dsh-bili-subagent / dsh-github 的约定）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 进设置靠 slots：
 *   slots.inject('settings.section', () => slots.register({ name, id, order, label }, () => h(Panel)))
 */
window.__ModuleLoader__.load({
  id: 'dsh-nest',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const API = '/api/dsh-nest/relations';

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

    /** 本地算每个会话的层级，用来画缩进（关系表有环也不会死循环）。 */
    function flatten(sessions, parents) {
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const childrenOf = new Map();
      const roots = [];
      for (const session of sessions) {
        const parent = parents[session.id];
        if (typeof parent === 'string' && byId.has(parent)) {
          const list = childrenOf.get(parent) ?? [];
          list.push(session);
          childrenOf.set(parent, list);
        } else {
          roots.push(session);
        }
      }
      const rows = [];
      const seen = new Set();
      const walk = (session, depth) => {
        if (seen.has(session.id)) return;
        seen.add(session.id);
        rows.push({ session, depth });
        for (const child of childrenOf.get(session.id) ?? []) walk(child, depth + 1);
      };
      for (const root of roots) walk(root, 0);
      for (const session of sessions) if (!seen.has(session.id)) walk(session, 0);
      return rows;
    }

    /** 某会话的全部下级（用于下拉框排除，避免选出环）。 */
    function descendantsOf(sessions, parents, id) {
      const childrenOf = new Map();
      for (const session of sessions) {
        const parent = parents[session.id];
        if (typeof parent !== 'string') continue;
        const list = childrenOf.get(parent) ?? [];
        list.push(session.id);
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

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760, padding: '2px 2px 12px' },
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
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      row: {
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '9px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
        background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.04))',
      },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
      titleLine: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
      title: { fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: 10.5,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        color: 'var(--dsw-alias-label-secondary, #b0b0b0)',
      },
      select: {
        maxWidth: 230,
        padding: '6px 8px',
        fontSize: 12.5,
        color: 'inherit',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        borderRadius: 7,
      },
      error: { fontSize: 12, color: '#ff9b9b' },
      empty: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', padding: '10px 2px' },
    };

    function Panel() {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState('');
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');

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

      const change = useCallback(async (child, parent) => {
        setSaving(child);
        setError('');
        try {
          const result = await api({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ child, parent: parent === '' ? null : parent }),
          });
          setData(result.payload ?? result);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSaving('');
        }
      }, []);

      const sessions = data ? data.sessions : [];
      const parents = data ? data.parents : {};
      const rows = useMemo(() => flatten(sessions, parents), [sessions, parents]);
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return rows;
        return rows.filter(({ session }) => `${session.title ?? ''} ${session.id}`.toLowerCase().includes(needle));
      }, [rows, query]);

      const relationCount = Object.keys(parents).length;

      return h('div', { style: styles.page, 'data-dsh-nest-panel': 'true' },
        h('div', { style: styles.hint },
          '这里只决定「母会话能访问谁」：在母会话里可以直接问「我的子会话」，不用报会话 id。',
          h('br'),
          '它不会改会话自己的历史，也不会改 DSH 侧边栏里的会话树 —— 想改回随时改，一条关系就是一行。'),
        h('div', { style: styles.toolbar },
          h('input', {
            style: styles.input,
            value: query,
            placeholder: '按标题 / id 过滤（不用手打 id，下面直接选）',
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', style: styles.button, onClick: () => void load(), disabled: loading },
            loading ? '读取中…' : '刷新'),
          h('span', { style: styles.hint }, `${sessions.length} 个会话 · ${relationCount} 条关系`)),
        error.length > 0 ? h('div', { style: styles.error }, error) : null,
        loading && sessions.length === 0
          ? h('div', { style: styles.empty }, '正在读会话列表…')
          : filtered.length === 0
            ? h('div', { style: styles.empty }, sessions.length === 0 ? '这台机器上还没有会话。' : '没有匹配的会话。')
            : h('div', { style: styles.list },
              filtered.map(({ session, depth }) => {
                const blocked = descendantsOf(sessions, parents, session.id);
                const options = sessions.filter((candidate) => candidate.id !== session.id && !blocked.has(candidate.id));
                const current = parents[session.id] ?? '';
                return h('div', { key: session.id, style: { ...styles.row, marginLeft: depth * 18 } },
                  h('div', { style: styles.rowMain },
                    h('div', { style: styles.titleLine },
                      h('span', { style: styles.title, title: session.title ?? session.id },
                        depth > 0 ? '↳ ' : '', session.title ?? '(还没起标题)'),
                      session.live ? h('span', { style: styles.badge }, '开着') : null,
                      session.origin === 'subagent' ? h('span', { style: styles.badge }, '子会话') : null),
                    h('div', { style: styles.meta, title: session.id },
                      shortId(session.id),
                      session.cwd ? ` · ${session.cwd}` : '')),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('span', { style: styles.hint }, '上级'),
                    h('select', {
                      style: styles.select,
                      value: current,
                      disabled: saving === session.id,
                      onChange: (event) => void change(session.id, event.target.value),
                    },
                    h('option', { value: '' }, '（无上级）'),
                    options.map((candidate) => h('option', { key: candidate.id, value: candidate.id },
                      labelOf(candidate)))),
                    saving === session.id ? h('span', { style: styles.hint }, '保存中…') : null));
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
