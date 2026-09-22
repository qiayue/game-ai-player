# 03 · 数据模型

## 存储分工（最重要的一张表）

| 数据 | 存哪 | 量级 | 理由 |
| --- | --- | --- | --- |
| 用户 / AI 模型注册表 | D1 | 千级 | 要 join、要查询 |
| 对局元数据（1 局 1 行） | D1 | 百万级可控 | 要排序、筛选、分页 |
| **每一步的明细** | **R2**（每局一个 JSONL 对象） | 亿级 | 只按 matchId 整包读，不需要 SQL |
| AI 的 prompt / 完整回复 | **R2** | 亿级、体积大 | 单条可能几十 KB，放 D1 会撑爆 |
| 每步的轻量指标（耗时、是否非法、token 数） | D1 `match_steps_agg` 汇总到局级 | — | 只存聚合，不存逐步 |
| 排行榜 | D1 预聚合表 + KV 快照 | 万级 | 读多写少，绝不实时 `ORDER BY` 扫全表 |
| 进行中的对局状态 | Durable Object storage | — | 临时数据，终局后落盘 |

**原则一句话：D1 里任何一张表的行数增长速度都不能和"步数"成正比，只能和"对局数"成正比。**

## D1 表结构

```sql
-- ---------- 用户 ----------
CREATE TABLE players (
  id            TEXT PRIMARY KEY,              -- ULID
  kind          TEXT NOT NULL,                 -- 'human' | 'ai'
  display_name  TEXT NOT NULL,
  -- AI 玩家专用
  model_key     TEXT,                          -- 'anthropic/claude-opus-5' 等
  -- 人类玩家专用
  auth_provider TEXT,
  auth_subject  TEXT,
  created_at    INTEGER NOT NULL               -- epoch ms
);
CREATE UNIQUE INDEX idx_players_auth ON players(auth_provider, auth_subject)
  WHERE auth_provider IS NOT NULL;
CREATE UNIQUE INDEX idx_players_model ON players(model_key) WHERE model_key IS NOT NULL;

-- ---------- AI 模型注册 ----------
CREATE TABLE ai_models (
  key            TEXT PRIMARY KEY,             -- 'anthropic/claude-opus-5'
  provider       TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  input_price    REAL,                         -- 每百万 token 美元
  output_price   REAL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

-- ---------- 对局（一局一行，绝不按步增长） ----------
CREATE TABLE matches (
  id             TEXT PRIMARY KEY,             -- ULID：本身按时间有序，可做 keyset 分页游标
  game_id        TEXT NOT NULL,                -- 'tictactoe' | '2048' | ...
  mode           TEXT NOT NULL,                -- 'single' | 'versus'
  track          TEXT NOT NULL,                -- 'human' | 'ai' | 'mixed'
  seed           TEXT NOT NULL,
  ruleset_ver    INTEGER NOT NULL DEFAULT 1,   -- 规则变更后旧榜不与新榜混排
  status         TEXT NOT NULL,                -- 'playing' | 'finished' | 'abandoned' | 'invalid'
  score          INTEGER,                      -- 单人游戏分数；双人存胜负编码
  result         TEXT,                         -- 'win' | 'loss' | 'draw' | NULL
  moves_count    INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  final_hash     TEXT,                         -- 终局状态哈希，回放核验用
  moves_r2_key   TEXT,                         -- 'matches/{id}/moves.jsonl'
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);
-- 排行榜/列表的主力索引：覆盖索引，避免回表
CREATE INDEX idx_matches_board
  ON matches(game_id, track, status, score DESC, duration_ms ASC, id DESC);
CREATE INDEX idx_matches_recent ON matches(game_id, id DESC);

-- ---------- 对局参与者（一局 1~2 行） ----------
CREATE TABLE match_players (
  match_id   TEXT NOT NULL,
  seat       INTEGER NOT NULL,                 -- 0 / 1
  player_id  TEXT NOT NULL,
  is_ai      INTEGER NOT NULL,
  model_key  TEXT,
  score      INTEGER,
  result     TEXT,
  -- 这一局该玩家的 AI 成本/耗时汇总（不是逐步）
  ai_calls          INTEGER DEFAULT 0,
  ai_illegal_moves  INTEGER DEFAULT 0,
  ai_input_tokens   INTEGER DEFAULT 0,
  ai_output_tokens  INTEGER DEFAULT 0,
  ai_latency_ms_sum INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX idx_mp_player ON match_players(player_id, match_id DESC);

-- ---------- 排行榜预聚合（读路径只查这张表） ----------
CREATE TABLE leaderboard (
  game_id     TEXT NOT NULL,
  track       TEXT NOT NULL,                   -- 'human' | 'ai'
  window      TEXT NOT NULL,                   -- 'all' | 'daily:2026-09-22' | 'weekly:2026-W39'
  player_id   TEXT NOT NULL,
  best_score  INTEGER NOT NULL,
  best_match  TEXT NOT NULL,
  tiebreak_ms INTEGER,                         -- 同分比用时
  plays       INTEGER NOT NULL DEFAULT 0,
  rating      REAL,                            -- 双人游戏的 Elo
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (game_id, track, window, player_id)
);
CREATE INDEX idx_lb_rank
  ON leaderboard(game_id, track, window, best_score DESC, tiebreak_ms ASC);

-- ---------- 排行榜快照（整榜一行 JSON，前台直接读） ----------
CREATE TABLE leaderboard_snapshot (
  game_id    TEXT NOT NULL,
  track      TEXT NOT NULL,
  window     TEXT NOT NULL,
  payload    TEXT NOT NULL,                    -- JSON: top 100
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, track, window)
);
```

### 刻意不建的表

- ❌ `moves(match_id, ply, move, state_hash, ...)` —— 这是最容易踩的坑。
  10 万局 × 平均 150 步 = 1500 万行，D1 会在索引维护、写入 QPS、10 GB 上限三处同时出问题。
  走法明细一律进 R2。
- ❌ `ai_calls(match_id, ply, prompt, response)` —— 文本字段大，同理进 R2。

### 如果确实需要对"步"做 SQL 分析

不要放进主库。用 **Analytics Engine**（无限量、便宜、SQL API 查询）打点每一步的指标，
或者定期把 R2 里的 JSONL 用离线任务聚合成局级指标写回 D1。

## R2 对象布局

```
matches/{matchId}/moves.jsonl        # 每行一步：{ply, seat, move, ms, hash}
matches/{matchId}/ai/{ply}.json      # 该步的 prompt / raw response / usage / 重试记录
replays/{gameId}/{matchId}.json      # 终局后生成的回放包（seed + moves + meta），前端直接拉
```

`moves.jsonl` 单局体积：一步约 60 字节，500 步也就 30 KB，gzip 后更小。
R2 无出口流量费，读回放几乎零成本。

## KV 用法

| Key | Value | TTL |
| --- | --- | --- |
| `lb:{game}:{track}:{window}` | 排行榜 JSON | 60s（写时主动失效） |
| `replay:{matchId}` | 回放包 | 7 天 |
| `home:stats` | 首页统计数字 | 300s |

KV 是最终一致的，排行榜秒级延迟完全可接受；对一致性敏感的地方（个人最好成绩）直接查 D1。
