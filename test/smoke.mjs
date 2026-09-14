// 冒烟测试：验证 bundle 清单、两端模块加载、导出形状、分时段计价与
// 计价缓存（cost ledger）——尤其是「历史花费不因时段切换而突变」的回归用例。
// 运行：node test/smoke.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  isPeak, priceFor, usageBreakdown, scopeBreakdown, tokensFromRow,
  beijingHourKey, beijingHourStart, emptyLedger, ledgerAdd, ledgerTotals, ledgerView,
  normalizeModel, prefixMatch, reviveLedger,
} from '../src/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

// ── manifest 校验（awesome-dsh-plugin 收录的硬性条件）─────────────────────────
assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch 缺失——无法通过 dsh plugin add 安装')
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 应为 web')
assert.equal(pkg.exports['.'], './src/index.js', 'exports["."] 应指向 node half 源码')
assert.equal(pkg.exports['./client'], './src/client.js', 'exports["./client"] 应指向 browser half 源码')

// ── node half：导出形状 ──────────────────────────────────────────────────────
const host = await import('../src/index.js')
assert.equal(host.name, 'dsh-balance-and-cost')
assert.deepEqual(host.inject, ['webServer'], '应声明 webServer 硬依赖')
assert.equal(typeof host.apply, 'function')

// ── 分时段判定（北京时间）：高峰 9-12 / 14-18 ────────────────────────────────
assert.equal(isPeak(new Date('2026-08-17T02:00:00Z')), true, '北京 10:00 应为高峰')
assert.equal(isPeak(new Date('2026-08-17T04:00:00Z')), false, '北京 12:00 应为空闲')
assert.equal(isPeak(new Date('2026-08-17T07:00:00Z')), true, '北京 15:00 应为高峰')
assert.equal(isPeak(new Date('2026-08-17T10:00:00Z')), false, '北京 18:00 应为空闲')

// ── 官方价格表（高峰/空闲 × 模型）───────────────────────────────────────────
const flashPeak = priceFor('deepseek-v4-flash', new Date('2026-08-17T02:00:00Z'))
assert.deepEqual(flashPeak, {
  input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0, estimated: false, peak: true,
})
const flashOff = priceFor('deepseek-v4-flash', new Date('2026-08-17T04:00:00Z'))
assert.deepEqual(flashOff, {
  input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5, estimated: false, peak: false,
})
const proPeak = priceFor('deepseek-v4-pro', new Date('2026-08-17T02:00:00Z'))
assert.deepEqual(proPeak, {
  input: 9.0, cacheRead: 0.3, cacheWrite: 9.0, output: 27.0, estimated: false, peak: true,
})
// 带版本后缀的模型 id（官方版本号如 DeepSeek-V4-Pro-0813）应前缀匹配正确价格
const proSuffixPeak = priceFor('deepseek-v4-pro-0813', new Date('2026-08-17T02:00:00Z'))
assert.deepEqual(proSuffixPeak, {
  input: 9.0, cacheRead: 0.3, cacheWrite: 9.0, output: 27.0, estimated: false, peak: true,
})
const flashSuffixOff = priceFor('deepseek-v4-flash-0731', new Date('2026-08-17T04:00:00Z'))
assert.deepEqual(flashSuffixOff, {
  input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5, estimated: false, peak: false,
})
const unknown = priceFor('deepseek-v9-unknown', new Date('2026-08-17T02:00:00Z'))
assert.equal(unknown.estimated, true, '未收录模型应标记估算并按 v4-flash 兜底')
assert.equal(unknown.input, 3.0)

