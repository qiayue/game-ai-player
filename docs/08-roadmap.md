# 08 · 实施路线

每个阶段都是"能跑起来的完整切片"，不做纯基建阶段。

## M0 · 骨架（1~2 天）

- monorepo 搭起来：`packages/games`、`packages/shared`、`apps/worker`、`apps/web`
- `wrangler.toml` 绑定 D1 / KV / R2，本地 `wrangler dev` 能跑
- D1 迁移 `0001_init.sql` 落地（见 03 文档的 DDL）
- CI：typecheck + test + `wrangler deploy --dry-run`

## M1 · 单人游戏闭环（核心，先把链路打通）

- 实现 `GameDefinition` 接口 + **2048**（单人、有随机、有分数，最能验证 seed 机制）
- 无 DO 版本：客户端持有状态，服务端从 `seed + moves[]` 重算校验（先简单）
- 终局写 R2 `moves.jsonl` + D1 `matches` 1 行
- 回放页跑通
- 排行榜（人类赛道）：upsert + KV 快照 + Cron 重算

**验收**：能玩、能存、能回放、能上榜。这时候数据模型的正确性已经被验证了。

## M2 · 接入 AI 玩家

- Provider 抽象 + AI Gateway + 先接 1 个模型
- Queue 异步执行每一步；prompt 协议与非法走法规则落地
- AI 赛道排行榜；回放页显示 AI 每步的推理
- 成本计数器与预算熔断

**验收**：一个模型能独立打完一局 2048 并上榜，回放里能看到它每步怎么想的。

## M3 · 双人对战 + Durable Object

- 引入 DO 作为对局房间，权威状态迁进去，WebSocket 观战
- 实现 **井字棋** 和 **四子棋**
- 人 vs AI、AI vs AI
- Elo 评分（人类池 / AI 池分离）

## M4 · 扩充游戏与模型

- 黑白棋、贪吃蛇、五子棋、数独、推箱子
- 接入 3~5 家模型，做模型横评页
- Cron 夜间自动 AI vs AI 刷榜

## M5 · 规模化与性能加固

- 按 [04-d1-performance.md](04-d1-performance.md) 的清单逐项验收
- 灌 50 万局模拟数据做压测，`EXPLAIN QUERY PLAN` 进 CI
- 终局写入改 Queue 批量合并
- 归档 Cron（冷数据进 R2）
- 预留分库开关：`getDbForGame(gameId)` 抽象就位（即使当前只有一个库）

## M6 · 打磨

- 日赛道（每日同 seed，人和 AI 同题竞技）
- 个人主页、对局分享卡片
- 移动端适配、键盘/手势操作
- 模型评测报告页（守规率、每分成本、决策质量）

---

## 需要你先拍板的几件事

1. **前端框架**：纯 Vite SPA（轻、快）还是 Next.js on Cloudflare（有 SSR / SEO 收益）？
   如果希望游戏页被搜索引擎收录，建议 Next.js；否则 Vite 更省事。
2. **登录**：一开始就要账号体系，还是先匿名（localStorage token）后补 OAuth？
3. **首批模型**：想先接哪几家？这决定 provider 适配器的优先级。
4. **AI vs AI 自动跑榜的预算上限**：每天愿意花多少，决定 Cron 的频率和模型选择。
5. **游戏优先级**：M1 用 2048 打通链路，之后你最想先要哪几个？
