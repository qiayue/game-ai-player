# 06 · AI 玩家

## 统一的 Provider 抽象

```ts
interface ModelProvider {
  key: string;                       // 'anthropic/claude-opus-5'
  call(req: {
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }>;
}
```

所有请求统一经过 **Cloudflare AI Gateway**，一处拿到：限速、重试、缓存、日志、成本统计。
各家 Key 存 Worker Secrets。新增模型 = 在 `ai_models` 表插一行 + 注册一个 provider 适配器。

## 提示词协议

系统提示固定三段：**规则 → 当前局面 → 输出格式**。

```
You are playing Connect Four as player X (seat 0).

RULES
- Board is 7 columns x 6 rows. Pieces drop to the lowest empty cell of a column.
- Four in a row (horizontal / vertical / diagonal) wins.

BOARD (row 0 is the top)
. . . . . . .
. . . . . . .
. . . . . . .
. . . O . . .
. . . X . . .
. . O X O . .

LEGAL MOVES: [0,1,2,3,4,5,6]

Think briefly, then output your move on the last line in exactly this format:
MOVE: <column>
```

要点：

- **总是把 `legalMoves` 一起给出来**，能显著降低非法走法率。
- 棋盘用人类可读的字符网格而不是原始数组——模型对 `. X O` 的空间理解明显好于 `[0,1,2]`。
  大棋盘（15×15）加坐标标尺。
- 输出格式约定一个易于正则提取的末行；支持 tool use / structured output 的模型走结构化输出，
  更稳定。
- 是否允许"思考文本"做成模型级配置：推理模型让它自由思考，非推理模型给 few-shot。
- 默认 `temperature = 0`，保证同局面可复现；想看多样性再单独开"高温赛道"。

## 非法走法处理（必须定死规则，否则排行榜不公平）

```
第 1 次非法 → 把错误信息回灌，重试（"Column 3 is full. Legal: [0,1,2,4,5,6]"）
第 2 次非法 → 再重试一次，提示更严格的格式
第 3 次非法 → 判定该步失败：
    - 双人游戏：直接判负，match.result = 'loss'，原因记为 'illegal_move'
    - 单人游戏：对局结束，保留当时分数
```

`match_players.ai_illegal_moves` 累计非法次数，排行榜旁边展示"守规率"，本身就是一个有意思的指标。

## 每步记录什么

| 字段 | 存哪 |
| --- | --- |
| ply、seat、最终走法、耗时、是否非法 | R2 `moves.jsonl`（每行一条） |
| 完整 prompt、模型原始回复、推理文本、重试记录、token 用量 | R2 `matches/{id}/ai/{ply}.json` |
| 本局 AI 调用数、非法数、token 总量、延迟总和 | D1 `match_players`（聚合，1 行） |

回放时，前端按需拉 `ai/{ply}.json` 展示"AI 当时在想什么"——这是这个平台最有看头的部分。

## 执行模型

- AI 的每一步由 **Queue 异步执行**，不阻塞 HTTP 请求。
  DO 投递 `{matchId, ply, seat}` → AI Worker 消费 → 回调 DO 落子 → 通过 WebSocket 推给观战者。
- 超时（比如 60s 无响应）视为该步失败，按非法走法流程处理。
- Queue 天然提供重试与死信队列；网络抖动不会毁掉一整局。
- 单局并发度为 1（DO 串行），全局并发由 Queue consumer 的 `max_concurrency` 控制。

## 成本控制

- 每个模型每天的调用次数 / token 预算存在 KV 计数器里，超了就暂停该模型的新对局。
- AI vs AI 的自动对战跑在 Cron 里，夜间低价时段批量刷榜，白天留给用户触发的对局。
- 棋盘序列化尽量短；长对局不重发全部历史，**只发当前局面**（游戏是马尔可夫的，
  除非规则依赖历史，如禁手/重复局面）。
- AI Gateway 的缓存对"同一局面 + 同一模型"直接命中，井字棋这类小状态空间命中率很高。

## 评测视角

有了逐步记录，可以做一些超出"排行榜"的分析：

- 每个模型的平均决策质量（用一个强引擎做参考，算每步的 loss）
- 非法走法率、格式遵循率
- 每分成本（token 成本 ÷ 得分）
- 同一局面下不同模型的选择差异对比
