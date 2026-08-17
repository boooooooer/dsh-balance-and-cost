/**
 * dsh-balance-and-cost — browser half.
 *
 * 在主页输入框下方（conversation.composer.dock）渲染摘要条，在插件中心
 * （设置 → 插件，settings.plugins.tab）注册「DeepSeek 用量」完整面板。
 * 与 Host 半部通过两个同源 GET 路由通信：
 *   /__dsh-balance-and-cost/balance   → 余额快照
 *   /__dsh-balance-and-cost/usage     → 用量快照（?sessionId= 当前会话维度）
 * 每 15 秒轮询一次；余额由 Host 端 60 秒缓存兜底。
 */
if (typeof window !== 'undefined' && typeof window.__ModuleLoader__ !== 'undefined') {
  window.__ModuleLoader__.load({
    id: 'dsh-balance-and-cost',
    factory(require) {
      const React = require('react')
      // 复用 DSH 的 Tooltip（与默认 stats 行同款）；该内部包不在 boot graph 时优雅回退
      let Tooltip = null
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        if (primitives && primitives.Tooltip) Tooltip = primitives.Tooltip
      } catch {
        Tooltip = null
      }
      const API_BALANCE = '/__dsh-balance-and-cost/balance'
      const API_USAGE = '/__dsh-balance-and-cost/usage'
      const REFRESH_MS = 15000

      const getBalance = () => fetch(API_BALANCE, { cache: 'no-store' }).then((r) => r.json())
      const getUsage = (sessionId) => fetch(
        API_USAGE + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''),
        { cache: 'no-store' },
      ).then((r) => r.json())

      return {
        apply(ctx) {
          const slots = ctx.get('slots')
          if (slots === undefined) return

          const styleEl = document.createElement('style')
          styleEl.textContent = `
            .dsbal-root { display: flex; flex-direction: column; gap: 14px; padding: 6px 2px; }
            .dsbal-row { display: flex; gap: 14px; flex-wrap: wrap; }
            .dsbal-card { flex: 1 1 280px; min-width: 260px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); }
            .dsbal-title { font-size: 13px; color: var(--dsw-alias-label-secondary); margin-bottom: 10px; }
            .dsbal-big { font-size: 26px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
            .dsbal-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
            .dsbal-ok { color: var(--dsw-alias-state-success-primary); }
            .dsbal-bad { color: var(--dsw-alias-state-error-primary); }
            .dsbal-warn { color: var(--dsw-alias-state-warn-primary); }
            .dsbal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-top: 10px; }
            .dsbal-grid > div { font-size: 13px; color: var(--dsw-alias-label-primary); display: flex; justify-content: space-between; gap: 8px; }
            .dsbal-grid span { color: var(--dsw-alias-label-secondary); }
            .dsbal-note { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
            .dsbal-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
            .dsbal-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 13px; }
            .dsbal-btn:hover { border-color: var(--dsw-alias-brand-primary); }
            .dsbal-btn:disabled { opacity: 0.6; cursor: default; }
            .dsbal-sum { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
            .dsbal-sum b { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
            .dsbal-sep { opacity: 0.45; }
            .dsbal-models { cursor: help; border-bottom: 1px dotted var(--dsw-alias-border-l2); }
          `
          document.head.appendChild(styleEl)
          ctx.on('dispose', () => {
            if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
          })

          const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—')
          const fmtCost = (n) => (typeof n === 'number' ? '¥ ' + n.toFixed(4) : '—')
          const fmtCostShort = (n) => (typeof n === 'number' ? '¥ ' + n.toFixed(3) : '—')
          const fmtBal = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—')
          const fmtTime = (t) => (typeof t === 'number' ? new Date(t).toLocaleTimeString('zh-CN') : '—')
          const tokOf = (u) => (u ? (u.inputTokens || 0) + (u.outputTokens || 0) : 0)
          const modelsOf = (u) => (u && Array.isArray(u.models) && u.models.length ? u.models : null)
          const timer = ctx.get('timer')

          const panelSeq = { v: 0 }
          const summarySeq = { v: 0 }

          function Panel() {
            const [balance, setBalance] = React.useState(null)
            const [usage, setUsage] = React.useState(null)
            const [error, setError] = React.useState(null)
            const [busy, setBusy] = React.useState(false)

            const load = async () => {
              const seq = ++panelSeq.v
              setBusy(true)
              try {
                const [b, u] = await Promise.all([getBalance(), getUsage(null)])
                if (seq !== panelSeq.v) return
                setBalance(b)
                setUsage(u)
                setError(null)
              } catch (e) {
                if (seq !== panelSeq.v) return
                setError(String((e && e.message) || e))
              } finally {
                if (seq === panelSeq.v) setBusy(false)
              }
            }

            React.useEffect(() => {
              load()
              if (!timer) return undefined
              return timer.interval(load, REFRESH_MS)
            }, [])

            const balanceCard = []
            balanceCard.push(React.createElement('div', { className: 'dsbal-title', key: 't' }, 'DeepSeek 账户余额'))
            if (!balance) {
              balanceCard.push(React.createElement('div', { className: 'dsbal-note', key: 'l' }, '加载中…'))
            } else if (!balance.ok) {
              balanceCard.push(React.createElement('div', { className: 'dsbal-bad', key: 'l' }, '余额查询失败：' + String(balance.error || '未知错误')))
              balanceCard.push(React.createElement('div', { className: 'dsbal-note', key: 'n' }, '请确认 ~/.dsh/.credentials.yaml 中已配置 DEEPSEEK_API_KEY，且本机可访问 api.deepseek.com。'))
            } else {
              balanceCard.push(React.createElement('div', { className: 'dsbal-big', key: 'b' }, fmtBal(balance.totalBalance) + ' ' + balance.currency))
              balanceCard.push(React.createElement('div', { className: 'dsbal-sub', key: 's' },
                React.createElement('span', { className: balance.isAvailable ? 'dsbal-ok' : 'dsbal-bad' }, balance.isAvailable ? '● 账户可用' : '● 账户不可用')))
              balanceCard.push(React.createElement('div', { className: 'dsbal-grid', key: 'g' },
                React.createElement('div', { key: 'top' }, React.createElement('span', null, '充值余额'), fmtBal(balance.toppedUpBalance) + ' ' + balance.currency),
                React.createElement('div', { key: 'grant' }, React.createElement('span', null, '赠送余额'), fmtBal(balance.grantedBalance) + ' ' + balance.currency)))
            }

            const usageCard = []
            usageCard.push(React.createElement('div', { className: 'dsbal-title', key: 't' }, '消耗量（总计）'))
            if (!usage) {
              usageCard.push(React.createElement('div', { className: 'dsbal-note', key: 'l' }, '加载中…'))
            } else {
              const tot = usage.totals || {}
              const delta = balance && balance.ok && usage.baseline
                ? (usage.baseline.totalBalance - balance.totalBalance)
                : null
              usageCard.push(React.createElement('div', { className: 'dsbal-grid', key: 'g' },
                React.createElement('div', { key: 'calls' }, React.createElement('span', null, '模型调用'), fmtNum(tot.calls) + ' 次'),
                React.createElement('div', { key: 'in' }, React.createElement('span', null, '输入 tokens'), fmtNum(tot.inputTokens)),
                React.createElement('div', { key: 'out' }, React.createElement('span', null, '输出 tokens'), fmtNum(tot.outputTokens)),
                React.createElement('div', { key: 'cr' }, React.createElement('span', null, '缓存读取'), fmtNum(tot.cacheReadTokens)),
                React.createElement('div', { key: 'cw' }, React.createElement('span', null, '缓存写入'), fmtNum(tot.cacheWriteTokens)),
                React.createElement('div', { key: 'rt' }, React.createElement('span', null, '推理 tokens'), fmtNum(tot.reasoningTokens))))
              usageCard.push(React.createElement('div', { className: 'dsbal-sub', key: 'c' },
                '估算费用（CNY）：',
                React.createElement('span', { className: 'dsbal-warn' }, fmtCost(tot.costCny)),
                tot.anyEstimated ? '（含未收录模型，按 deepseek-v4-flash 估算）' : ''))
              usageCard.push(React.createElement('div', { className: 'dsbal-sub', key: 'p' },
                '当前时段：',
                React.createElement('span', { className: usage.peak ? 'dsbal-warn' : 'dsbal-ok' }, usage.peak ? '高峰（北京 9-12 / 14-18）' : '空闲'),
                '，按官方 v4 价格表分时段计价'))
              usageCard.push(React.createElement('div', { className: 'dsbal-sub', key: 'd' },
                delta === null
                  ? '余额变化对比：等待余额基线建立…'
                  : React.createElement('span', { className: delta >= 0 ? 'dsbal-ok' : 'dsbal-bad' }, '余额变化：' + delta.toFixed(2) + ' ' + balance.currency + '（自统计起）')))
              usageCard.push(React.createElement('div', { className: 'dsbal-note', key: 's' }, '统计持久化于 ' + fmtTime(usage.startedAt) + ' 起；余额基线 = 首次成功查询时的余额。当前会话的实时消耗见主页输入框下方的摘要条。'))
              if (tot.perModel && tot.perModel.length) {
                usageCard.push(React.createElement('div', { className: 'dsbal-title', key: 'mt' }, '按模型明细'))
                usageCard.push(React.createElement('div', { className: 'dsbal-grid', key: 'mg' },
                  tot.perModel.map((r) => React.createElement('div', { key: r.model },
                    React.createElement('span', null, r.model + (r.estimated ? '（估算）' : '')),
                    fmtNum(r.calls) + ' 次 · ' + fmtNum(r.inputTokens + r.outputTokens) + ' tok ≈' + fmtCostShort(r.costCny)))))
              }
              if (usage.sessions && usage.sessions.length) {
                usageCard.push(React.createElement('div', { className: 'dsbal-title', key: 'st' }, '各会话消耗'))
                usageCard.push(React.createElement('div', { className: 'dsbal-grid', key: 'sg' },
                  usage.sessions.map((s) => React.createElement('div', { key: s.sessionId },
                    React.createElement('span', null, '会话 ' + String(s.sessionId).slice(0, 8) + (s.models && s.models.length === 1 ? ' · ' + s.models[0] : '')),
                    fmtNum(s.calls) + ' 次 · ' + fmtNum(s.inputTokens + s.outputTokens) + ' tok ≈' + fmtCostShort(s.costCny)))))
              }
            }

            return React.createElement('div', { className: 'dsbal-root' },
              React.createElement('div', { className: 'dsbal-row' },
                React.createElement('div', { className: 'dsbal-card' }, balanceCard),
                React.createElement('div', { className: 'dsbal-card' }, usageCard)),
              React.createElement('div', { className: 'dsbal-foot' },
                React.createElement('button', { className: 'dsbal-btn', onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新'),
                error ? React.createElement('span', { className: 'dsbal-bad' }, '刷新出错：' + error) : null),
              React.createElement('div', { className: 'dsbal-note' }, '每 15 秒自动刷新（余额查询 Host 端缓存 60 秒）。费用按官方价格表（api-docs.deepseek.com/quick_start/pricing）分高峰/空闲时段计价，随调用时刻自动判定。'))
          }

          function Summary(props) {
            const sessionId = props && props.sessionId ? String(props.sessionId) : null
            const [balance, setBalance] = React.useState(null)
            const [usage, setUsage] = React.useState(null)
            const [error, setError] = React.useState(null)
            const load = async () => {
              const seq = ++summarySeq.v
              try {
                const [b, u] = await Promise.all([getBalance(), getUsage(sessionId)])
                if (seq !== summarySeq.v) return
                setBalance(b)
                setUsage(u)
                setError(null)
              } catch (e) {
                if (seq !== summarySeq.v) return
                setError(String((e && e.message) || e))
              }
            }
            React.useEffect(() => {
              load()
              // SSE 实时推送：模型切换 / 用量产生 → 立即刷新（15s 轮询仅作断连兜底）
              let es = null
              try {
                es = new EventSource('/__dsh-balance-and-cost/events')
                es.onmessage = () => { load() }
              } catch {
                es = null
              }
              if (!timer) return () => { if (es) es.close() }
              const poll = timer.interval(load, REFRESH_MS)
              return () => {
                poll()
                if (es) es.close()
              }
            }, [sessionId])

            const balText = balance && balance.ok
              ? fmtBal(balance.totalBalance) + ' ' + balance.currency
              : (balance && !balance.ok ? '余额—' : '余额…')

            let curNodes = React.createElement('span', null, '本会话 —')
            let totText = '总计 —'
            if (usage) {
              const curModels = modelsOf(usage.current)
              // 显示优先级：当前选中的模型 > 实际调用过的模型（切换即跟随）
              let curLabel = null
              if (usage.selectedModel && usage.selectedModel.model) {
                curLabel = usage.selectedModel.model
              } else if (curModels) {
                curLabel = curModels.length === 1 ? curModels[0] : curModels.length + ' 模型'
              }
              totText = '总计 ' + fmtNum(tokOf(usage.totals)) + ' tok ≈' + fmtCostShort(usage.totals.costCny)
              // 本会话格显示当前选中模型的实际消耗（≈¥ 即估算费用）
              const act = usage.current.selectedActual
              const hasAct = act && act.tokens > 0
              const tokText = (hasAct ? fmtNum(act.tokens) : fmtNum(tokOf(usage.current))) + ' tok ≈' + fmtCostShort(hasAct ? act.costCny : usage.current.costCny)
              if (curLabel) {
                let labelEl = React.createElement('span', { className: 'dsbal-models' }, curLabel)
                // 模型名上悬停：两模型实际消耗量与估算价对比（与默认 stats 行同款 Tooltip）
                if (Tooltip !== null) {
                  const detail = (usage.current.modelsActual || [])
                    .map((m) => m.model + (m.selected ? '（当前）' : '') + '：' + fmtNum(m.tokens) + ' tok ≈' + fmtCostShort(m.costCny))
                    .join(' · ')
                  if (detail) labelEl = React.createElement(Tooltip, { label: detail, side: 'top', delayMs: 500 }, labelEl)
                }
                curNodes = React.createElement('span', null, '本会话 (', labelEl, ') ', tokText)
              } else {
                curNodes = React.createElement('span', null, '本会话 ', tokText)
              }
            }

            const nodes = [
              React.createElement('span', { key: 'b' }, React.createElement('b', null, 'DeepSeek'), ' 余额 ', React.createElement('b', null, balText)),
              React.createElement('span', { key: 'sep1', className: 'dsbal-sep' }, '·'),
              React.createElement('span', { key: 'c' }, curNodes),
              React.createElement('span', { key: 'sep2', className: 'dsbal-sep' }, '·'),
              React.createElement('span', { key: 't' }, totText),
            ]
            if (usage) {
              nodes.push(React.createElement('span', { key: 'sep3', className: 'dsbal-sep' }, '·'))
              nodes.push(React.createElement('span', { key: 'pk', className: usage.peak ? 'dsbal-warn' : 'dsbal-ok' }, usage.peak ? '[高峰]' : '[空闲]'))
            }
            if (error) {
              nodes.push(React.createElement('span', { key: 'err', className: 'dsbal-bad' }, '（刷新失败）'))
            }
            return React.createElement('div', { className: 'dsbal-sum' }, nodes)
          }

          slots.inject('settings.plugins.tab', () => slots.register(
            { name: 'settings.plugins.tab', id: 'dsh-balance-and-cost', order: 20, label: 'DeepSeek 用量' },
            () => React.createElement(Panel),
          ))

          slots.inject('conversation.composer.dock', () => slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-balance-and-cost-summary', order: 10 },
            (props) => React.createElement(Summary, props),
          ))
        },
      }
    },
  })
}
