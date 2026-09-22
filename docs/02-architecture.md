# 02 · 架构与技术选型

## 组件

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 前端 | React + Vite + TypeScript，用 Workers Static Assets 托管 | 纯 SPA，游戏渲染用 Canvas / CSS Grid；和 API 同源，省掉 CORS |
| API | 单个 Cloudflare Worker + Hono | 路由简单、体积小、冷启动快 |
| 对局状态 | Durable Object，一局一个实例 | 串行化写入、强一致；避免每步都读写 D1 |
| 关系数据 | D1 | 用户、对局元数据、排行榜。**行数严格受控** |
| 冷数据 | R2 | 走法明细 JSONL、AI 原始 prompt / response |
| 读缓存 | KV | 排行榜快照、首页、已完结对局的回放包 |
| AI 调用 | Cloudflare Queues + AI Gateway | 异步、可重试、限速、缓存、统一计费观测 |
| 定时任务 | Cron Triggers | 排行榜重算、归档、清理 |

## 代码结构（monorepo）

```
/packages/games          # 纯 TypeScript 游戏内核，零依赖，前后端共用
    src/core/types.ts    #   GameDefinition 接口
    src/games/tictactoe/ #   每个游戏一个目录：reducer / 合法走法 / 终局判定 / 序列化
    src/index.ts         #   registry: Record<GameId, GameDefinition>
/packages/shared         # API 类型、zod schema、常量
/apps/worker             # Hono API + Durable Object + Queue consumer
/apps/web                # React 前端（游戏 UI、回放器、排行榜）
/db/migrations           # D1 迁移 SQL
```

**`packages/games` 必须是纯函数、无 I/O、无 `Date.now()`、无 `Math.random()`。**
这是回放和服务端校验的前提，也让同一份代码能在浏览器、Worker、以及本地批量自测里跑。

## 一步棋的完整数据流

```
1. 客户端 POST /api/matches/:id/moves  { move, clientStateHash }
2. Worker 路由到该 match 的 Durable Object（DO id = matchId）
3. DO 在内存中持有权威 state：
     - 校验轮次、校验走法合法性
     - state' = reduce(state, move)
     - 追加一条 move 记录到内存缓冲（不落库）
     - 每 N 步 / 每 T 秒把 state 快照写入 DO storage（崩溃恢复用）
4. 如果下一手是 AI：DO 往 Queue 投递 { matchId, ply }
5. AI Worker 消费：拼 prompt → AI Gateway → 解析走法 → 回调 DO 执行第 3 步
6. 终局时 DO 一次性：
     - 把全部走法以 JSONL 写入 R2: matches/{id}/moves.jsonl
     - 往 D1 batch 写入 1 行 matches + 1 行 leaderboard upsert
     - 把回放包写入 KV（带 TTL）
```

**关键点：进行中的对局完全不碰 D1。** 一局 200 步的贪吃蛇，D1 只收到 1 次写入，不是 200 次。
详见 [04-d1-performance.md](04-d1-performance.md)。

## 为什么用 Durable Object

- D1 没有行锁，两个并发请求同时落子会产生竞态；DO 天然串行。
- 每步读一次 D1 拿状态、写一次 D1 存状态，延迟高（跨区域）且把 D1 写入 QPS 打满。
- DO 常驻内存，一步棋的延迟是 ~1ms 的内存操作。
- DO 还顺带承载 WebSocket（观战、AI vs AI 实时推流）。

> 如果想先跑通再上 DO：MVP 阶段可以让客户端持有状态、每步提交到 Worker 做无状态校验
> （服务端从 seed + 全部历史走法重算），单人小游戏完全够用。
> 但双人对战和防作弊迟早需要 DO，架构上一开始就留好这一层。

## 环境与部署

- `wrangler.toml` 里配置 D1 / KV / R2 / Queue / DO 绑定，dev / prod 两套环境。
- 数据库迁移用 `wrangler d1 migrations apply`，迁移文件进版本库。
- 前端和 Worker 一起部署，CI 用 GitHub Actions + `wrangler deploy`。
- 模型 API Key 用 Worker Secrets，绝不进前端。
