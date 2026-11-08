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
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-balance-and-cost'
// webServer 只在 Web 组合里存在：不再作为硬依赖，headless/CLI 组合里仍然统计用量；
// Web 组合里再用 ctx.inject(['webServer'], …) 注册 HTTP 端点（见 apply）。
export const inject = []

// 北京时间偏移：高峰/空闲判定与整点分桶都用它，且与宿主时区无关。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

// 官方价格表（api-docs.deepseek.com/zh-cn/quick_start/pricing，人民币 / 百万 tokens）。
// 现行表：DeepSeek-V4.1-Flash-1017 + DeepSeek-V4-Pro-0813（2026-09-10 12:00 起的价格未再变动）：
//   deepseek-flash（V4.1-Flash）：未命中 高峰2/空闲1，命中 高峰0.04/空闲0.02，输出 高峰8/空闲4
//   deepseek-v4-pro（V4-Pro-0813）：未命中 高峰9/空闲4.5，命中 高峰0.30/空闲0.15，输出 高峰27/空闲13.5
// 高峰 = 北京时间**周一至周五（不含中国法定节假日）** 9:00-12:00、14:00-18:00；其余（含周末与
// 法定节假日）为空闲。缓存写入按输入未命中计价；未收录模型按 deepseek-flash 估算。
// 价格表可通过 $DSH_HOME/dsh-balance-and-cost.pricing.json（或 DSH_BALANCE_AND_COST_PRICING 指向的
// JSON 文件）覆盖，见 apply 里的 loadPricingOverrides / configurePricing。
const DEFAULT_PRICES = {
  'deepseek-flash': { inputMiss: { peak: 2.0, off: 1.0 }, inputHit: { peak: 0.04, off: 0.02 }, output: { peak: 8.0, off: 4.0 } },
  'deepseek-v4-pro': { inputMiss: { peak: 9.0, off: 4.5 }, inputHit: { peak: 0.30, off: 0.15 }, output: { peak: 27.0, off: 13.5 } },
}
const FALLBACK_KEY = 'deepseek-flash'
const DEFAULT_PEAK_WINDOWS = [
  { weekdays: [1, 2, 3, 4, 5], start: 9, end: 12 },
  { weekdays: [1, 2, 3, 4, 5], start: 14, end: 18 },
]
// 2026 年法定节假日（国办发明电〔2025〕7 号，含调休形成的连休；周末本来就算空闲，重复无影响）。
// 只影响高峰/空闲判定；2027 年及以后可用定价配置文件覆盖。
const DEFAULT_HOLIDAY_RANGES = [
  ['2026-01-01', 3], ['2026-02-15', 9], ['2026-04-04', 3], ['2026-05-01', 5],
  ['2026-06-19', 3], ['2026-09-25', 3], ['2026-10-01', 7],
]

const clone = (value) => JSON.parse(JSON.stringify(value))

function expandDateRange(start, days) {
  const out = []
  const base = Date.parse(start + 'T00:00:00Z')
  for (let i = 0; i < days; i += 1) out.push(new Date(base + i * 86400000).toISOString().slice(0, 10))
  return out
}
const DEFAULT_HOLIDAYS = DEFAULT_HOLIDAY_RANGES.flatMap(([start, days]) => expandDateRange(start, days))

let PRICES = clone(DEFAULT_PRICES)
let PEAK_WINDOWS = clone(DEFAULT_PEAK_WINDOWS)
let HOLIDAYS = new Set(DEFAULT_HOLIDAYS)
let PRICING_SOURCE = 'builtin'

// 只统计官方 DeepSeek 路由（deepseek-official / deepseek-account）。不做 provider 子串匹配，
// 避免把名为 my-deepseek-proxy 的第三方路由按官方价计费。可用 DSH_BALANCE_AND_COST_PROVIDERS
// 或定价配置文件的 providers 数组覆盖。
const DEFAULT_PROVIDERS = ['deepseek-official', 'deepseek-account']
let METERED_PROVIDERS = new Set(DEFAULT_PROVIDERS)

export function isMeteredProvider(provider) {
  return METERED_PROVIDERS.has(String(provider || '').trim().toLowerCase())
}

function fallbackTable() {
  return PRICES[FALLBACK_KEY] || Object.values(PRICES)[0] || DEFAULT_PRICES[FALLBACK_KEY]
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isDateString = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

function parsePriceTable(table) {
  if (!isObject(table)) return null
  const picked = {}
  for (const key of ['inputMiss', 'inputHit', 'output']) {
    const pair = table[key]
    if (!isObject(pair) || !isPositiveNumber(pair.peak) || !isPositiveNumber(pair.off)) return null
    picked[key] = { peak: pair.peak, off: pair.off }
  }
  return picked
}

function parsePeakWindow(window) {
  if (!isObject(window)) return null
  const weekdays = Array.isArray(window.weekdays) ? window.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : []
  const start = window.start
  const end = window.end
  if (weekdays.length === 0) return null
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) return null
  return { weekdays: [...new Set(weekdays)], start, end }
}

// 覆盖内置价格表/高峰窗口/节假日。只影响**之后**产生的消耗；历史费用仍以计价缓存为准。
// 返回 { applied, errors }，供启动日志和设置页展示。
export function configurePricing(config, meta = {}) {
  const errors = []
  if (!isObject(config)) return { applied: false, errors: ['config is not an object'], priceChanged: false }
  let applied = false
  let priceChanged = false
  if (config.models !== undefined) {
    if (!isObject(config.models)) {
      errors.push('models must be an object')
    } else {
      const next = {}
      for (const [model, table] of Object.entries(config.models)) {
        const parsed = parsePriceTable(table)
        if (parsed === null) errors.push('invalid price table for ' + model)
        else next[String(model).toLowerCase()] = parsed
      }
      if (Object.keys(next).length > 0) {
        PRICES = next
        applied = true
        priceChanged = true
      }
    }
  }
  if (config.peakWindows !== undefined) {
    if (!Array.isArray(config.peakWindows)) {
      errors.push('peakWindows must be an array')
    } else {
      const windows = config.peakWindows.map(parsePeakWindow).filter((item) => item !== null)
      if (windows.length === 0) errors.push('peakWindows contains no valid window')
      else {
        PEAK_WINDOWS = windows
        applied = true
        priceChanged = true
      }
    }
  }
  if (config.holidays !== undefined) {
    if (!Array.isArray(config.holidays)) {
      errors.push('holidays must be an array of YYYY-MM-DD strings')
    } else {
      const valid = config.holidays.filter(isDateString)
      if (valid.length !== config.holidays.length) errors.push('holidays contains invalid dates')
      HOLIDAYS = new Set(valid)
      applied = true
      priceChanged = true
    }
  }
  if (config.providers !== undefined) {
    if (!Array.isArray(config.providers)) {
      errors.push('providers must be an array of provider ids')
    } else {
      const list = config.providers.map((p) => String(p || '').trim().toLowerCase()).filter((p) => p.length > 0)
      if (list.length === 0) errors.push('providers contains no valid provider id')
      else {
        METERED_PROVIDERS = new Set(list)
        applied = true
      }
    }
  }
  if (priceChanged) {
    PRICING_SOURCE = meta.source || 'config'
    PRICING_INFO.source = PRICING_SOURCE
    PRICING_INFO.modelVersion = Object.keys(PRICES).join(' / ')
  }
  return { applied, errors, priceChanged }
}

