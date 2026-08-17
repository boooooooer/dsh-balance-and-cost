# Security

## 设计原则

- **无密钥硬编码**：代码中不包含任何 API Key。`DEEPSEEK_API_KEY` 仅通过 DSH 的 `credentials` 服务在运行时解析（`~/.dsh/.credentials.yaml` 或同名环境变量）
- **无遥测**：不收集、不上报任何使用数据；统计仅保存在本机 `$DSH_HOME/dsh-balance-and-cost.json`
- **出站请求单一**：唯一的网络出站是 `https://api.deepseek.com/user/balance`（余额查询）
- **无文件写入除统计文件外**：不读写工作区或其他用户文件

## 已知边界

- 统计文件（`$DSH_HOME/dsh-balance-and-cost.json`）以明文 JSON 保存聚合数字，不含密钥
- 插件以与 DSH 宿主进程相同的权限运行——安装第三方插件前请阅读其源码（详见 awesome-dsh-plugin 列表顶部的免责声明）

## 报告问题

发现安全问题请通过 GitHub Issues 私下或公开报告：https://github.com/boooooooer/dsh-balance-and-cost/issues
