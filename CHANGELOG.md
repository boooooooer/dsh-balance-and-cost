# Changelog

## 0.1.0 (2026-08)

- 消耗统计：监听 `llm/stream`，按 DeepSeek 路由累计 token（输入 / 输出 / 缓存读取 / 缓存写入 / 推理），区分总计与当前会话
- 计价：官方 v4 价格表（deepseek-v4-flash / deepseek-v4-pro），按每次调用时刻的北京时间高峰/空闲时段计价（CNY）
- 余额：经 `credentials` 服务解析 `DEEPSEEK_API_KEY` 查询官方余额接口，60 秒缓存
- 持久化：统计落盘 `$DSH_HOME/dsh-balance-and-cost.json`，重启后恢复
- Web UI：主页输入框下方摘要条（余额 / 本会话 / 总计 / 时段标记）+ 插件中心「DeepSeek 用量」面板（按模型、按会话明细）
- 纯 JavaScript、零依赖、零构建，GitHub 直装无需 `allowBuilds` 授权