// 模型名 → 价格表 key 的别名表（官方改名/下线后旧名仍会路由到新模型并按其单价计费）：
//   deepseek-v4-flash、deepseek-v4-flash-vision-exp  → 由 DeepSeek-V4.1-Flash 提供服务，按 Flash 计价
//   deepseek-v4-pro-0813 等版本后缀                  → 归到 deepseek-v4-pro
const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

// 归一化时允许裁掉的版本/日期后缀：0731、1017、v4.1、2026-09-10、vision-exp 等。
// 不能裁掉 deepseek-flash-lite / deepseek-flash-pro 这类真正不同的模型（否则会被错误并入 flash 计价）。
const VERSION_SUFFIX = /^(?:v?\d+(?:[.-]\d+)*|vision-exp|\d{4}(?:-\d{2}){0,2})$/i

// 价格表元信息：版本号用于「历史分桶换表重算」的一次性迁移（见 apply 内 repriceLedger）。
// v3：高峰规则补上「不含中国法定节假日」，启动时按新规则重算一次历史分桶的时段标记。
export const PRICING_VERSION = 3
export const PRICING_INFO = {
  version: PRICING_VERSION,
  effectiveAt: '2026-09-10T12:00:00+08:00',
  modelVersion: 'DeepSeek-V4.1-Flash-1017 / DeepSeek-V4-Pro-0813',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  peakRule: '高峰 = 北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00；其余（含周末与法定节假日）为空闲',
  holidayRule: '2026 年法定节假日按国办发明电〔2025〕7 号；可用定价配置文件覆盖',
}

// 北京时间的日/时/日期（与宿主时区无关）
function beijingParts(date) {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return {
    day: shifted.getUTCDay(), // 0=周日 … 6=周六
    hour: shifted.getUTCHours(),
    date: shifted.getUTCFullYear() + '-' + p(shifted.getUTCMonth() + 1) + '-' + p(shifted.getUTCDate()),
  }
}

// 高峰判定：落在任一高峰窗口内，且当天不是中国法定节假日（节假日全天空闲，周末本来就不在窗口内）
export function isPeak(date) {
  const { day, hour, date: ymd } = beijingParts(date)
  if (HOLIDAYS.has(ymd)) return false
  return PEAK_WINDOWS.some((w) => w.weekdays.includes(day) && hour >= w.start && hour < w.end)
}

// 解析模型名 → 价格表条目。先查别名表（覆盖改名与版本后缀），未收录返回 undefined。
function resolvePriceTable(model) {
  return PRICES[normalizeModel(model)]
}

