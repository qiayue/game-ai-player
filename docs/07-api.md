# 07 · API 与路由

## 页面路由（输出 HTML，可被索引）

| 路径 | 说明 |
| --- | --- |
| `/` | 首页：游戏列表 + 最新 AI 录像 + 总榜摘要 |
| `/games/{gameId}` | 游戏页：玩法说明（SEO 正文）+ 排行榜 Top10 + 开始游戏按钮 |
| `/games/{gameId}/leaderboard` | 完整排行榜（人类 / AI 两个 tab，SSR） |
| `/games/{gameId}/ai` | 该游戏的 AI 录像列表 |
| `/replay/{matchId}` | 回放页，HTML 里含该局的文字摘要 |
| `/p/{handle}` | 玩家主页 |
| `/models` `/models/{slug}` | 模型横评 / 单个模型的战绩页 |
| `/sitemap.xml` `/sitemap-*.xml` | 动态生成 |

渲染方式见 [09-frontend-seo.md](09-frontend-seo.md)。

## API（`/api` 前缀，JSON，错误体 `{ error: { code, message } }`）

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/google` | body `{ credential }`（Google ID token）→ 验签 → 下发 session Cookie |
| `POST` | `/api/auth/logout` | 清 Cookie |
| `GET` | `/api/me` | 当前用户（未登录返回 `{ user: null }`） |
| `PATCH` | `/api/me` | 改显示名 / handle |

### 人类对局（整局只有 2 次请求）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/matches` | `{ gameId }` → `{ matchId, seed, startedAt, stepwise, state, legalMoves, ticket }`。**不写数据库** |
| `POST` | `/api/matches/{id}/step` | 仅信息不完全的游戏：`{ ticket, moves[] }` → 服务端从 seed 重放 → `{ state, legalMoves, terminal }`。无状态 |
| `POST` | `/api/matches/{id}/finish` | `{ ticket, moves[], stepMs[], durationMs, finalHash }` → replay 校验 → 入库 → `{ score, rank, personalBest, replayUrl, flagged }` |
| `POST` | `/api/matches/claim` | 登录后批量认领匿名期间打完的对局 |

`ticket` 是开局时下发的签名 JWT，装着 `{ matchId, gameId, seed, startedAt }`，
有效期 12 小时。因此开局零写入，半途放弃的对局不留痕迹。

`finish` 是幂等的：同一 matchId 重复提交返回首次结果，不重复计分。
未登录时 `finish` 会算出成绩但不落库，前端把票据存进 localStorage，登录后走 `/claim` 补记。

### AI 录制

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/models?gameId=` | 可用模型列表 + 该游戏的预估成本 |
| `POST` | `/api/ai-runs` | `{ gameId, modelKey }` → 校验配额与预算 → `{ runId }`（立即返回） |
| `GET` | `/api/ai-runs/{id}` | 进度：`{ status, ply, score, board, lastThought, costUsd }`（前端每 2s 轮询） |
| `POST` | `/api/ai-runs/{id}/abort` | 中止；已跑部分保存为未完成录像 |
| `GET` | `/api/ai-runs?mine=1&cursor=` | 我发起过的录制任务 |

轮询打的是 Durable Object 内存，不碰 D1。

### 回放

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/replays/{matchId}` | `{ gameId, seed, moves[], meta }`，走 R2，`immutable` |
| `GET` | `/api/replays/{matchId}/ai/{ply}` | 该步的 prompt / 回复 / 推理 / 用量 |

### 排行榜与列表

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/leaderboards/{gameId}?track=ai&window=all&limit=100` | 读 KV 快照，miss 落 `leaderboard_snapshot` |
| `GET` | `/api/leaderboards/{gameId}/me` | 我的最好成绩与名次（榜内精确，榜外给百分位） |
| `GET` | `/api/players/{handle}/matches?cursor=` | **keyset 分页**，游标是上一页末条的 matchId |

排行榜接口不接受任意排序字段，只接受预建索引的固定组合，避免被构造成全表扫描。

### 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/admin/models/{key}` | 启用/停用模型、设置 `max_game_plies` / 锁定供应商 |
| `POST` | `/api/admin/matches/{id}/flag` | 标记违规对局，移出排行榜 |
| `POST` | `/api/admin/leaderboards/rebuild` | 重算指定榜 |

## 全局约定

- **所有列表接口用 cursor，不用 page/offset。**
- 响应统一带 `Cache-Control`：排行榜 `s-maxage=60, stale-while-revalidate=600`；回放 `immutable`。
- 写接口校验 `Origin` 头（配合 `SameSite=Lax` Cookie 防 CSRF）；限流用 KV 计数器。
- 单个请求的 D1 查询数 ≤ 4，多语句用 `db.batch()`。
