# 02 · 架构与技术选型

## 组件

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 前端 | **原生 HTML + ES module，零框架**，托管在 Workers Static Assets | 首屏 HTML 自带 SEO 内容；游戏 JS 按需加载。详见 [09-frontend-seo.md](09-frontend-seo.md) |
| 动态页渲染 | Worker 里拼 HTML / HTMLRewriter 注入 | 排行榜、回放页也输出完整 HTML，可被索引 |
| API | 单个 Cloudflare Worker + Hono | 和前端同源，无 CORS，冷启动快 |
| 登录 | **Google Identity Services + 自签 session JWT** | 无回调页、无 session 表。详见 [10-auth.md](10-auth.md) |
| AI 跑局 | **Durable Object + alarm 自驱循环** | 一个 DO = 一次录制任务，无步数上限、可断点续跑 |
| 模型接入 | **OpenRouter（可选套 AI Gateway）** | 一套 API 接全部模型 |
| 关系数据 | D1 | 用户、对局元数据、排行榜。**行数严格受控** |
| 冷数据 | R2 | 走法明细 JSONL、AI prompt / 回复、回放包 |
| 读缓存 | KV + Cache API | 排行榜快照、配额计数器、页面缓存 |
| 异步落库 | Queues | 终局写入批量合并，削平 D1 写入峰值 |
| 定时任务 | Cron Triggers | 同步模型列表、重算排行榜、归档、重建静态页 |

## 全景图

```
                         浏览器（静态 HTML，游戏 JS 按需 import）
                                    │  HTTPS（同源）
                                    ▼
                    ┌───────────────────────────────────┐
                    │   Cloudflare Worker (Hono)        │
                    │   · 静态资源 / SSR 动态页          │
                    │   · /api/*                        │
                    └───┬───────────┬───────────┬───────┘
                        │           │           │
          ┌─────────────┘           │           └──────────────┐
          ▼                         ▼                          ▼
   ┌─────────────┐          ┌──────────────┐           ┌──────────────┐
   │  AiRunDO    │          │  D1          │           │  KV / Cache  │
   │ 一次录制任务 │          │ 用户/对局/榜  │           │ 榜快照/配额   │
   │ alarm 循环  │          └──────▲───────┘           └──────────────┘
   └──┬───────┬──┘                 │
      │       │                    │ Queue 批量写
      │       └────────────────────┘
      ▼
 ┌──────────────┐        ┌──────────────┐
 │  OpenRouter  │        │  R2          │
 │  各家模型     │        │ 走法/AI明细/  │
 └──────────────┘        │ 回放包        │
                         └──────────────┘
```

## 两条主要数据流

### A. 人类玩游戏（极简，不用 DO）

```
1. GET /games/2048 → 静态 HTML（含 SEO 文字 + 排行榜 Top10）
2. 点「开始游戏」 → import('/js/games/2048.js')
3. POST /api/matches { gameId } → 服务端生成并记录 seed + startedAt，返回 { matchId, seed }
4. 游戏全程在浏览器里跑，每步只记录到内存数组，不发请求 ← 零延迟、零服务端压力
5. 终局 → POST /api/matches/{id}/finish { moves[], durationMs, clientFinalHash }
6. 服务端用同一份内核 replay 一遍 moves：
     - 校验每步合法、终局哈希一致
     - 反作弊检查（见下）
     - 写 R2 moves.jsonl + 回放包
     - Queue → D1 写 1 行 matches + 排行榜 upsert
```

**整局只有 2 次 API 请求。** 不需要 Durable Object，不需要 WebSocket。

服务端 replay 的成本极低：2048 跑 800 步纯数组运算不到 1ms。

### B. AI 跑游戏（录制任务）

```
1. 登录用户在页面选 游戏 + 模型 → 显示预估成本 → 点「开始录制」
2. POST /api/ai-runs → 校验配额 → 创建 AiRunDO → 立即返回 runId
3. DO 的 alarm 循环：每批跑 1~3 步（prompt → OpenRouter → 落子 → 记录 → 重设 alarm）
4. 前端每 2 秒 GET /api/ai-runs/{id}，棋盘跟着动 —— 用户看到的是一场"直播"
5. 终局 → DO 写 R2（moves.jsonl + 每步 AI 明细 + 回放包）→ Queue → D1
6. 前端切到回放播放器；这一局同时出现在 /games/2048/ai 列表和排行榜 AI 赛道
```

详见 [06-ai-players.md](06-ai-players.md)。

## 反作弊（人类赛道）

客户端持有游戏状态意味着理论上可以伪造走法序列。缓解手段（够用即可，不追求绝对）：

- **seed 由服务端生成并记录下发时间**，客户端拿不到"未来"的随机数
- **服务端 replay 全部走法**，非法走法直接拒绝——伪造必须是"真的算出一个合法高分序列"
- **时间校验**：`durationMs >= moves × 每步最小耗时`（如 60ms），且提交时间与开局时间吻合
- **节奏异常检测**：逐步时间戳的方差过小（机器般均匀）标记为可疑
- **分数阈值**：超过历史 P99.9 的成绩进人工/自动复核队列，复核通过才上榜
- 榜上成绩都有回放，社区可以举报

作弊者最多能拿到"用脚本玩"的成绩，而这个成本已经高于收益。AI 赛道本来就是机器玩，不存在这个问题。

## 代码结构（monorepo）

```
/packages/games          # 纯 TypeScript 游戏内核，零依赖，前后端共用 ★
    src/core/types.ts    #   GameDefinition 接口 + PRNG
    src/games/2048/      #   每个游戏：reducer / 合法走法 / 终局 / toPrompt / parseMove
    src/index.ts         #   registry
/packages/shared         # API 类型、zod schema、常量
/apps/worker             # Hono API + 页面渲染 + AiRunDO + Queue consumer
/apps/web                # 静态 HTML 模板、CSS、游戏 UI 绑定层、构建脚本
/db/migrations           # D1 迁移 SQL
/content                 # 各游戏的 SEO 文案（Markdown，构建时注入 HTML）
```

**`packages/games` 必须是纯函数：无 I/O、无 `Date.now()`、无 `Math.random()`。**
这是回放、服务端校验、AI 驱动三者共用一份逻辑的前提。

## 部署

- `wrangler.toml` 配置 D1 / KV / R2 / Queue / DO 绑定，dev / prod 两套环境
- `wrangler d1 migrations apply` 做迁移，迁移文件进版本库
- CI（GitHub Actions）：typecheck → test → build（esbuild 打包游戏模块 + 生成静态 HTML）→ `wrangler deploy`
- `OPENROUTER_API_KEY`、`SESSION_SECRET` 用 Worker Secrets；`GOOGLE_CLIENT_ID` 是公开值，可进前端