// 返回该时刻的具体单价（元/百万 tokens）
export function priceFor(model, date) {
  const table = resolvePriceTable(model) || fallbackTable()
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

// 模型名归一化到价格表 key：先查别名（官方改名/下线后的旧名），再按别名 + 明确的版本/日期后缀
// 匹配（deepseek-v4-pro-0813 → deepseek-v4-pro），未收录模型保留原始名。
// 归一化后的名字同时作为统计与计价缓存的 key。
export function normalizeModel(model) {
  const raw = String(model || 'unknown')
  const m = raw.toLowerCase()
  if (MODEL_ALIASES[m] !== undefined) return MODEL_ALIASES[m]
  for (const alias of Object.keys(MODEL_ALIASES)) {
    if (m.length <= alias.length + 1) continue
    if (!m.startsWith(alias + '-') && !m.startsWith(alias + '_')) continue
    if (VERSION_SUFFIX.test(m.slice(alias.length + 1))) return MODEL_ALIASES[alias]
  }
  return raw
}

// 存储 key 与查询名的前缀匹配（保留给外部/历史调用；统计内部已改用归一化后的精确匹配）
export function prefixMatch(stored, wanted) {
  const s = String(stored || '')
  const w = String(wanted || '')
  return s === w || s.startsWith(w + '-') || s.startsWith(w + '_')
}

// 模型名比对：两侧先归一到价格表 key 再比较。会话配置里的模型名可能带版本后缀
// （deepseek-v4-flash-0731）而统计 key 已归一化，归一后精确相等才算是同一模型——
// 不再做任意前缀匹配，避免 deepseek-flash-lite 之类被并入 flash。
export function modelMatches(stored, wanted) {
  return normalizeModel(stored) === normalizeModel(wanted)
}

// ── 计价缓存（cost ledger）───────────────────────────────────────────────────
// 设计要点：**历史花费一经记录即冻结**。
// 每次实时消耗都会按「发生时刻」写入一个小时分桶（北京时间整点），桶内记录：
//   at        该整点的 UTC 毫秒时间戳（真实时间点）
//   peak      该时刻属于高峰还是空闲
//   models.*  该模型在这个小时内的调用次数、三档 token、三档真实花费、当时单价快照
// 之后的高峰/空闲切换、跨天、进程重启都不会改变已记录的费用——
// 展示层只做「求和」，不再用当前时间给历史 token 重新定价。
// 计价缓存版本 = 价格表版本：两者一起递增，用于「换表重算」的一次性迁移标记
const LEDGER_VERSION = PRICING_VERSION
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
        s = {
          calls: 0, missTokens: 0, hitTokens: 0, outputTokens: 0,
          missCostCny: 0, hitCostCny: 0, outputCostCny: 0,
          hours: 0, peakTokens: 0, offTokens: 0,
          firstAt: bucket.at, lastAt: bucket.at,
        }
        ledger.settled[model] = s
      }
      s.calls += row.calls
      s.missTokens += row.missTokens
      s.hitTokens += row.hitTokens
      s.outputTokens += row.outputTokens
      s.missCostCny += row.missCostCny
      s.hitCostCny += row.hitCostCny
      s.outputCostCny += row.outputCostCny
      // 归档时保留高峰/空闲口径，否则 30 天后的「高峰/空闲 token」会全部算成空闲
      const tok = (row.missTokens || 0) + (row.hitTokens || 0) + (row.outputTokens || 0)
      if (bucket.peak) s.peakTokens = (s.peakTokens || 0) + tok
      else s.offTokens = (s.offTokens || 0) + tok
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
  const addCounts = (row) => {
    out.calls += row.calls || 0
    out.missTokens += row.missTokens || 0
    out.hitTokens += row.hitTokens || 0
    out.outputTokens += row.outputTokens || 0
    out.missCostCny += row.missCostCny || 0
    out.hitCostCny += row.hitCostCny || 0
    out.outputCostCny += row.outputCostCny || 0
    if (row.estimated) out.estimated = true
    return (row.missTokens || 0) + (row.hitTokens || 0) + (row.outputTokens || 0)
  }
  const addAt = (at) => {
    if (typeof at !== 'number') return
    out.hours += 1
    out.firstAt = out.firstAt === null ? at : Math.min(out.firstAt, at)
    out.lastAt = out.lastAt === null ? at : Math.max(out.lastAt, at)
  }
  for (const key of Object.keys(ledger.buckets || {})) {
    const bucket = ledger.buckets[key]
    for (const name of Object.keys(bucket.models || {})) {
      if (wanted !== null && !modelMatches(name, wanted)) continue
      const tok = addCounts(bucket.models[name])
      if (bucket.peak) out.peakTokens += tok
      else out.offTokens += tok
      addAt(bucket.at)
    }
  }
  for (const name of Object.keys(ledger.settled || {})) {
    if (wanted !== null && !modelMatches(name, wanted)) continue
    const row = ledger.settled[name]
    const tok = addCounts(row)
    // 新归档保留时段拆分；旧数据没有时段信息，按空闲计（与升级前行为一致）
    if (typeof row.peakTokens === 'number' || typeof row.offTokens === 'number') {
      out.peakTokens += row.peakTokens || 0
      out.offTokens += row.offTokens || 0
    } else {
      out.offTokens += tok
    }
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

// 把某作用域（总计 / 某会话）的聚合计费按「模型 → 差额」同步一次。
// 聚合行可能按 provider:model 或历史前缀 key 分裂，这里把每个模型的差额落到第一处命中的行上。
function applyCostDelta(scope, delta) {
  const remaining = { ...delta }
  const take = (name) => {
    const key = normalizeModel(name)
    const value = remaining[key] || 0
    remaining[key] = 0
    return value
  }
  let sum = 0
  for (const key of Object.keys(delta)) sum += delta[key]
  if (scope.kind === 'totals') {
    scope.stats.totals.costCny = Math.max(0, (scope.stats.totals.costCny || 0) + sum)
    for (const key of Object.keys(scope.stats.totals.perModel || {})) {
      const row = scope.stats.totals.perModel[key]
      row.costCny = Math.max(0, (row.costCny || 0) + take(row.model))
    }
    return sum
  }
  const session = scope.session
  session.costCny = Math.max(0, (session.costCny || 0) + sum)
  for (const key of Object.keys(session.modelsTok || {})) {
    session.modelsTok[key].costCny = Math.max(0, (session.modelsTok[key].costCny || 0) + take(key))
  }
  return sum
}

// 换表重算（价格表版本变化时的一次性迁移）：
// 把计价缓存里每个分桶按它**记录下来的时间**用新价格表重算——时间取自记录、只换表，
// 所以不会出现「按当前时段重算历史」的突变；同时把官方改名后的旧模型 key
// （deepseek-v4-flash*）合并到新名字下，并按新规则重判时段（如周末为空闲）。
// 差额同步进对应作用域的聚合费用，保证界面各处一致。
// 没有时间记录的历史 token（0.2.0 之前只有聚合值、以及被裁掉的归档分桶）不参与重算。
export function repriceLedger(stats) {
  const scopes = [{ kind: 'totals', stats, ledger: stats.ledger }]
  for (const sid of Object.keys(stats.sessions || {})) {
    scopes.push({ kind: 'session', session: stats.sessions[sid], ledger: stats.sessions[sid].ledger })
  }
  const costOf = (row) => (row.missCostCny || 0) + (row.hitCostCny || 0) + (row.outputCostCny || 0)
  let repriced = false
  for (const scope of scopes) {
    const ledger = scope.ledger
    if (!ledger || ledger.v === PRICING_VERSION) continue
    const oldByModel = {}
    const newByModel = {}
    for (const key of Object.keys(ledger.buckets || {})) {
      const bucket = ledger.buckets[key]
      const at = new Date(bucket.at)
      const peak = isPeak(at)
      bucket.peak = peak
      const merged = {}
      for (const name of Object.keys(bucket.models || {})) {
        const row = bucket.models[name]
        const model = normalizeModel(name)
        oldByModel[model] = (oldByModel[model] || 0) + costOf(row)
        const price = priceFor(model, at)
        let target = merged[model]
        if (!target) {
          target = {
            peak,
            estimated: !!price.estimated,
            price: { input: price.input, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, output: price.output },
            calls: 0, missTokens: 0, hitTokens: 0, outputTokens: 0,
            missCostCny: 0, hitCostCny: 0, outputCostCny: 0,
          }
          merged[model] = target
        }
        target.calls += row.calls || 0
        target.missTokens += row.missTokens || 0
        target.hitTokens += row.hitTokens || 0
        target.outputTokens += row.outputTokens || 0
      }
      for (const model of Object.keys(merged)) {
        const row = merged[model]
        const price = row.price
        row.missCostCny = row.missTokens * price.input / 1e6
        row.hitCostCny = row.hitTokens * price.cacheRead / 1e6
        row.outputCostCny = row.outputTokens * price.output / 1e6
        newByModel[model] = (newByModel[model] || 0) + costOf(row)
      }
      bucket.models = merged
    }
    const delta = {}
    for (const model of Object.keys(oldByModel)) {
      delta[model] = (newByModel[model] || 0) - oldByModel[model]
    }
    for (const model of Object.keys(newByModel)) {
      if (oldByModel[model] !== undefined) continue
      delta[model] = newByModel[model]
    }
    const sum = applyCostDelta(scope, delta)
    ledger.costCny = Math.max(0, (ledger.costCny || 0) + sum)
    ledger.v = PRICING_VERSION
    repriced = true
  }
  return repriced
}

// 统计文件位置：$DSH_HOME（与 DSH 其余用户数据一致），未设置时退到 ~/.dsh。
// 注意 Windows 上必须用 os.homedir()（HOME 往往为空，早先写成 `HOME || ''` 会让路径
// 变成驱动器相对的 `\.dsh\...`，统计被写到当前盘根目录），这里同时保留旧位置作为迁移来源。
const DATA_FILENAME = 'dsh-balance-and-cost.json'
export const DSH_HOME_DIR = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
// 显式覆盖（自定义位置 / 测试用）：给出后不再探测旧位置
const EXPLICIT_DATA_FILE = (process.env.DSH_BALANCE_AND_COST_FILE || '').trim()
const DATA_FILE = EXPLICIT_DATA_FILE || join(DSH_HOME_DIR, DATA_FILENAME)
// 旧版本可能落在这些位置（按优先级）：
//  1) $HOME/.dsh/  —— 旧代码在 HOME 有值时的落点
//  2) cwd 所在盘根的 \.dsh\ —— 旧代码在 HOME 为空时写出的驱动器相对路径（Windows）
// 另可用 DSH_BALANCE_AND_COST_LEGACY_FILES 显式指定（多路径分隔符 ; / :，测试与手工迁移用）。
const ENV_LEGACY_FILES = (process.env.DSH_BALANCE_AND_COST_LEGACY_FILES || '').trim()
export const LEGACY_DATA_FILES = ENV_LEGACY_FILES
  ? ENV_LEGACY_FILES.split(process.platform === 'win32' ? ';' : ':').map((p) => p.trim()).filter((p) => p.length > 0)
  : (EXPLICIT_DATA_FILE
    ? []
    : [
      process.env.HOME ? join(process.env.HOME, '.dsh', DATA_FILENAME) : null,
      resolve('/.dsh/' + DATA_FILENAME),
    ].filter((p) => p !== null && p !== DATA_FILE))

// 读取一个统计文件（含 size/mtime，用于记录「该分片已被消费」的指纹）
function readOneStatsFile(path) {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    let mtimeMs = 0
    let size = 0
    try {
      const st = statSync(path)
      mtimeMs = st.mtimeMs
      size = st.size
    } catch {
      mtimeMs = 0
      size = 0
    }
    return { path, raw, mtimeMs, size }
  } catch {
    return null
  }
}

