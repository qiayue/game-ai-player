/**
 * 页面外壳。
 *
 * 这个脚本很小，只负责：登录、开始游戏的入口、AI 录制面板、资料修改。
 * 游戏本身的代码要等用户点了「开始游戏」才会被加载。
 */
import { api, ApiError } from './api.js';
import { getModels, listPending, clearPending, type ModelPayload } from './store.js';
import type { GameState } from '@gap/games';

interface Bootstrap {
  user: { id: string; handle: string; displayName: string; avatarUrl: string | null } | null;
  siteName: string;
  googleClientId: string;
}

const boot = readBootstrap();

function readBootstrap(): Bootstrap {
  const el = document.getElementById('bootstrap');
  try {
    return JSON.parse(el?.textContent ?? '{}') as Bootstrap;
  } catch {
    return { user: null, siteName: '', googleClientId: '' };
  }
}

// ---------------------------------------------------------------- 登录

let gisReady: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('无法加载 Google 登录组件'));
    document.head.appendChild(s);
  });
  return gisReady;
}

interface GoogleId {
  accounts: {
    id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void }): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
      prompt(): void;
    };
  };
}

async function openLogin(): Promise<void> {
  if (!boot.googleClientId) {
    alert('本站还没有配置 Google 登录');
    return;
  }
  await loadGis();
  const g = (window as unknown as { google: GoogleId }).google;

  const dialog = document.createElement('div');
  dialog.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;'
    + 'justify-content:center;z-index:999';
  dialog.innerHTML =
    '<div class="card" style="text-align:center;min-width:280px">'
    + '<h3 style="margin-top:0">登录后即可上榜</h3>'
    + '<p class="small muted">只读取你的昵称和头像，不会拿到你的邮箱。</p>'
    + '<div id="gbtn" style="display:flex;justify-content:center"></div>'
    + '<p><button id="gcancel" class="small">先不登录</button></p></div>';
  document.body.appendChild(dialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
  dialog.querySelector('#gcancel')!.addEventListener('click', () => dialog.remove());

  g.accounts.id.initialize({
    client_id: boot.googleClientId,
    callback: async (res) => {
      dialog.remove();
      try {
        await api.post('/api/auth/google', { credential: res.credential });
        await claimPending();
        location.reload();
      } catch (err) {
        alert(err instanceof ApiError ? err.message : '登录失败');
      }
    },
  });
  g.accounts.id.renderButton(dialog.querySelector('#gbtn') as HTMLElement, {
    theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill',
  });
  g.accounts.id.prompt();
}

/** 登录后把未登录期间打完的对局一次性补记上去 */
async function claimPending(): Promise<void> {
  const pending = listPending();
  if (!pending.length) return;
  try {
    await api.post('/api/matches/claim', {
      pending: pending.map((p) => ({
        ticket: p.ticket, moves: p.moves, stepMs: p.stepMs,
        durationMs: p.durationMs, finalHash: p.finalHash,
      })),
    });
    clearPending();
  } catch {
    /* 票据过期就算了，不打扰用户 */
  }
}

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'login-btn' || t.id === 'login-inline') void openLogin();
});

// ---------------------------------------------------------------- 开始游戏

