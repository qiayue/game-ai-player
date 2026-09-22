/**
 * localStorage 封装。
 *
 * 两个用途：
 *  1. 模型列表缓存 —— 模型几乎不变，没必要每次打开页面都拉一遍
 *  2. 未登录时打完的对局 —— 暂存起来，登录后一次性认领
 *
 * 隐私模式下 localStorage 可能直接抛异常，所以每次读写都包在 try 里，
 * 拿不到也不影响页面正常工作。
 */

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式或配额用尽，忽略即可 */
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

// ------------------------------------------------------------ 模型列表缓存

const MODELS_KEY = 'gap.models.v1';
const MODELS_TTL = 24 * 3600 * 1000;

export interface ModelPayload {
  version: string;
  updatedAt: number;
  models: { key: string; displayName: string; vendor: string; priceIn: number | null; priceOut: number | null }[];
  estimates: Record<string, Record<string, number>>;
}

interface CachedModels {
  version: string;
  fetchedAt: number;
  data: ModelPayload;
}

export function cacheModels(data: ModelPayload): void {
  write(MODELS_KEY, { version: data.version, fetchedAt: Date.now(), data } satisfies CachedModels);
}

/**
 * 取模型列表，三级来源：
 *  1. 页面内联的 <script id="models-data">（游戏页首屏自带，零请求）
 *  2. localStorage 里 24 小时内的缓存（零请求）
 *  3. 带 If-None-Match 的条件请求（命中 304 时几乎不传输字节）
 */
export async function getModels(): Promise<ModelPayload | null> {
  const inline = document.getElementById('models-data');
  if (inline?.textContent) {
    try {
      const data = JSON.parse(inline.textContent) as ModelPayload;
      cacheModels(data);
      return data;
    } catch {
      /* 落到下面 */
    }
  }

  const cached = read<CachedModels>(MODELS_KEY);
  if (cached && Date.now() - cached.fetchedAt < MODELS_TTL) return cached.data;

  try {
    const res = await fetch('/api/models', {
      headers: cached ? { 'If-None-Match': `W/"${cached.version}"` } : undefined,
    });
    if (res.status === 304 && cached) {
      write(MODELS_KEY, { ...cached, fetchedAt: Date.now() });
      return cached.data;
    }
    if (!res.ok) return cached?.data ?? null;
    const data = (await res.json()) as ModelPayload;
    cacheModels(data);
    return data;
  } catch {
    return cached?.data ?? null;
  }
}

// ------------------------------------------------------------ 待认领的对局

const PENDING_KEY = 'gap.pending.v1';

export interface PendingMatch {
  ticket: string;
  gameId: string;
  score: number;
  moves: unknown[];
  stepMs: number[];
  durationMs: number;
  finalHash?: string;
  savedAt: number;
}

export function listPending(): PendingMatch[] {
  const all = read<PendingMatch[]>(PENDING_KEY) ?? [];
  // 票据有效期 12 小时，过期的直接丢掉
  const fresh = all.filter((p) => Date.now() - p.savedAt < 11 * 3600 * 1000);
  if (fresh.length !== all.length) write(PENDING_KEY, fresh);
  return fresh;
}

export function addPending(match: PendingMatch): void {
  const all = listPending();
  all.push(match);
  write(PENDING_KEY, all.slice(-20));
}

export function clearPending(): void {
  drop(PENDING_KEY);
}

// ------------------------------------------------------------ 本地最好成绩

const BEST_KEY = 'gap.best.v1';

export function localBest(gameId: string): number {
  return (read<Record<string, number>>(BEST_KEY) ?? {})[gameId] ?? 0;
}

export function setLocalBest(gameId: string, score: number): boolean {
  const all = read<Record<string, number>>(BEST_KEY) ?? {};
  if ((all[gameId] ?? 0) >= score) return false;
  all[gameId] = score;
  write(BEST_KEY, all);
  return true;
}
