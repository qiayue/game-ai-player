/** 确定性随机：同样的 (seed, cursor) 永远给出同样的值 */

/** FNV-1a 32 位，把 seed 字符串压成一个整数 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32：把 (seedHash, cursor) 映射到 [0,1) */
export function rngAt(seedHash: number, cursor: number): number {
  let z = (seedHash + Math.imul(cursor + 1, 0x9e3779b9)) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  return z / 4294967296;
}

export function randInt(seedHash: number, cursor: number, n: number): number {
  return Math.floor(rngAt(seedHash, cursor) * n) % n;
}

/**
 * 从 cursor 开始消费随机数的小游标对象。
 * 用完后把 .cursor 写回 state.rngCursor。
 */
export class Rng {
  private h: number;
  cursor: number;
  constructor(seed: string, cursor: number) {
    this.h = hashSeed(seed);
    this.cursor = cursor;
  }
  next(): number {
    return rngAt(this.h, this.cursor++);
  }
  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }
  /** 原地 Fisher-Yates */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}
