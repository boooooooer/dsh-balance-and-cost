# dsh-balance-and-cost

DeepSeek Harness（DSH）标准 bundle 插件：显示 **DeepSeek 账户余额** 与 **模型消耗量**。

- 主页输入框下方实时摘要条：`DeepSeek 余额 ¥xx.xx CNY · 本会话 (deepseek-v4-flash) xxx tok ≈¥x.xxx · 总计 xxx tok ≈¥x.xxx · [高峰/空闲]`
- 插件中心（设置 → 插件）「DeepSeek 用量」标签页：余额明细 + 完整用量面板

纯 JavaScript、零依赖、零构建——GitHub 直装无需构建授权。

## 功能特性

| 功能 | 说明 |
|---|---|
| 余额查询 | `api.deepseek.com/user/balance`，显示总余额 / 充值 / 赠送 / 可用状态（60 秒缓存） |
| 消耗量统计 | 监听 `llm/stream` 实时累计 DeepSeek 调用的 token（输入 / 输出 / 缓存读取 / 缓存写入 / 推理），区分**总计**与**当前会话** |
| 按模型计价 | 按实际调用模型匹配官方价格表；未收录模型按 deepseek-v4-flash 估算并标注 |
| 分时段计价 | 高峰（北京 9-12 / 14-18）与空闲价格不同，按**每次调用时刻**即时计价 |
| 会话明细 | 每个会话的调用次数 / token / 估算费用 / 使用模型 |
| 持久化 | 统计落盘 `$DSH_HOME/dsh-balance-and-cost.json`，进程重启后恢复 |
| 自动刷新 | 界面每 15 秒轮询，余额 Host 端 60 秒缓存 |

## 价格表（内置，人民币 / 百万 tokens）

来源：[DeepSeek 官方定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（价格可能变动，请以官方页面为准；编辑 `src/index.js` 的 `PRICES` 即可更新）

| 模型 | 输入·缓存未命中 | 输入·缓存命中 | 输出 |
|---|---|---|---|
| deepseek-v4-flash | 高峰 ¥3.0 / 空闲 ¥1.5 | 高峰 ¥0.10 / 空闲 ¥0.05 | 高峰 ¥9.0 / 空闲 ¥4.5 |
| deepseek-v4-pro | 高峰 ¥9.0 / 空闲 ¥4.5 | 高峰 ¥0.30 / 空闲 ¥0.15 | 高峰 ¥27.0 / 空闲 ¥13.5 |

高峰时段 = 北京时间 9:00-12:00、14:00-18:00，其余为空闲时段（价格为高峰一半）。缓存写入按输入未命中计价。

## 安装

```sh
# GitHub 直装（纯 JS 零依赖，无需 allowBuilds 构建授权）
dsh plugin --profile web add github:boooooooer/dsh-balance-and-cost

# 或本地目录 / tarball
dsh plugin --profile web add ./dsh-balance-and-cost
pnpm pack   # 生成 tarball 后：dsh plugin --profile web add ./dsh-balance-and-cost-0.1.0.tgz
```

安装后**重启 dsh**（bundle 层在启动时组合）。卸载：`dsh plugin --profile web remove dsh-balance-and-cost`。

### 配置

- **API Key**：插件通过 DSH 的 `credentials` 服务解析 `DEEPSEEK_API_KEY`（`~/.dsh/.credentials.yaml` 或同名环境变量），代码中不含任何密钥
- 统计文件：`$DSH_HOME/dsh-balance-and-cost.json`（可删除以重置统计）

## 目录结构

```
dsh-balance-and-cost/
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # bundle 补丁层：insert 插件行
├── src/
│   ├── index.js        # node half：llm/stream 统计、计价、余额查询、HTTP 路由
│   └── client.js       # browser half：摘要条 + 设置页（__ModuleLoader__ 加载）
├── README.md
└── LICENSE
```

## 工作原理

| 文件 | 职责 |
|---|---|
| `src/index.js` | `export const name` + `export function apply(ctx)`；`ctx.webServer.register` 暴露 `/__dsh-balance-and-cost/balance` 与 `/__dsh-balance-and-cost/usage` 两个 GET 路由 |
| `src/client.js` | `window.__ModuleLoader__.load({ id, factory })` 注册浏览器插件；`slots` 注入两个位置，`fetch` 调用上述路由 |

费用在 Host 端按调用时刻计价（`costCny` 在 usage 到达时即时累计），因此跨时段统计依然精确。

## 开发与测试

```sh
node test/smoke.mjs   # manifest / 两端模块加载 / 分时段计价用例
```

改动记录见 [CHANGELOG.md](CHANGELOG.md)，安全设计见 [SECURITY.md](SECURITY.md)。

## 已知限制

- 只统计 provider 含 `deepseek` 的模型调用（`deepseek-official` 等路由）
- 费用为估算值（官方单价 × token 用量），实际扣费以 DeepSeek 账单为准
- 重放（replay）的模型调用可能重复计入（近似）

## License

MIT
