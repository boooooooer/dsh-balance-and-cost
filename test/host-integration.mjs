// 端到端集成测试：用最小假 ctx 挂载 node half，模拟 llm/stream 消耗，
// 再通过 /usage 路由读取快照——验证计价缓存贯通：
// 旧位置统计文件迁移 → 写入（时间 + 单价）→ 快照 → 落盘 → 重启恢复 → 重置。
// 运行：node test/host-integration.mjs
// 注意：import 之前把 HOME/DSH_HOME 指向临时目录，避免碰用户的真实统计文件。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsbal-test-'))
const home = join(sandbox, 'dsh-home')
// 旧版本落点：$HOME/.dsh/dsh-balance-and-cost.json（新位置是 $DSH_HOME/…）
const legacyFile = join(sandbox, '.dsh', 'dsh-balance-and-cost.json')
// 第二个互补分片：模拟「换过启动目录 / 多实例」各写一份历史
const legacyShard2 = join(sandbox, 'other-drive', '.dsh', 'dsh-balance-and-cost.json')
const newFile = join(home, 'dsh-balance-and-cost.json')
process.env.HOME = sandbox
process.env.DSH_HOME = home
// 显式指定位置与旧文件，保证测试不触及机器上真实的统计文件
process.env.DSH_BALANCE_AND_COST_FILE = newFile
process.env.DSH_BALANCE_AND_COST_LEGACY_FILES = [legacyFile, legacyShard2].join(';')

// 旧格式统计（0.1.0 落盘：没有 ledger，只有聚合值）
const legacyStats = {
  startedAt: Date.parse('2026-08-17T16:01:35Z'),
  totals: {
    calls: 3, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costCny: 1.5, anyEstimated: false,
    perModel: {
      'deepseek-official:deepseek-v4-flash': {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', calls: 3, inputTokens: 1000,
        outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 1.5,
      },
    },
  },
  sessions: {
    'old-session': {
      calls: 3, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, costCny: 1.5, models: { 'deepseek-v4-flash': 3 },
      modelsTok: { 'deepseek-v4-flash': { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 1.5 } },
    },
  },
  baseline: null,
}
mkdirSync(join(sandbox, '.dsh'), { recursive: true })
writeFileSync(legacyFile, JSON.stringify(legacyStats))
// 第二个分片：另一会话（互补）→ 应被合并；调用次数不同 → 不是副本
const shard2 = JSON.parse(JSON.stringify(legacyStats))
shard2.startedAt = Date.parse('2026-08-21T07:28:01Z')
shard2.totals.calls = 5
shard2.totals.costCny = 2.25
shard2.totals.perModel['deepseek-official:deepseek-v4-flash'].calls = 5
shard2.totals.perModel['deepseek-official:deepseek-v4-flash'].costCny = 2.25
shard2.sessions = {
  'session-a9d04677-367f-4a0a-a607-b35d1bb9e2a8': {
    calls: 5, inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costCny: 2.25, models: { 'deepseek-v4-flash': 5 },
    modelsTok: { 'deepseek-v4-flash': { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 2.25 } },
  },
}
mkdirSync(join(sandbox, 'other-drive', '.dsh'), { recursive: true })
writeFileSync(legacyShard2, JSON.stringify(shard2))

const { apply, beijingHourKey, isPeak, PRICING_VERSION, DSH_HOME_DIR, LEGACY_DATA_FILES, candidateStatsPaths } = await import('../src/index.js')
assert.equal(DSH_HOME_DIR, home, 'DSH_HOME 优先作为统计目录')
assert.deepEqual(LEGACY_DATA_FILES, [legacyFile, legacyShard2], '显式指定的旧位置生效')
assert.deepEqual(candidateStatsPaths(), [newFile, legacyFile, legacyShard2], '迁移扫描顺序：新位置 → 旧位置')

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

// ── 1) 挂载：路由齐备；旧位置统计被迁移到 $DSH_HOME ──────────────────────────
const first = mount()
for (const path of ['/balance', '/usage', '/reset']) {
  assert.ok(first.routes.has('/__dsh-balance-and-cost' + path), '应注册 ' + path + ' 路由')
}
assert.ok(existsSync(newFile), '启动时应把旧位置统计迁移到 $DSH_HOME')
const migratedLoad = await first.getUsage('old-session')
assert.equal(migratedLoad.totals.calls, 8, '迁移后两个互补分片都被合并（3 + 5）')
assert.ok(Math.abs(migratedLoad.totals.costCny - 3.75) < 1e-9, '迁移后旧费用相加（1.5 + 2.25）')
assert.equal(migratedLoad.sessions.length, 2, '两个分片的会话都在')
assert.equal(migratedLoad.pricing.hours, 0, '旧数据没有时间记录 → 计价缓存为空')

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

