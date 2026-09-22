/**
 * OpenRouter 客户端。所有模型都从这里走，接新模型只需要在 ai_models 表里开一行。
 * 可选把 baseURL 指向 Cloudflare AI Gateway，免费拿到统一日志 / 缓存 / 限速。
 */
import type { Env } from '../env.js';

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  /** 主模型不可用时按顺序降级，避免一局跑到一半崩掉 */
  fallbacks?: string[];
  /** 锁定供应商，保证同一模型在不同 run 之间行为一致 */
  provider?: string | null;
  jsonSchema?: unknown;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  modelUsed: string;
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

function baseUrl(env: Env): string {
  return (env.AI_GATEWAY_URL || DEFAULT_BASE).replace(/\/$/, '');
}

export async function chat(env: Env, opts: ChatOptions): Promise<ChatResult> {
  if (!env.OPENROUTER_API_KEY) throw new OpenRouterError('OPENROUTER_API_KEY 未配置', 500, false);
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0,
    usage: { include: true },
  };
  if (opts.fallbacks?.length) body.models = [opts.model, ...opts.fallbacks];
  if (opts.provider) body.provider = { order: [opts.provider], allow_fallbacks: false };
  if (opts.jsonSchema) body.response_format = { type: 'json_schema', json_schema: opts.jsonSchema };

  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.SITE_URL,
        'X-Title': env.SITE_NAME,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new OpenRouterError(`网络错误: ${err instanceof Error ? err.message : String(err)}`, 0, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    throw new OpenRouterError(`OpenRouter ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
  }

  const data = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string | null; reasoning?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };
  if (data.error) throw new OpenRouterError(data.error.message ?? 'unknown error', 502, true);

  const choice = data.choices?.[0]?.message;
  const content = (choice?.content ?? '').trim();
  const reasoning = (choice?.reasoning ?? '').trim();
  const text = content || reasoning;
  if (!text) throw new OpenRouterError('模型返回了空内容', 502, true);

  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : 0,
    latencyMs: Date.now() - started,
    modelUsed: data.model ?? opts.model,
  };
}

export interface SyncedModel {
  key: string;
  displayName: string;
  vendor: string;
  contextLength: number | null;
  priceIn: number | null;
  priceOut: number | null;
  supportsSchema: boolean;
  supportsReasoning: boolean;
}

/**
 * 同步模型列表。Cron 每天跑一次，新模型上线不需要改代码，
 * 管理员在后台勾选 enabled 即可。
 */
export async function fetchModels(env: Env): Promise<SyncedModel[]> {
  const res = await fetch(`${baseUrl(env)}/models`, {
    headers: env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {},
  });
  if (!res.ok) throw new Error(`fetch models failed: ${res.status}`);
  const data = (await res.json()) as {
    data?: {
      id: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }[];
  };
  const perMillion = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n * 1_000_000 : null;
  };
  return (data.data ?? []).map((m) => ({
    key: m.id,
    displayName: m.name ?? m.id,
    vendor: m.id.split('/')[0] ?? 'unknown',
    contextLength: m.context_length ?? null,
    priceIn: perMillion(m.pricing?.prompt),
    priceOut: perMillion(m.pricing?.completion),
    supportsSchema: (m.supported_parameters ?? []).includes('structured_outputs'),
    supportsReasoning: (m.supported_parameters ?? []).includes('reasoning'),
  }));
}

/** 按每百万 token 单价估算一局的成本 */
export function estimateRunCost(
  priceIn: number | null, priceOut: number | null,
  avgPlies: number, avgInTokens: number, avgOutTokens: number,
): number {
  const inCost = ((priceIn ?? 0) / 1_000_000) * avgInTokens * avgPlies;
  const outCost = ((priceOut ?? 0) / 1_000_000) * avgOutTokens * avgPlies;
  return inCost + outCost;
}
