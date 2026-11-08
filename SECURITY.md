# Security

## 设计原则

- **无密钥硬编码**：代码中不包含任何 API Key。账号登录走 DSH 的 `deepseekAccount` 服务；
  API Key 仅通过 DSH 的 `credentials` 服务在运行时解析（`~/.dsh/.credentials.yaml` 或同名环境变量）
- **无遥测**：不收集、不上报任何使用数据；统计仅保存在本机 `$DSH_HOME/dsh-balance-and-cost.json`
- **出站请求单一**：唯一的网络出站是 DeepSeek 余额查询（账号通道由 DSH 账号服务发起；API Key 通道为
  `https://api.deepseek.com/user/balance`，可用 `DSH_BALANCE_AND_COST_BASE_URL` 指向网关）
- **无文件写入除统计文件外**：不读写工作区或其他用户文件

## HTTP 端点防护

`/balance`、`/usage`、`/events`、`/reset` 只在 Web 组合中注册，并做了三层约束：

- **Host 白名单**：只接受回环（127.0.0.1 / localhost / ::1）、DSH 实际监听的地址、私有网段，
  以及 `DSH_BALANCE_AND_COST_ALLOWED_HOSTS` 显式列出的 host（挡 DNS rebinding）
- **同源校验**：`/reset` 与 `/events` 拒绝跨站 `Origin`
- **CSRF token**：`/usage` 下发每个进程随机生成的 token，`/reset` 必须通过
  `x-dsh-balance-token` 携带；跨站页面读不到 `/usage` 的响应，因此拿不到 token

`/usage` 会返回会话标题与消耗，仍属于本机数据：同一台机器上的其他进程可以直接读取（与读取统计文件等价）。
如果本机存在不受信任的进程，请勿安装任何第三方插件。

## 已知边界

- 统计文件（`$DSH_HOME/dsh-balance-and-cost.json`）以明文 JSON 保存聚合数字与计价缓存，不含密钥；
  保存前会在同目录留一份 `.bak`
- 插件以与 DSH 宿主进程相同的权限运行——安装第三方插件前请阅读其源码（详见 awesome-dsh-plugin 列表顶部的免责声明）

## 报告问题

发现安全问题请通过 GitHub Issues 私下或公开报告：https://github.com/boooooooer/dsh-balance-and-cost/issues
