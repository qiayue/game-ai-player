/** 连子类游戏（井字棋 / 四子棋 / 五子棋）共用的判定 */

const RAYS = [
  [0, 1],   // 横
  [1, 0],   // 竖
  [1, 1],   // 右下
  [1, -1],  // 左下
] as const;

/** 以 idx 为起点沿 (dr,dc) 方向数出连续同色的个数（不含起点） */
function runLength(
  board: number[], rows: number, cols: number,
  r: number, c: number, dr: number, dc: number, player: number,
): number {
  let n = 0;
  let rr = r + dr;
  let cc = c + dc;
  while (rr >= 0 && rr < rows && cc >= 0 && cc < cols && board[rr * cols + cc] === player) {
    n++;
    rr += dr;
    cc += dc;
  }
  return n;
}

/** 刚落在 idx 的这一子是否构成 need 连（need 连或更长都算赢） */
export function winsAt(
  board: number[], rows: number, cols: number, idx: number, player: number, need: number,
): boolean {
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  for (const [dr, dc] of RAYS) {
    const total =
      1 +
      runLength(board, rows, cols, r, c, dr, dc, player) +
      runLength(board, rows, cols, r, c, -dr, -dc, player);
    if (total >= need) return true;
  }
  return false;
}

/** 找出所有构成胜利的格子（用于高亮） */
export function winningCells(
  board: number[], rows: number, cols: number, idx: number, player: number, need: number,
): number[] {
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  for (const [dr, dc] of RAYS) {
    const fwd = runLength(board, rows, cols, r, c, dr, dc, player);
    const back = runLength(board, rows, cols, r, c, -dr, -dc, player);
    if (1 + fwd + back < need) continue;
    const cells: number[] = [];
    for (let i = -back; i <= fwd; i++) cells.push((r + dr * i) * cols + (c + dc * i));
    return cells;
  }
  return [];
}
