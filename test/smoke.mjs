// 冒烟测试：验证 bundle 清单、两端模块加载、导出形状与分时段计价逻辑。
// 运行：node test/smoke.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { isPeak, priceFor } from '../src/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// manifest 校验（awesome-dsh-plugin 收录的硬性条件）
assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch 缺失——无法通过 dsh plugin add 安装')
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 应为 web')
assert.equal(pkg.exports['.'], './src/index.js', 'exports["."] 应指向 node half 源码')
assert.equal(pkg.exports['./client'], './src/client.js', 'exports["./client"] 应指向 browser half 源码')

// node half：导出形状
const host = await import('../src/index.js')
assert.equal(host.name, 'dsh-balance-and-cost')
assert.deepEqual(host.inject, ['webServer'], '应声明 webServer 硬依赖')
assert.equal(typeof host.apply, 'function')

// 分时段判定（北京时间）：高峰 9-12 / 14-18
assert.equal(isPeak(new Date('2026-08-17T02:00:00Z')), true, '北京 10:00 应为高峰')
assert.equal(isPeak(new Date('2026-08-17T04:00:00Z')), false, '北京 12:00 应为空闲')
assert.equal(isPeak(new Date('2026-08-17T07:00:00Z')), true, '北京 15:00 应为高峰')
assert.equal(isPeak(new Date('2026-08-17T10:00:00Z')), false, '北京 18:00 应为空闲')

// 官方价格表（高峰/空闲 × 模型）
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
const unknown = priceFor('deepseek-v9-unknown', new Date('2026-08-17T02:00:00Z'))
assert.equal(unknown.estimated, true, '未收录模型应标记估算并按 v4-flash 兜底')
assert.equal(unknown.input, 3.0)

// browser half：Node 环境下加载不应有副作用、不应抛错
await import('../src/client.js')

console.log('smoke OK: manifest / node half / browser half / 计价用例')
