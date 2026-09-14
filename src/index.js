/**
 * dsh-balance-and-cost — node half（标准 bundle 插件）。
 *
 * DeepSeek 账户余额与模型消耗量：
 * - 监听 llm/stream 瀑布流，累计 DeepSeek 路由的 token 消耗（输入/输出/缓存读取/
 *   缓存写入/推理），按官方价格表（api-docs.deepseek.com/zh-cn/quick_start/pricing）
 *   分高峰/空闲时段计价——价格按每次调用时刻的北京时间时段即时判定。
 * - 计价缓存（cost ledger）：每次消耗都把「具体时间（北京整点）+ 当时单价 + 三档
 *   token + 该单价下的真实花费」写入缓存并冻结。所有展示（三档悬停、总计、按会话、
 *   按小时明细）都从这份记录读取，绝不用「当前时间」重算历史 token 的价格，
 *   因此高峰/空闲切换时历史花费不会跳变。
 * - 按模型（provider:model）与按会话（sessionId）双维度聚合，区分「总计」与
 *   「当前会话」。
 * - 账户余额：经 credentials 服务解析 DEEPSEEK_API_KEY，用 Node 内置 fetch 调用
 *   https://api.deepseek.com/user/balance（60 秒缓存）。
 * - 统计持久化到 $DSH_HOME/dsh-balance-and-cost.json（防抖 10s 落盘），进程重启后恢复。
 * - 对外通道：webServer 注册两个 GET 路由，浏览器端 client 半部用 fetch 调用：
 *     /__dsh-balance-and-cost/balance   → 余额快照
 *     /__dsh-balance-and-cost/usage     → 用量快照（?sessionId= 取当前会话维度）
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'dsh-balance-and-cost'
// webServer 由 web 组合保证提供；声明为硬依赖使 apply 等待其就绪后再运行。
export const inject = ['webServer']

// 官方价格表（api-docs.deepseek.com/zh-cn/quick_start/pricing，人民币 / 百万 tokens）：
// deepseek-v4-flash：输入未命中 高峰3.0/空闲1.5，命中 高峰0.10/空闲0.05，输出 高峰9.0/空闲4.5
// deepseek-v4-pro：  输入未命中 高峰9.0/空闲4.5，命中 高峰0.30/空闲0.15，输出 高峰27.0/空闲13.5
// 高峰 = 北京时间 9-12、14-18；缓存写入按输入未命中计价；未收录模型按 deepseek-v4-flash 估算
const PRICES = {
  'deepseek-v4-flash': { inputMiss: { peak: 3.0, off: 1.5 }, inputHit: { peak: 0.10, off: 0.05 }, output: { peak: 9.0, off: 4.5 } },
  'deepseek-v4-pro': { inputMiss: { peak: 9.0, off: 4.5 }, inputHit: { peak: 0.30, off: 0.15 }, output: { peak: 27.0, off: 13.5 } },
}
const FALLBACK = PRICES['deepseek-v4-flash']

export function isPeak(date) {
  const h = (date.getUTCHours() + 8) % 24
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

// 解析模型名 → 价格表条目。先精确匹配，再按前缀匹配以覆盖带版本后缀的
// 模型 id（如 deepseek-v4-pro-0813 匹配 deepseek-v4-pro）。
function resolvePriceTable(model) {
  const m = String(model || '')
  for (const key of Object.keys(PRICES)) {
    if (m === key || m.startsWith(key + '-') || m.startsWith(key + '_')) return PRICES[key]
  }
  return undefined
}

// 返回该时刻的具体单价（元/百万 tokens）
export function priceFor(model, date) {
  const table = resolvePriceTable(model) || FALLBACK
  const peak = isPeak(date)
  const pick = (v) => (peak ? v.peak : v.off)
  return {
    input: pick(table.inputMiss),
    cacheRead: pick(table.inputHit),
    cacheWrite: pick(table.inputMiss),
    output: pick(table.output),
    estimated: resolvePriceTable(model) === undefined,
    peak,
  }
}

// 模型名归一化到价格表 key（带版本后缀如 deepseek-v4-flash-0731 → deepseek-v4-flash），
// 未收录模型保留原始名。归一化后的名字同时作为统计与计价缓存的 key。
export function normalizeModel(model) {
  const m = String(model || 'unknown')
  for (const key of Object.keys(PRICES)) {
    if (m === key || m.startsWith(key + '-') || m.startsWith(key + '_')) return key
  }
  return m
}

// 存储 key 与查询名的前缀匹配（兼容历史 key 分裂：deepseek-v4-flash + deepseek-v4-flash-0731）
export function prefixMatch(stored, wanted) {
  const s = String(stored || '')
  const w = String(wanted || '')
  return s === w || s.startsWith(w + '-') || s.startsWith(w + '_')
}

// 模型名比对：两侧先归一到价格表 key 再前缀匹配。会话配置里的模型名可能带版本后缀
// （deepseek-v4-flash-0731）而统计 key 已归一化，双向归一后才能在两个方向命中同族记录。
export function modelMatches(stored, wanted) {
  return prefixMatch(normalizeModel(stored), normalizeModel(wanted))
}

// ── 计价缓存（cost ledger）───────────────────────────────────────────────────
// 设计要点：**历史花费一经记录即冻结**。
// 每次实时消耗都会按「发生时刻」写入一个小时分桶（北京时间整点），桶内记录：
//   at        该整点的 UTC 毫秒时间戳（真实时间点）
//   peak      该时刻属于高峰还是空闲
//   models.*  该模型在这个小时内的调用次数、三档 token、三档真实花费、当时单价快照
// 之后的高峰/空闲切换、跨天、进程重启都不会改变已记录的费用——
// 展示层只做「求和」，不再用当前时间给历史 token 重新定价。
const LEDGER_VERSION = 1
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const LEDGER_MAX_BUCKETS = 720 // 保留最近 720 个整点（30 天），更早的折叠进 settled
const LEDGER_VIEW_MAX = 24 // 对外暴露的最近分桶行数

// 北京时间整点的 UTC 毫秒（用于排序、裁剪与展示）
export function beijingHourStart(date) {
  return Math.floor((date.getTime() + BEIJING_OFFSET_MS) / 3600000) * 3600000 - BEIJING_OFFSET_MS
}

// 北京时间整点 key：'2026-09-14T09'（+08:00）
export function beijingHourKey(date) {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return shifted.getUTCFullYear() + '-' + p(shifted.getUTCMonth() + 1) + '-' + p(shifted.getUTCDate()) + 'T' + p(shifted.getUTCHours())
}

export function emptyLedger() {
  return { v: LEDGER_VERSION, buckets: {}, settled: {}, costCny: 0, tokens: 0 }
}

// 分桶裁剪：超过保留窗口的最旧整点折叠进 settled（按模型汇总），
// 只丢时间粒度、不丢费用——合计仍然精确。
function pruneLedger(ledger) {
  const keys = Object.keys(ledger.buckets)
  if (keys.length <= LEDGER_MAX_BUCKETS) return
  keys.sort((a, b) => ledger.buckets[a].at - ledger.buckets[b].at)
  for (const key of keys.slice(0, keys.length - LEDGER_MAX_BUCKETS)) {
    const bucket = ledger.buckets[key]
    for (const model of Object.keys(bucket.models)) {
      const row = bucket.models[model]
      let s = ledger.settled[model]
      if (!s) {
        s = { calls: 0, missTokens: 0, hitTokens: 0, outputTokens: 0, missCostCny: 0, hitCostCny: 0, outputCostCny: 0, hours: 0, firstAt: bucket.at, lastAt: bucket.at }
        ledger.settled[model] = s
      }
      s.calls += row.calls
      s.missTokens += row.missTokens
      s.hitTokens += row.hitTokens
      s.outputTokens += row.outputTokens
      s.missCostCny += row.missCostCny
      s.hitCostCny += row.hitCostCny
      s.outputCostCny += row.outputCostCny
      s.hours += 1
      s.firstAt = Math.min(s.firstAt, bucket.at)
      s.lastAt = Math.max(s.lastAt, bucket.at)
    }
    delete ledger.buckets[key]
  }
}

// 记录一次消耗：把「具体时间 + 当时单价」写进计价缓存，返回按该单价冻结的真实费用。
// 费用用本次调用的实际单价计算（row.price 是该小时首次出现时的单价快照，供展示与审计）。
export function ledgerAdd(ledger, model, date, tiers, price) {
  if (!ledger || typeof ledger !== 'object') return 0
  if (!ledger.buckets) ledger.buckets = {}
  if (!ledger.settled) ledger.settled = {}
  const miss = (tiers.inputTokens || 0) + (tiers.cacheWriteTokens || 0)
  const hit = tiers.cacheReadTokens || 0
  const out = tiers.outputTokens || 0
  const missCost = miss * price.input / 1e6
  const hitCost = hit * price.cacheRead / 1e6
  const outCost = out * price.output / 1e6
  const cost = missCost + hitCost + outCost
  const key = beijingHourKey(date)
  const at = beijingHourStart(date)
  let bucket = ledger.buckets[key]
  if (!bucket) {
    bucket = { at, peak: !!price.peak, models: {} }
    ledger.buckets[key] = bucket
  }
  let row = bucket.models[model]
  if (!row) {
    row = {
      peak: !!price.peak,
      estimated: !!price.estimated,
      price: { input: price.input, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, output: price.output },
      calls: 0, missTokens: 0, hitTokens: 0, outputTokens: 0,
      missCostCny: 0, hitCostCny: 0, outputCostCny: 0,
    }
    bucket.models[model] = row
  }
  row.calls += 1
  row.missTokens += miss
  row.hitTokens += hit
  row.outputTokens += out
  row.missCostCny += missCost
  row.hitCostCny += hitCost
  row.outputCostCny += outCost
  ledger.costCny = (ledger.costCny || 0) + cost
  ledger.tokens = (ledger.tokens || 0) + miss + hit + out
  pruneLedger(ledger)
  return cost
}

// 从计价缓存读出某个模型（model 为空 = 全部模型）的冻结三档合计
export function ledgerTotals(ledger, model) {
  const out = {
    calls: 0, missTokens: 0, hitTokens: 0, outputTokens: 0,
    missCostCny: 0, hitCostCny: 0, outputCostCny: 0, totalCostCny: 0,
    hours: 0, peakTokens: 0, offTokens: 0, firstAt: null, lastAt: null, estimated: false,
  }
  if (!ledger || typeof ledger !== 'object') return out
  const wanted = model === null || model === undefined ? null : normalizeModel(model)
  const add = (row, peak, at) => {
    out.calls += row.calls || 0
    out.missTokens += row.missTokens || 0
    out.hitTokens += row.hitTokens || 0
    out.outputTokens += row.outputTokens || 0
    out.missCostCny += row.missCostCny || 0
    out.hitCostCny += row.hitCostCny || 0
    out.outputCostCny += row.outputCostCny || 0
    if (row.estimated) out.estimated = true
    const tok = (row.missTokens || 0) + (row.hitTokens || 0) + (row.outputTokens || 0)
    if (peak) out.peakTokens += tok
    else out.offTokens += tok
    if (typeof at === 'number') {
      out.hours += 1
      out.firstAt = out.firstAt === null ? at : Math.min(out.firstAt, at)
      out.lastAt = out.lastAt === null ? at : Math.max(out.lastAt, at)
    }
  }
  for (const key of Object.keys(ledger.buckets || {})) {
    const bucket = ledger.buckets[key]
    for (const name of Object.keys(bucket.models || {})) {
      if (wanted !== null && !modelMatches(name, wanted)) continue
      add(bucket.models[name], bucket.peak, bucket.at)
    }
  }
  for (const name of Object.keys(ledger.settled || {})) {
    if (wanted !== null && !modelMatches(name, wanted)) continue
    add(ledger.settled[name], false, null)
  }
  out.totalCostCny = out.missCostCny + out.hitCostCny + out.outputCostCny
  return out
}

// 计价缓存的可视快照：最近 LEDGER_VIEW_MAX 个整点 + 折叠归档 + 合计
export function ledgerView(ledger, model) {
  const wanted = model === null || model === undefined ? null : normalizeModel(model)
  const rows = []
  for (const key of Object.keys((ledger && ledger.buckets) || {})) {
    const bucket = ledger.buckets[key]
    let calls = 0
    let miss = 0
    let hit = 0
    let out = 0
    let cost = 0
    const models = []
    const price = {}
    for (const name of Object.keys(bucket.models || {})) {
      if (wanted !== null && !modelMatches(name, wanted)) continue
      const row = bucket.models[name]
      calls += row.calls || 0
      miss += row.missTokens || 0
      hit += row.hitTokens || 0
      out += row.outputTokens || 0
      cost += (row.missCostCny || 0) + (row.hitCostCny || 0) + (row.outputCostCny || 0)
      models.push(name)
      price[name] = row.price
    }
    if (calls === 0) continue
    rows.push({
      hour: key,
      at: bucket.at,
      peak: !!bucket.peak,
      calls,
      missTokens: miss,
      hitTokens: hit,
      outputTokens: out,
      tokens: miss + hit + out,
      costCny: cost,
      models,
      price,
    })
  }
  rows.sort((a, b) => b.at - a.at)
  const settled = []
  for (const name of Object.keys((ledger && ledger.settled) || {})) {
    if (wanted !== null && !modelMatches(name, wanted)) continue
    const s = ledger.settled[name]
    settled.push({
      model: name,
      hours: s.hours || 0,
      calls: s.calls || 0,
      tokens: (s.missTokens || 0) + (s.hitTokens || 0) + (s.outputTokens || 0),
      costCny: (s.missCostCny || 0) + (s.hitCostCny || 0) + (s.outputCostCny || 0),
      firstAt: s.firstAt || null,
      lastAt: s.lastAt || null,
    })
  }
  settled.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  const totals = ledgerTotals(ledger, model)
  return {
    hours: rows.length,
    shown: rows.slice(0, LEDGER_VIEW_MAX),
    truncated: Math.max(0, rows.length - LEDGER_VIEW_MAX),
    settled,
    costCny: totals.totalCostCny,
    tokens: totals.missTokens + totals.hitTokens + totals.outputTokens,
    peakTokens: totals.peakTokens,
    offTokens: totals.offTokens,
    firstAt: totals.firstAt,
    lastAt: totals.lastAt,
  }
}

const DATA_FILE = join(process.env.DSH_HOME || (process.env.HOME || '') + '/.dsh', 'dsh-balance-and-cost.json')
const BALANCE_CACHE_MS = 60000
const SAVE_DEBOUNCE_MS = 10000

function emptyTotals() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCny: 0, anyEstimated: false, perModel: {} }
}

function emptySession() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCny: 0, models: {}, modelsTok: {}, ledger: emptyLedger() }
}

// 恢复计价缓存：缺少 buckets/settled 时补空结构（旧版本落盘没有 ledger，
// 这部分历史 token 由 scopeBreakdown 用「已记录的真实费用残差」兜底分摊）
export function reviveLedger(raw) {
  const ledger = emptyLedger()
  if (!raw || typeof raw !== 'object') return ledger
  for (const key of Object.keys(raw.buckets || {})) {
    const bucket = raw.buckets[key]
    if (!bucket || typeof bucket !== 'object' || !bucket.models) continue
    ledger.buckets[key] = {
      at: typeof bucket.at === 'number' ? bucket.at : (Date.parse(key + ':00:00+08:00') || 0),
      peak: !!bucket.peak,
      models: bucket.models,
    }
  }
  for (const name of Object.keys(raw.settled || {})) ledger.settled[name] = raw.settled[name]
  ledger.costCny = typeof raw.costCny === 'number' ? raw.costCny : 0
  ledger.tokens = typeof raw.tokens === 'number' ? raw.tokens : 0
  return ledger
}

function loadStats() {
  try {
    if (!existsSync(DATA_FILE)) return null
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const stats = {
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
      totals: { ...emptyTotals(), ...(raw.totals || {}) },
      sessions: {},
      baseline: raw.baseline || null,
      ledger: reviveLedger(raw.ledger),
    }
    for (const key of Object.keys(raw.sessions || {})) {
      const session = { ...emptySession(), ...raw.sessions[key] }
      session.ledger = reviveLedger(raw.sessions[key] && raw.sessions[key].ledger)
      stats.sessions[key] = session
    }
    return stats
  } catch {
    return null
  }
}

function saveStats(stats) {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    const tmp = DATA_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(stats))
    renameSync(tmp, DATA_FILE)
  } catch {
    // 忽略持久化失败（只影响重启后的恢复）
  }
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// 三档用量拆分（与官方计费口径一致）：输入·缓存未命中（含缓存写入，官方按未命中价收）/
// 输入·缓存命中 / 输出。**该函数用 date 时刻的单价计算，只用于兜底估算**——
// 正式展示请用 scopeBreakdown（读计价缓存里冻结的真实费用）。
export function usageBreakdown(row, model, date) {
  const p = priceFor(model, date)
  const miss = (row.inputTokens || 0) + (row.cacheWriteTokens || 0)
  const hit = row.cacheReadTokens || 0
  const out = row.outputTokens || 0
  const missCost = miss * p.input / 1e6
  const hitCost = hit * p.cacheRead / 1e6
  const outCost = out * p.output / 1e6
  return {
    missTokens: miss,
    hitTokens: hit,
    outputTokens: out,
    totalTokens: miss + hit + out,
    missCostCny: missCost,
    hitCostCny: hitCost,
    outputCostCny: outCost,
    totalCostCny: missCost + hitCost + outCost,
  }
}

export function tokensFromRow(row) {
  const miss = (row.inputTokens || 0) + (row.cacheWriteTokens || 0)
  const hit = row.cacheReadTokens || 0
  const out = row.outputTokens || 0
  return { miss, hit, out, total: miss + hit + out }
}

// 展示口径的三档拆分：
// - 费用主体来自计价缓存（每次消耗发生时刻的单价，已冻结），因此时段切换不会改变历史花费；
// - 旧版本落盘的历史 token 没有时间记录，用「已记录的真实总费用 − 缓存已计费用」作为残差，
//   按当前单价权重分摊（仅是拆分近似，**合计始终等于记录的真实费用**），并标记 approximate。
// date 只参与残差权重，不参与已记录部分——这就是「价格不再突变」的关键。
export function scopeBreakdown(tokens, recordedCostCny, ledger, model, date) {
  const led = ledgerTotals(ledger, model)
  const residueMiss = Math.max(0, tokens.miss - led.missTokens)
  const residueHit = Math.max(0, tokens.hit - led.hitTokens)
  const residueOut = Math.max(0, tokens.out - led.outputTokens)
  const residueTokens = residueMiss + residueHit + residueOut
  let missCost = led.missCostCny
  let hitCost = led.hitCostCny
  let outCost = led.outputCostCny
  if (residueTokens > 0) {
    const p = priceFor(model || '', date)
    const wMiss = residueMiss * p.input / 1e6
    const wHit = residueHit * p.cacheRead / 1e6
    const wOut = residueOut * p.output / 1e6
    const wSum = wMiss + wHit + wOut
    const residueCost = Math.max(0, (recordedCostCny || 0) - led.totalCostCny)
    if (wSum > 0) {
      const factor = residueCost / wSum
      missCost += wMiss * factor
      hitCost += wHit * factor
      outCost += wOut * factor
    } else if (residueCost > 0) {
      missCost += residueCost
    }
  }
  // 归一：合计必须等于记录的真实费用（三档之和 = 合计）
  const rawSum = missCost + hitCost + outCost
  const target = typeof recordedCostCny === 'number' && Number.isFinite(recordedCostCny) ? recordedCostCny : rawSum
  const k = rawSum > 0 ? target / rawSum : 0
  return {
    missTokens: tokens.miss,
    hitTokens: tokens.hit,
    outputTokens: tokens.out,
    totalTokens: tokens.total,
    missCostCny: missCost * k,
    hitCostCny: hitCost * k,
    outputCostCny: outCost * k,
    totalCostCny: rawSum * k,
    // 计价缓存信息：frozen 部分是逐次消耗冻结的真实费用，approximate 表示含无时间记录的历史 token
    frozenCostCny: led.totalCostCny,
    residueTokens,
    approximate: residueTokens > 0,
    hours: led.hours,
    peakTokens: led.peakTokens,
    offTokens: led.offTokens,
  }
}

// 全局总计的三档汇总：每个模型各自读自己的计价缓存（旧数据用各自单价分摊残差）后相加，
// 再按 totals.costCny（逐次调用冻结的真实费用之和）归一。
function totalsBreakdown(stats, date) {
  let miss = 0
  let hit = 0
  let out = 0
  let missC = 0
  let hitC = 0
  let outC = 0
  let frozen = 0
  let residue = 0
  let approximate = false
  for (const key of Object.keys(stats.totals.perModel)) {
    const r = stats.totals.perModel[key]
    const b = scopeBreakdown(tokensFromRow(r), r.costCny || 0, stats.ledger, r.model, date)
    miss += b.missTokens
    hit += b.hitTokens
    out += b.outputTokens
    missC += b.missCostCny
    hitC += b.hitCostCny
    outC += b.outputCostCny
    frozen += b.frozenCostCny
    residue += b.residueTokens
    if (b.approximate) approximate = true
  }
  const rawSum = missC + hitC + outC
  const target = stats.totals.costCny || 0
  const k = rawSum > 0 ? target / rawSum : 0
  return {
    missTokens: miss,
    hitTokens: hit,
    outputTokens: out,
    totalTokens: miss + hit + out,
    missCostCny: missC * k,
    hitCostCny: hitC * k,
    outputCostCny: outC * k,
    totalCostCny: rawSum * k,
    frozenCostCny: frozen * k,
    residueTokens: residue,
    approximate,
  }
}

export function apply(ctx) {
  const stats = loadStats() || { startedAt: Date.now(), totals: emptyTotals(), sessions: {}, baseline: null, ledger: emptyLedger() }
  if (!stats.ledger) stats.ledger = emptyLedger()
  let saveTimer = null
  const scheduleSave = () => {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveStats(stats)
    }, SAVE_DEBOUNCE_MS)
  }

  // SSE 实时推送：模型选择变化 / 用量产生时通知浏览器，避免轮询延迟
  const sseClients = new Set()
  let lastUsageBroadcast = 0
  const sseBroadcast = (data) => {
    const payload = 'data: ' + JSON.stringify(data) + '\n\n'
    for (const client of sseClients) {
      try {
        client.write(payload)
      } catch {
        // 忽略单个断连客户端
      }
    }
  }
  const maybeBroadcastUsage = () => {
    const now = Date.now()
    if (now - lastUsageBroadcast < 2000) return
    lastUsageBroadcast = now
    sseBroadcast({ type: 'usage' })
  }
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n')
      } catch {
        // 忽略
      }
    }
  }, 30000)
  // 会话模型选择变化（用户切换模型）→ 即时推送
  ctx.on('settings/updated', (ns) => {
    if (String(ns) === 'agent-default-model') sseBroadcast({ type: 'selection' })
  })

  // 统计 DeepSeek 路由的每次模型调用：总计 + 按会话；费用按调用时刻的时段计价
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    const provider = String((options && options.provider) || '')
    if (provider.toLowerCase().indexOf('deepseek') === -1) return stream
    const model = String((options && options.model) || 'unknown')
    const sid = options && options.sessionId ? String(options.sessionId) : null
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'usage' && chunk.usage) {
          const u = chunk.usage
          const i = u.inputTokens || 0
          const o = u.outputTokens || 0
          const cr = u.cacheReadTokens || 0
          const cw = u.cacheWriteTokens || 0
          const rt = u.reasoningTokens || 0
          // 计价缓存的写入时刻 = 消耗发生的具体时间：单价按这一刻判定并冻结，
          // 返回的 cost 就是这次消耗的真实花费（之后任何时段变化都不会改动它）
          const at = new Date()
          const price = priceFor(model, at)
          const normModel = normalizeModel(model)
          const cost = ledgerAdd(stats.ledger, normModel, at, { inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw }, price)
          stats.totals.calls += 1
          stats.totals.inputTokens += i
          stats.totals.outputTokens += o
          stats.totals.cacheReadTokens += cr
          stats.totals.cacheWriteTokens += cw
          stats.totals.reasoningTokens += rt
          stats.totals.costCny += cost
          if (price.estimated) stats.totals.anyEstimated = true
          const key = provider + ':' + model
          let row = stats.totals.perModel[key]
          if (!row) {
            row = { provider, model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0, estimated: price.estimated }
            stats.totals.perModel[key] = row
          }
          row.calls += 1
          row.inputTokens += i
          row.outputTokens += o
          row.cacheReadTokens += cr
          row.cacheWriteTokens += cw
          row.costCny += cost
          if (sid) {
            let s = stats.sessions[sid]
            if (!s) {
              s = emptySession()
              stats.sessions[sid] = s
            }
            s.calls += 1
            s.inputTokens += i
            s.outputTokens += o
            s.cacheReadTokens += cr
            s.cacheWriteTokens += cw
            s.reasoningTokens += rt
            s.costCny += cost
            // 会话级计价缓存：同一份「时间 + 单价」记录，供本会话三档悬停读取
            ledgerAdd(s.ledger, normModel, at, { inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw }, price)
            // 模型名归一化到价格表 key（带版本后缀如 deepseek-v4-flash-0731 → deepseek-v4-flash），
            // 保证 models/modelsTok 的 key 与价格表、悬停查询一致；未收录模型保留原始名
            s.models[normModel] = (s.models[normModel] || 0) + 1
            // 按模型细分 token（供「当前模型实际消耗」与悬停两模型对比）
            let mt = s.modelsTok[normModel]
            if (!mt) {
              mt = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0 }
              s.modelsTok[normModel] = mt
            }
            mt.inputTokens += i
            mt.outputTokens += o
            mt.cacheReadTokens += cr
            mt.cacheWriteTokens += cw
            mt.costCny += cost
          }
          scheduleSave()
          maybeBroadcastUsage()
        }
        yield chunk
      }
    })()
  })

  // 查询 DeepSeek 余额（Node 内置 fetch；Key 经 credentials 服务解析）
  async function fetchBalance() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { ok: false, error: 'credentials 服务不可用' }
    const cred = await credentials.resolve('DEEPSEEK_API_KEY')
    if (!cred || !cred.value) return { ok: false, error: '未配置 DEEPSEEK_API_KEY（请在 ~/.dsh/.credentials.yaml 中设置）' }
    let json
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return { ok: false, error: '余额接口 HTTP ' + res.status }
      json = await res.json()
    } catch (e) {
      return { ok: false, error: '余额查询失败：' + String((e && e.message) || e) }
    }
    const info = Array.isArray(json.balance_infos) ? json.balance_infos[0] : undefined
    if (!info) return { ok: false, error: '响应缺少 balance_infos' }
    return {
      ok: true,
      isAvailable: !!json.is_available,
      currency: String(info.currency || ''),
      totalBalance: Number(info.total_balance),
      grantedBalance: Number(info.granted_balance),
      toppedUpBalance: Number(info.topped_up_balance),
    }
  }

  // 余额查询 60 秒缓存
  let balanceCache = { at: 0, value: null }
  async function getBalanceCached() {
    const now = Date.now()
    if (balanceCache.value && now - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value
    const result = await fetchBalance()
    if (result.ok && stats.baseline === null) {
      stats.baseline = { totalBalance: result.totalBalance, currency: result.currency }
      scheduleSave()
    }
    balanceCache = { at: now, value: result }
    return result
  }

  function rowView(row) {
    return {
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens || 0,
      costCny: row.costCny || 0,
      models: row.models ? Object.keys(row.models) : [],
    }
  }

  async function usageSnapshot(sessionId) {
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : null
    const currentRow = sid && stats.sessions[sid] ? stats.sessions[sid] : emptySession()
    const perModel = Object.keys(stats.totals.perModel).map((key) => {
      const r = stats.totals.perModel[key]
      return { provider: r.provider, model: r.model, calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costCny: r.costCny, estimated: r.estimated }
    })
    // 会话标题（sessionQuery.readTitle，读取失败或未命名则回退 null）
    const sessionQueryService = ctx.get('sessionQuery')
    const titleOf = async (id) => {
      if (!sessionQueryService || typeof sessionQueryService.readTitle !== 'function') return null
      try {
        const t = await sessionQueryService.readTitle(id)
        return t && t.title ? String(t.title) : null
      } catch {
        return null
      }
    }
    const sessions = []
    for (const id of Object.keys(stats.sessions)) {
      const s = stats.sessions[id]
      // 分模型明细：价格表内模型（flash/pro）+ 该会话实际用过的所有模型；
      // 聚合精确与全部前缀 key（兼容历史 key 分裂）；未调用模型给 0 占位。
      const sessionModelKeys = new Set([...Object.keys(PRICES), ...Object.keys(s.models), ...Object.keys(s.modelsTok || {})])
      const modelsDetail = []
      for (const m of sessionModelKeys) {
        let calls = 0
        let tokens = 0
        let costCny = 0
        for (const k of Object.keys(s.models)) {
          if (modelMatches(k, m)) calls += s.models[k] || 0
        }
        for (const k of Object.keys(s.modelsTok || {})) {
          if (modelMatches(k, m)) {
            const t = s.modelsTok[k]
            tokens += (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0)
            costCny += t.costCny || 0
          }
        }
        modelsDetail.push({ model: m, calls, tokens, costCny })
      }
      modelsDetail.sort((a, b) => {
        if (a.calls !== b.calls) return b.calls - a.calls
        if (a.tokens !== b.tokens) return b.tokens - a.tokens
        return a.model < b.model ? -1 : 1
      })
      sessions.push({
        sessionId: id,
        title: await titleOf(id),
        calls: s.calls,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        reasoningTokens: s.reasoningTokens,
        costCny: s.costCny,
        models: Object.keys(s.models).sort((a, b) => (s.models[b] || 0) - (s.models[a] || 0)),
        modelsDetail,
      })
    }
    sessions.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
    const totals = rowView(stats.totals)
    totals.anyEstimated = stats.totals.anyEstimated
    totals.perModel = perModel
    // 会话当前选中的模型：优先读该会话最近的请求配置（会话日志 requestHeader，
    // 持久化、按会话隔离——切到哪个对话框就显示哪个），否则回退全局默认。
    let selectedModel = null
    if (sid) {
      const agentsService = ctx.get('agents')
      if (agentsService && typeof agentsService.get === 'function') {
        const agent = agentsService.get(sid)
        if (agent && agent.session && typeof agent.session.requestHeader === 'function') {
          const header = agent.session.requestHeader()
          if (header && header.config && header.config.model) {
            selectedModel = { provider: String(header.config.provider || ''), model: String(header.config.model) }
          }
        }
      }
    }
    if (selectedModel === null) {
      const defaultModelService = ctx.get('agentDefaultModel')
      if (defaultModelService && typeof defaultModelService.currentSelection === 'function') {
        const sel = defaultModelService.currentSelection()
        if (sel && sel.model) {
          selectedModel = { provider: String(sel.provider || ''), model: String(sel.model) }
        }
      }
    }
    const current = rowView(currentRow)
    // 当前会话按模型的实际消耗（实时累计值，供摘要条「本会话(当前选中模型)」与悬停两模型对比）。
    // 聚合精确 key 与所有前缀 key（兼容历史 key 分裂：deepseek-v4-flash + deepseek-v4-flash-0731）。
    const modelTokens = (m) => {
      let tokens = 0
      let costCny = 0
      for (const k of Object.keys(currentRow.modelsTok || {})) {
        if (modelMatches(k, m)) {
          const t = currentRow.modelsTok[k]
          tokens += (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0)
          costCny += t.costCny || 0
        }
      }
      return { tokens, costCny }
    }
    // 价格表内的模型（flash / pro）两两对比；选中模型排前并标注
    current.modelsActual = Object.keys(PRICES)
      .map((m) => {
        const v = modelTokens(m)
        return { model: m, tokens: v.tokens, costCny: v.costCny, selected: selectedModel !== null && m === selectedModel.model }
      })
      .sort((a, b) => {
        if (a.selected !== b.selected) return a.selected ? -1 : 1
        return b.tokens - a.tokens
      })
    // 当前选中模型的实际消耗（本会话格直接显示）
    current.selectedActual = selectedModel ? modelTokens(selectedModel.model) : { tokens: 0, costCny: 0 }
    const now = new Date()
    // 三档拆分全部读计价缓存（消耗发生时刻的单价，已冻结）：
    // 已记录部分永不随当前时段变化，因此高峰/空闲切换不会造成历史花费跳变。
    const modelTokensRow = (m) => {
      const row = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      for (const k of Object.keys(currentRow.modelsTok || {})) {
        if (modelMatches(k, m)) {
          const t = currentRow.modelsTok[k]
          row.inputTokens += t.inputTokens || 0
          row.outputTokens += t.outputTokens || 0
          row.cacheReadTokens += t.cacheReadTokens || 0
          row.cacheWriteTokens += t.cacheWriteTokens || 0
        }
      }
      return row
    }
    current.selectedBreakdown = selectedModel
      ? scopeBreakdown(tokensFromRow(modelTokensRow(selectedModel.model)), modelTokens(selectedModel.model).costCny, currentRow.ledger, selectedModel.model, now)
      : null
    totals.breakdown = totalsBreakdown(stats, now)
    // 计价缓存视图（设置页「计价缓存（按小时）」用）：记录每次消耗的具体时间与当时单价
    const pricing = ledgerView(stats.ledger, null)
    pricing.currentSession = sid ? ledgerView(currentRow.ledger, null) : null
    pricing.maxBuckets = LEDGER_MAX_BUCKETS
    return {
      startedAt: stats.startedAt,
      totals,
      current,
      baseline: stats.baseline,
      sessions,
      peak: isPeak(new Date()),
      selectedModel,
      pricing,
    }
  }

  const disposers = []
  if (ctx.webServer !== undefined) {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/balance',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        getBalanceCached().then((value) => sendJson(res, value)).catch((e) => {
          sendJson(res, { ok: false, error: String((e && e.message) || e) })
        })
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/usage',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        const url = new URL(req.url || '/', 'http://localhost')
        usageSnapshot(url.searchParams.get('sessionId')).then((value) => sendJson(res, value)).catch((e) => {
          sendJson(res, { ok: false, error: String((e && e.message) || e) })
        })
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/reset',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        stats.totals = emptyTotals()
        stats.sessions = {}
        stats.baseline = null
        stats.startedAt = Date.now()
        stats.ledger = emptyLedger()
        balanceCache = { at: 0, value: null }
        saveStats(stats)
        sseBroadcast({ type: 'usage' })
        sendJson(res, { ok: true })
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/events',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write('retry: 5000\n\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
      },
    }))
  }

  ctx.on('dispose', () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    clearInterval(heartbeat)
    for (const client of sseClients) {
      try {
        client.end()
      } catch {
        // 忽略
      }
    }
    sseClients.clear()
    saveStats(stats)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 忽略卸载期异常
      }
    }
  })

  console.log('[dsh-balance-and-cost] 已激活：llm/stream 统计 + 余额/用量路由')
}