const stage = document.getElementById('stage');
if (stage) {
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;
  const host = document.getElementById('board-host')!;
  const hud = document.getElementById('hud')!;
  const msg = document.getElementById('play-msg')!;
  const gameId = stage.dataset.game!;
  let session: { stop(): void } | null = null;

  playBtn?.addEventListener('click', async () => {
    playBtn.disabled = true;
    playBtn.textContent = '加载中…';
    try {
      session?.stop();
      const { startGame } = await import('./play.js');
      session = await startGame(gameId, host, hud, msg, !!boot.user);
      playBtn.textContent = '重开一局';
    } catch (err) {
      msg.textContent = err instanceof ApiError ? err.message : '开局失败，刷新页面再试试';
      playBtn.textContent = '开始游戏';
    } finally {
      playBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- AI 录制

const aiPanel = document.getElementById('ai-panel');
if (aiPanel) {
  const gameId = aiPanel.dataset.game!;
  const select = document.getElementById('model-select') as HTMLSelectElement;
  const opponent = document.getElementById('opponent-select') as HTMLSelectElement | null;
  const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
  const hint = document.getElementById('run-hint')!;
  const progress = document.getElementById('run-progress')!;
  const statusEl = document.getElementById('run-status')!;
  const boardHost = document.getElementById('run-board')!;
  const thoughtEl = document.getElementById('run-thought')!;
  const abortBtn = document.getElementById('abort-btn') as HTMLButtonElement;

  // 模型列表优先用页面内联的那份，其次用 localStorage 缓存，都没有才发请求
  void getModels().then((payload) => {
    if (!payload) return;
    fillOpponent(payload);
    updateHint(payload);
  });

  function fillOpponent(payload: ModelPayload): void {
    if (!opponent || opponent.options.length > 1) return;
    for (const m of payload.models) {
      if (payload.estimates[gameId]?.[m.key] === undefined) continue;
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = `对手：${m.displayName}`;
      opponent.appendChild(opt);
    }
  }

  function updateHint(payload: ModelPayload): void {
    const est = payload.estimates[gameId]?.[select.value];
    hint.textContent = est !== undefined
      ? `预计消耗约 $${est.toFixed(3)}，跑完一整局通常需要几分钟，期间可以离开页面。`
      : '跑完一整局通常需要几分钟，期间可以离开页面。';
  }

  select.addEventListener('change', () => { void getModels().then((p) => p && updateHint(p)); });

  let poll: number | undefined;
  let runId: string | null = null;
  let board: { update(s: GameState): void } | null = null;

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      const res = await api.post<{ runId: string; estimateUsd: number }>('/api/ai-runs', {
        gameId,
        modelKey: select.value,
        opponentKey: opponent?.value || undefined,
      });
      runId = res.runId;
      progress.classList.remove('hidden');
      statusEl.textContent = '已开始，正在等模型走第一步…';
      startPolling();
    } catch (err) {
      runBtn.disabled = false;
      if (err instanceof ApiError && err.status === 401) void openLogin();
      else statusEl.textContent = err instanceof ApiError ? err.message : '启动失败';
      progress.classList.remove('hidden');
    }
  });

  abortBtn.addEventListener('click', async () => {
    if (!runId) return;
    abortBtn.disabled = true;
    try {
      await api.post(`/api/ai-runs/${runId}/abort`);
    } catch { /* 已经结束了 */ }
  });

  function startPolling(): void {
    if (poll) clearInterval(poll);
    void tickOnce();
    poll = window.setInterval(tickOnce, 2000);
  }

  async function tickOnce(): Promise<void> {
    if (!runId) return;
    let s: {
      status: string; ply: number; score: number; costUsd: number;
      state: GameState | null; lastMoveText: string | null; lastThought: string | null;
      illegalMoves: number; matchId: string | null; error: string | null;
    };
    try {
      s = await api.get(`/api/ai-runs/${runId}`);
    } catch {
      return;
    }

    if (s.state) {
      if (!board) {
        const { mountBoard } = await import('./board.js');
        const { loadGame } = await import('./play.js');
        const mod = await loadGame(gameId);
        board = mountBoard(boardHost, mod.game, s.state, { readonly: true, cellSize: 40 });
      } else {
        board.update(s.state);
      }
    }

    const bar = progress.querySelector('.progress i') as HTMLElement | null;
    if (bar) bar.style.width = `${Math.min(100, (s.ply / 200) * 100)}%`;

    statusEl.textContent = [
      s.status === 'running' ? '录制中' : statusLabel(s.status),
      `第 ${s.ply} 步`,
      `${s.score} 分`,
      `$${s.costUsd.toFixed(4)}`,
      s.illegalMoves ? `${s.illegalMoves} 次非法走法` : '',
      s.lastMoveText ? `最近一步：${s.lastMoveText}` : '',
    ].filter(Boolean).join(' · ');
    thoughtEl.textContent = s.lastThought ?? '';

    if (s.status !== 'running' && s.status !== 'queued') {
      if (poll) clearInterval(poll);
      runBtn.disabled = false;
      abortBtn.disabled = true;
      if (s.matchId) {
        statusEl.innerHTML += ` · <a href="/replay/${s.matchId}"><b>看完整回放 →</b></a>`;
      } else if (s.error) {
        statusEl.textContent += ` · ${s.error}`;
      }
    }
  }

  function statusLabel(status: string): string {
    return { finished: '已完成', failed: '失败', aborted: '已中止', stalled: '已超时终止' }[status] ?? status;
  }
}

// ---------------------------------------------------------------- 资料修改

const saveBtn = document.getElementById('save-profile');
if (saveBtn) {
  saveBtn.addEventListener('click', async () => {
    const name = (document.getElementById('edit-name') as HTMLInputElement).value;
    const handle = (document.getElementById('edit-handle') as HTMLInputElement).value;
    const out = document.getElementById('profile-msg')!;
    try {
      const res = await api.patch<{ user: { handle: string } }>('/api/me', { displayName: name, handle });
      out.textContent = '已保存';
      if (res.user.handle !== handle) location.href = `/p/${res.user.handle}`;
      else location.reload();
    } catch (err) {
      out.textContent = err instanceof ApiError ? err.message : '保存失败';
    }
  });
}

// 登录状态下如果还有未认领的成绩，静默补记
if (boot.user && listPending().length) void claimPending().then(() => location.reload());