// 模型名归一化与历史 key 前缀兼容
assert.equal(normalizeModel('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-v4-flash')
assert.equal(normalizeModel('deepseek-v9-unknown'), 'deepseek-v9-unknown', '未收录模型保留原名')
assert.equal(prefixMatch('deepseek-v4-flash-0731', 'deepseek-v4-flash'), true)
assert.equal(prefixMatch('deepseek-v4-flash', 'deepseek-v4-flash'), true)
assert.equal(prefixMatch('deepseek-v4-pro', 'deepseek-v4-flash'), false)

// ── 三档拆分（官方计费口径）：缓存未命中含缓存写入；三档之和 = 合计 ──────────
const bd = usageBreakdown(
  { inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 4000000, cacheWriteTokens: 500000 },
  'deepseek-v4-flash',
  new Date('2026-08-17T04:00:00Z'), // 空闲时段：未命中 1.5 / 命中 0.05 / 输出 4.5
)
assert.equal(bd.missTokens, 1500000, '缓存未命中应含缓存写入')
assert.equal(bd.hitTokens, 4000000)
assert.equal(bd.outputTokens, 1000)
assert.equal(bd.totalTokens, 5501000, '三档之和 = 合计')
const expectCost = (1500000 * 1.5 + 4000000 * 0.05 + 1000 * 4.5) / 1e6
assert.ok(near(bd.totalCostCny, expectCost), '费用 = 三档各自单价之和')
assert.ok(near(bd.missCostCny + bd.hitCostCny + bd.outputCostCny, bd.totalCostCny, 1e-12), '三档费用之和 = 合计费用')

// ── 计价缓存：具体时间（北京整点）───────────────────────────────────────────
assert.equal(beijingHourKey(new Date('2026-08-17T02:34:56Z')), '2026-08-17T10', '北京 10:34 应归到 10 点整点')
assert.equal(beijingHourKey(new Date('2026-08-17T16:05:00Z')), '2026-08-18T00', '跨天按北京时间归属')
assert.equal(beijingHourStart(new Date('2026-08-17T02:34:56Z')), Date.parse('2026-08-17T02:00:00Z'), '整点起点应可还原为时间戳')

// ── 回归用例（核心 bug）：消耗在空闲时段记录后，高峰时刻查询不得变贵 ──────────
const offTime = new Date('2026-08-17T04:00:00Z') // 北京 12:00 空闲
const peakTime = new Date('2026-08-17T02:00:00Z') // 北京 10:00 高峰
const ledger = emptyLedger()
const tiers = { inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const costAtOff = ledgerAdd(ledger, 'deepseek-v4-flash', offTime, tiers, priceFor('deepseek-v4-flash', offTime))
const expectedOff = (1000000 * 1.5 + 1000 * 4.5) / 1e6
assert.ok(near(costAtOff, expectedOff), '写入时按发生时刻的空闲单价计价')
assert.ok(near(ledger.costCny, expectedOff), '计价缓存累计 = 真实花费')

const tokens = tokensFromRow({ inputTokens: 1000000, outputTokens: 1000 })
const bdPeakQuery = scopeBreakdown(tokens, costAtOff, ledger, 'deepseek-v4-flash', peakTime)
assert.ok(near(bdPeakQuery.totalCostCny, expectedOff), '高峰时刻查询历史花费不得跳变（修复前会翻倍）')
assert.ok(near(bdPeakQuery.missCostCny, 1.5), '未命中档沿用记录时的空闲单价')
assert.ok(near(bdPeakQuery.outputCostCny, 0.0045), '输出档沿用记录时的空闲单价')
assert.equal(bdPeakQuery.approximate, false, '有计价缓存时拆分不是估算')
assert.equal(bdPeakQuery.hours, 1, '计价缓存覆盖 1 个整点')
// 对照：旧的「按当前时段重算」口径在高峰查询时确实会翻倍（这就是被修掉的 bug）
const stalePricing = usageBreakdown({ inputTokens: 1000000, outputTokens: 1000 }, 'deepseek-v4-flash', peakTime)
assert.ok(stalePricing.totalCostCny > expectedOff * 1.9, '旧口径在高峰查询时会明显变贵')

// ── 多时段记录：每个整点各自冻结，合计 = 各整点之和 ──────────────────────────
ledgerAdd(ledger, 'deepseek-v4-pro', peakTime, tiers, priceFor('deepseek-v4-pro', peakTime))
const proTotal = ledgerTotals(ledger, 'deepseek-v4-pro')
assert.ok(near(proTotal.totalCostCny, (1000000 * 9 + 1000 * 27) / 1e6), 'peak 档按高峰单价')
assert.equal(proTotal.hours, 1)
const view = ledgerView(ledger, null)
assert.equal(view.hours, 2, '两个整点各一条记录')
assert.equal(view.shown.length, 2)
assert.equal(view.shown[0].hour, '2026-08-17T12', '最近的整点排在前（北京 12:00）')
assert.equal(view.shown[0].peak, false, '北京 12:00 为空闲')
assert.equal(view.shown[1].hour, '2026-08-17T10', '再往前是北京 10:00')
assert.equal(view.shown[1].peak, true, '北京 10:00 为高峰')
assert.ok(near(view.shown[0].costCny + view.shown[1].costCny, view.costCny), '分桶费用之和 = 缓存合计')
assert.equal(view.peakTokens, 1001000, '按记录时段统计高峰 token')
assert.equal(view.offTokens, 1001000, '按记录时段统计空闲 token')
const viewFlash = ledgerView(ledger, 'deepseek-v4-flash')
assert.equal(viewFlash.hours, 1, '按模型过滤只保留该模型的整点')
assert.ok(near(viewFlash.costCny, expectedOff))

// ── 历史数据（无计价缓存）：合计仍等于记录的真实花费，只是拆分标记估算 ────────
const legacy = scopeBreakdown(tokens, expectedOff, emptyLedger(), 'deepseek-v4-flash', peakTime)
assert.ok(near(legacy.totalCostCny, expectedOff), '无缓存时合计取记录的真实费用，不按当前时段重算')
assert.equal(legacy.approximate, true, '无时间记录的历史 token 应标记为估算拆分')
assert.equal(legacy.residueTokens, 1001000)
assert.ok(near(legacy.missCostCny + legacy.hitCostCny + legacy.outputCostCny, legacy.totalCostCny, 1e-12), '三档之和 = 合计')

// ── 分桶裁剪：超过保留窗口的整点折叠进 settled，费用不丢 ─────────────────────
const big = emptyLedger()
let spent = 0
for (let i = 0; i < 725; i++) {
  const at = new Date(Date.parse('2026-06-01T00:00:00Z') + i * 3600000)
  spent += ledgerAdd(big, 'deepseek-v4-flash', at, { inputTokens: 1000 }, priceFor('deepseek-v4-flash', at))
}
assert.equal(Object.keys(big.buckets).length, 720, '只保留最近 720 个整点')
assert.ok(Object.keys(big.settled).length > 0, '更早的整点折叠进 settled')
const bigTotals = ledgerTotals(big, null)
assert.ok(near(bigTotals.totalCostCny, spent, 1e-6), '裁剪后合计费用不变（只丢时间粒度）')
assert.equal(bigTotals.hours, 720, '归档部分不再计入 hours')

// ── 持久化恢复：JSON 往返后计价缓存仍在 ─────────────────────────────────────
const roundTrip = reviveLedger(JSON.parse(JSON.stringify(ledger)))
assert.deepEqual(roundTrip.buckets['2026-08-17T12'], ledger.buckets['2026-08-17T12'], '分桶可无损恢复')
assert.ok(near(ledgerTotals(roundTrip, null).totalCostCny, ledgerTotals(ledger, null).totalCostCny), '恢复后合计一致')
assert.deepEqual(reviveLedger(undefined), emptyLedger(), '旧数据没有 ledger 时补空结构')
assert.deepEqual(reviveLedger(null).buckets, {})

// ── browser half：Node 环境下加载不应有副作用、不应抛错 ─────────────────────
await import('../src/client.js')

console.log('smoke OK: manifest / node half / browser half / 分时段计价 / 计价缓存（时段切换不跳变）')
