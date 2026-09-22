const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID：前 10 位是时间，天然按时间有序，直接当 keyset 分页游标 */
export function ulid(ts: number = Date.now()): string {
  let time = '';
  let t = ts;
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENC[rnd[i] & 31];
  return time + rand;
}

/** 从 ULID 还原出毫秒时间戳 */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) t = t * 32 + ENC.indexOf(id[i]);
  return t;
}

export function randomSeed(): string {
  const rnd = new Uint8Array(12);
  crypto.getRandomValues(rnd);
  return Array.from(rnd, (b) => ENC[b & 31]).join('');
}

/** 由显示名生成 URL 友好的 handle */
export function slugify(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return base || fallback;
}
