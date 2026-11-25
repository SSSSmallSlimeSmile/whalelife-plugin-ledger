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

## 权限与范围

工具被调用时，看的是**这次调用的权限**，不是插件的权限。

| 调用者权限 | `usage_daily` 看到 | `usage_sessions` 看到 | `ledger_today` 看到 | 对账（调 `usage_today`） |
|---|---|---|---|---|
| `full` | 全部会话的日志 | 全部会话（会用 `sessions.list()` 列一次） | 今日各模型用量与参考金额 | 执行 |
| `ask` / `off` | **只有自己那条会话的执行目录** | 只有自己那条会话 | 只有本会话的累计用量 | 跳过，回执里写明「对账需要 full 权限」 |

范围是**读之前**定下来的：普通调用只按自己的会话 id 取一次 `sessions.context()`，不会先列全部会话再过滤。反过来，需要全局汇总的调用只出现在有 `full` 权限的入口和需要登录的插件页面里。

调用者既不是 `full`、又拿不到会话 id 时，直接回一句「没有可统计的范围」，不返回任何数据，也不会退回去读全实例。

**全局视图只开在插件页面**（`/plugins/ledger/` 及各数据接口）。这些页面要求控制台登录，未登录返回 401，算管理员入口。

## 页面

`/plugins/ledger/` —— 24 小时图（按模型分段）、每日柱、模型排名、会话累计、价目表。

`/plugins/ledger/detail` —— 1/7/30 天切换 + 明细表。

数据接口：`/plugins/ledger/data`（会话口径，含按小时）、`/plugins/ledger/log`（日志口径）。

## 设置保存走哪条接口

表单提交到 **`POST /plugins/ledger/save`**，成功回 303 到 `/plugins/ledger/`。
价目表单独走 **`POST /plugins/ledger/price`**（JSON）。

`ctx.web.page()` **只挂 GET**，在 page 的处理里判断 `req.method === "POST"` 不管用——请求会落空返回 404。要收 POST 必须用 `ctx.web.api()`，这是本插件 0.2.1 修掉的一个真问题。

## 读什么、不写什么

- 只读 `logDir` 下的 `*.jsonl`，文件名必须是 `YYYYMMDD` 开头，按天数先筛再读。
- 不写宿主的任何文件；唯一会写的自己的 `data/config.json`。
- 想清日志腾空间，那是用户自己的事，插件不碰。

## 金额不是账单

按 `data/config.json` 里的价目表重算，单位是美元/百万 token。算不出来就显示「—」，不猜。价目表可在页面下方编辑或导入。

## 历史

原 `ledger`（0.1.x）只用会话口径。0.2.0 把 `usage-daily` 并了进来：日志口径、缓存命中、会话累计、对账，页面合成一张，工具从四个收到三个（`usage_reconcile` 并进 `usage_daily` 的返回）。

0.2.1 修了两处：设置表单 POST 落空返回 404；工具调用未按调用者权限限定统计范围。
