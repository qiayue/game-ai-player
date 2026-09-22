# 06 · AI 玩家：OpenRouter + 录制模式

## 核心决策：AI 对局 = 一次"录制任务"，不是实时对战

用户在页面上选好 `游戏 + 模型`，点「开始」，然后：

```
点击 → 创建一个 run（立即返回 runId，页面开始显示进度）
     → 后台逐步跑完整局（每步一次 OpenRouter 调用）
     → 跑完生成回放包
     → 回放页可以逐步观看，AI 每一步的推理都能展开看
```

这个决策消除了大量复杂度：

- **不需要实时对战的低延迟保证**，模型慢没关系（跑 10 分钟也行）
- **不需要 WebSocket 做双向交互**，进度用轮询就够（或 SSE 单向推送）
- **失败可以整局重试**，不会毁掉一个人类玩家的体验
- **成本可控**：一次点击 = 一个明确的预算单元，跑之前就能估算

页面上的 AI 对局本质上是"**录像**"，和 B 站上的速通视频是一个性质——
这也正好是 SEO 内容的来源（见 [09-frontend-seo.md](09-frontend-seo.md)）。

---

## 执行引擎：Durable Object + alarm 自驱循环

一局 2048 有 800 步 = 800 次 LLM 调用。单个 Worker 请求扛不住这个时长，必须持久化地分段执行。

**选型：`AiRunDO`，一个 DO 实例 = 一次 run。**

```
POST /api/ai-runs  →  Worker 生成 runId → 拿到 DO stub → stub.start(config) → 立即返回 runId
                                             │
                                             ▼
                                      DO.start(): 初始化 state，setAlarm(now)
                                             │
                                      ┌──────▼─────────────────────────────┐
                                      │ alarm() 每次执行一"批"（1~3 步）：  │
                                      │  1. toPrompt(state)                │
                                      │  2. fetch OpenRouter               │
                                      │  3. parseMove → 校验 → reduce      │
                                      │  4. 追加 move + AI 明细到缓冲       │
                                      │  5. 未终局 → setAlarm(now + 间隔)  │
                                      │     已终局 → finalize()            │
                                      └────────────────────────────────────┘
                                             │
                                      finalize(): 写 R2 回放 + AI 明细
                                                  → Queue 投递 D1 落库消息
```

为什么用 DO alarm 而不是 Cloudflare Workflows：

| | DO + alarm | Workflows |
| --- | --- | --- |
| 步数上限 | 无（自己控制循环） | 单实例有 step 数量上限，800 步需要打包 |
| 状态 | DO storage，读写就在本地 | 每个 step 的输出自动持久化 |
| 重试 | 自己写（更可控） | 内置指数退避 |
| 观测 | 自己实现进度查询 | 有现成的实例状态查询 |
| 复杂度 | 低 | 低 |

**结论：用 DO + alarm。** 步数没有上限这一条是决定性的——2048 / 贪吃蛇动辄几百上千步。
Workflows 更适合"步骤少、每步重"的场景。

### 关键实现细节

- **每次 alarm 只跑 1~3 步就返回**，把长任务切成很多个短请求，规避单次调用的 CPU / 时长限制。
- 每批结束后把 `state + moves缓冲` 写进 DO storage，进程被回收也能从断点续跑。
- **幂等**：每步带 `ply` 序号，重复执行同一 `ply` 直接跳过，防止 alarm 重放导致走两步。
- **超时看门狗**：记录 `lastProgressAt`，超过 5 分钟没进展就标记 `stalled` 并终止。
- **总步数硬上限**（每个游戏配置，如 2048 上限 2000 步），防止死循环烧钱。
- **暂停 / 取消**：用户可以中止，DO 收到后清掉 alarm，把已跑的部分作为"未完成录像"保存。

## 进度反馈

前端在 run 进行中每 2 秒轮询一次：

```json
GET /api/ai-runs/{runId}
{ "status": "running", "ply": 147, "score": 3284, "board": [...], "lastThought": "右下角..." }
```

页面上棋盘实时跟着动——**用户看到的就是一场直播**，虽然底层只是轮询。
跑完后 `status: "finished"`，前端切到回放播放器。

轮询打的是 DO（不是 D1），一次读内存，成本可以忽略。
在线人数多时可以升级成 SSE（DO 支持长连接），但轮询先够用。

---

## OpenRouter 接入

所有模型统一走 OpenRouter，一套 API 一个 Key，接新模型只需改配置。

```ts
// apps/worker/src/ai/openrouter.ts
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': env.SITE_URL,      // OpenRouter 用于榜单归属，可选但建议带
    'X-Title': 'Game AI Player',
  },
  body: JSON.stringify({
    model: 'anthropic/claude-opus-4.5',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: 512,
    // 主模型不可用时自动降级，避免整局中断
    models: ['anthropic/claude-opus-4.5', 'openai/gpt-5'],
    // 有的模型支持结构化输出，优先用它拿稳定格式
    response_format: { type: 'json_schema', json_schema: MOVE_SCHEMA },
    provider: { require_parameters: true },
    usage: { include: true },          // 返回体里带 token 用量与成本
  }),
});
```

要点：

