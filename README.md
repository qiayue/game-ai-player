# Game AI Player

一个部署在 Cloudflare 上的经典小游戏平台：每个游戏的状态都可以用一维 / 多维数组完整描述，
人类玩家和 AI 模型玩家共用同一套游戏内核与同一套 API。

核心能力：

1. **多款经典小游戏**（井字棋、四子棋、黑白棋、2048、贪吃蛇、推箱子、数独……）
2. **人机同场**：人类在浏览器里点，AI 通过大模型逐步推理落子，走的是同一个 `POST /move` 接口
3. **逐步记录**：任何一个玩家（人或 AI）的每一步都被完整记录，包括走法、走之前的状态哈希、耗时；
   AI 还额外记录 prompt / 推理文本 / token 消耗
4. **完整回放**：从初始种子 + 走法序列可确定性重放整局，无需存每一帧
5. **排行榜**：按游戏 × 赛道（人类 / AI / 全部）× 时间窗排序，支持按模型维度看 AI 之间的高下

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/01-product.md](docs/01-product.md) | 游戏清单、每个游戏的状态数组表示、计分与分档 |
| [docs/02-architecture.md](docs/02-architecture.md) | Cloudflare 上的整体架构与技术选型 |
| [docs/03-data-model.md](docs/03-data-model.md) | D1 表结构、KV / R2 分工、完整 DDL |
| [docs/04-d1-performance.md](docs/04-d1-performance.md) | **D1 在大数据量下的性能问题与应对方案（重点）** |
| [docs/05-game-engine.md](docs/05-game-engine.md) | 游戏内核抽象：统一的状态数组 + reducer 接口 |
| [docs/06-ai-players.md](docs/06-ai-players.md) | AI 玩家接入、提示词协议、非法走法处理、成本控制 |
| [docs/07-api.md](docs/07-api.md) | HTTP API 设计 |
| [docs/08-roadmap.md](docs/08-roadmap.md) | 分阶段实施路线 |

## 一句话架构

```
浏览器 (React SPA)
      │  HTTPS
      ▼
Cloudflare Worker (Hono)  ──►  Durable Object: 单局对局房间（权威状态 + 走法缓冲）
      │                              │
      │                              ├─► Queue ──► AI Worker ──► AI Gateway ──► 各家模型
      │                              │
      ├─► D1   : 用户、对局元数据、排行榜快照（行数受控）
      ├─► KV   : 排行榜/首页读缓存
      └─► R2   : 走法明细 JSONL、AI 原始 prompt/response（冷数据、按局归档）
```

关键取舍：**D1 只存"可查询的、有限的、聚合过的"数据；每一步的明细与 AI 文本走 R2**。
详见 [docs/04-d1-performance.md](docs/04-d1-performance.md)。
