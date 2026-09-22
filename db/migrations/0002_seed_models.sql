-- 首批可用模型。真实价格与能力由 Cron 从 OpenRouter /api/v1/models 覆盖同步，
-- 这里只是让站点在首次同步之前也能用。enabled 需要管理员在后台确认。
INSERT INTO ai_models (key, display_name, vendor, context_length, price_in, price_out,
                       supports_schema, supports_reasoning, enabled, max_game_plies, sort_order, synced_at)
VALUES
  ('anthropic/claude-opus-4.5',      'Claude Opus 4.5',   'anthropic', 200000, 5.0,  25.0, 1, 1, 0, 200,  10, 0),
  ('anthropic/claude-sonnet-4.5',    'Claude Sonnet 4.5', 'anthropic', 200000, 3.0,  15.0, 1, 1, 1, 600,  20, 0),
  ('anthropic/claude-haiku-4.5',     'Claude Haiku 4.5',  'anthropic', 200000, 1.0,   5.0, 1, 0, 1, NULL, 30, 0),
  ('openai/gpt-5',                   'GPT-5',             'openai',    400000, 1.25, 10.0, 1, 1, 0, 400,  40, 0),
  ('openai/gpt-5-mini',              'GPT-5 mini',        'openai',    400000, 0.25,  2.0, 1, 0, 1, NULL, 50, 0),
  ('google/gemini-2.5-pro',          'Gemini 2.5 Pro',    'google',   1000000, 1.25, 10.0, 1, 1, 0, 400,  60, 0),
  ('google/gemini-2.5-flash',        'Gemini 2.5 Flash',  'google',   1000000, 0.3,   2.5, 1, 0, 1, NULL, 70, 0),
  ('deepseek/deepseek-chat',         'DeepSeek Chat',     'deepseek',  128000, 0.27,  1.1, 0, 0, 1, NULL, 80, 0),
  ('meta-llama/llama-3.3-70b-instruct','Llama 3.3 70B',   'meta',      128000, 0.12,  0.3, 0, 0, 1, NULL, 90, 0);
