// 京都線上導遊 — 後端代理
//
// 這支程式唯一的工作，是幫前端把問題轉給 AI，並且「把金鑰藏在伺服器這一側」。
// 前端是公開的靜態網頁，任何人按 F12 就看得到原始碼，所以金鑰絕對不能放在那裡。
//
// 刻意不使用任何 npm 套件（express 等一律沒有），只用 Node 內建模組：
//   - 部署快、沒有相依套件要維護、也不會有套件漏洞
//   - Node 18 以上內建 fetch，不需要 node-fetch

const http = require('node:http');

const PORT = process.env.PORT || 10000;

// OmniRoute（或任何 OpenAI 相容端點）的網址與金鑰，都從環境變數讀取
const AI_BASE_URL = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'auto/best-free';

// 只允許自己的網站呼叫。沒設定的話預設只放行正式網址。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://kyoto-trip-map.vercel.app')
  .split(',').map(s => s.trim()).filter(Boolean);

// 很簡單的流量限制：同一個 IP 每分鐘最多 20 次，避免網址被別人撿去亂用
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20);
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const key = ip + ':' + minute;
  const count = (hits.get(key) || 0) + 1;
  hits.set(key, count);
  // 清掉舊的計數，避免記憶體無限成長
  if (hits.size > 5000) {
    for (const k of hits.keys()) {
      if (!k.endsWith(':' + minute)) hits.delete(k);
    }
  }
  return count > RATE_LIMIT;
}

const SYSTEM_PROMPT = `你是一位在京都帶團多年的台灣導遊，正在協助一家四口自由行：
提問者、他的姊姊與妹妹，以及一位年長的伯父。
行程是 2026/9/29 抵達關西機場、10/3 離開，住在京都車站附近的 RESI STAY HEART。

你的工作：
- 解說景點特色與實際看點，講具體的東西，不要寫官方簡介那種空話。
- 使用者要求時，幫忙安排或調整行程順序、判斷順不順路、一天塞不塞得下。
- 回答現場突發問題（找廁所、藥局、迷路、怎麼搭車）。

回答規則：
- 用繁體中文，語氣像朋友帶路。
- 控制在 150 字以內，除非對方要求詳細說明。排行程可以放寬到 300 字。
- 有長輩同行，談路線時要主動提醒坡度、階梯、步行距離。
- 不確定的事（營業時間、票價、是否需預約）要老實說「請再確認」，絕對不要編造。
- 「目前畫面狀態」是使用者在地圖上選的景點與順序，回答請直接對應那些地方。
- 狀態裡若附上「可能相關的其他景點」，那是從他們自己的景點資料庫撈出來的，
  請優先根據那些資料回答，不要改用你記憶中的版本；
  資料庫裡沒有的地方可以提，但要說明那不在他們的清單上。
- 建議調整行程時，說明理由（例如順路、避開人潮、長輩體力），讓他們自己決定，
  不要擅自替他們決定該去哪裡。
- 不要重複使用者的問題，直接回答。`;

function send(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req, limitBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function askAI({ question, context, history }) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (const turn of (Array.isArray(history) ? history.slice(-6) : [])) {
    if (turn && typeof turn.q === 'string') messages.push({ role: 'user', content: turn.q.slice(0, 1000) });
    if (turn && typeof turn.a === 'string') messages.push({ role: 'assistant', content: turn.a.slice(0, 2000) });
  }

  const userContent = context
    ? `【目前畫面狀態】\n${String(context).slice(0, 6000)}\n\n【問題】\n${question}`
    : question;
  messages.push({ role: 'user', content: userContent });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('AI 回應錯誤', res.status, text.slice(0, 500));
      throw new Error(`AI 服務回應 ${res.status}`);
    }

    const data = JSON.parse(text);
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) throw new Error('AI 沒有回傳內容');
    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : null;
  const url = new URL(req.url, 'http://localhost');

  // 瀏覽器的 CORS 預檢
  if (req.method === 'OPTIONS') {
    if (!allowed) return send(res, 403, { error: 'origin not allowed' });
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
    return res.end();
  }

  // 健康檢查：Render 用來確認服務活著，前端也用它把休眠的服務叫醒
  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, configured: Boolean(AI_BASE_URL && AI_API_KEY) }, allowed || '*');
  }

  if (url.pathname !== '/ask' || req.method !== 'POST') {
    return send(res, 404, { error: 'not found' }, allowed);
  }

  if (!allowed) {
    return send(res, 403, { error: 'origin not allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return send(res, 429, { error: '問太快了，請稍等一下再問' }, allowed);
  }

  if (!AI_BASE_URL || !AI_API_KEY) {
    return send(res, 500, { error: '伺服器尚未設定 AI_BASE_URL / AI_API_KEY' }, allowed);
  }

  try {
    const raw = await readBody(req);
    const payload = JSON.parse(raw || '{}');
    const question = String(payload.question || '').trim().slice(0, 1000);
    if (!question) return send(res, 400, { error: '問題是空的' }, allowed);

    const answer = await askAI({
      question,
      context: payload.context,
      history: payload.history,
    });
    return send(res, 200, { answer }, allowed);
  } catch (err) {
    console.error('處理失敗:', err.message);
    const message = err.name === 'AbortError'
      ? 'AI 回應逾時，請再試一次'
      : '導遊暫時無法回答，請稍後再試';
    return send(res, 502, { error: message }, allowed);
  }
});

server.listen(PORT, () => {
  console.log(`京都導遊後端已啟動，port ${PORT}`);
  console.log(`允許的來源：${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`AI 設定完成：${Boolean(AI_BASE_URL && AI_API_KEY)}`);
});
