// 端到端集成测试：用最小假 ctx 挂载 node half，模拟 llm/stream 消耗，
// 再通过 /usage 路由读取快照——验证计价缓存贯通（写入 → 持久化 → 重启恢复 → 重置）。
// 运行：node test/host-integration.mjs
// 注意：必须在 import 之前把 DSH_HOME 指向临时目录，避免碰用户的真实统计文件。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsbal-test-'))
process.env.DSH_HOME = sandbox

const { apply, beijingHourKey, isPeak } = await import('../src/index.js')

// 用最小假 ctx 挂载一次：只有 webServer 与 on 是必需的，其余服务缺席时应优雅降级
function mount() {
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    on(name, fn) {
      listeners.set(name, fn)
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash-0731' }) }
      }
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  apply(ctx)
  const getUsage = (sessionId) => new Promise((resolve, reject) => {
    const res = {
      writeHead() {},
      end(body) {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      },
    }
    Promise.resolve(routes.get('/__dsh-balance-and-cost/usage')({ method: 'GET', url: '/__dsh-balance-and-cost/usage?sessionId=' + sessionId }, res)).catch(reject)
  })
  const post = (path) => new Promise((resolve) => {
    const res = { writeHead() {}, end: () => resolve() }
    routes.get('/__dsh-balance-and-cost' + path)({ method: 'POST', url: path }, res)
  })
  return { listeners, routes, ctx, getUsage, post }
}

// ── 1) 挂载：路由齐备 ────────────────────────────────────────────────────────
const first = mount()
for (const path of ['/balance', '/usage', '/reset']) {
  assert.ok(first.routes.has('/__dsh-balance-and-cost' + path), '应注册 ' + path + ' 路由')
}

// ── 2) 模拟一次 DeepSeek 调用（usage chunk 经 llm/stream 瀑布流）─────────────
const stream = first.listeners.get('llm/stream')({ provider: 'deepseek-official', model: 'deepseek-v4-flash-0731', sessionId: 'session-test' }, () => (async function* () {
  yield { type: 'text', text: 'hi' }
  yield {
    type: 'usage',
    usage: { inputTokens: 1000000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }
})())
const chunks = []
for await (const chunk of stream) chunks.push(chunk)
assert.equal(chunks.length, 2, '应原样透传所有 chunk')

// ── 3) /usage 快照：时间记录 + 费用来自记录时的单价 ──────────────────────────
const snapshot = await first.getUsage('session-test')
const now = new Date()
const bucket = snapshot.pricing.shown[0]
assert.equal(bucket.hour, beijingHourKey(now), '记录的整点 = 消耗发生的北京时间整点')
assert.equal(bucket.peak, isPeak(now), '记录的时段 = 消耗发生时刻的时段')
const recorded = bucket.price['deepseek-v4-flash']
assert.ok(recorded, '缓存应记录归一化模型名与当时单价快照')
const expected = (1000000 * recorded.input + 1000 * recorded.output) / 1e6
assert.ok(Math.abs(snapshot.totals.costCny - expected) < 1e-9, '总计费用 = 记录时刻的真实花费')
assert.ok(Math.abs(snapshot.totals.breakdown.totalCostCny - expected) < 1e-9, '总计三档合计 = 真实花费')
assert.ok(Math.abs(snapshot.totals.breakdown.missCostCny + snapshot.totals.breakdown.hitCostCny + snapshot.totals.breakdown.outputCostCny - expected) < 1e-12, '三档之和 = 合计')
assert.equal(snapshot.current.selectedBreakdown.approximate, false, '新写入的数据全部有计价缓存')
assert.ok(Math.abs(snapshot.current.selectedBreakdown.totalCostCny - expected) < 1e-9, '本会话三档合计 = 真实花费（模型名带版本后缀也能命中）')
assert.equal(snapshot.pricing.hours, 1, '计价缓存记录了 1 个整点')
assert.ok(Math.abs(snapshot.pricing.costCny - expected) < 1e-9, '缓存合计 = 真实花费')
assert.equal(snapshot.pricing.currentSession.hours, 1, '会话级缓存同样记录整点')

// ── 4) 落盘：统计文件保留时间、单价与费用 ────────────────────────────────────
first.listeners.get('dispose')()
const statsFile = join(sandbox, 'dsh-balance-and-cost.json')
const persisted = JSON.parse(readFileSync(statsFile, 'utf8'))
assert.ok(persisted.ledger, '统计文件应包含 ledger')
assert.ok(persisted.ledger.buckets[bucket.hour], '落盘保留整点分桶')
assert.equal(persisted.ledger.buckets[bucket.hour].models['deepseek-v4-flash'].price.input, recorded.input, '落盘保留当时的单价快照')
assert.equal(persisted.ledger.buckets[bucket.hour].at, Date.parse(bucket.hour + ':00:00+08:00'), '落盘保留整点时间戳')
assert.ok(persisted.sessions['session-test'].ledger, '会话也持久化计价缓存')

// ── 5) 重启恢复：重新挂载后计价缓存与费用必须一致 ────────────────────────────
const second = mount()
const restored = await second.getUsage('session-test')
assert.equal(restored.pricing.shown[0].hour, bucket.hour, '恢复后整点不变')
assert.ok(Math.abs(restored.totals.breakdown.totalCostCny - expected) < 1e-9, '恢复后合计费用不变')
assert.equal(restored.totals.breakdown.approximate, false, '恢复后仍是缓存计价、不是估算')

// ── 6) 重置：清空计价缓存与统计 ─────────────────────────────────────────────
await second.post('/reset')
const afterReset = await second.getUsage('session-test')
assert.equal(afterReset.pricing.hours, 0, '重置后计价缓存为空')
assert.equal(afterReset.totals.costCny, 0)
second.listeners.get('dispose')()

rmSync(sandbox, { recursive: true, force: true })
console.log('integration OK: 路由 / llm/stream 统计 / 计价缓存贯通 / 持久化 / 重启恢复 / 重置')
