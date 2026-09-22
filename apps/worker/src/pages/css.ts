/**
 * 全站样式，直接内联进每个页面的 <head>。
 *
 * 为什么内联：整份 gzip 后大约 3KB，内联省掉一次阻塞渲染的往返；
 * 动态页本身在边缘有缓存，重复传输的代价可以忽略。
 * 不加载任何 web font，只用系统字体栈。
 */
export const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#fbfbfa;--panel:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e6e3dd;
  --accent:#b4501e;--accent-soft:#fbeee6;--ok:#2f7a4f;--warn:#a8781a;--bad:#b3352b;
  --radius:10px;--shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.04);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#171614;--panel:#201f1c;--ink:#ece9e3;--muted:#9a958c;--line:#33312c;
  --accent:#e0824c;--accent-soft:#33241b;--ok:#6cbb8b;--warn:#d7ab54;--bad:#e0705f;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);
}}
:root[data-theme=dark]{
  --bg:#171614;--panel:#201f1c;--ink:#ece9e3;--muted:#9a958c;--line:#33312c;
  --accent:#e0824c;--accent-soft:#33241b;--ok:#6cbb8b;--warn:#d7ab54;--bad:#e0705f;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);
}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);line-height:1.65;
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:16px;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.3;margin:0 0 .5em}
h1{font-size:1.75rem;letter-spacing:-.01em}
h2{font-size:1.25rem;margin-top:2rem}
h3{font-size:1.05rem}
p{margin:0 0 1em}
ul,ol{margin:0 0 1em;padding-left:1.3em}
li{margin:.3em 0}
code,kbd{font-family:var(--mono);font-size:.9em}
kbd{background:var(--panel);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:1px 5px}
.wrap{max-width:900px;margin:0 auto;padding:0 16px}
.wide{max-width:1120px}
header.site{border-bottom:1px solid var(--line);background:var(--panel)}
header.site .wrap{display:flex;align-items:center;gap:16px;height:56px}
.brand{font-weight:650;color:var(--ink);font-size:1.02rem;white-space:nowrap}
.brand:hover{text-decoration:none;color:var(--accent)}
nav.top{display:flex;gap:14px;flex:1;overflow-x:auto;scrollbar-width:none}
nav.top::-webkit-scrollbar{display:none}
nav.top a{color:var(--muted);font-size:.92rem;white-space:nowrap}
nav.top a:hover,nav.top a[aria-current]{color:var(--ink)}
main{padding:28px 0 64px}
footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:.86rem;padding:22px 0 40px}
footer.site a{color:var(--muted)}
.lede{font-size:1.05rem;color:var(--muted);margin-bottom:1.5em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)}
.grid{display:grid;gap:14px}
.grid-games{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.game-card{display:block;color:inherit;padding:14px 16px}
.game-card:hover{text-decoration:none;border-color:var(--accent);transform:translateY(-1px);transition:.12s}
.game-card b{display:block;font-size:1.05rem;margin-bottom:2px}
.game-card span{color:var(--muted);font-size:.88rem;line-height:1.5;display:block}
.badge{display:inline-block;font-size:.74rem;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);vertical-align:middle}
.badge.ai{background:var(--accent-soft);border-color:transparent;color:var(--accent)}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.spread{justify-content:space-between}
button,.btn{
  font:inherit;font-size:.94rem;padding:8px 16px;border-radius:8px;border:1px solid var(--line);
  background:var(--panel);color:var(--ink);cursor:pointer;line-height:1.4;
}
button:hover,.btn:hover{border-color:var(--accent);text-decoration:none}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{filter:brightness(1.08)}
select,input[type=text]{font:inherit;font-size:.92rem;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);max-width:100%}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:500;font-size:.84rem}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.me td{background:var(--accent-soft)}
.rank{color:var(--muted);font-variant-numeric:tabular-nums;width:2.5em}
.rank.top{color:var(--accent);font-weight:600}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:14px}
.tabs a{padding:7px 14px;color:var(--muted);border-bottom:2px solid transparent;font-size:.94rem}
.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--accent);text-decoration:none}
.muted{color:var(--muted)}
.small{font-size:.86rem}
.mono{font-family:var(--mono)}
.stat{display:flex;gap:22px;flex-wrap:wrap;margin:10px 0 18px}
.stat div{display:flex;flex-direction:column}
.stat b{font-size:1.35rem;font-variant-numeric:tabular-nums;line-height:1.2}
.stat span{color:var(--muted);font-size:.8rem}
.notice{border-left:3px solid var(--accent);background:var(--accent-soft);padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0}
details{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:8px 0;background:var(--panel)}
details summary{cursor:pointer;font-weight:550}
details[open] summary{margin-bottom:8px}
.faq h3{font-size:1rem;margin-bottom:.2em}
.split{display:grid;gap:24px;grid-template-columns:minmax(0,1fr)}
@media(min-width:900px){.split{grid-template-columns:minmax(0,1fr) 300px}}
.sticky{position:sticky;top:16px}

/* ---------------- 棋盘通用 ---------------- */
#stage{margin:0 0 18px}
.board{display:grid;gap:4px;background:var(--line);padding:4px;border-radius:var(--radius);
  width:max-content;max-width:100%;user-select:none;-webkit-user-select:none;touch-action:none}
