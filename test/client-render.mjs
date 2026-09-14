// browser half 渲染测试：不依赖真实 React，用假 React/假 slots 驱动 client.js，
// 验证两个槽位注册 + 两个组件在「有数据」时能正常渲染（含新增的计价缓存区块）。
// 运行：node test/client-render.mjs
import assert from 'node:assert/strict'

// ── 假 React：createElement 产出可检查的普通对象（函数组件就地求值）；hooks 用脚本化队列喂初始值 ──
let stateQueue = []
const createElement = (type, props, ...children) => {
  if (typeof type === 'function') return type({ ...(props || {}), children })
  return { type, props: props || {}, children }
}
const React = {
  createElement,
  cloneElement: (el, extra) => ({ ...el, props: { ...el.props, ...extra } }),
  useState: (init) => [stateQueue.length > 0 ? stateQueue.shift() : init, () => {}],
  useEffect: () => {},
}

// ── 假 __ModuleLoader__：捕获 client.js 注册的描述符 ────────────────────────
let descriptor = null
globalThis.window = {
  __ModuleLoader__: {
    load(d) {
      descriptor = d
    },
  },
}
// 假 document：client.js 会注入一段 <style>
const fakeEl = () => ({ textContent: '', dataset: {}, parentNode: null, appendChild() {}, setAttribute() {} })
globalThis.document = {
  createElement: fakeEl,
  head: { appendChild() {} },
  querySelector: () => null,
}
await import('../src/client.js')
assert.ok(descriptor, 'client.js 应调用 window.__ModuleLoader__.load')
assert.equal(descriptor.id, 'dsh-balance-and-cost')

// require 解析：react 用假实现；primitives 故意缺 Tooltip，验证原生 title 回退
const requireFn = (id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return {} // 无 Tooltip → 回退分支
  throw new Error('unexpected require: ' + id)
}

// ── 假 slots：记录注册，并允许直接渲染 ──────────────────────────────────────
const registered = []
const slots = {
  inject: (name, fn) => fn(),
  register: (options, component) => {
    registered.push({ options, component })
    return () => {}
  },
}
const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  on: () => {},
  effect: () => {},
}

const plugin = descriptor.factory(requireFn)
plugin.apply(ctx)
assert.equal(registered.length, 2, '应注册摘要条与设置页两个槽位')
const panelReg = registered.find((r) => r.options.name === 'settings.plugins.tab')
const summaryReg = registered.find((r) => r.options.name === 'conversation.composer.dock')
assert.ok(panelReg, '应注册 settings.plugins.tab')
assert.ok(summaryReg, '应注册 conversation.composer.dock')
assert.equal(panelReg.options.label, 'DeepSeek 用量')

// ── 收集渲染树里的文本 ──────────────────────────────────────────────────────
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