- **模型列表从 OpenRouter 的 `/api/v1/models` 拉取**，Cron 每天同步一次到 D1 `ai_models` 表
  （模型名、上下文长度、单价、是否支持 structured output / reasoning）。
  这样新模型上线你不用改代码，后台勾选启用即可。
- **精确成本**：响应的 `usage` 字段直接给出成本；需要更精确可以事后查
  `/api/v1/generation?id={gen_id}`。成本按步累加，最终写进 `match_players.ai_cost_usd`。
- **`models` 数组做 fallback**：某个 provider 抽风时自动切换，避免一局跑到一半崩掉。
- **`provider.order` / `provider.only`** 可以锁定具体供应商，保证同一模型在不同 run 之间的
  行为一致（不同供应商的量化版本可能表现不同，这会影响排行榜公平性）。**建议锁定。**
- 可选：外面再套一层 **Cloudflare AI Gateway**（把 baseURL 指向 gateway），
  免费拿到统一日志、缓存、限速和成本看板。井字棋这类小状态空间的缓存命中率很高。

### 错误与重试

| 情况 | 处理 |
| --- | --- |
| 429 / 5xx | 指数退避重试 3 次（在 alarm 的下一批里重试，不阻塞） |
| 超时（> 60s） | 当作一次失败，重试 |
| 连续 3 次调用失败 | run 标记 `failed`，保留已跑部分，前端显示"录制中断" |
| 模型返回非法走法 | 见下方规则 |

---

## 提示词协议

系统提示固定三段：**规则 → 当前局面 → 输出格式**。

```
You are playing 2048. Your goal is to reach the highest score.

RULES
- 4x4 grid. Each move slides ALL tiles in one direction.
- Equal adjacent tiles merge into one tile of double the value; each tile merges at most once per move.
- After each move a new tile (2 with 90% chance, 4 with 10%) appears in a random empty cell.
- The game ends when no move changes the board.

BOARD (row 0 is the top)
   0    2    4    2
   0    0    8   16
   2    4   32   64
   4    8   16  128
SCORE: 1284
LEGAL MOVES: UP, DOWN, LEFT, RIGHT

Think briefly, then output your move on the last line exactly as:
MOVE: <UP|DOWN|LEFT|RIGHT>
```

- **总是附上 `LEGAL MOVES`**，能显著降低非法走法率。
- 棋盘用人类可读的对齐网格，不要原始 JSON 数组——模型对视觉网格的空间理解明显更好。
  大棋盘（五子棋 15×15）加行列坐标标尺。
- 支持结构化输出的模型走 `json_schema`，其余用末行正则提取，双保险。
- 推理模型（带 reasoning 的）让它自由思考，普通模型给 2 个 few-shot 示例。
- **`temperature = 0`** 保证可复现；想看多样性另开"高温赛道"，两者不混榜。
- **不发历史走法，只发当前局面**。游戏是马尔可夫的，这能把每步的 input token 压到几百个，
  是控制成本最有效的一招。（除非规则依赖历史，如禁手、重复局面判和。）

## 非法走法处理（必须定死，否则排行榜不公平）

```
第 1 次非法 → 回灌错误信息重试："LEFT does not change the board. Legal: UP, DOWN, RIGHT"
第 2 次非法 → 再重试一次，加严格格式提示
第 3 次非法 → 该步失败：
    单人游戏 → 对局结束，保留当时分数，标记 ended_reason='illegal_move'
    双人游戏 → 判负
```

`match_players.ai_illegal_moves` 累计非法次数，排行榜旁展示「守规率」——
这本身就是一个很有意思的模型对比指标。

## 每步记录什么

| 数据 | 存哪 |
| --- | --- |
| ply、走法、耗时、是否非法重试过 | R2 `matches/{id}/moves.jsonl`（每行一条） |
| 完整 prompt、原始回复、推理文本、重试记录、token、成本 | R2 `matches/{id}/ai/{ply}.json` |
| 本局汇总：调用数、非法数、token 总量、总成本、总延迟 | D1 `match_players`（1 行） |

回放时前端按需拉 `ai/{ply}.json` 展示"AI 当时在想什么"。**这是整个平台最有看头的部分**，
也是回放页能吃到搜索流量的原因。

## 成本控制

- 用户配额 + 全站日预算，都在 KV 计数器里（见 [10-auth.md](10-auth.md)）。
- 创建 run 之前先**预估成本**：`平均步数 × (prompt tokens + 输出 tokens) × 单价`，
  在确认按钮上直接显示"预计消耗 $0.12"，超过阈值要二次确认。
- 贵的模型限制只能跑短游戏（井字棋、四子棋）；2048 / 贪吃蛇这种上千步的默认只开放便宜模型，
  贵模型需要管理员手动放行。
- 每个游戏配一个 `maxPlies` 和 `maxCostUsd`，跑到上限强制结束。

## 模型横评

有了逐步记录，可以做超出排行榜的分析，并生成 `/models` 页面的内容：

- 平均分 / 最高分 / 达成率（比如"合出 2048 的比例"）
- 非法走法率、格式遵循率
- 每分成本（总成本 ÷ 得分）—— 性价比榜
- 平均每步决策延迟
- 决策质量：用一个强引擎（四子棋可以写完美求解器）算每步的 loss，得到"平均失误幅度"
