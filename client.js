/**
 * dsh-prompt-enhance 客户端半边。
 *
 * 挂 conversation.input.right（输入框右下、模型选择器旁），三态按钮：
 *   idle     星光 ✨  草稿 → 请求增强 → 整段替换草稿，记住原文
 *   enhanced 还原 ↩  草稿换回原文，清记忆
 *   busy     转圈     请求在途时禁用
 *
 * ★ 为什么不用 conversation 服务 ★（2026-10-19 修）
 *   上一版写 `inject:['conversation']` + `ctx.inject(['conversation'], scope => ...)`，
 *   按钮一直不出现。原因是 conversation 这个 client 服务由 dsh-client-ui-conversation
 *   在自己的 fiber 上 provide，第三方插件是它的**兄弟节点**，拿不到 → 回调永不执行。
 *   正解：插槽渲染器本身会给每个 session 作用域的条目下发标准 props，
 *   其中 `useInput`（selector hook，源是 shell.state）与 `inputActions`（= shell.actions，
 *   含 setDraft）正是 ui-conversation 在 `ctx.uiSession.provide({hooks:['conversation','input'],
 *   props:['inputActions'], ...})` 里登记的（conv-client.js L18127-18143）。
 *   于是：**只要这个插槽被渲染，这两个 prop 就必然存在**，零服务依赖。
 *
 * 注册形态抄本机已验证可用的 dsh-hardware-cockpit/client.js 结尾：
 *   return { inject:['slots'], apply(ctx){ ctx.slots.inject(slot, () => ctx.slots.register({...}, Comp)) } }
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 宿主路由（与 index.js 的 routeBase 保持一致）。 */
    const ENHANCE_PATH = '/prompt-enhance/enhance';

    /**
     * 每个会话的「增强记账」：增强成功后记下 original（用户原文）与 enhanced（增强结果）。
     *
     * 为什么不放组件 state：按钮组件会因切会话 / InputBar 重挂载而重建，内存 state 一丢，
     * 用户就再也点不到「恢复原文」，原文永久丢失。放插件级 Map 里，只要页面不刷新就还在。
     * contextTurns：本次增强实际用了最近多少条对话上下文（0 = 没用上）。
     * @type {Map<string, {original:string, enhanced:string, contextTurns:number}>}
     */
    const ledger = new Map();

    /** 已经警告过「插槽没下发 props」的会话，避免每次渲染都刷屏。 */
    const warned = new Set();

    /** 当前草稿（对 undefined 安全）。 */
    const draftOf = (snapshot) =>
      snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : '';

    /** 主按钮。props 由插槽运行时下发：useInput / inputActions / sessionId。 */
    function EnhanceButton(props) {
      const { useInput, inputActions, sessionId } = props;
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      /** 非 null 表示这次增强是规则模板兜底（模型没跑通），值是失败原因。 */
      const [degraded, setDegraded] = React.useState(null);

      // hook 必须无条件调用；useInput 缺失时退化为常量，绝不抛。
      const draft = typeof useInput === 'function' ? useInput(draftOf) : '';
      const canWrite = !!inputActions && typeof inputActions.setDraft === 'function';

      // 一次性自检：按钮"看得见但点不动"时，凭这两行日志能立刻判断是
      // 插槽契约变了（useInput/inputActions 没下发）还是别的原因。
      if (!warned.has(sessionId) && (typeof useInput !== 'function' || !canWrite)) {
        warned.add(sessionId);
        console.warn('[dsh-prompt-enhance] 插槽未下发 useInput/inputActions，按钮将不可用', {
          useInput: typeof useInput,
          inputActions: typeof inputActions,
        });
      }

      const rec = sessionId === undefined ? undefined : ledger.get(sessionId);
      const enhanced = !!rec && draft === rec.enhanced;
      const empty = draft.trim() === '';

      const onEnhance = async () => {
        if (busy || !canWrite || empty) return;
        setBusy(true);
        setFailed(false);
        try {
          const response = await fetch(ENHANCE_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ text: draft, sessionId }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`);
          }
          const next = typeof payload.enhanced === 'string' ? payload.enhanced : '';
          if (!next) throw new Error('empty enhanced result');
          // 服务端会带回这次实际用了几条会话上下文（0 = 没读到，退化成只看草稿）。
          const contextTurns = Number.isFinite(payload.contextTurns) ? payload.contextTurns : 0;
          // 服务端降级时 source !== 'model'：结果仍是可用的结构化骨架，但不是模型写的。
          // 以前这里完全静默，用户只会觉得"效果一般"，查不出是模型挂了 —— 现在明确提示一句。
          if (payload.source !== 'model') {
            setDegraded(payload.reason || payload.source || 'fallback');
            console.warn('[dsh-prompt-enhance] 已降级为规则模板:', payload.source, payload.reason);
          } else {
            setDegraded(null);
          }
          console.info('[dsh-prompt-enhance] 增强完成，使用会话上下文', `${contextTurns} 条`);
          if (sessionId !== undefined) ledger.set(sessionId, { original: draft, enhanced: next, contextTurns });
          inputActions.setDraft(next);
        } catch (error) {
          setFailed(true);
          console.error('[dsh-prompt-enhance] 增强失败:', error);
        } finally {
          setBusy(false);
        }
      };

      const onRestore = () => {
        if (!canWrite || !rec) return;
        inputActions.setDraft(rec.original);
        if (sessionId !== undefined) ledger.delete(sessionId);
      };

      const contextNote =
        rec && rec.contextTurns > 0 ? `（含最近 ${rec.contextTurns} 条上下文）` : '';
      const label = busy
        ? '增强中…'
        : enhanced
          ? degraded
            ? `恢复原文（本次为模板兜底：${degraded}）`
            : `恢复原文${contextNote}`
          : empty
            ? '先输入一些内容'
            : '增强为结构化提示词';

      return h(
        'button',
        {
          type: 'button',
          'data-dsh-prompt-enhance': enhanced ? 'restore' : 'enhance',
          disabled: busy || (!enhanced && (empty || !canWrite)),
          onClick: enhanced ? onRestore : onEnhance,
          title: label,
          'aria-label': label,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: failed || degraded
              ? 'var(--dsw-alias-state-warning-primary, #b26a00)'
              : enhanced
                ? 'var(--dsw-alias-state-business-primary, #1677ff)'
                : 'var(--dsw-alias-label-secondary, #666)',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
            fontSize: 15,
            lineHeight: 1,
            flex: '0 0 auto',
          },
        },
        busy ? '⋯' : enhanced ? '↩' : '✨',
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'prompt-enhance',
              order: 10,
              // sessionId 由插槽运行时传给 inject；这里只做透传，不碰任何服务。
              inject: (sessionId) => ({ sessionId }),
            },
            EnhanceButton,
          ),
        );
        // 挂载证据：浏览器控制台出现这行 = 客户端半边确实加载并执行了 apply。
        console.info('[dsh-prompt-enhance] 已挂载到 conversation.input.right');
      },
    };
  },
});
