# 03 · 数据模型

## 存储分工（最重要的一张表）

| 数据 | 存哪 | 量级 | 理由 |
| --- | --- | --- | --- |
| 用户 / AI 模型注册表 | D1 | 千级 | 要 join、要查询 |
| 对局元数据（1 局 1 行） | D1 | 百万级可控 | 要排序、筛选、分页 |
| AI 录制任务（1 次 1 行） | D1 | 十万级 | 配额统计、失败任务排查 |
| **每一步的明细** | **R2**（每局一个 JSONL 对象） | 亿级 | 只按 matchId 整包读，不需要 SQL |
| AI 的 prompt / 完整回复 | **R2** | 亿级、体积大 | 单条可能几十 KB，放 D1 会撑爆 |
| 排行榜 | D1 预聚合表 + KV 快照 | 万级 | 读多写少，绝不实时 `ORDER BY` 扫全表 |
| session | **不存**（自签 JWT） | — | 避免每个请求查一次库 |
| 进行中的 AI 任务状态 | Durable Object storage | — | 临时数据，终局后落盘 |
| 进行中的人类对局 | **浏览器内存** | — | 只有开局和终局两次请求 |

**原则一句话：D1 里任何一张表的行数增长速度都不能和"步数"成正比，只能和"对局数"成正比。**

## D1 表结构

```sql
-- ---------- 用户（只有 Google 登录） ----------
CREATE TABLE players (
  id            TEXT PRIMARY KEY,              -- ULID
  kind          TEXT NOT NULL,                 -- 'human' | 'ai'
  handle        TEXT NOT NULL,                 -- URL 用的唯一短名，/p/{handle}
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  -- 人类玩家：Google sub（不存 email）
  google_sub    TEXT,
  -- AI 玩家：一个模型对应一个"虚拟玩家"
  model_key     TEXT,                          -- OpenRouter 的模型 id，如 'anthropic/claude-opus-4.5'
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL               -- epoch ms
);
CREATE UNIQUE INDEX idx_players_handle ON players(handle);
CREATE UNIQUE INDEX idx_players_google ON players(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX idx_players_model  ON players(model_key)  WHERE model_key  IS NOT NULL;

-- ---------- 模型注册表（Cron 从 OpenRouter /api/v1/models 同步） ----------
CREATE TABLE ai_models (
  key                TEXT PRIMARY KEY,         -- OpenRouter model id
  display_name       TEXT NOT NULL,
  vendor             TEXT NOT NULL,            -- 'anthropic' | 'openai' | ...
  context_length     INTEGER,
  price_in           REAL,                     -- 每百万 input token 美元
  price_out          REAL,
  supports_schema    INTEGER NOT NULL DEFAULT 0,  -- 是否支持 json_schema 结构化输出
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  -- 运营开关
  enabled            INTEGER NOT NULL DEFAULT 0,  -- 默认关闭，后台勾选启用
  max_game_plies     INTEGER,                  -- 贵模型限制只能跑短游戏
  pinned_provider    TEXT,                     -- 锁定供应商，保证排行榜可比性
  synced_at          INTEGER NOT NULL
);

-- ---------- AI 录制任务（一次点击 = 一行） ----------
CREATE TABLE ai_runs (
  id           TEXT PRIMARY KEY,               -- ULID = runId = DO name
  player_id    TEXT NOT NULL,                  -- 谁点的开始（用于配额与归属）
  game_id      TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  status       TEXT NOT NULL,                  -- 'queued'|'running'|'finished'|'failed'|'aborted'|'stalled'
  plies        INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  match_id     TEXT,                           -- 成功后关联的对局；失败则为 NULL
  error        TEXT,
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX idx_runs_player ON ai_runs(player_id, id DESC);
CREATE INDEX idx_runs_status ON ai_runs(status, id DESC);

-- ---------- 对局（一局一行，绝不按步增长） ----------
CREATE TABLE matches (
  id             TEXT PRIMARY KEY,             -- ULID：时间有序，直接当 keyset 分页游标
  game_id        TEXT NOT NULL,
  mode           TEXT NOT NULL,                -- 'single' | 'versus'
  track          TEXT NOT NULL,                -- 'human' | 'ai'
  seed           TEXT NOT NULL,
  ruleset_ver    INTEGER NOT NULL DEFAULT 1,   -- 规则变更后旧榜不与新榜混排
  status         TEXT NOT NULL,                -- 'finished' | 'invalid' | 'flagged'
  ended_reason   TEXT,                         -- 'terminal'|'illegal_move'|'ply_limit'|'aborted'
  score          INTEGER,
  result         TEXT,                         -- 'win'|'loss'|'draw'|NULL
  moves_count    INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  final_hash     TEXT,                         -- 终局状态哈希，回放核验用
  ai_run_id      TEXT,                         -- AI 赛道才有
  indexable      INTEGER NOT NULL DEFAULT 0,   -- 回放页是否允许搜索引擎收录（见 09 文档）
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL
);
-- 排行榜/列表的主力索引：覆盖索引，避免回表
CREATE INDEX idx_matches_board
  ON matches(game_id, track, status, score DESC, duration_ms ASC, id DESC);
CREATE INDEX idx_matches_recent ON matches(game_id, track, id DESC);

-- ---------- 对局参与者（一局 1~2 行） ----------
CREATE TABLE match_players (
  match_id   TEXT NOT NULL,
  seat       INTEGER NOT NULL,
  player_id  TEXT NOT NULL,
  is_ai      INTEGER NOT NULL,
  model_key  TEXT,
  score      INTEGER,
  result     TEXT,
  -- 这一局该 AI 的汇总（不是逐步！逐步在 R2）
  ai_calls          INTEGER DEFAULT 0,
  ai_illegal_moves  INTEGER DEFAULT 0,
  ai_input_tokens   INTEGER DEFAULT 0,
  ai_output_tokens  INTEGER DEFAULT 0,
  ai_cost_usd       REAL    DEFAULT 0,
  ai_latency_ms_sum INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX idx_mp_player ON match_players(player_id, match_id DESC);

-- ---------- 排行榜预聚合（读路径只查这张表 / 快照） ----------
CREATE TABLE leaderboard (
  game_id     TEXT NOT NULL,
  track       TEXT NOT NULL,                   -- 'human' | 'ai'
  window      TEXT NOT NULL,                   -- 'all' | 'daily:2026-09-22' | 'weekly:2026-W39'
  player_id   TEXT NOT NULL,
  best_score  INTEGER NOT NULL,
  best_match  TEXT NOT NULL,
  tiebreak_ms INTEGER,
  plays       INTEGER NOT NULL DEFAULT 0,
  rating      REAL,                            -- 双人游戏的 Elo
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (game_id, track, window, player_id)
);
CREATE INDEX idx_lb_rank
  ON leaderboard(game_id, track, window, best_score DESC, tiebreak_ms ASC);

-- ---------- 整榜快照（一行一个榜，前台直接读 JSON） ----------
CREATE TABLE leaderboard_snapshot (
  game_id    TEXT NOT NULL,
  track      TEXT NOT NULL,
  window     TEXT NOT NULL,
  payload    TEXT NOT NULL,                    -- JSON: Top 100，含玩家名和头像，免 join
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, track, window)
);

-- ---------- 计数器（替代实时 COUNT(*)） ----------
CREATE TABLE stats (
  key   TEXT PRIMARY KEY,                      -- 'matches:2048:human' 等
  value INTEGER NOT NULL DEFAULT 0
);
```

