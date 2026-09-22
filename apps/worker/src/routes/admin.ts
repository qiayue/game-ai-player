import { Hono } from 'hono';
import type { Env, Vars } from '../env.js';
import { requireAdmin } from '../auth.js';
import { checkOrigin, badRequest, param } from '../util/http.js';
import * as repo from '../repo.js';
import { refreshSnapshot } from '../leaderboard.js';
import { parseTrack, parseWindow } from './leaderboards.js';
import { invalidateModelCache } from './models.js';
import { fetchModels } from '../ai/openrouter.js';

export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

admin.get('/models', async (c) => {
  requireAdmin(c);
  return c.json({ models: await repo.listModels(c.env, false) });
});

admin.post('/models/sync', async (c) => {
  requireAdmin(c);
  checkOrigin(c, c.env.SITE_URL);
  const synced = await fetchModels(c.env);
  const n = await repo.syncModels(c.env, synced);
  await invalidateModelCache(c.env);
  return c.json({ synced: n });
});

admin.post('/models/:key{.+}', async (c) => {
  requireAdmin(c);
  checkOrigin(c, c.env.SITE_URL);
  const key = param(c, 'key');
  const body = await c.req.json<{
    enabled?: boolean; maxGamePlies?: number | null; pinnedProvider?: string | null; sortOrder?: number;
  }>();
  await repo.updateModelFlags(c.env, key, body);
  await invalidateModelCache(c.env);
  return c.json({ ok: true });
});

admin.post('/matches/:id/flag', async (c) => {
  requireAdmin(c);
  checkOrigin(c, c.env.SITE_URL);
  const status = (await c.req.json<{ status?: string }>()).status ?? 'flagged';
  if (!['flagged', 'invalid', 'finished'].includes(status)) throw badRequest('status 不合法');
  await repo.flagMatch(c.env, param(c, 'id'), status);
  return c.json({ ok: true });
});

admin.post('/leaderboards/rebuild', async (c) => {
  requireAdmin(c);
  checkOrigin(c, c.env.SITE_URL);
  const gameId = c.req.query('gameId');
  if (!gameId) throw badRequest('缺少 gameId');
  const track = parseTrack(c.req.query('track'));
  const windowKey = parseWindow(c.req.query('window'));
  const data = await refreshSnapshot(c.env, gameId, track, windowKey);
  return c.json({ rows: data.rows.length });
});
