/**
 * R2 / KV 访问层。
 *
 * 走法明细与 AI 的 prompt/回复全部在 R2：它们的量级和「步数」成正比，
 * 放进 D1 会在索引维护、写入 QPS、容量上限三处同时出问题。
 */
import type { Env } from './env.js';
import type { AiStepRecord, ReplayPackage } from '@gap/shared';
import type { Move } from '@gap/games';

export const movesKey = (matchId: string) => `matches/${matchId}/moves.jsonl`;
export const aiStepKey = (matchId: string, ply: number) => `matches/${matchId}/ai/${ply}.json`;
export const replayKey = (matchId: string) => `replays/${matchId}.json`;

export interface MoveRecord {
  ply: number;
  seat: number;
  move: Move;
  ms: number;
  hash: string;
}

/** 每行一步的 JSONL。一步约 60 字节，800 步也不到 50KB。 */
export async function putMoves(env: Env, matchId: string, records: MoveRecord[]): Promise<void> {
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  await env.R2.put(movesKey(matchId), body, {
    httpMetadata: { contentType: 'application/x-ndjson', cacheControl: 'public, max-age=31536000, immutable' },
  });
}

export async function getMoves(env: Env, matchId: string): Promise<MoveRecord[] | null> {
  const obj = await env.R2.get(movesKey(matchId));
  if (!obj) return null;
  const text = await obj.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as MoveRecord);
}

export async function putReplay(env: Env, pkg: ReplayPackage): Promise<void> {
  await env.R2.put(replayKey(pkg.matchId), JSON.stringify(pkg), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
  });
}

export async function getReplay(env: Env, matchId: string): Promise<ReplayPackage | null> {
  const obj = await env.R2.get(replayKey(matchId));
  if (!obj) return null;
  return (await obj.json()) as ReplayPackage;
}

export async function putAiStep(env: Env, matchId: string, rec: AiStepRecord): Promise<void> {
  await env.R2.put(aiStepKey(matchId, rec.ply), JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
  });
}

export async function getAiStep(env: Env, matchId: string, ply: number): Promise<AiStepRecord | null> {
  const obj = await env.R2.get(aiStepKey(matchId, ply));
  if (!obj) return null;
  return (await obj.json()) as AiStepRecord;
}

// ---------------------------------------------------------------- KV 计数器

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** 当日剩余秒数，用作 KV 的 TTL */
function secondsToMidnight(): number {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((end - now.getTime()) / 1000));
}

export async function bumpCounter(env: Env, key: string, delta = 1): Promise<number> {
  const cur = Number((await env.KV.get(key)) ?? '0');
  const next = cur + delta;
  await env.KV.put(key, String(next), { expirationTtl: secondsToMidnight() });
  return next;
}

export async function readCounter(env: Env, key: string): Promise<number> {
  return Number((await env.KV.get(key)) ?? '0');
}

export const userRunsKey = (playerId: string) => `quota:user:${playerId}:${dayKey()}`;
export const costKey = () => `quota:cost:${dayKey()}`;

/** AI 成本以「微美元」为单位累加，避免浮点误差 */
export async function addCost(env: Env, usd: number): Promise<number> {
  return bumpCounter(env, costKey(), Math.round(usd * 1_000_000));
}

export async function todayCostUsd(env: Env): Promise<number> {
  return (await readCounter(env, costKey())) / 1_000_000;
}
