export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  FINISH_QUEUE: Queue<unknown>;
  AI_RUN: DurableObjectNamespace;

  SITE_URL: string;
  SITE_NAME: string;
  GOOGLE_CLIENT_ID: string;
  DAILY_BUDGET_USD: string;
  USER_DAILY_RUNS: string;

  // secrets
  SESSION_SECRET: string;
  OPENROUTER_API_KEY: string;
  /** 可选：把 OpenRouter 请求走 AI Gateway，拿统一日志/缓存/限速 */
  AI_GATEWAY_URL?: string;
  /** 逗号分隔的管理员 Google sub */
  ADMIN_SUBS?: string;
}

export interface Vars {
  user: import('@gap/shared').PublicUser | null;
}