.board > div{
  display:flex;align-items:center;justify-content:center;background:var(--panel);
  border-radius:5px;font-weight:600;font-variant-numeric:tabular-nums;transition:background .08s;
}
.board.clickable > div{cursor:pointer}
.cell-win{outline:2px solid var(--accent);outline-offset:-2px}
.cell-last{box-shadow:inset 0 0 0 2px var(--accent)}
.cell-hint{background:var(--accent-soft)}
/* 2048 */
.tile{font-size:1.5rem}
.tile-0{background:rgba(125,120,110,.12)}
.tile-2{background:#eee4da;color:#776e65}.tile-4{background:#ede0c8;color:#776e65}
.tile-8{background:#f2b179;color:#fff}.tile-16{background:#f59563;color:#fff}
.tile-32{background:#f67c5f;color:#fff}.tile-64{background:#f65e3b;color:#fff}
.tile-128{background:#edcf72;color:#fff;font-size:1.25rem}.tile-256{background:#edcc61;color:#fff;font-size:1.25rem}
.tile-512{background:#edc850;color:#fff;font-size:1.25rem}.tile-1024{background:#edc53f;color:#fff;font-size:1rem}
.tile-2048{background:#edc22e;color:#fff;font-size:1rem}.tile-super{background:#3c3a32;color:#fff;font-size:1rem}
/* 井字棋 */
.mark-0{color:transparent}.mark-1{color:var(--accent)}.mark-2{color:var(--ok)}
.board .cell{font-size:2rem}
/* 四子棋 / 黑白棋 */
.disc{position:relative}
.disc-1::after,.disc-2::after{content:"";position:absolute;inset:14%;border-radius:50%}
.disc-1::after{background:#2f2d2a}.disc-2::after{background:#f3efe7;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)}
/* 五子棋 */
.stone{background:#dcc08c!important;border-radius:0!important;position:relative}
.stone::before{content:"";position:absolute;inset:0;background:
  linear-gradient(to right,transparent calc(50% - .5px),#0003 calc(50% - .5px),#0003 calc(50% + .5px),transparent calc(50% + .5px)),
  linear-gradient(to bottom,transparent calc(50% - .5px),#0003 calc(50% - .5px),#0003 calc(50% + .5px),transparent calc(50% + .5px))}
.stone-1::after,.stone-2::after{content:"";position:absolute;inset:8%;border-radius:50%;z-index:1}
.stone-1::after{background:#26241f}.stone-2::after{background:#fbf8f2;box-shadow:inset 0 0 0 1px #0002}
/* 贪吃蛇 */
.snake-cell{border-radius:3px!important}
.sc-0{background:rgba(125,120,110,.1)}
.sc-1{background:var(--ok);opacity:.65}
.sc-2{background:var(--ok)}
.sc-3{background:var(--accent)}
/* 扫雷 */
.ms{font-size:.95rem}
.ms-hidden{background:rgba(125,120,110,.22);cursor:pointer}
.ms-hidden:hover{background:rgba(125,120,110,.32)}
.ms-flag{background:rgba(125,120,110,.22)}
.ms-open{background:rgba(125,120,110,.07)}
.ms-boom{background:var(--bad)}
.ms-n1{color:#3b6fd4}.ms-n2{color:#2f7a4f}.ms-n3{color:#c0392b}.ms-n4{color:#6b3fa0}
.ms-n5{color:#a8781a}.ms-n6{color:#178f8f}.ms-n7{color:var(--ink)}.ms-n8{color:var(--muted)}
/* 数独 */
.sud{font-size:1.15rem}
.sud-given{font-weight:700}
.sud-user{color:var(--accent);font-weight:500}
.sud-br{margin-right:3px}
.sud-bb{margin-bottom:3px}
.palette{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.palette button{width:42px;padding:8px 0;font-size:1.05rem}
.palette button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
/* 华容道 */
.fif{font-size:1.4rem;background:var(--accent-soft)!important;cursor:pointer}
.fif-ok{background:var(--accent)!important;color:#fff}
.fif-blank{background:transparent!important;box-shadow:none;cursor:default}
/* 推箱子 */
.sok{font-size:1.4rem}
.sok-1{background:#8a8378}
.sok-2{color:var(--accent);font-size:1.8rem}
/* 记忆翻牌 */
.card-down{background:var(--accent);cursor:pointer}
.card-up,.card-matched{font-size:2rem}
.card-matched{opacity:.55}

/* ---------------- 回放播放器 ---------------- */
.player-bar{display:flex;gap:8px;align-items:center;margin:12px 0;flex-wrap:wrap}
input[type=range]{flex:1;min-width:180px;accent-color:var(--accent)}
.thought{white-space:pre-wrap;font-size:.9rem;background:var(--panel);border:1px solid var(--line);
  border-radius:8px;padding:12px;max-height:320px;overflow:auto;line-height:1.6}
.thought:empty::before{content:"这一步没有记录推理内容";color:var(--muted)}
pre.prompt{white-space:pre-wrap;font-family:var(--mono);font-size:.8rem;background:var(--bg);
  border:1px solid var(--line);border-radius:8px;padding:12px;max-height:340px;overflow:auto}
.progress{height:4px;background:var(--line);border-radius:999px;overflow:hidden}
.progress i{display:block;height:100%;background:var(--accent);transition:width .3s}
.hidden{display:none!important}
`.trim();
