/**
 * dsh-balance-and-cost — node half（标准 bundle 插件）。
 *
 * DeepSeek 账户余额与模型消耗量：
 * - 监听 llm/stream 瀑布流，累计 DeepSeek 路由的 token 消耗（输入/输出/缓存读取/
 *   缓存写入/推理），按官方价格表（api-docs.deepseek.com/zh-cn/quick_start/pricing）
 *   分高峰/空闲时段计价——价格按每次调用时刻的北京时间时段即时判定。
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

// 返回该时刻的具体单价（元/百万 tokens）
export function priceFor(model, date) {
  const table = PRICES[model] || FALLBACK
  const peak = isPeak(date)
  const pick = (v) => (peak ? v.peak : v.off)
  return {
    input: pick(table.inputMiss),
    cacheRead: pick(table.inputHit),
    cacheWrite: pick(table.inputMiss),
    output: pick(table.output),
    estimated: !PRICES[model],
    peak,
  }
}

const DATA_FILE = join(process.env.DSH_HOME || (process.env.HOME || '') + '/.dsh', 'dsh-balance-and-cost.json')
const BALANCE_CACHE_MS = 60000
const SAVE_DEBOUNCE_MS = 10000

function emptyTotals() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCny: 0, anyEstimated: false, perModel: {} }
}

function emptySession() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCny: 0, models: {} }
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
    }
    for (const key of Object.keys(raw.sessions || {})) {
      stats.sessions[key] = { ...emptySession(), ...raw.sessions[key] }
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

export function apply(ctx) {
  const stats = loadStats() || { startedAt: Date.now(), totals: emptyTotals(), sessions: {}, baseline: null }
  let saveTimer = null
  const scheduleSave = () => {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveStats(stats)
    }, SAVE_DEBOUNCE_MS)
  }

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
          const price = priceFor(model, new Date())
          const cost = (i * price.input + cr * price.cacheRead + cw * price.cacheWrite + o * price.output) / 1e6
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
            s.models[model] = (s.models[model] || 0) + 1
          }
          scheduleSave()
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

  function usageSnapshot(sessionId) {
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : null
    const currentRow = sid && stats.sessions[sid] ? stats.sessions[sid] : emptySession()
    const perModel = Object.keys(stats.totals.perModel).map((key) => {
      const r = stats.totals.perModel[key]
      return { provider: r.provider, model: r.model, calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costCny: r.costCny, estimated: r.estimated }
    })
    const sessions = Object.keys(stats.sessions).map((id) => {
      const s = stats.sessions[id]
      return { sessionId: id, calls: s.calls, inputTokens: s.inputTokens, outputTokens: s.outputTokens, cacheReadTokens: s.cacheReadTokens, cacheWriteTokens: s.cacheWriteTokens, reasoningTokens: s.reasoningTokens, costCny: s.costCny, models: Object.keys(s.models) }
    }).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
    const totals = rowView(stats.totals)
    totals.anyEstimated = stats.totals.anyEstimated
    totals.perModel = perModel
    const current = rowView(currentRow)
    // 会话当前选中的模型（agentDefaultModel：用户切换模型即时生效；未产生调用时用于即时显示）
    let selectedModel = null
    const defaultModelService = ctx.get('agentDefaultModel')
    if (defaultModelService && typeof defaultModelService.currentSelection === 'function') {
      const sel = defaultModelService.currentSelection()
      if (sel && sel.model) {
        selectedModel = { provider: String(sel.provider || ''), model: String(sel.model) }
      }
    }
    return {
      startedAt: stats.startedAt,
      totals,
      current,
      baseline: stats.baseline,
      sessions,
      peak: isPeak(new Date()),
      selectedModel,
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
        sendJson(res, usageSnapshot(url.searchParams.get('sessionId')))
      },
    }))
  }

  ctx.on('dispose', () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
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
