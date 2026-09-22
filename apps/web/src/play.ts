/**
 * 人类对局的运行时。
 *
 * 完全信息的游戏全程在浏览器里跑，整局只有两次请求：开局拿 seed，终局提交走法序列。
 * 信息不完全的游戏（扫雷、记忆翻牌）每步提交一次，服务端从 seed 重放出可见视图——
 * 它同样不保存中间状态，所以依旧没有服务端会话。
 */
import type { AnyGameDefinition, GameState, Move } from '@gap/games';
import { api, ApiError } from './api.js';
import { mountBoard, type BoardHandle } from './board.js';
import { addPending, setLocalBest, type PendingMatch } from './store.js';

interface StartResponse {
  matchId: string;
  seed: string;
  startedAt: number;
  stepwise: boolean;
  state: GameState;
  legalMoves: Move[];
  ticket: string;
}

interface FinishResponse {
  score: number;
  status: string;
  moves: number;
  rank: number | null;
  personalBest: boolean;
  replayUrl: string;
  flagged: boolean;
}

export interface GameModule {
  game: AnyGameDefinition;
  hashState(s: GameState): string;
  frames(def: AnyGameDefinition, seed: string, moves: Move[]): GameState[];
}

const loaded = new Map<string, GameModule>();

/** 按需加载：进页面时不下载任何游戏代码，点开始才拉这一个游戏的模块 */
export async function loadGame(gameId: string): Promise<GameModule> {
  const hit = loaded.get(gameId);
  if (hit) return hit;
  const url = `/assets/games/${gameId}.js`;
  const mod = (await import(/* @vite-ignore */ url)) as GameModule;
  loaded.set(gameId, mod);
  return mod;
}

export interface Session {
  stop(): void;
}

export async function startGame(
  gameId: string, host: HTMLElement, hud: HTMLElement, msg: HTMLElement, loggedIn: boolean,
): Promise<Session> {
  msg.textContent = '';
  const mod = await loadGame(gameId);
  const def = mod.game;
  const start = await api.post<StartResponse>('/api/matches', { gameId });

  let state = start.state;
  const moves: Move[] = [];
  const stepMs: number[] = [];
  let lastAt = Date.now();
  let finished = false;
  let busy = false;
  let tick: number | undefined;
  let pendingMove: Move | null = null;

  const board: BoardHandle = mountBoard(host, def, state, {
    onMove: (m) => {
      if (def.ui.autoTickMs) pendingMove = m; // 自动推进的游戏：按键只改方向
      else void apply(m);
    },
  });

  function renderHud(): void {
    const bits = [`分数 ${state.score}`, `${state.plies} 步`];
    if (state.status !== 'playing') bits.push(statusText(state.status));
    hud.textContent = bits.join(' · ');
  }
  renderHud();

  async function apply(move: Move): Promise<void> {
    if (finished || busy) return;
    const now = Date.now();

    if (start.stepwise) {
      // 隐藏信息：本地算不出结果，交给服务端重放
      busy = true;
      try {
        const res = await api.post<{ state: GameState; terminal: boolean }>(
          `/api/matches/${start.matchId}/step`,
          { ticket: start.ticket, moves: [...moves, move] },
        );
        moves.push(move);
        stepMs.push(now - lastAt);
        lastAt = now;
        state = res.state;
      } catch (err) {
        if (err instanceof ApiError) msg.textContent = err.message;
        return;
      } finally {
        busy = false;
      }
    } else {
      let next: GameState;
      try {
        next = def.reduce(state, move, start.seed);
      } catch (err) {
        // 非法走法在本地就被拦住，不浪费一次请求
        msg.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
      moves.push(move);
      stepMs.push(now - lastAt);
      lastAt = now;
      state = next;
    }

    board.update(state);
    renderHud();
    msg.textContent = '';
    if (def.isTerminal(state) || moves.length >= def.maxPlies) await finish();
  }

  async function finish(): Promise<void> {
    if (finished) return;
    finished = true;
    if (tick) clearInterval(tick);
    const durationMs = Date.now() - start.startedAt;
    const payload = {
      ticket: start.ticket,
      moves,
      stepMs,
      durationMs,
      finalHash: def.hiddenInfo ? undefined : mod.hashState(state),
    };

    const isBest = setLocalBest(gameId, def.scoreOf(state, 0));
    try {
      const res = await api.post<FinishResponse>(`/api/matches/${start.matchId}/finish`, payload);
      if (loggedIn) {
        msg.innerHTML = summaryHtml(res, isBest);
      } else {
        // 没登录：先把票据存起来，登录之后一次性认领
        addPending({
          ticket: start.ticket, gameId, score: res.score, moves, stepMs, durationMs,
          finalHash: payload.finalHash, savedAt: Date.now(),
        } satisfies PendingMatch);
        msg.innerHTML = `本局 <b>${res.score}</b> 分，${statusText(state.status)}。`
          + ' <button id="login-inline" class="small">登录后上榜</button>'
          + '<span class="small muted"> 成绩已暂存，登录后会自动补记。</span>';
      }
    } catch (err) {
      msg.textContent = err instanceof ApiError ? err.message : '提交成绩失败，成绩没有被记录';
    }
  }

  function summaryHtml(res: FinishResponse, isBest: boolean): string {
    const bits = [`本局 <b>${res.score}</b> 分，${statusText(state.status)}。`];
    if (res.flagged) bits.push('<span class="muted">这局的操作节奏异常，暂不计入排行榜。</span>');
    else if (res.personalBest || isBest) bits.push('<b>个人新纪录！</b>');
    if (res.rank) bits.push(`当前排名第 ${res.rank}。`);
    bits.push(`<a href="${res.replayUrl}">看回放 →</a>`);
    return bits.join(' ');
  }

  if (def.ui.autoTickMs) {
    // 贪吃蛇这类游戏按固定节奏推进，按键只负责改方向
    pendingMove = (state.extra.dir as number) ?? 1;
    tick = window.setInterval(() => {
      if (finished || pendingMove === null) return;
      void apply(pendingMove);
    }, def.ui.autoTickMs);
  }

  return {
    stop() {
      finished = true;
      if (tick) clearInterval(tick);
      board.destroy();
    },
  };
}

function statusText(status: string): string {
  switch (status) {
    case 'won': return '通关了';
    case 'lost': return '游戏结束';
    case 'draw': return '平局';
    default: return '还在进行';
  }
}