// 旧版本在 HOME 为空时会把统计写到「当前盘根」的 \.dsh\，换一次启动目录就会换一个盘，
// 因此迁移时额外扫描各盘符（仅 Windows，且只在需要迁移时用到）。
function driveRootLegacyFiles() {
  if (process.platform !== 'win32') return []
  const found = []
  for (let code = 65; code <= 90; code++) {
    const root = String.fromCharCode(code) + ':'
    if (!existsSync(root + '\\')) continue
    const path = root + '\\.dsh\\' + DATA_FILENAME
    if (existsSync(path)) found.push(path)
  }
  return found
}

// 迁移扫描：新位置优先，其后是已知旧位置与各盘根旧位置（去重）
export function candidateStatsPaths() {
  const list = [DATA_FILE, ...LEGACY_DATA_FILES]
  if (!existsSync(DATA_FILE) && ENV_LEGACY_FILES === '' && EXPLICIT_DATA_FILE === '') {
    for (const path of driveRootLegacyFiles()) if (!list.includes(path)) list.push(path)
  }
  return list
}

// 读取第一个存在的统计文件（新位置优先）
function readStatsFile() {
  for (const path of candidateStatsPaths()) {
    const found = readOneStatsFile(path)
    if (found !== null) return found
  }
  return null
}

// 判定旧文件是不是「同一份数据的副本」：它的每个会话都已在主文件里、且调用次数完全一致。
// 不同进程写出的分片即使会话 id 相同，各进程也只统计自己发起的调用，次数不会雷同，
// 因此该判定只拦真正的文件副本（保留导出供测试/诊断）。
export function isDuplicateShard(primarySessions, otherSessions) {
  const ids = Object.keys(otherSessions || {})
  if (ids.length === 0) return false
  for (const id of ids) {
    const mine = primarySessions[id]
    if (mine === undefined) return false
    if ((mine.calls || 0) !== (otherSessions[id].calls || 0)) return false
  }
  return true
}

// 旧文件的内容是否已被主文件「包含」：每个会话都在主文件里且调用次数不少于旧文件。
// 保留为诊断/测试工具；实际合并策略见 isDisjointShard。
export function isContainedShard(primarySessions, otherSessions) {
  const ids = Object.keys(otherSessions || {})
  if (ids.length === 0) return false
  for (const id of ids) {
    const mine = primarySessions[id]
    if (mine === undefined) return false
    if ((mine.calls || 0) < (otherSessions[id].calls || 0)) return false
  }
  return true
}

// 只有「所有会话都还没出现在主文件里」的旧分片才整体合并。
// 只要有一个会话重叠，就说明这份旧文件与主文件同源（迁移前的副本/子集），
// 整体合并会把重叠会话重复计数——宁可跳过，也不要把金额算多。
export function isDisjointShard(primarySessions, otherSessions) {
  const ids = Object.keys(otherSessions || {})
  if (ids.length === 0) return false
  for (const id of ids) {
    if (primarySessions[id] !== undefined) return false
  }
  return true
}

// 记录一个分片已被消费（path → 指纹）。持久化在统计文件里，跨重启生效。
export function recordConsumedShard(stats, path, extra = {}) {
  if (!stats || !path) return
  if (!stats.mergedShards || typeof stats.mergedShards !== 'object') stats.mergedShards = {}
  let fingerprint = {}
  try {
    const st = statSync(path)
    fingerprint = { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  } catch {
    fingerprint = {}
  }
  stats.mergedShards[path] = { at: Date.now(), ...fingerprint, ...extra }
}

// 哪些旧文件需要合并进主文件：排除主文件自身、已消费过的（mergedShards）、
// 空分片，以及任何与主文件存在会话重叠的旧文件。
export function planLegacyMerge(primary, others, mergedShards = {}) {
  const primarySessions = primary.sessions || {}
  return others.filter((other) => {
    if (other.path === primary.path) return false
    if (mergedShards && mergedShards[other.path]) return false
    return isDisjointShard(primarySessions, other.sessions)
  })
}

function mergeLedgerInto(dst, src) {
  if (!src) return
  for (const key of Object.keys(src.buckets || {})) {
    const from = src.buckets[key]
    const to = dst.buckets[key]
    if (!to) {
      dst.buckets[key] = from
      continue
    }
    for (const model of Object.keys(from.models || {})) {
      const a = to.models[model]
      const b = from.models[model]
      if (!a) {
        to.models[model] = b
        continue
      }
      a.calls += b.calls || 0
      a.missTokens += b.missTokens || 0
      a.hitTokens += b.hitTokens || 0
      a.outputTokens += b.outputTokens || 0
      a.missCostCny += b.missCostCny || 0
      a.hitCostCny += b.hitCostCny || 0
      a.outputCostCny += b.outputCostCny || 0
    }
  }
  for (const model of Object.keys(src.settled || {})) {
    const from = src.settled[model]
    const to = dst.settled[model]
    if (!to) {
      dst.settled[model] = from
      continue
    }
    to.calls += from.calls || 0
    to.missTokens += from.missTokens || 0
    to.hitTokens += from.hitTokens || 0
    to.outputTokens += from.outputTokens || 0
    to.missCostCny += from.missCostCny || 0
    to.hitCostCny += from.hitCostCny || 0
    to.outputCostCny += from.outputCostCny || 0
    to.hours += from.hours || 0
    to.firstAt = Math.min(to.firstAt || from.firstAt || 0, from.firstAt || to.firstAt || 0)
    to.lastAt = Math.max(to.lastAt || 0, from.lastAt || 0)
  }
  dst.costCny = (dst.costCny || 0) + (src.costCny || 0)
  dst.tokens = (dst.tokens || 0) + (src.tokens || 0)
  dst.v = Math.min(typeof dst.v === 'number' ? dst.v : 0, typeof src.v === 'number' ? src.v : 0)
}

const SUM_FIELDS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costCny']

// 把 perModel 归一到「provider:归一化模型名」：升级前后的旧名（deepseek-v4-flash）与新名
// （deepseek-flash）合并成一行，并按当前价目表重算 estimated（不再让旧标记永久粘住）。
export function normalizePerModel(perModel) {
  const out = {}
  for (const key of Object.keys(perModel || {})) {
    const row = perModel[key]
    if (!row || typeof row !== 'object') continue
    const provider = String(row.provider || String(key).split(':')[0] || '')
    const model = normalizeModel(row.model || String(key).split(':').slice(1).join(':') || key)
    const nk = provider + ':' + model
    let target = out[nk]
    if (!target) {
      target = out[nk] = { ...row, provider, model }
      target.estimated = PRICES[model] === undefined
    } else {
      for (const field of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costCny']) {
        target[field] = (target[field] || 0) + (row[field] || 0)
      }
    }
  }
  for (const key of Object.keys(out)) out[key].estimated = PRICES[out[key].model] === undefined
  return out
}

// 合并两份互补的统计（分片）：计数相加、会话并集、计价缓存按整点相加
export function mergeStats(target, extra) {
  target.startedAt = Math.min(target.startedAt, extra.startedAt)
  if (!target.baseline && extra.baseline) target.baseline = extra.baseline
  for (const field of SUM_FIELDS) target.totals[field] = (target.totals[field] || 0) + (extra.totals[field] || 0)
  target.totals.anyEstimated = !!target.totals.anyEstimated || !!extra.totals.anyEstimated
  for (const key of Object.keys(extra.totals.perModel || {})) {
    const from = extra.totals.perModel[key]
    const to = target.totals.perModel[key]
    if (!to) {
      target.totals.perModel[key] = from
      continue
    }
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costCny']) {
      to[field] = (to[field] || 0) + (from[field] || 0)
    }
    to.estimated = !!to.estimated || !!from.estimated
  }
  for (const sid of Object.keys(extra.sessions || {})) {
    const from = extra.sessions[sid]
    const to = target.sessions[sid]
    if (!to) {
      target.sessions[sid] = from
      continue
    }
    for (const field of SUM_FIELDS) to[field] = (to[field] || 0) + (from[field] || 0)
    for (const model of Object.keys(from.models || {})) to.models[model] = (to.models[model] || 0) + (from.models[model] || 0)
    for (const model of Object.keys(from.modelsTok || {})) {
      const src = from.modelsTok[model]
      let dst = to.modelsTok[model]
      if (!dst) {
        dst = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0 }
        to.modelsTok[model] = dst
      }
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costCny']) {
        dst[field] = (dst[field] || 0) + (src[field] || 0)
      }
    }
    mergeLedgerInto(to.ledger, from.ledger)
  }
  mergeLedgerInto(target.ledger, extra.ledger)
  for (const path of Object.keys(extra.mergedShards || {})) {
    if (!target.mergedShards) target.mergedShards = {}
    if (!target.mergedShards[path]) target.mergedShards[path] = extra.mergedShards[path]
  }
  target.totals.perModel = normalizePerModel(target.totals.perModel)
  return target
}

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
  // 保留落盘的价格表版本：缺失但存在分桶时视为「未知旧表」(0)，以便触发换表重算
  ledger.v = typeof raw.v === 'number'
    ? raw.v
    : (Object.keys(raw.buckets || {}).length > 0 ? 0 : LEDGER_VERSION)
  return ledger
}

