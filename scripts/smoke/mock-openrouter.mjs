/**
 * 假的 OpenRouter：真的去读提示词，从里面挑一个合法走法回答。
 * 这样能完整跑通 AiRunDO 的 alarm 循环、R2 写入、Queue → D1 → 排行榜，
 * 而不需要真的花钱调模型。
 */
import { createServer } from 'node:http';

let calls = 0;
let illegalOnce = false;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock/model', name: 'Mock', context_length: 8000,
        pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['structured_outputs'] }] }));
      return;
    }
    calls++;
    const payload = JSON.parse(body || '{}');
    const user = payload.messages?.find((m) => m.role === 'user')?.content ?? '';

    let move = '';
    const legal = /LEGAL MOVES[^:]*:\s*(.+)/.exec(user);
    if (legal) {
      move = legal[1].split(',')[0].trim().replace(/\.\.\.$/, '').trim();
    } else {
      const sud = /([A-I]\d)=\{(\d)/.exec(user);
      if (sud) move = `${sud[1]}=${sud[2]}`;
    }

    // 第三次调用故意给一个非法走法，测试纠错重试链路
    if (calls === 3 && !illegalOnce) { illegalOnce = true; move = 'ZZ99'; }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'mock/model',
      choices: [{ message: { content: `Looking at the board carefully.\nMOVE: ${move}` } }],
      usage: { prompt_tokens: 320, completion_tokens: 18, cost: 0.00004 },
    }));
  });
}).listen(9911, () => console.log('mock openrouter on :9911'));
