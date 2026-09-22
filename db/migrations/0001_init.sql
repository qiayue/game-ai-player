-- 初始 schema。
-- 设计约束：任何一张表的行数只与「对局数」成正比，绝不与「步数」成正比。
-- 走法明细、AI 的 prompt/回复一律在 R2；session 不落库（自签 JWT）。

CREATE TABLE players (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                 -- 'human' | 'ai'
  handle        TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  google_sub    TEXT,                          -- 人类玩家；不存 email
  model_key     TEXT,                          -- AI 玩家：一个模型一个虚拟玩家
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_players_handle ON players(handle);
CREATE UNIQUE INDEX idx_players_google ON players(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX idx_players_model  ON players(model_key)  WHERE model_key  IS NOT NULL;

CREATE TABLE ai_models (
  key                TEXT PRIMARY KEY,         -- OpenRouter model id
  display_name       TEXT NOT NULL,
  vendor             TEXT NOT NULL,
  context_length     INTEGER,
  price_in           REAL,                     -- 每百万 input token 美元
  price_out          REAL,
  supports_schema    INTEGER NOT NULL DEFAULT 0,
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 0,
  max_game_plies     INTEGER,                  -- 贵模型只放开短局
  pinned_provider    TEXT,                     -- 锁定供应商，保证可比性
  sort_order         INTEGER NOT NULL DEFAULT 100,
  synced_at          INTEGER NOT NULL
);
CREATE INDEX idx_models_enabled ON ai_models(enabled, sort_order);

CREATE TABLE ai_runs (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL,                  -- 谁点的开始
  game_id      TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  opponent_key TEXT,
  status       TEXT NOT NULL,
  plies        INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  match_id     TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX idx_runs_player ON ai_runs(player_id, id DESC);
CREATE INDEX idx_runs_status ON ai_runs(status, id DESC);

CREATE TABLE matches (
  id             TEXT PRIMARY KEY,             -- ULID，时间有序，直接当 keyset 游标
  game_id        TEXT NOT NULL,
  mode           TEXT NOT NULL,                -- 'single' | 'versus'
  track          TEXT NOT NULL,                -- 'human' | 'ai'
  seed           TEXT NOT NULL,
  ruleset_ver    INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL,                -- 'finished' | 'invalid' | 'flagged'
  ended_reason   TEXT,
  score          INTEGER,
  result         TEXT,
  moves_count    INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  final_hash     TEXT,
  ai_run_id      TEXT,
  indexable      INTEGER NOT NULL DEFAULT 0,   -- 回放页是否允许被搜索引擎收录
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL
);
CREATE INDEX idx_matches_board
  ON matches(game_id, track, status, score DESC, duration_ms ASC, id DESC);
CREATE INDEX idx_matches_recent ON matches(game_id, track, id DESC);
CREATE INDEX idx_matches_indexable ON matches(indexable, id DESC);

CREATE TABLE match_players (
  match_id   TEXT NOT NULL,
  seat       INTEGER NOT NULL,
  player_id  TEXT NOT NULL,
  is_ai      INTEGER NOT NULL,
  model_key  TEXT,
  score      INTEGER,
  result     TEXT,
  -- 这一局该 AI 的汇总；逐步明细在 R2
  ai_calls          INTEGER DEFAULT 0,
  ai_illegal_moves  INTEGER DEFAULT 0,
  ai_input_tokens   INTEGER DEFAULT 0,
  ai_output_tokens  INTEGER DEFAULT 0,
  ai_cost_usd       REAL    DEFAULT 0,
  ai_latency_ms_sum INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX idx_mp_player ON match_players(player_id, match_id DESC);

CREATE TABLE leaderboard (
  game_id     TEXT NOT NULL,
  track       TEXT NOT NULL,
  window_key  TEXT NOT NULL,                   -- 'all' | 'daily:2026-09-22' | 'weekly:2026-W39'
  player_id   TEXT NOT NULL,
  best_score  INTEGER NOT NULL,
  best_match  TEXT NOT NULL,
  tiebreak_ms INTEGER,
  plays       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  rating      REAL,                            -- 双人游戏 Elo
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (game_id, track, window_key, player_id)
);
CREATE INDEX idx_lb_rank
  ON leaderboard(game_id, track, window_key, best_score DESC, tiebreak_ms ASC);

CREATE TABLE leaderboard_snapshot (
  game_id    TEXT NOT NULL,
  track      TEXT NOT NULL,
  window_key TEXT NOT NULL,
  payload    TEXT NOT NULL,                    -- JSON: Top 100，含玩家名，免 join
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, track, window_key)
);

-- 计数器，替代实时 COUNT(*)
CREATE TABLE stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- 模型横评页的聚合查询用；这个查询只在 Cron 里跑并缓存到 KV，不在热路径上
CREATE INDEX idx_mp_model ON match_players(model_key) WHERE model_key IS NOT NULL;