// 把某个文件解析成运行期 stats 结构
function statsFromRaw(raw, path) {
  const stats = {
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
    totals: { ...emptyTotals(), ...(raw.totals || {}) },
    sessions: {},
    baseline: raw.baseline || null,
    ledger: reviveLedger(raw.ledger),
    loadedFrom: path,
    mergedShards: raw.mergedShards && typeof raw.mergedShards === 'object' ? raw.mergedShards : {},
  }
  stats.totals.perModel = normalizePerModel(stats.totals.perModel)
  for (const key of Object.keys(raw.sessions || {})) {
    const session = { ...emptySession(), ...raw.sessions[key] }
    session.ledger = reviveLedger(raw.sessions[key] && raw.sessions[key].ledger)
    stats.sessions[key] = session
  }
  return stats
}

function loadStats() {
  try {
    const primary = readStatsFile()
    if (primary === null) return null
    const stats = statsFromRaw(primary.raw, primary.path)
    // 旧位置可能留下互补的分片（例如换启动目录后写到另一个盘根，或多个实例各写一份）：
    // 已消费过的（mergedShards）、副本、以及内容已被主文件包含的旧快照都跳过，避免重复计数。
    const others = candidateStatsPaths()
      .map((path) => {
        const found = readOneStatsFile(path)
        if (found === null) return null
        return { path: found.path, raw: found.raw, sessions: found.raw.sessions || {}, size: found.size, mtimeMs: found.mtimeMs }
      })
      .filter((item) => item !== null)
    const merged = planLegacyMerge({ path: primary.path, sessions: stats.sessions }, others, stats.mergedShards)
    for (const item of merged) {
      const shardStats = statsFromRaw(item.raw, item.path)
      mergeStats(stats, shardStats)
      recordConsumedShard(stats, item.path, { merged: true, calls: shardStats.totals.calls || 0 })
    }
    // 未合并的旧文件也登记一次（副本/已被包含/已消费），后续启动不再重复判断
    for (const item of others) {
      if (item.path === primary.path) continue
      if (stats.mergedShards[item.path]) continue
      recordConsumedShard(stats, item.path, {
        merged: false,
        reason: isDuplicateShard(stats.sessions, item.sessions) ? 'duplicate' : 'overlap',
      })
    }
    stats.mergedFrom = merged.map((item) => item.path)
    return stats
  } catch {
    return null
  }
}

let saveErrorLogged = false

function saveStats(stats) {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true })
    const tmp = DATA_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(stats))
    // 覆盖前留一份上一版，JSON 损坏/误重置时还能找回
    if (existsSync(DATA_FILE)) {
      try {
        copyFileSync(DATA_FILE, DATA_FILE + '.bak')
      } catch {
        // 备份失败不影响主写入
      }
    }
    renameSync(tmp, DATA_FILE)
    saveErrorLogged = false
  } catch (error) {
    if (!saveErrorLogged) {
      saveErrorLogged = true
      console.warn('[dsh-balance-and-cost] 统计保存失败（本次运行仍会继续统计，重启后可能丢失）: ' + String((error && error.message) || error))
    }
  }
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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
  return breakdownFromLedger(tokens, recordedCostCny, ledgerTotals(ledger, model), model, date)
}

