# 账本（ledger）

读用量，算参考金额。只读，不拦请求。

## 两个口径，都在这里了

| 口径 | 数据源 | 覆盖 | 工具 |
|---|---|---|---|
| 日志（真） | `logs/executions/**/*.jsonl` 里每一次 `model_result` | 100% | `usage_daily` |
| 会话（账本） | `memory/sessions/*/episodes/*.jsonl` 的 `request_usage` | 约 10% | `ledger_today`、宿主 `usage_today` |
| 会话累计 | `ctx.sessions.context()` 的全量计数 | 100% | `usage_sessions` |

账本那份每轮对话只写一次（收尾那一笔），一轮里跑了十几次模型只留最后一次。所以看真实花销用 `usage_daily`，它末尾会带一行对账，说明账本覆盖了多少。

## 工具

- `ledger_today` —— 今天按模型的用量和参考金额（会话口径）
- `usage_daily` —— 按天/按模型，带缓存命中率、参考金额、账本覆盖率（日志口径）
- `usage_sessions` —— 每个会话的累计请求与 token

## 页面

`/plugins/ledger/` —— 过去 24 小时按模型堆叠、每日输入与金额切换、模型排名、会话累计、价目表编辑。

明细在 `/plugins/ledger/detail`：1 / 7 / 30 天切换 + 明细表。

数据接口三个：`/plugins/ledger/data`（会话口径，含按小时）、`/plugins/ledger/log`（日志口径）、`/plugins/ledger/days?days=N`（图表数据）。

## 金额不是账单

按 `data/config.json` 里的价目表重算，单位是美元/百万 token。价目表在页面上可以贴 JSON 或选文件上传。算不出来就显示「—」，不猜。

服务商不回传 cost 的（比如 MiraRouter），金额永远是参考值。

## 仓库与历史

本库是「账本」的唯一维护地。

- 0.1.x：只有会话口径，粗糙。
- 0.2.0：把 `usage-daily` 并了进来——日志口径、缓存命中、会话累计、对账，页面合成一张，工具从四个收到三个（`usage_reconcile` 并进 `usage_daily` 的返回）。

> **`whalelife-plugin-usage-daily` 已并入本库**，那个仓库转为私有、只作历史留档，不再更新、不再发版。要装、要改、要报问题，都看这里。