const bucketHour = '2026-09-14T09'
const usage = {
  startedAt: Date.now() - 3600000,
  peak: true,
  selectedModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  baseline: { totalBalance: 100, currency: 'CNY' },
  totals: {
    calls: 12,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costCny: 0.1234,
    anyEstimated: false,
    perModel: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', calls: 12, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0, costCny: 0.1234, estimated: false }],
    breakdown: { missTokens: 1000, hitTokens: 5000, outputTokens: 200, totalTokens: 6200, missCostCny: 0.003, hitCostCny: 0.0005, outputCostCny: 0.0018, totalCostCny: 0.1234, approximate: false },
  },
  current: {
    calls: 12,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 0,
    costCny: 0.1234,
    models: ['deepseek-v4-flash'],
    modelsActual: [{ model: 'deepseek-v4-flash', tokens: 6200, costCny: 0.1234, selected: true }],
    selectedActual: { tokens: 6200, costCny: 0.1234 },
    selectedBreakdown: { missTokens: 1000, hitTokens: 5000, outputTokens: 200, totalTokens: 6200, missCostCny: 0.003, hitCostCny: 0.0005, outputCostCny: 0.0018, totalCostCny: 0.1234, approximate: false },
  },
  sessions: [{
    sessionId: 's1',
    title: '测试会话',
    calls: 12,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 0,
    costCny: 0.1234,
    models: ['deepseek-v4-flash'],
    modelsDetail: [{ model: 'deepseek-v4-flash', calls: 12, tokens: 6200, costCny: 0.1234 }],
  }],
  pricing: {
    hours: 2,
    shown: [
      { hour: bucketHour, at: Date.parse('2026-09-14T01:00:00Z'), peak: true, calls: 3, missTokens: 1000000, hitTokens: 0, outputTokens: 1000, tokens: 1001000, costCny: 3.009, models: ['deepseek-v4-flash'], price: { 'deepseek-v4-flash': { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 } } },
      { hour: '2026-09-14T12', at: Date.parse('2026-09-14T04:00:00Z'), peak: false, calls: 1, missTokens: 1000, hitTokens: 0, outputTokens: 10, tokens: 1010, costCny: 0.0015, models: ['deepseek-v4-pro'], price: { 'deepseek-v4-pro': { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 } } },
    ],
    truncated: 0,
    settled: [],
    costCny: 3.0105,
    tokens: 1002010,
    peakTokens: 1001000,
    offTokens: 1010,
    firstAt: Date.parse('2026-09-14T01:00:00Z'),
    lastAt: Date.parse('2026-09-14T04:00:00Z'),
    currentSession: null,
    maxBuckets: 720,
  },
}
const balance = { ok: true, isAvailable: true, currency: 'CNY', totalBalance: 88.5, grantedBalance: 8.5, toppedUpBalance: 80 }

// ── 设置页：Panel 的 useState 顺序 = balance, usage, error, busy ─────────────
stateQueue = [balance, usage, null, false]
const panelText = textOf(panelReg.component())
assert.ok(panelText.includes('DeepSeek 账户余额'), '余额卡片应渲染')
assert.ok(panelText.includes('88.50'), '余额数值应渲染')
assert.ok(panelText.includes('计价缓存（按小时）'), '应渲染计价缓存区块')
assert.ok(panelText.includes('09-14 09:00–10:00'), '应渲染消耗发生的整点时间')
assert.ok(panelText.includes('高峰'), '应渲染记录下的时段')
assert.ok(panelText.includes('空闲'), '应渲染另一条空闲记录')
assert.ok(panelText.includes('测试会话'), '会话卡片应渲染')
assert.ok(panelText.includes('导出明细') && panelText.includes('重置记录'), '按钮应渲染')

// ── 摘要条：Summary 的 useState 顺序 = balance, usage, error ────────────────
stateQueue = [balance, usage, null]
const summaryText = textOf(summaryReg.component({ sessionId: 's1' }))
assert.ok(summaryText.includes('DeepSeek'), '摘要条应渲染')
assert.ok(summaryText.includes('88.50 CNY'), '摘要条应显示余额')
assert.ok(summaryText.includes('本会话'), '摘要条应显示本会话')
assert.ok(summaryText.includes('[高峰]'), '摘要条应显示时段标记')

// ── 无计价缓存的历史数据（旧落盘）：拆分标记为估算也不能崩 ────────────────────
const legacyUsage = JSON.parse(JSON.stringify(usage))
legacyUsage.pricing = { hours: 0, shown: [], truncated: 0, settled: [], costCny: 0, tokens: 0, peakTokens: 0, offTokens: 0, firstAt: null, lastAt: null, currentSession: null, maxBuckets: 720 }
legacyUsage.totals.breakdown.approximate = true
legacyUsage.current.selectedBreakdown.approximate = true
stateQueue = [balance, legacyUsage, null, false]
const legacyText = textOf(panelReg.component())
assert.ok(legacyText.includes('暂无记录'), '没有整点记录时应给出提示而不是报错')

// ── 断连/加载中：usage 为 null 时不能崩 ─────────────────────────────────────
stateQueue = [null, null, null, false]
const emptyText = textOf(panelReg.component())
assert.ok(emptyText.includes('加载中'), '未取到数据时应显示加载中')

console.log('client render OK: 槽位注册 / 摘要条 / 设置页 / 计价缓存区块 / 空数据降级')