// 用一份已经取好的计价缓存合计做三档拆分（totals 汇总时按模型族各取一次，避免重复计入）
function breakdownFromLedger(tokens, recordedCostCny, led, model, date) {
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

const EMPTY_LEDGER_TOTALS = {
  calls: 0, missTokens: 0, hitTokens: 0, outputTokens: 0,
  missCostCny: 0, hitCostCny: 0, outputCostCny: 0, totalCostCny: 0,
  hours: 0, peakTokens: 0, offTokens: 0, firstAt: null, lastAt: null, estimated: false,
}

// 每个归一化模型一份 ledger 合计（同族新旧 key 只算一次）
function ledgerByModel(ledger) {
  const names = new Set()
  for (const key of Object.keys((ledger && ledger.buckets) || {})) {
    for (const name of Object.keys(ledger.buckets[key].models || {})) names.add(normalizeModel(name))
  }
  for (const name of Object.keys((ledger && ledger.settled) || {})) names.add(normalizeModel(name))
  const map = new Map()
  for (const name of names) map.set(name, ledgerTotals(ledger, name))
  return map
}

// 全局总计的三档汇总：每个模型族各取一次自己的计价缓存（旧数据用各自单价分摊残差）后相加，
// 再按 totals.costCny（逐次调用冻结的真实费用之和）归一。
function totalsBreakdown(stats, date) {
  let miss = 0
  let hit = 0
  let out = 0
  let missC = 0
  let hitC = 0
  let outC = 0
  let residue = 0
  let approximate = false
  const ledMap = ledgerByModel(stats.ledger)
  const used = new Set()
  for (const key of Object.keys(stats.totals.perModel)) {
    const r = stats.totals.perModel[key]
    const family = normalizeModel(r.model)
    // 同一模型族只把 ledger 计入一次（不同 provider 也可能用同一模型名）
    const led = used.has(family) ? EMPTY_LEDGER_TOTALS : (ledMap.get(family) || EMPTY_LEDGER_TOTALS)
    used.add(family)
    const b = breakdownFromLedger(tokensFromRow(r), r.costCny || 0, led, r.model, date)
    miss += b.missTokens
    hit += b.hitTokens
    out += b.outputTokens
    missC += b.missCostCny
    hitC += b.hitCostCny
    outC += b.outputCostCny
    residue += b.residueTokens
    if (b.approximate) approximate = true
  }
  const rawSum = missC + hitC + outC
  const target = stats.totals.costCny || 0
  const k = rawSum > 0 ? target / rawSum : 0
  const ledAll = ledgerTotals(stats.ledger, null)
  const ledTokens = ledAll.missTokens + ledAll.hitTokens + ledAll.outputTokens
  const tokenTotal = miss + hit + out
  return {
    missTokens: miss,
    hitTokens: hit,
    outputTokens: out,
    totalTokens: tokenTotal,
    missCostCny: missC * k,
    hitCostCny: hitC * k,
    outputCostCny: outC * k,
    totalCostCny: rawSum * k,
    frozenCostCny: ledAll.totalCostCny,
    residueTokens: Math.max(residue, tokenTotal - ledTokens),
    approximate: approximate || tokenTotal > ledTokens,
  }
}

// 定价配置文件：默认 $DSH_HOME/dsh-balance-and-cost.pricing.json，可用 DSH_BALANCE_AND_COST_PRICING 指定。
// 只影响之后的消耗；历史费用仍以计价缓存里冻结的单价为准。
function pricingConfigPath() {
  const explicit = (process.env.DSH_BALANCE_AND_COST_PRICING || '').trim()
  return explicit || join(DSH_HOME_DIR, 'dsh-balance-and-cost.pricing.json')
}

function loadPricingOverrides() {
  const path = pricingConfigPath()
  if (!existsSync(path)) return { applied: false, path, errors: [], priceChanged: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const result = configurePricing(raw, { source: path })
    return { ...result, path }
  } catch (error) {
    return { applied: false, path, errors: [String((error && error.message) || error)], priceChanged: false }
  }
}

export function apply(ctx) {
  // 供应商白名单可先用环境变量给，再被定价配置文件覆盖
  const envProviders = (process.env.DSH_BALANCE_AND_COST_PROVIDERS || '').trim()
  if (envProviders) {
    configurePricing({ providers: envProviders.split(',').map((p) => p.trim()).filter((p) => p.length > 0) }, { source: 'env' })
  }
  const pricingConfig = loadPricingOverrides()
  const stats = loadStats() || { startedAt: Date.now(), totals: emptyTotals(), sessions: {}, baseline: null, ledger: emptyLedger(), mergedShards: {} }
  if (!stats.ledger) stats.ledger = emptyLedger()
  if (!stats.mergedShards) stats.mergedShards = {}
  // 会话标题短期缓存：轮询/SSE 刷新很频繁，标题却几乎不变
  const titleCache = new Map()
  const TITLE_CACHE_MS = 30000
  // 价格表版本变化 → 按各分桶记录的时间用新表重算一次（时间不变，只换表）。
  // 用户用定价配置文件改了价格/窗口/节假日时跳过：配置只影响之后的消耗，历史费用保持冻结。
  const repriced = pricingConfig.priceChanged ? false : repriceLedger(stats)
  // 统计文件迁移到 $DSH_HOME（旧位置见 LEGACY_DATA_FILES），分片互补时已合并
  const migrated = stats.loadedFrom !== undefined && stats.loadedFrom !== DATA_FILE
  // 迁移来源本身也要登记为「已消费」，否则旧文件会在之后的每次启动被当成新分片再次合并
  if (migrated && stats.loadedFrom) recordConsumedShard(stats, stats.loadedFrom, { migrated: true })
  if (repriced || migrated || (stats.mergedFrom && stats.mergedFrom.length > 0)) saveStats(stats)
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
  // 模型选择变化（用户切换模型）→ 即时推送。DSH 0.2.x 的事件名是 settings/document-updated，
  // 旧的 settings/updated 已不存在（监听它会静默失效，只能靠 15s 轮询兜底）。
  ctx.on('settings/document-updated', (ns) => {
    if (String(ns || '') === 'agent-default-model') sseBroadcast({ type: 'selection' })
  })

  // 统计 DeepSeek 路由的每次模型调用：总计 + 按会话；费用按调用时刻的时段计价
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    const provider = String((options && options.provider) || '')
    if (!isMeteredProvider(provider)) return stream
    const model = String((options && options.model) || 'unknown')
    const sid = options && options.sessionId ? String(options.sessionId) : null
    // 计费时刻取「请求发起时刻」而不是 usage chunk 到达时刻：流式请求可能跨 12:00/18:00，
    // 官方按请求发生的时间段计价，跨时段的调用不能按结束时刻算。
    const requestAt = new Date()
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'usage' && chunk.usage) {
          const u = chunk.usage
          const i = u.inputTokens || 0
          const o = u.outputTokens || 0
          const cr = u.cacheReadTokens || 0
          const cw = u.cacheWriteTokens || 0
          const rt = u.reasoningTokens || 0
          const at = requestAt
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
          // perModel 以「provider:归一化模型名」为 key：升级前后的旧名不会再分裂成两行，
          // estimated 每次写入都按当前价目表刷新（不再永久粘住旧标记）。
          const key = provider + ':' + normModel
          let row = stats.totals.perModel[key]
          if (!row) {
            row = { provider, model: normModel, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0, estimated: false }
            stats.totals.perModel[key] = row
          }
          row.provider = provider
          row.model = normModel
          row.estimated = !!price.estimated
          row.calls += 1
          row.inputTokens += i
          row.outputTokens += o
          row.cacheReadTokens += cr
          row.cacheWriteTokens += cw
          row.costCny += cost
          stats.totals.anyEstimated = Object.keys(stats.totals.perModel).some((k) => !!stats.totals.perModel[k].estimated)
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

  // ── 余额 ──────────────────────────────────────────────────────────────────
  // 优先走 DSH 官方账号服务（deepseekAccount，账号登录用户没有 API Key），
  // 未登录/失败时再回退 API Key + 官方 /user/balance。两种来源都返回多钱包/多币种。

  function accountClientMeta() {
    return {
      version: '0.4.0',
      locale: 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  // 把「充值钱包 + 赠送钱包」按币种合并：total = toppedUp + granted
  function walletSummary(recharge, bonus) {
    const byCurrency = new Map()
    const ensure = (currency) => {
      const key = String(currency || '')
      let item = byCurrency.get(key)
      if (!item) {
        item = { currency: key, toppedUp: 0, granted: 0, total: 0 }
        byCurrency.set(key, item)
      }
      return item
    }
    for (const wallet of recharge || []) {
      if (!wallet || typeof wallet.currency !== 'string') continue
      const item = ensure(wallet.currency)
      item.toppedUp += Number(wallet.balance) || 0
    }
    for (const wallet of bonus || []) {
      if (!wallet || typeof wallet.currency !== 'string') continue
      const item = ensure(wallet.currency)
      item.granted += Number(wallet.balance) || 0
    }
    for (const item of byCurrency.values()) item.total = item.toppedUp + item.granted
    return [...byCurrency.values()]
  }

  // 主展示钱包：优先 CNY，其次第一个
  function pickWallet(wallets) {
    return (wallets || []).find((w) => w.currency === 'CNY') || (wallets || [])[0] || null
  }

  function balanceResult(source, isAvailable, wallets) {
    const primary = pickWallet(wallets)
    if (!primary) return { ok: false, source, error: '余额响应为空' }
    return {
      ok: true,
      source,
      isAvailable: !!isAvailable,
      currency: primary.currency,
      totalBalance: primary.total,
      grantedBalance: primary.granted,
      toppedUpBalance: primary.toppedUp,
      wallets,
    }
  }

  async function fetchAccountBalance() {
    const account = ctx.get('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') return null
    let result
    try {
      result = await account.getBalance(accountClientMeta())
    } catch (e) {
      return { ok: false, source: 'account', error: '账号余额查询失败：' + String((e && e.message) || e) }
    }
    if (result === null || result === undefined) return null // 未登录 → 回退 API Key
    if (result.status !== 'ready') return { ok: false, source: 'account', error: '账号余额查询失败' }
    const wallets = walletSummary(result.value, result.bonusWallets)
    return balanceResult('account', true, wallets)
  }

  // 余额接口地址：默认官方；网关/中转可用 DSH_BALANCE_AND_COST_BASE_URL 覆盖
  function balanceEndpoint() {
    const raw = (process.env.DSH_BALANCE_AND_COST_BASE_URL || '').trim() || 'https://api.deepseek.com'
    try {
      return new URL('/user/balance', new URL(raw).origin).href
    } catch {
      return 'https://api.deepseek.com/user/balance'
    }
  }

  async function fetchApiKeyBalance() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { ok: false, source: 'api-key', error: 'credentials 服务不可用' }
    // 默认 DEEPSEEK_API_KEY；用户改过 apiKeyEnv 时可用 DSH_BALANCE_AND_COST_API_KEY_ENV 指定
    const refs = []
    const envRef = (process.env.DSH_BALANCE_AND_COST_API_KEY_ENV || '').trim()
    if (envRef) refs.push(envRef)
    refs.push('DEEPSEEK_API_KEY')
    let cred = null
    let lastError = null
    for (const ref of [...new Set(refs)]) {
      try {
        const found = await credentials.resolve(ref)
        if (found && found.value) {
          cred = found
          break
        }
      } catch (e) {
        lastError = e
      }
    }
    if (cred === null) {
      if (lastError) return { ok: false, source: 'api-key', error: '读取凭据失败：' + String((lastError && lastError.message) || lastError) }
      return { ok: false, source: 'api-key', error: '未配置 DEEPSEEK_API_KEY（可在 ~/.dsh/.credentials.yaml 或环境变量中设置）' }
    }
    let json
    try {
      const res = await fetch(balanceEndpoint(), {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return { ok: false, source: 'api-key', error: '余额接口 HTTP ' + res.status }
      json = await res.json()
    } catch (e) {
      return { ok: false, source: 'api-key', error: '余额查询失败：' + String((e && e.message) || e) }
    }
    const infos = Array.isArray(json && json.balance_infos) ? json.balance_infos : []
    // 官方允许同时返回 CNY / USD 等多个钱包，逐个保留而不是只取第一个
    const wallets = infos
      .filter((info) => info && typeof info.currency === 'string')
      .map((info) => ({
        currency: String(info.currency),
        total: Number(info.total_balance),
        granted: Number(info.granted_balance) || 0,
        toppedUp: Number(info.topped_up_balance) || 0,
      }))
      .filter((wallet) => Number.isFinite(wallet.total))
    if (wallets.length === 0) return { ok: false, source: 'api-key', error: '响应缺少 balance_infos' }
    return balanceResult('api-key', json.is_available, wallets)
  }

  async function fetchBalance() {
    const account = await fetchAccountBalance()
    if (account && account.ok) return account
    const apiKey = await fetchApiKeyBalance()
    if (apiKey.ok) return apiKey
    // 账号已登录但查询失败时，优先展示账号的错误（更贴近用户当前状态）
    return account || apiKey
  }

  // 余额基线：按币种分别记录（首次成功查询时建立）
  function baselineWallets(baseline) {
    if (!baseline) return {}
    if (baseline.wallets && typeof baseline.wallets === 'object') return baseline.wallets
    if (baseline.currency && typeof baseline.totalBalance === 'number') return { [baseline.currency]: baseline.totalBalance }
    return {}
  }

  // 余额查询 60 秒缓存
  let balanceCache = { at: 0, value: null }
  async function getBalanceCached() {
    const now = Date.now()
    if (balanceCache.value && now - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value
    const result = await fetchBalance()
    if (result.ok && stats.baseline === null) {
      stats.baseline = {
        at: Date.now(),
        currency: result.currency,
        totalBalance: result.totalBalance,
        wallets: Object.fromEntries((result.wallets || []).map((w) => [w.currency, w.total])),
      }
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
    // 会话标题：优先用 readTitleSnapshots 批量读，失败再逐个 readTitle；带 30s 缓存，
    // 避免 15s 轮询 / SSE 刷新把几十个会话日志重复读一遍。
    const sessionQueryService = ctx.get('sessionQuery')
    const sessionIds = Object.keys(stats.sessions)
    const titleOf = async (id) => {
      if (!sessionQueryService || typeof sessionQueryService.readTitle !== 'function') return null
      const cached = titleCache.get(id)
      if (cached && Date.now() - cached.at < TITLE_CACHE_MS) return cached.title
      try {
        const t = await sessionQueryService.readTitle(id)
        const title = t && t.title ? String(t.title) : null
        titleCache.set(id, { title, at: Date.now() })
        return title
      } catch {
        return null
      }
    }
    const titles = new Map()
    let batchTitles = false
    if (sessionQueryService && typeof sessionQueryService.readTitleSnapshots === 'function' && sessionIds.length > 0) {
      try {
        const batch = await sessionQueryService.readTitleSnapshots(sessionIds)
        batchTitles = true
        for (const item of batch || []) {
          const id = String(item && item.sessionId)
          const title = item && item.status === 'fulfilled' && item.value && item.value.title && item.value.title.title
            ? String(item.value.title.title)
            : null
          titles.set(id, title)
          titleCache.set(id, { title, at: Date.now() })
        }
      } catch {
        batchTitles = false
      }
    }
    const sessions = []
    for (const id of sessionIds) {
      const s = stats.sessions[id]
      // 分模型明细：先按归一化模型聚合（旧 key deepseek-v4-flash 与新 key deepseek-flash 合并），
      // 再补上价目表内未调用的模型占位。同一模型只输出一行。
      const agg = new Map()
      const bump = (model) => {
        let item = agg.get(model)
        if (!item) {
          item = { calls: 0, tokens: 0, costCny: 0 }
          agg.set(model, item)
        }
        return item
      }
      for (const k of Object.keys(s.models || {})) {
        bump(normalizeModel(k)).calls += s.models[k] || 0
      }
      for (const k of Object.keys(s.modelsTok || {})) {
        const t = s.modelsTok[k]
        const item = bump(normalizeModel(k))
        item.tokens += (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0)
        item.costCny += t.costCny || 0
      }
      const sessionModelKeys = new Set([...Object.keys(PRICES), ...agg.keys()])
      const modelsDetail = [...sessionModelKeys].map((model) => ({ model, ...(agg.get(model) || { calls: 0, tokens: 0, costCny: 0 }) }))
      modelsDetail.sort((a, b) => {
        if (a.calls !== b.calls) return b.calls - a.calls
        if (a.tokens !== b.tokens) return b.tokens - a.tokens
        return a.model < b.model ? -1 : 1
      })
      const modelList = [...agg.entries()]
        .filter(([, v]) => v.calls > 0)
        .sort((a, b) => b[1].calls - a[1].calls)
        .map(([model]) => model)
      sessions.push({
        sessionId: id,
        title: batchTitles ? (titles.get(id) || null) : await titleOf(id),
        calls: s.calls,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        reasoningTokens: s.reasoningTokens,
        costCny: s.costCny,
        models: modelList,
        modelsDetail,
      })
    }
    // 按总 token（含缓存读写）排序：只算 input+output 会严重低估缓存命中型会话
    const totalTokensOf = (s) => (s.inputTokens || 0) + (s.outputTokens || 0) + (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0)
    sessions.sort((a, b) => totalTokensOf(b) - totalTokensOf(a))
    const totals = rowView(stats.totals)
    totals.anyEstimated = Object.keys(stats.totals.perModel).some((key) => !!stats.totals.perModel[key].estimated)
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
        return { model: m, tokens: v.tokens, costCny: v.costCny, selected: selectedModel !== null && normalizeModel(m) === normalizeModel(selectedModel.model) }
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
    // 当前生效的价格表信息（供界面标注与审计）
    pricing.table = {
      ...PRICING_INFO,
      providers: [...METERED_PROVIDERS],
      holidays: HOLIDAYS.size,
      config: {
        path: pricingConfig.path,
        applied: !!pricingConfig.applied,
        errors: pricingConfig.errors || [],
      },
      models: Object.keys(PRICES).map((key) => ({
        model: key,
        inputMiss: PRICES[key].inputMiss,
        inputHit: PRICES[key].inputHit,
        output: PRICES[key].output,
      })),
    }
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
  let routeErrorLogged = false
  const logRouteError = (path, error) => {
    if (routeErrorLogged) return
    routeErrorLogged = true
    console.warn('[dsh-balance-and-cost] ' + path + ' 处理失败: ' + String((error && error.stack) || error))
  }
  // 每个进程一份 CSRF token：由 /usage 下发给同源页面（跨站读不到响应），/reset 必须带上它。
  const csrfToken = randomUUID()

  // webServer 是可选依赖：headless/CLI 组合没有它，插件仍然统计用量；Web 组合里再挂路由。
  const registerRoutes = (webServer) => {
    // 服务被替换/重载时先清掉旧路由，避免重复注册抛错（也保证不会叠出两套端点）
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 忽略旧路由释放异常
      }
    }
    // Host 白名单：回环 + DSH 实际监听的 host + 私有网段（LAN 访问）+ 显式白名单。
    // 目的是挡住 DNS rebinding（攻击者域名解析到 127.0.0.1），同时不破坏远程访问。
    const hostNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
    const hostPorts = new Set()
    for (const extra of (process.env.DSH_BALANCE_AND_COST_ALLOWED_HOSTS || '').split(',')) {
      const value = extra.trim().toLowerCase()
      if (value) hostNames.add(value)
    }
    try {
      const origin = new URL(webServer.getOrigin())
      hostNames.add(origin.hostname.toLowerCase())
      hostPorts.add(origin.host.toLowerCase())
    } catch {
      // getOrigin 在 listen 之前会抛错，回退到回环白名单
    }
    const isPrivateHost = (name) => {
      const bare = name.replace(/^\[|\]$/g, '')
      if (/^10\./.test(bare) || /^192\.168\./.test(bare) || /^169\.254\./.test(bare)) return true
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true
      if (/^(fc|fd|fe80)/i.test(bare)) return true
      return false
    }
    const hostAllowed = (req) => {
      const host = String((req.headers && req.headers.host) || '').toLowerCase()
      if (!host) return false
      if (hostPorts.has(host)) return true
      const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return hostNames.has(name) || isPrivateHost(name)
    }
    // 同源校验只对带 Origin 的浏览器请求生效（curl/本地进程没有 Origin）
    const sameOrigin = (req) => {
      const origin = req.headers && req.headers.origin
      if (!origin) return true
      try {
        const parsed = new URL(origin)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
        return parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase()
      } catch {
        return false
      }
    }
    const guard = (req, res, needSameOrigin) => {
      if (!hostAllowed(req)) {
        sendJson(res, { ok: false, error: 'forbidden host' }, 403)
        return false
      }
      if (needSameOrigin && !sameOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden origin' }, 403)
        return false
      }
      return true
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/balance',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        if (!guard(req, res, false)) return
        getBalanceCached().then((value) => sendJson(res, value)).catch((e) => {
          sendJson(res, { ok: false, error: String((e && e.message) || e) })
        })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/usage',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        if (!guard(req, res, false)) return
        const url = new URL(req.url || '/', 'http://localhost')
        usageSnapshot(url.searchParams.get('sessionId')).then((value) => {
          sendJson(res, { ...value, csrfToken })
        }).catch((e) => {
          logRouteError('/usage', e)
          sendJson(res, { ok: false, error: String((e && e.message) || e) })
        })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/reset',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        // 重置是破坏性操作：必须同源 + 带 /usage 下发的 token（防 CSRF）
        if (!guard(req, res, true)) return
        const token = String((req.headers && req.headers['x-dsh-balance-token']) || '')
        if (token !== csrfToken) {
          sendJson(res, { ok: false, error: 'invalid csrf token' }, 403)
          return
        }
        stats.totals = emptyTotals()
        stats.sessions = {}
        stats.baseline = null
        stats.startedAt = Date.now()
        stats.ledger = emptyLedger()
        // mergedShards 保留：已经消费过的旧分片不能在重置后被重新合并回来
        balanceCache = { at: 0, value: null }
        titleCache.clear()
        saveStats(stats)
        sseBroadcast({ type: 'usage' })
        sendJson(res, { ok: true })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/__dsh-balance-and-cost/events',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        if (!guard(req, res, true)) return
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        })
        res.write('retry: 5000\n\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
      },
    }))
    console.log('[dsh-balance-and-cost] HTTP 端点已注册（余额 / 用量 / 重置 / SSE）')
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx.webServer))
  } else {
    const fallbackWebServer = ctx.webServer !== undefined ? ctx.webServer : (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
    if (fallbackWebServer !== undefined && fallbackWebServer !== null) registerRoutes(fallbackWebServer)
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

  console.log('[dsh-balance-and-cost] 已激活：llm/stream 统计；统计文件 ' + DATA_FILE
    + (migrated ? '（已从 ' + stats.loadedFrom + ' 迁移' + ((stats.mergedFrom && stats.mergedFrom.length) ? '，并合并 ' + stats.mergedFrom.join('、') : '') + '）' : '')
    + (pricingConfig.applied ? '；价格表覆盖自 ' + pricingConfig.path : '')
    + ((pricingConfig.errors && pricingConfig.errors.length) ? '；定价配置有误：' + pricingConfig.errors.join('；') : ''))
}
