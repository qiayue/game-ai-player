# 08 · 实施路线

每个阶段都是"能跑起来的完整切片"，不做纯基建阶段。

## M0 · 骨架（1~2 天）

- monorepo：`packages/games`、`packages/shared`、`apps/worker`、`apps/web`、`content`
- `wrangler.toml` 绑定 D1 / KV / R2 / Queue / DO，本地 `wrangler dev` 跑通
- D1 迁移 `0001_init.sql`（见 [03-data-model.md](03-data-model.md) 的 DDL）
- 构建脚本：esbuild 打包游戏模块 + Markdown → 静态 HTML
- CI：typecheck + test + `wrangler deploy --dry-run`

## M1 · 人类玩 2048 的完整闭环 ★

先把"玩 → 存 → 回放 → 上榜"这条链路跑通，数据模型的正确性就被验证了。

- `GameDefinition` 接口 + PRNG + **2048**（单人、有随机、有分数，最能验证 seed 机制）
- 静态游戏页（含 SEO 正文）+ 原生 JS 游戏 UI（CSS Grid + 键盘/滑动操作）
- `POST /api/matches` → 玩 → `POST /finish` → 服务端 replay 校验 → R2 + D1
- 回放页 + 播放器（逐步 / 倍速 / 跳转）
- 人类排行榜：upsert + KV 快照 + Cron 重算

**验收**：能玩、能存、能回放、能上榜，首屏 HTML 里有完整文字内容。

## M2 · Google 登录

- GIS 按钮 + ID token 验签 + session JWT Cookie
- 匿名成绩认领
- 玩家主页 `/p/{handle}`
- AI 跑局配额的 KV 计数器（为 M3 铺路）

## M3 · AI 录制（核心差异化）★

- OpenRouter 客户端 + Cron 同步模型列表到 `ai_models`
- `AiRunDO`：alarm 自驱循环、断点续跑、幂等、超时看门狗、步数与成本硬上限
- prompt 协议 + 非法走法三次判负规则
- 前端：选模型 → 显示预估成本 → 点开始 → 轮询进度（棋盘像直播一样动）→ 切回放
- 回放页展开"AI 当时在想什么"
- AI 赛道排行榜 + `/games/2048/ai` 录像列表

**验收**：点一下按钮，一个模型自己把 2048 打完，全过程可回放、可看推理、能上榜。

## M4 · 游戏扩充 + 双人对战

- **井字棋**、**四子棋**（双人，AI vs AI 录制，模型对打）
- Elo 评分（人类池 / AI 池分离）
- 黑白棋、贪吃蛇
- `/models` 模型横评页（平均分、守规率、每分成本、决策质量）

## M5 · 性能与规模加固

- 按 [04-d1-performance.md](04-d1-performance.md) 的清单逐项验收
- 灌 50 万局模拟数据压测，`EXPLAIN QUERY PLAN` 进 CI
- 终局写入改 Queue 批量合并
- 归档 Cron（冷数据进 R2）
- 预留分库开关：`getDbForGame(gameId)` 抽象就位（即使当前只有一个库）

## M6 · SEO 与增长

- sitemap 分片 + 回放页 `indexable` 规则（只放精选录像）
- JSON-LD 结构化数据全站铺开
- 英文站 `/en/`（「claude plays 2048」这类词英文搜索量更大）
- 对局分享卡片（OG image 用 Worker 动态生成 SVG→PNG）
- 每日赛道：每天同一个 seed，人类和 AI 同题竞技

## M7 · 长尾

- 五子棋、数独、推箱子、华容道、扫雷（信息不完全，服务端持有隐藏层）
- 俄罗斯方块（改为"逐块决策"以适配 AI）
- 决策质量分析（四子棋写完美求解器算每步 loss）

---

## 待确认

1. **首批启用哪几个模型**？建议开局 3~4 个：一个顶级推理模型、一个主流中档、一个便宜快速的
   （便宜的用来跑 2048 这种上千步的长局），跑通后再扩。
2. **AI 跑局的日预算上限**是多少美元？这决定配额怎么配、贵模型是否对普通用户开放。
3. **中文站还是中英双语先行**？双语从一开始做比后补便宜很多。
4. M1 之后，你更想先要 **AI 录制（M3）** 还是 **更多游戏（M4）**？
   我的建议是 M3 优先——AI 录像是这个站点区别于其他小游戏站的唯一理由，也是 SEO 的主要抓手。