### 刻意不建的表

- ❌ `moves(match_id, ply, move, ...)` —— 最容易踩的坑。10 万局 × 平均 150 步 = 1500 万行，
  D1 会在索引维护、写入 QPS、容量上限三处同时出问题。走法明细一律进 R2。
- ❌ `ai_calls(match_id, ply, prompt, response)` —— 文本字段大，同理进 R2。
- ❌ `sessions(token, player_id, expires_at)` —— 用自签 JWT，省掉每请求一次查询。

### 如果确实需要对"步"做 SQL 分析

不要放进主库。用 **Analytics Engine** 打点每一步的指标（便宜、无限量、可 SQL 查询），
或者定期把 R2 的 JSONL 离线聚合成局级指标写回 D1。

## R2 对象布局

```
matches/{matchId}/moves.jsonl        # 每行一步：{ply, seat, move, ms, hash}
matches/{matchId}/ai/{ply}.json      # 该步的 prompt / 原始回复 / 推理 / usage / 重试
replays/{gameId}/{matchId}.json      # 终局后生成的回放包（seed + moves + meta），前端直接拉
```

`moves.jsonl` 单局体积：一步约 60 字节，800 步也就 48 KB，gzip 后更小。
R2 无出口流量费，看回放几乎零成本。

## KV 用法

| Key | Value | TTL |
| --- | --- | --- |
| `lb:{game}:{track}:{window}` | 排行榜 JSON | 60s（写时主动失效） |
| `quota:user:{playerId}:{date}` | 今日 AI 跑局次数 | 到当日结束 |
| `quota:cost:{date}` | 全站今日成本（美分） | 到当日结束 |
| `uver:{playerId}` | session 版本号（强制下线用） | 永久 |
| `jwks:google` | Google 公钥 | 按响应的 max-age |

KV 最终一致，排行榜秒级延迟完全可接受；个人最好成绩这类对一致性敏感的直接查 D1。
