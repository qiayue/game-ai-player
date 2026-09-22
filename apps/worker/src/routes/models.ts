import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import type { ModelListResponse } from '@gap/shared';
import { getGame, GAME_IDS } from '@gap/games';
import * as repo from '../repo.js';
import { estimateCost } from '../ai/estimate.js';

export const models = new Hono<{ Bindings: Env; Variables: Vars }>();

const KV_KEY = 'models:payload';

function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 可用模型列表 + 每个游戏的成本预估。整份数据由 KV 缓存，前端再缓存一层。 */
export async function buildModelPayload(env: Env): Promise<ModelListResponse & { estimates: Record<string, Record<string, number>> }> {
  const rows = await repo.listModels(env, true);
  const estimates: Record<string, Record<string, number>> = {};
  for (const gameId of GAME_IDS) {
    const def = getGame(gameId);
    estimates[gameId] = {};
    for (const m of rows) {
      const capped = m.max_game_plies != null && def.maxPlies > m.max_game_plies * 1.5;
      if (capped) continue;
      estimates[gameId][m.key] = Number(estimateCost(def, m).toFixed(4));
    }
  }
  const payload = {
    version: '',
    updatedAt: Date.now(),
    models: rows.map((r) => ({
      key: r.key,
      displayName: r.display_name,
      vendor: r.vendor,
      priceIn: r.price_in,
      priceOut: r.price_out,
      supportsSchema: r.supports_schema === 1,
      maxGamePlies: r.max_game_plies,
    })),
    estimates,
  };
  payload.version = fingerprint(JSON.stringify({ models: payload.models, estimates }));
  return payload;
}

export async function cachedModelPayload(env: Env): Promise<ModelListResponse & { estimates: Record<string, Record<string, number>> }> {
  const cached = await env.KV.get(KV_KEY);
  if (cached) return JSON.parse(cached);
  const payload = await buildModelPayload(env);
  await env.KV.put(KV_KEY, JSON.stringify(payload), { expirationTtl: 3600 });
  return payload;
}

export async function invalidateModelCache(env: Env): Promise<void> {
  await env.KV.delete(KV_KEY);
}

/**
 * 模型列表几乎不变，所以给足缓存：
 *  - ETag + 304，前端带 If-None-Match 时几乎不传输任何字节
 *  - 前端再把整份数据连同 version 存进 localStorage，24 小时内直接用，连请求都不发
 *  - 游戏页首屏 HTML 里还会内联一份，首次打开不需要任何额外请求
 */
models.get('/', async (c) => {
  const payload = await cachedModelPayload(c.env);
  const etag = `W/"${payload.version}"`;
  if (c.req.header('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400' },
    });
  }
  return c.json(payload, {
    headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400' },
  });
});
