# 07 · API 设计

统一前缀 `/api`，JSON in / JSON out，错误体 `{ error: { code, message } }`。

## 游戏与对局

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/games` | 游戏列表（来自代码里的 registry，边缘缓存，不查库） |
| `POST` | `/api/matches` | 开一局。body: `{ gameId, mode, seats: [{kind:'human'|'ai', modelKey?}], seed? }`，返回 `{ matchId, state, legalMoves }` |
| `GET` | `/api/matches/:id` | 当前状态（进行中从 DO 读，已结束从 KV/R2 读） |
| `POST` | `/api/matches/:id/moves` | 落子。body: `{ ply, move, clientStateHash }`，返回 `{ state, legalMoves, status }` |
| `POST` | `/api/matches/:id/resign` | 认输 / 放弃 |
| `GET` | `/api/matches/:id/stream` | WebSocket（DO 直连）：观战、AI 走子推送 |

`ply` 参数做幂等：重复提交同一 `ply` 返回同样结果，不会走两步（弱网重试必需）。

## 回放

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/replays/:matchId` | 回放包 `{ gameId, seed, moves[], meta }`，走 R2 + Cache API，`immutable` |
| `GET` | `/api/replays/:matchId/ai/:ply` | 该步的 AI prompt / 回复 / 用量 |

前端拿到回放包后本地重放，服务端不参与逐帧计算。

## 排行榜

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/leaderboards/:gameId?track=ai&window=all&limit=100` | 读 KV 快照，miss 时读 `leaderboard_snapshot` |
| `GET` | `/api/leaderboards/:gameId/me` | 我的最好成绩与名次（榜内精确，榜外给百分位） |
| `GET` | `/api/players/:id/matches?cursor=` | **keyset 分页**，游标是上一页末条的 matchId |

排行榜接口一律不接受任意排序字段，只接受预先建好索引的几个固定组合，避免被构造成全表扫描。

## 约定

- **所有列表接口用 cursor，不用 page/offset。**
- 响应统一带 `Cache-Control`：排行榜 `max-age=30, stale-while-revalidate=300`；回放 `immutable`。
- 写接口做速率限制（按 IP + 用户），用 KV 或 DO 计数器。
- 认证：MVP 用匿名 + 本地 token（`players.kind='human'` 生成匿名玩家），
  后续接 OAuth（GitHub / Google）把匿名成绩迁移到正式账号。
