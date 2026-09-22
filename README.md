# Game AI Player

一个部署在 Cloudflare 上的经典小游戏平台：每个游戏的状态都可以用一维 / 多维数组完整描述，
人类玩家和 AI 模型玩家共用同一套游戏内核。

核心能力：

1. **多款经典小游戏**（2048、井字棋、四子棋、黑白棋、贪吃蛇、五子棋、数独、推箱子……）
2. **人类直接玩**：打开页面就能玩，不用登录；登录后成绩上榜
3. **AI 录制**：登录用户点一下「开始」，指定模型通过 **OpenRouter** 自己把一局打完，
   全程被录制下来，跑完即可在网页上逐步回放，并能展开看模型每一步的推理
4. **完整回放**：初始 seed + 走法序列即可确定性重放整局，不用存每一帧
5. **排行榜**：按游戏 × 赛道（人类 / AI）排序，AI 之间还能横向对比守规率与每分成本

## 技术选型（已确定）

| | 选择 |
| --- | --- |
| 前端 | **原生 HTML + ES module，零框架**。SEO 内容直接写在 HTML 里，游戏 JS 点击后才加载 |
| 登录 | **Google 登录**（Identity Services + 自签 session JWT，不建 session 表） |
| 模型 | **全部走 OpenRouter**，一套 API 接所有模型 |
| AI 执行 | **Durable Object + alarm 自驱循环**，手动触发、后台跑完、产出录像 |
| 数据库 | **D1**，行数严格与"对局数"线性，绝不与"步数"线性 |
| 冷数据 | **R2**（走法明细、AI prompt/回复、回放包） |

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/01-product.md](docs/01-product.md) | 游戏清单、状态数组表示、计分与公平性 |
| [docs/02-architecture.md](docs/02-architecture.md) | 整体架构、两条主数据流、反作弊 |
| [docs/03-data-model.md](docs/03-data-model.md) | 存储分工、完整 D1 DDL、R2/KV 布局 |
| [docs/04-d1-performance.md](docs/04-d1-performance.md) | **D1 大数据量下的 10 类性能问题与对策（重点）** |
| [docs/05-game-engine.md](docs/05-game-engine.md) | `GameDefinition` 接口、确定性 PRNG、回放与测试 |
| [docs/06-ai-players.md](docs/06-ai-players.md) | OpenRouter 接入、录制引擎、提示词协议、成本控制 |
| [docs/07-api.md](docs/07-api.md) | 页面路由 + HTTP API |
| [docs/08-roadmap.md](docs/08-roadmap.md) | M0~M7 分阶段实施路线 |
| [docs/09-frontend-seo.md](docs/09-frontend-seo.md) | 零框架前端、首屏 HTML、SEO 与缓存策略 |
| [docs/10-auth.md](docs/10-auth.md) | Google 登录、匿名游玩、权限与配额 |

## 一句话架构

```
浏览器（静态 HTML + 按需加载的游戏 JS）
      │  HTTPS（同源）
      ▼
Cloudflare Worker (Hono) ──► AiRunDO: 一次 AI 录制任务，alarm 自驱循环
      │                           │
      │                           └──► OpenRouter ──► 各家模型
      ├─► D1   : 用户、对局元数据、排行榜（行数受控）
      ├─► KV   : 排行榜快照、配额计数器
      ├─► R2   : 走法明细、AI prompt/回复、回放包
      └─► Queue: 终局写入批量合并
```

两条主数据流：

- **人类玩游戏**：整局只有 2 次 API 请求（开局拿 seed → 终局提交走法序列，服务端 replay 校验）
- **AI 跑游戏**：点击 → DO 后台逐步跑 → 前端轮询看"直播" → 跑完生成录像和排行榜条目

关键取舍：**D1 只存"可查询的、有限的、聚合过的"数据；每一步的明细和 AI 文本走 R2**。
详见 [docs/04-d1-performance.md](docs/04-d1-performance.md)。
