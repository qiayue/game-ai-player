/**
 * 通用棋盘渲染器。
 *
 * 所有游戏共用这一份代码：每个游戏只通过 GameDefinition.ui 提供
 * 「这个格子长什么样」和「点它产生什么走法」，渲染器不认识任何具体游戏。
 */
import type { AnyGameDefinition, GameState, Move } from '@gap/games';

export interface BoardHandle {
  el: HTMLElement;
  update(state: GameState): void;
  destroy(): void;
}

export interface BoardOptions {
  onMove?(move: Move): void;
  /** 只读（回放） */
  readonly?: boolean;
  /** 覆盖格子尺寸 */
  cellSize?: number;
}

export function mountBoard(
  host: HTMLElement, def: AnyGameDefinition, state: GameState, opts: BoardOptions = {},
): BoardHandle {
  host.innerHTML = '';
  const ui = def.ui;
  const interactive = !opts.readonly && !!opts.onMove;

  const board = document.createElement('div');
  board.className = 'board' + (interactive && (ui.clickCell || ui.paletteMove) ? ' clickable' : '');
  const size = opts.cellSize ?? ui.cellSize ?? 48;
  board.style.gridTemplateColumns = `repeat(${state.cols}, ${size}px)`;
  board.style.gridAutoRows = `${size}px`;

  const cells: HTMLDivElement[] = [];
  for (let i = 0; i < state.rows * state.cols; i++) {
    const cell = document.createElement('div');
    cell.dataset.idx = String(i);
    board.appendChild(cell);
    cells.push(cell);
  }
  host.appendChild(board);

  let current = state;
  let selected: number | null = ui.palette ? ui.palette.values[0] : null;

  function paint(s: GameState): void {
    current = s;
    for (let i = 0; i < cells.length; i++) {
      const v = s.board[i];
      const cls = ui.cellClass(v, s, i);
      if (cells[i].className !== cls) cells[i].className = cls;
      const label = ui.cellLabel(v, s, i);
      if (cells[i].textContent !== label) cells[i].textContent = label;
      if (size < 34) cells[i].style.fontSize = `${Math.max(10, size * 0.45)}px`;
    }
  }
  paint(state);

  const cleanups: (() => void)[] = [];

  if (interactive) {
    const emit = (m: Move | null) => { if (m !== null && m !== undefined) opts.onMove!(m); };

    if (ui.clickCell || ui.paletteMove) {
      const onClick = (e: MouseEvent) => {
        const idx = cellIndex(e.target);
        if (idx === null) return;
        if (ui.paletteMove && selected !== null) emit(ui.paletteMove(idx, selected, current));
        else if (ui.clickCell) emit(ui.clickCell(idx, current));
      };
      board.addEventListener('click', onClick);
      cleanups.push(() => board.removeEventListener('click', onClick));
    }

    if (ui.altClickCell) {
      const onCtx = (e: MouseEvent) => {
        const idx = cellIndex(e.target);
        if (idx === null) return;
        e.preventDefault();
        emit(ui.altClickCell!(idx, current));
      };
      board.addEventListener('contextmenu', onCtx);
      cleanups.push(() => board.removeEventListener('contextmenu', onCtx));

      // 手机上用长按代替右键
      let timer: number | undefined;
      const onDown = (e: TouchEvent) => {
        const idx = cellIndex(e.target);
        if (idx === null) return;
        timer = window.setTimeout(() => {
          timer = undefined;
          emit(ui.altClickCell!(idx, current));
        }, 450);
      };
      const cancel = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
      board.addEventListener('touchstart', onDown, { passive: true });
      board.addEventListener('touchend', cancel);
      board.addEventListener('touchmove', cancel);
      cleanups.push(() => {
        board.removeEventListener('touchstart', onDown);
        board.removeEventListener('touchend', cancel);
        board.removeEventListener('touchmove', cancel);
      });
    }

    if (ui.swipe) {
      let sx = 0;
      let sy = 0;
      let tracking = false;
      const down = (e: PointerEvent) => { sx = e.clientX; sy = e.clientY; tracking = true; };
      const up = (e: PointerEvent) => {
        if (!tracking) return;
        tracking = false;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        if (Math.hypot(dx, dy) < 24) return;
        emit(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
      };
      board.addEventListener('pointerdown', down);
      board.addEventListener('pointerup', up);
      cleanups.push(() => {
        board.removeEventListener('pointerdown', down);
        board.removeEventListener('pointerup', up);
      });
    }

    if (ui.keys) {
      const onKey = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        const m = ui.keys![e.key];
        if (m === undefined) return;
        e.preventDefault();
        emit(m);
      };
      window.addEventListener('keydown', onKey);
      cleanups.push(() => window.removeEventListener('keydown', onKey));
    }

    if (ui.palette) {
      const bar = document.createElement('div');
      bar.className = 'palette';
      for (const v of ui.palette.values) {
        const b = document.createElement('button');
        b.textContent = ui.palette.label(v);
        b.setAttribute('aria-pressed', String(v === selected));
        b.addEventListener('click', () => {
          selected = v;
          for (const other of bar.querySelectorAll('button')) other.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
        });
        bar.appendChild(b);
      }
      host.appendChild(bar);
    }

    if (ui.buttons?.length) {
      const bar = document.createElement('div');
      bar.className = 'row';
      bar.style.marginTop = '10px';
      for (const item of ui.buttons) {
        const b = document.createElement('button');
        b.textContent = item.label;
        b.className = 'small';
        b.addEventListener('click', () => emit(item.move));
        bar.appendChild(b);
      }
      host.appendChild(bar);
    }
  }

  function cellIndex(target: EventTarget | null): number | null {
    const el = target as HTMLElement | null;
    const raw = el?.dataset?.idx;
    return raw === undefined ? null : Number(raw);
  }

  return {
    el: board,
    update: paint,
    destroy() {
      for (const fn of cleanups) fn();
      host.innerHTML = '';
    },
  };
}