// ── 3) /usage 快照：时间记录 + 按记录时单价计费 + 当前价格表信息 ─────────────
const snapshot = await first.getUsage('session-test')
const now = new Date()
const bucket = snapshot.pricing.shown[0]
assert.equal(bucket.hour, beijingHourKey(now), '记录的整点 = 消耗发生的北京时间整点')
assert.equal(bucket.peak, isPeak(now), '记录的时段 = 消耗发生时刻的时段（工作日规则）')
const recorded = bucket.price['deepseek-flash']
assert.ok(recorded, '旧模型名 deepseek-v4-flash-0731 应归一到 deepseek-flash 记录')
const newCost = (1000000 * recorded.input + 1000 * recorded.output) / 1e6
assert.ok(Math.abs(snapshot.totals.costCny - (3.75 + newCost)) < 1e-9, '总计 = 旧分片费用 + 本次真实花费')
assert.ok(Math.abs(snapshot.totals.breakdown.totalCostCny - snapshot.totals.costCny) < 1e-9, '总计三档合计 = 记录的真实费用')
assert.equal(snapshot.totals.breakdown.approximate, true, '含旧历史 token → 拆分标注估算')
assert.equal(snapshot.current.selectedBreakdown.approximate, false, '本会话数据全有计价缓存')
assert.ok(Math.abs(snapshot.current.selectedBreakdown.totalCostCny - newCost) < 1e-9, '本会话三档合计 = 本次真实花费')
assert.equal(snapshot.pricing.hours, 1, '计价缓存记录了 1 个整点')
assert.equal(snapshot.pricing.currentSession.hours, 1, '会话级缓存同样记录整点')
// 价格表信息随快照下发（界面标注当前生效表）
assert.equal(snapshot.pricing.table.version, PRICING_VERSION)
assert.deepEqual(snapshot.pricing.table.models.map((m) => m.model), ['deepseek-flash', 'deepseek-v4-pro'])
const flashTable = snapshot.pricing.table.models[0]
assert.equal(flashTable.inputMiss.peak, 2)
assert.equal(flashTable.inputMiss.off, 1)
assert.equal(flashTable.inputHit.peak, 0.04)
assert.equal(flashTable.output.off, 4)
assert.ok(String(snapshot.pricing.table.peakRule).includes('周一至周五'), '价格表元信息应说明工作日高峰')

// ── 4) 落盘：统计写在新位置，保留时间、单价与费用 ────────────────────────────
first.listeners.get('dispose')()
const persisted = JSON.parse(readFileSync(newFile, 'utf8'))
assert.ok(persisted.ledger, '统计文件应包含 ledger')
assert.ok(persisted.ledger.buckets[bucket.hour], '落盘保留整点分桶')
assert.equal(persisted.ledger.buckets[bucket.hour].models['deepseek-flash'].price.input, recorded.input, '落盘保留当时的单价快照')
assert.equal(persisted.ledger.buckets[bucket.hour].at, Date.parse(bucket.hour + ':00:00+08:00'), '落盘保留整点时间戳')
assert.equal(persisted.ledger.v, PRICING_VERSION, '落盘带上价格表版本')
assert.ok(persisted.sessions['session-test'].ledger, '会话也持久化计价缓存')

// ── 5) 重启恢复：重新挂载后计价缓存与费用必须一致 ────────────────────────────
const second = mount()
const restored = await second.getUsage('session-test')
assert.equal(restored.pricing.shown[0].hour, bucket.hour, '恢复后整点不变')
assert.ok(Math.abs(restored.totals.costCny - snapshot.totals.costCny) < 1e-9, '恢复后费用不变')
assert.ok(Math.abs(restored.current.selectedBreakdown.totalCostCny - newCost) < 1e-9, '恢复后本会话费用不变')
assert.equal(JSON.parse(readFileSync(newFile, 'utf8')).ledger.v, PRICING_VERSION, '恢复后仍标记当前价格表版本（不会重复重算）')

// ── 6) 重置：清空计价缓存与统计 ─────────────────────────────────────────────
await second.post('/reset')
const afterReset = await second.getUsage('session-test')
assert.equal(afterReset.pricing.hours, 0, '重置后计价缓存为空')
assert.equal(afterReset.totals.costCny, 0)
second.listeners.get('dispose')()

rmSync(sandbox, { recursive: true, force: true })
console.log('integration OK: 旧文件迁移 / 路由 / llm/stream 统计 / 计价缓存贯通 / 持久化 / 重启恢复 / 重置')
