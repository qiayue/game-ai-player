/** 网格与文本渲染的公共小工具 */

export const DIRS = [
  { dr: -1, dc: 0, name: 'UP' },
  { dr: 0, dc: 1, name: 'RIGHT' },
  { dr: 1, dc: 0, name: 'DOWN' },
  { dr: 0, dc: -1, name: 'LEFT' },
] as const;

export const DIR_NAMES = ['UP', 'RIGHT', 'DOWN', 'LEFT'] as const;

export function idxOf(r: number, c: number, cols: number): number {
  return r * cols + c;
}

export function inBounds(r: number, c: number, rows: number, cols: number): boolean {
  return r >= 0 && r < rows && c >= 0 && c < cols;
}

/** 列标：A..Z, AA.. */
export function colLabel(c: number): string {
  let s = '';
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** 坐标文本，如 H8（列用字母、行用 1 起的数字） */
export function coordText(r: number, c: number): string {
  return `${colLabel(c)}${r + 1}`;
}

export function parseCoord(text: string, rows: number, cols: number): number | null {
  const m = /^([A-Za-z]{1,2})\s*(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  let c = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) c = c * 26 + (letters.charCodeAt(i) - 64);
  c -= 1;
  const r = parseInt(m[2], 10) - 1;
  if (!inBounds(r, c, rows, cols)) return null;
  return r * cols + c;
}

/**
 * 把棋盘渲染成对齐的文本网格，可选带行列坐标标尺。
 * 模型对这种视觉网格的理解明显好于原始数组。
 */
export function renderGrid(
  board: number[],
  rows: number,
  cols: number,
  cell: (v: number, idx: number) => string,
  opts: { ruler?: boolean; width?: number } = {},
): string {
  const cells: string[] = new Array(rows * cols);
  let w = opts.width ?? 1;
  for (let i = 0; i < rows * cols; i++) {
    cells[i] = cell(board[i], i);
    if (cells[i].length > w) w = cells[i].length;
  }
  const pad = (s: string) => s.padStart(w, ' ');
  const lines: string[] = [];
  if (opts.ruler) {
    const rowLabelW = String(rows).length;
    lines.push(' '.repeat(rowLabelW + 1) + Array.from({ length: cols }, (_, c) => pad(colLabel(c))).join(' '));
    for (let r = 0; r < rows; r++) {
      const label = String(r + 1).padStart(rowLabelW, ' ');
      lines.push(label + ' ' + Array.from({ length: cols }, (_, c) => pad(cells[r * cols + c])).join(' '));
    }
  } else {
    for (let r = 0; r < rows; r++) {
      lines.push(Array.from({ length: cols }, (_, c) => pad(cells[r * cols + c])).join(' '));
    }
  }
  return lines.join('\n');
}

/** 从模型输出的最后一行里抓 `MOVE: xxx` */
export function extractMoveText(text: string): string {
  const m = /MOVE\s*[:：]\s*(.+?)\s*$/im.exec(text);
  if (m) return m[1].trim();
  // 兜底：取最后一个非空行
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : '';
}
