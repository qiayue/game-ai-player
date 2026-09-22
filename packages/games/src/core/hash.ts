import type { GameState } from './types.js';

/** 状态的稳定哈希：用于服务端校验与回放核对。包含隐藏字段。 */
export function hashState(s: GameState): string {
  let h = 0x811c9dc5;
  const put = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const putStr = (str: string) => {
    for (let i = 0; i < str.length; i++) put(str.charCodeAt(i));
  };
  for (const v of s.board) put(v | 0);
  put(s.rows);
  put(s.cols);
  put(s.turn);
  put(s.score | 0);
  put(s.plies);
  put(s.rngCursor);
  putStr(s.status);
  for (const k of Object.keys(s.extra).sort()) {
    putStr(k);
    const v = s.extra[k];
    if (Array.isArray(v)) {
      put(v.length);
      for (const n of v) put(n | 0);
    } else {
      put(v | 0);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
