// 冒烟测试：验证 bundle 清单、两端模块加载、导出形状、分时段计价与
// 计价缓存（cost ledger）——尤其是「历史花费不因时段切换而突变」的回归用例。
// 运行：node test/smoke.mjs
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import {
  isPeak, priceFor, usageBreakdown, scopeBreakdown, tokensFromRow,
  beijingHourKey, beijingHourStart, emptyLedger, ledgerAdd, ledgerTotals, ledgerView,
  normalizeModel, prefixMatch, modelMatches, reviveLedger, repriceLedger, mergeStats, planLegacyMerge, isDuplicateShard,
  PRICING_VERSION, PRICING_INFO, LEGACY_DATA_FILES, DSH_HOME_DIR,
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

// ── 分时段判定（北京时间）：高峰 = 工作日 9-12 / 14-18（周末全天空闲）────────
assert.equal(isPeak(new Date('2026-08-17T02:00:00Z')), true, '周一 北京 10:00 应为高峰')
assert.equal(isPeak(new Date('2026-08-17T04:00:00Z')), false, '周一 北京 12:00 应为空闲')
assert.equal(isPeak(new Date('2026-08-17T07:00:00Z')), true, '周一 北京 15:00 应为高峰')
assert.equal(isPeak(new Date('2026-08-17T10:00:00Z')), false, '周一 北京 18:00 应为空闲')
assert.equal(isPeak(new Date('2026-09-18T02:00:00Z')), true, '周五 北京 10:00 应为高峰')
assert.equal(isPeak(new Date('2026-09-19T02:00:00Z')), false, '周六 北京 10:00 应为空闲（周末无高峰）')
assert.equal(isPeak(new Date('2026-09-20T07:00:00Z')), false, '周日 北京 15:00 应为空闲（周末无高峰）')
assert.equal(isPeak(new Date('2026-09-21T02:00:00Z')), true, '下周一 北京 10:00 恢复高峰')

// ── 官方价格表（2026-09-10 12:00 生效；高峰/空闲 × 模型）────────────────────
assert.equal(PRICING_INFO.version, PRICING_VERSION)
const flashPeak = priceFor('deepseek-flash', new Date('2026-09-14T02:00:00Z'))
assert.deepEqual(flashPeak, {
  input: 2.0, cacheRead: 0.04, cacheWrite: 2.0, output: 8.0, estimated: false, peak: true,
})
const flashOff = priceFor('deepseek-flash', new Date('2026-09-14T04:00:00Z'))
assert.deepEqual(flashOff, {
  input: 1.0, cacheRead: 0.02, cacheWrite: 1.0, output: 4.0, estimated: false, peak: false,
})
const proPeak = priceFor('deepseek-v4-pro', new Date('2026-09-14T02:00:00Z'))
assert.deepEqual(proPeak, {
  input: 9.0, cacheRead: 0.3, cacheWrite: 9.0, output: 27.0, estimated: false, peak: true,
})
// 旧模型名（deepseek-v4-flash / -0731 / -vision-exp）由 V4.1-Flash 提供服务，按 Flash 计价
const legacyFlashPeak = priceFor('deepseek-v4-flash', new Date('2026-09-14T02:00:00Z'))
assert.deepEqual(legacyFlashPeak, flashPeak, '旧名 deepseek-v4-flash 应按新 Flash 单价')
const flashSuffixOff = priceFor('deepseek-v4-flash-0731', new Date('2026-09-14T04:00:00Z'))
assert.deepEqual(flashSuffixOff, flashOff, '带版本后缀的旧名按新 Flash 单价')
const visionOff = priceFor('deepseek-v4-flash-vision-exp', new Date('2026-09-14T04:00:00Z'))
assert.deepEqual(visionOff, flashOff, 'vision-exp 旧名按新 Flash 单价')
const proSuffixPeak = priceFor('deepseek-v4-pro-0813', new Date('2026-09-14T02:00:00Z'))
assert.deepEqual(proSuffixPeak, proPeak, '带版本后缀的 pro 仍按 pro 单价')
const unknown = priceFor('deepseek-v9-unknown', new Date('2026-09-14T02:00:00Z'))
assert.equal(unknown.estimated, true, '未收录模型应标记估算并按 deepseek-flash 兜底')
assert.equal(unknown.input, 2.0)

// 模型名归一化（含官方改名映射）与历史 key 前缀兼容
assert.equal(normalizeModel('deepseek-flash'), 'deepseek-flash')
assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-flash', '旧名归一到新名')
assert.equal(normalizeModel('deepseek-v4-flash-0731'), 'deepseek-flash')
assert.equal(normalizeModel('deepseek-v4-flash-vision-exp'), 'deepseek-flash')
assert.equal(normalizeModel('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
assert.equal(normalizeModel('deepseek-v9-unknown'), 'deepseek-v9-unknown', '未收录模型保留原名')
assert.equal(modelMatches('deepseek-v4-flash-0731', 'deepseek-flash'), true, '历史 key 与新名同族')
assert.equal(modelMatches('deepseek-flash', 'deepseek-v4-flash'), true, '双向归一后互相命中')
assert.equal(prefixMatch('deepseek-v4-flash-0731', 'deepseek-v4-flash'), true)
assert.equal(prefixMatch('deepseek-v4-pro', 'deepseek-v4-flash'), false)
assert.equal(modelMatches('deepseek-v4-pro', 'deepseek-flash'), false)

// ── 三档拆分（官方计费口径）：缓存未命中含缓存写入；三档之和 = 合计 ──────────
const bd = usageBreakdown(
  { inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 4000000, cacheWriteTokens: 500000 },
  'deepseek-flash',
  new Date('2026-09-14T04:00:00Z'), // 周一北京 12:00 空闲：未命中 1 / 命中 0.02 / 输出 4
)
assert.equal(bd.missTokens, 1500000, '缓存未命中应含缓存写入')
assert.equal(bd.hitTokens, 4000000)
assert.equal(bd.outputTokens, 1000)
assert.equal(bd.totalTokens, 5501000, '三档之和 = 合计')
const expectCost = (1500000 * 1.0 + 4000000 * 0.02 + 1000 * 4.0) / 1e6
assert.ok(near(bd.totalCostCny, expectCost), '费用 = 三档各自单价之和')
assert.ok(near(bd.missCostCny + bd.hitCostCny + bd.outputCostCny, bd.totalCostCny, 1e-12), '三档费用之和 = 合计费用')

// ── 计价缓存：具体时间（北京整点）───────────────────────────────────────────
assert.equal(beijingHourKey(new Date('2026-08-17T02:34:56Z')), '2026-08-17T10', '北京 10:34 应归到 10 点整点')
assert.equal(beijingHourKey(new Date('2026-08-17T16:05:00Z')), '2026-08-18T00', '跨天按北京时间归属')
assert.equal(beijingHourStart(new Date('2026-08-17T02:34:56Z')), Date.parse('2026-08-17T02:00:00Z'), '整点起点应可还原为时间戳')

// ── 回归用例（核心 bug）：消耗在空闲时段记录后，高峰时刻查询不得变贵 ──────────
const offTime = new Date('2026-09-14T04:00:00Z') // 周一北京 12:00 空闲
const peakTime = new Date('2026-09-14T02:00:00Z') // 周一北京 10:00 高峰
const ledger = emptyLedger()
const tiers = { inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const costAtOff = ledgerAdd(ledger, 'deepseek-flash', offTime, tiers, priceFor('deepseek-flash', offTime))
const expectedOff = (1000000 * 1.0 + 1000 * 4.0) / 1e6
assert.ok(near(costAtOff, expectedOff), '写入时按发生时刻的空闲单价计价')
assert.ok(near(ledger.costCny, expectedOff), '计价缓存累计 = 真实花费')

const tokens = tokensFromRow({ inputTokens: 1000000, outputTokens: 1000 })
const bdPeakQuery = scopeBreakdown(tokens, costAtOff, ledger, 'deepseek-flash', peakTime)
assert.ok(near(bdPeakQuery.totalCostCny, expectedOff), '高峰时刻查询历史花费不得跳变（修复前会翻倍）')
assert.ok(near(bdPeakQuery.missCostCny, 1.0), '未命中档沿用记录时的空闲单价')
assert.ok(near(bdPeakQuery.outputCostCny, 0.004), '输出档沿用记录时的空闲单价')
assert.equal(bdPeakQuery.approximate, false, '有计价缓存时拆分不是估算')
assert.equal(bdPeakQuery.hours, 1, '计价缓存覆盖 1 个整点')
// 对照：旧的「按当前时段重算」口径在高峰查询时确实会翻倍（这就是被修掉的 bug）
const stalePricing = usageBreakdown({ inputTokens: 1000000, outputTokens: 1000 }, 'deepseek-flash', peakTime)
assert.ok(stalePricing.totalCostCny > expectedOff * 1.9, '旧口径在高峰查询时会明显变贵')

// ── 多时段记录：每个整点各自冻结，合计 = 各整点之和 ──────────────────────────
ledgerAdd(ledger, 'deepseek-v4-pro', peakTime, tiers, priceFor('deepseek-v4-pro', peakTime))
const proTotal = ledgerTotals(ledger, 'deepseek-v4-pro')
assert.ok(near(proTotal.totalCostCny, (1000000 * 9 + 1000 * 27) / 1e6), 'pro 高峰单价（官方未调整）')
assert.equal(proTotal.hours, 1)
const view = ledgerView(ledger, null)
assert.equal(view.hours, 2, '两个整点各一条记录')
assert.equal(view.shown.length, 2)
assert.equal(view.shown[0].hour, '2026-09-14T12', '最近的整点排在前（周一北京 12:00）')
assert.equal(view.shown[0].peak, false, '周一北京 12:00 为空闲')
assert.equal(view.shown[1].hour, '2026-09-14T10', '再往前是周一北京 10:00')
assert.equal(view.shown[1].peak, true, '周一北京 10:00 为高峰')
assert.ok(near(view.shown[0].costCny + view.shown[1].costCny, view.costCny), '分桶费用之和 = 缓存合计')
assert.equal(view.peakTokens, 1001000, '按记录时段统计高峰 token')
assert.equal(view.offTokens, 1001000, '按记录时段统计空闲 token')
const viewFlash = ledgerView(ledger, 'deepseek-flash')
assert.equal(viewFlash.hours, 1, '按模型过滤只保留该模型的整点')
assert.ok(near(viewFlash.costCny, expectedOff))
// 旧名（deepseek-v4-flash）应命中同一个模型族
assert.ok(near(ledgerView(ledger, 'deepseek-v4-flash').costCny, expectedOff), '旧名查询命中新名记录')

// ── 历史数据（无计价缓存）：合计仍等于记录的真实花费，只是拆分标记估算 ────────
const legacy = scopeBreakdown(tokens, expectedOff, emptyLedger(), 'deepseek-flash', peakTime)
assert.ok(near(legacy.totalCostCny, expectedOff), '无缓存时合计取记录的真实费用，不按当前时段重算')
assert.equal(legacy.approximate, true, '无时间记录的历史 token 应标记为估算拆分')
assert.equal(legacy.residueTokens, 1001000)
assert.ok(near(legacy.missCostCny + legacy.hitCostCny + legacy.outputCostCny, legacy.totalCostCny, 1e-12), '三档之和 = 合计')

// ── 换表迁移：价格表版本变化时，历史分桶按各自记录的时间用新表重算 ────────────
// 构造「旧表 + 旧模型名」的计价缓存：flash 旧价 高峰 3.0/0.1/9.0
const stale = emptyLedger()
stale.v = PRICING_VERSION - 1
const staleAt = new Date('2026-09-14T02:00:00Z') // 周一北京 10:00 高峰期
const staleCost = ledgerAdd(stale, 'deepseek-v4-flash', staleAt, tiers, {
  input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0, peak: true, estimated: false,
})
const staleModelRow = { inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: staleCost }
const statsLike = {
  totals: { calls: 1, inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: staleCost, perModel: { 'deepseek-official:deepseek-v4-flash': { provider: 'deepseek-official', model: 'deepseek-v4-flash', calls: 1, inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: staleCost } } },
  sessions: { s1: { calls: 1, costCny: staleCost, modelsTok: { 'deepseek-v4-flash': { ...staleModelRow } }, ledger: JSON.parse(JSON.stringify(stale)) } },
  ledger: stale,
}
assert.equal(repriceLedger(statsLike), true, '旧表版本应触发重算')
const expectedPeak = (1000000 * 2.0 + 1000 * 8.0) / 1e6
const repricedBucket = statsLike.ledger.buckets['2026-09-14T10']
assert.ok(repricedBucket, '分桶仍在原整点')
assert.deepEqual(Object.keys(repricedBucket.models), ['deepseek-flash'], '旧模型名合并到新名')
assert.ok(near(repricedBucket.models['deepseek-flash'].missCostCny, 2.0), '未命中按新表高峰单价重算')
assert.ok(near(repricedBucket.models['deepseek-flash'].outputCostCny, 0.008), '输出按新表高峰单价重算')
assert.ok(near(statsLike.ledger.costCny, expectedPeak), '缓存合计按新表更新')
assert.ok(near(statsLike.totals.costCny, expectedPeak), '总计费用同步更新')
assert.ok(near(statsLike.totals.perModel['deepseek-official:deepseek-v4-flash'].costCny, expectedPeak), '按模型行同步更新')
assert.ok(near(statsLike.sessions.s1.costCny, expectedPeak), '会话费用同步更新')
assert.ok(near(statsLike.sessions.s1.modelsTok['deepseek-v4-flash'].costCny, expectedPeak), '会话分模型费用同步更新')
assert.equal(statsLike.ledger.v, PRICING_VERSION, '版本已标记为当前价格表')
assert.equal(statsLike.sessions.s1.ledger.v, PRICING_VERSION, '会话缓存版本同步标记')
assert.equal(repriceLedger(statsLike), false, '重算是幂等的（再次调用不再改动）')
assert.ok(near(statsLike.totals.costCny, expectedPeak), '幂等调用后费用不变')
// 时段规则重判：周末分桶按新规则记为「空闲」并改用空闲价
const weekend = emptyLedger()
weekend.v = PRICING_VERSION - 1
const satAt = new Date('2026-09-19T02:00:00Z') // 周六北京 10:00
ledgerAdd(weekend, 'deepseek-flash', satAt, tiers, { input: 2.0, cacheRead: 0.04, cacheWrite: 2.0, output: 8.0, peak: true, estimated: false })
const weekendStats = { totals: { costCny: (1000000 * 2.0 + 1000 * 8.0) / 1e6, perModel: {} }, sessions: {}, ledger: weekend }
repriceLedger(weekendStats)
assert.equal(weekend.buckets['2026-09-19T10'].peak, false, '周末分桶重判为空闲')
assert.ok(near(weekendStats.totals.costCny, (1000000 * 1.0 + 1000 * 4.0) / 1e6), '周末消耗改用空闲单价')

// ── 分桶裁剪：超过保留窗口的整点折叠进 settled，费用不丢 ─────────────────────
const big = emptyLedger()
let spent = 0
for (let i = 0; i < 725; i++) {
  const at = new Date(Date.parse('2026-06-01T00:00:00Z') + i * 3600000)
  spent += ledgerAdd(big, 'deepseek-flash', at, { inputTokens: 1000 }, priceFor('deepseek-flash', at))
}
assert.equal(Object.keys(big.buckets).length, 720, '只保留最近 720 个整点')
assert.ok(Object.keys(big.settled).length > 0, '更早的整点折叠进 settled')
const bigTotals = ledgerTotals(big, null)
assert.ok(near(bigTotals.totalCostCny, spent, 1e-6), '裁剪后合计费用不变（只丢时间粒度）')
assert.equal(bigTotals.hours, 720, '归档部分不再计入 hours')

// ── 持久化恢复：JSON 往返后计价缓存仍在 ─────────────────────────────────────
const roundTrip = reviveLedger(JSON.parse(JSON.stringify(ledger)))
assert.deepEqual(roundTrip.buckets['2026-09-14T12'], ledger.buckets['2026-09-14T12'], '分桶可无损恢复')
assert.ok(near(ledgerTotals(roundTrip, null).totalCostCny, ledgerTotals(ledger, null).totalCostCny), '恢复后合计一致')
assert.deepEqual(reviveLedger(undefined), emptyLedger(), '旧数据没有 ledger 时补空结构')
assert.deepEqual(reviveLedger(null).buckets, {})
// 落盘的价格表版本必须保留，否则重启后「换表重算」会被跳过
assert.equal(reviveLedger({ v: 1, buckets: {}, settled: {} }).v, 1, '恢复时保留落盘版本')
assert.equal(reviveLedger({ buckets: { '2026-09-14T10': { at: 1, peak: true, models: {} } } }).v, 0, '有分桶但无版本 → 视为未知旧表')
assert.equal(reviveLedger(undefined).v, PRICING_VERSION, '空数据按当前版本')

// ── 统计文件位置：默认落在 $DSH_HOME 下，并保留旧位置作为迁移来源 ─────────────
assert.deepEqual(LEGACY_DATA_FILES.filter((p) => p.endsWith('dsh-balance-and-cost.json')).length, LEGACY_DATA_FILES.length, '迁移候选都是同名文件')
assert.ok(LEGACY_DATA_FILES.some((p) => p === resolve('/.dsh/dsh-balance-and-cost.json')), 'Windows 盘根 \\\\.dsh\\\\ 仍在候选内')
assert.ok(!LEGACY_DATA_FILES.includes(join(DSH_HOME_DIR, 'dsh-balance-and-cost.json')), '当前统计文件不重复出现在候选里')

// ── 旧分片合并：互补分片合并，完全重复的副本忽略（避免重复计数）─────────────
const statsShard = (calls, costCny, startedAt) => ({
  startedAt,
  totals: { calls, inputTokens: 10 * calls, outputTokens: calls, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCny, anyEstimated: false, perModel: { 'p:m': { provider: 'p', model: 'm', calls, inputTokens: 10 * calls, outputTokens: calls, cacheReadTokens: 0, cacheWriteTokens: 0, costCny } } },
  sessions: { s: { calls, inputTokens: 10 * calls, outputTokens: calls, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCny, models: { m: calls }, modelsTok: { m: { inputTokens: 10 * calls, outputTokens: calls, cacheReadTokens: 0, cacheWriteTokens: 0, costCny } }, ledger: emptyLedger() } },
  baseline: null,
  ledger: emptyLedger(),
})
const shardA = statsShard(3, 1.5, 1000)
const shardB = statsShard(4, 2.5, 5000)
mergeStats(shardA, shardB)
assert.equal(shardA.totals.calls, 7, '合并后调用次数相加')
assert.ok(near(shardA.totals.costCny, 4.0), '合并后费用相加')
assert.equal(shardA.startedAt, 1000, '起点取更早的一个')
assert.equal(shardA.totals.perModel['p:m'].calls, 7, '按模型明细相加')
assert.equal(shardA.sessions.s.calls, 7, '会话明细相加')
assert.equal(shardA.sessions.s.modelsTok.m.costCny, 4.0, '会话分模型费用相加')
// 互补分片（会话 id 不同或缺次数不同）→ 合并；完全一致的副本 → 忽略
const primaryLike = { path: 'new.json', sessions: { s1: { calls: 5 } } }
assert.deepEqual(
  planLegacyMerge(primaryLike, [
    { path: 'new.json', sessions: { s1: { calls: 5 } } },
    { path: 'other.json', sessions: { s1: { calls: 5 }, s2: { calls: 9 } } },
    { path: 'same-count.json', sessions: { s1: { calls: 5 } } },
    { path: 'different-count.json', sessions: { s1: { calls: 6 } } },
  ]).map((item) => item.path),
  ['other.json', 'different-count.json'],
  '只合并互补分片，跳过重复副本与主文件自身',
)
assert.equal(isDuplicateShard({ a: { calls: 1 } }, { a: { calls: 1 } }), true)
assert.equal(isDuplicateShard({ a: { calls: 1 } }, { a: { calls: 2 } }), false, '同一会话次数不同 = 两个进程各自的调用')
assert.equal(isDuplicateShard({}, {}), false, '空会话集不判为副本')

// ── browser half：Node 环境下加载不应有副作用、不应抛错 ─────────────────────
await import('../src/client.js')

console.log('smoke OK: manifest / node half / browser half / 分时段计价 / 计价缓存（时段切换不跳变）')
