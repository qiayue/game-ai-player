# Game AI Player

一个部署在 Cloudflare 上的经典小游戏平台：每个游戏的状态都能用一维 / 多维数组完整描述，
人类玩家和 AI 模型玩家共用同一套游戏内核。

- **11 款经典小游戏**：2048、井字棋、四子棋、五子棋、黑白棋、贪吃蛇、扫雷、数独、
  数字华容道、推箱子、记忆翻牌
- **打开就能玩**，不用登录。想让成绩上榜再用 Google 账号登录，之前打的几局会自动补记
- **AI 录制**：登录用户点一下「开始录制」，指定模型通过 OpenRouter 自己把一整局打完，
  跑完即可逐步回放，并展开看它每一步的推理、提示词和被拒绝的非法走法
- **完整回放**：整局只存 `seed + 走法序列`，前端本地重放出每一帧
- **排行榜**：人类和 AI 两条独立赛道；单人游戏比分数，双人游戏用 Elo

## 现在的状态

游戏内核、Worker、页面、前端、AI 录制链路都已实现并验证：

| | |
| --- | --- |
| 单元测试 | 188 项（游戏规则、确定性、模糊测试、AI 提示词协议、JWT、Elo、反作弊） |
| 端到端冒烟 | 36 项（开局 → 玩完 → 服务端校验 → 上榜 → 回放 → 权限 → 反作弊） |
| AI 链路冒烟 | 24 项（DO alarm 循环 → 非法走法重试 → R2 → Queue → D1 → 排行榜） |
| 浏览器验证 | 15 项（真实点击玩 2048 / 井字棋 / 扫雷 / 数独、回放器、按需加载、移动端） |

前端产物：`app.js` 6 KB，每个游戏 2–5 KB，进页面时**不加载任何游戏代码**。

## 本地跑起来

```bash
npm install
npm run build                       # 用 esbuild 打包前端，产物进 apps/web/public/assets
npx wrangler d1 migrations apply game_ai_player --local
cp .dev.vars.example .dev.vars      # 填 SESSION_SECRET；OPENROUTER_API_KEY 可留空
npx wrangler dev                    # http://localhost:8787
```

不填 `OPENROUTER_API_KEY` 也能玩全部游戏，只是不能发起 AI 录制。

## 部署

```bash
npx wrangler d1 create game_ai_player          # 把返回的 database_id 填进 wrangler.toml
npx wrangler kv namespace create KV            # 同上，填 id
npx wrangler r2 bucket create game-ai-player
npx wrangler queues create match-finish
npx wrangler queues create match-finish-dlq

npx wrangler secret put SESSION_SECRET         # 随机长字符串
npx wrangler secret put OPENROUTER_API_KEY
# GOOGLE_CLIENT_ID 是公开值，直接写进 wrangler.toml 的 [vars]
# ADMIN_SUBS 填你自己的 Google sub（逗号分隔），用来访问 /api/admin/*

npx wrangler d1 migrations apply game_ai_player --remote
npm run deploy
```

部署后第一件事：调 `POST /api/admin/models/sync` 从 OpenRouter 同步模型列表，
再用 `POST /api/admin/models/{key}` 把要开放的模型 `enabled` 打开。
之后每天凌晨的 Cron 会自动同步。

## 代码结构

```
packages/games      纯 TypeScript 游戏内核，零依赖，前端 / Worker / 回放三处共用
  src/core          GameDefinition 接口、确定性 PRNG、状态哈希、连子判定、文本棋盘、replay
  src/games         11 个游戏，一个文件一个
packages/shared     API 类型
apps/worker         Hono API + 服务端渲染页面 + AiRunDO + Queue consumer + Cron
  src/pages         每个页面一个文件，输出完整 HTML
  src/content       各游戏的 SEO 正文
  src/ai            OpenRouter 客户端、提示词协议、成本预估
apps/web/src        零框架前端：通用棋盘渲染器、对局运行时、回放器、localStorage 缓存
db/migrations       D1 迁移
docs                设计文档
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/01-product.md](docs/01-product.md) | 游戏清单、状态数组表示、计分与公平性 |
| [docs/02-architecture.md](docs/02-architecture.md) | 架构、两条主数据流、对局票据、反作弊 |
| [docs/03-data-model.md](docs/03-data-model.md) | 存储分工、完整 D1 DDL、R2/KV 布局 |
| [docs/04-d1-performance.md](docs/04-d1-performance.md) | **D1 大数据量下的 12 类性能问题与对策（重点）** |
| [docs/05-game-engine.md](docs/05-game-engine.md) | `GameDefinition` 接口、确定性 PRNG、回放与测试 |
| [docs/06-ai-players.md](docs/06-ai-players.md) | OpenRouter 接入、录制引擎、提示词协议、成本控制 |
| [docs/07-api.md](docs/07-api.md) | 页面路由 + HTTP API |
| [docs/08-roadmap.md](docs/08-roadmap.md) | 分阶段实施路线 |
| [docs/09-frontend-seo.md](docs/09-frontend-seo.md) | 零框架前端、首屏 HTML、SEO 与缓存策略 |
| [docs/10-auth.md](docs/10-auth.md) | Google 登录、匿名游玩、权限与配额 |

## 架构一句话

```
浏览器（静态 HTML + 按需加载的游戏 JS）
      │  HTTPS（同源）
      ▼
Cloudflare Worker (Hono) ──► AiRunDO：一次 AI 录制任务，alarm 自驱循环
      │                           └──► OpenRouter ──► 各家模型
      ├─► D1   : 用户、对局元数据、排行榜（行数只与对局数成正比）
      ├─► KV   : 排行榜快照、配额计数器、模型列表
      ├─► R2   : 走法明细、AI prompt/回复、回放包
      └─► Queue: 终局写入批量合并
```

两条主数据流：

- **人类玩游戏**：整局只有 2 次 API 请求（开局拿签名票据 → 终局提交走法序列，服务端 replay 校验）。
  信息不完全的游戏改为逐步提交，但服务端每次从 seed 重放，同样不保存中间状态
- **AI 跑游戏**：点击 → Durable Object 后台逐步跑 → 前端轮询看「直播」→ 跑完生成录像和排行榜条目

核心取舍：**D1 只存可查询的、有限的、聚合过的数据；每一步的明细和 AI 文本全部走 R2。**
详见 [docs/04-d1-performance.md](docs/04-d1-performance.md)。
