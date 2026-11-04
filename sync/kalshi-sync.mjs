// 合买账本 · Kalshi 同步
// 由 GitHub Actions 每小时运行一次（.github/workflows/kalshi-sync.yml）。
//
// 需要的环境变量（放在 GitHub 仓库的 Secrets 里）：
//   KALSHI_KEY_ID        Kalshi API key 的 Key ID
//   KALSHI_PRIVATE_KEY   Kalshi API key 的私钥（整段 PEM；只读权限就够）
//   KL_SYNC_TOKEN        账本「设置 → Kalshi 同步」里生成的同步令牌
//
// 运行日志是公开的，所以这里只打印条数，不打印任何交易内容。

import crypto from 'node:crypto';
import { mapFills, resultOf, SERIES } from './kalshi-map.mjs';

const KALSHI = process.env.KALSHI_BASE || 'https://api.elections.kalshi.com';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ofjchymwuwqbinbgczys.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_RoHUK-K1TdEbz0XVnIly9Q_5LKXHduK';
const LOOKBACK_DAYS = 7; // 往前多拉几天，用来算清每个市场的净仓位

function need(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`缺少 ${name}：到 GitHub 仓库 Settings → Secrets and variables → Actions 里添加`);
  return v.trim();
}

export function loadKey(pem) {
  // GitHub Secrets 里粘贴时换行可能丢了；只给了中间那段也能认
  let text = pem.replace(/\\n/g, '\n').trim();
  if (!text.includes('-----BEGIN')) {
    const body = text.replace(/-----END[^-]*-----/g, '').replace(/\s+/g, '');
    text = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  }
  return crypto.createPrivateKey(text);
}

export function kalshiClient(keyId, key) {
  const sign = (msg) => (key.asymmetricKeyType === 'ed25519'
    ? crypto.sign(null, Buffer.from(msg), key)
    : crypto.sign('sha256', Buffer.from(msg), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
  ).toString('base64');
  return async function get(path, query = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''));
    const full = `/trade-api/v2${path}`;
    const ts = String(Date.now());
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${KALSHI}${full}${qs.size ? '?' + qs : ''}`, {
        headers: { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sign(ts + 'GET' + full) },
      });
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`Kalshi ${path} 返回 ${res.status}${res.status === 401 ? '（Key ID 或私钥不对）' : ''}`);
      return res.json();
    }
  };
}

async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* 原样 */ }
    throw new Error(`账本 ${name} 失败：${msg.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// 美元兑人民币：先用 open.er-api.com（每天更新），不行再用欧洲央行的数据
export async function fetchRate() {
  const sources = [
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', (d) => d.result === 'success' && d.rates?.CNY],
    ['欧洲央行', 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY', (d) => d.rates?.CNY],
  ];
  for (const [source, url, pick] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const rate = res.ok ? Number(pick(await res.json())) : NaN;
      if (rate >= 1 && rate <= 20) return { rate, source };
    } catch { /* 换下一个 */ }
  }
  return null;
}

export async function run({ get, call, log = console.log, token, rate = fetchRate }) {
  const info = await call('kalshi_sync_info', { p_token: token });
  // 起始日期按北京时间零点算（你们俩都在国内）
  const sinceMs = Date.parse(`${info.since}T00:00:00+08:00`);
  const minTs = Math.floor(sinceMs / 1000) - LOOKBACK_DAYS * 86400;

  const fills = [];
  let cursor;
  do {
    const page = await get('/portfolio/fills', { min_ts: minTs, limit: 1000, cursor });
    fills.push(...(page.fills || []));
    cursor = page.cursor;
  } while (cursor);
  const nbaFills = fills.filter((f) => (f.ticker || '').startsWith(SERIES + '-'));

  const mapped = mapFills(nbaFills, { sinceMs });
  // 需要查结果的比赛：这次的 + 账本里还没出结果的
  const events = new Set([...mapped.fills.map((f) => f.event_ticker), ...(info.open_events || [])]);
  const results = [];
  for (const ev of events) {
    const page = await get('/markets', { event_ticker: ev, limit: 10 });
    const r = resultOf(ev, page.markets || []);
    if (r) results.push(r);
  }
  const message = `Kalshi 成交 ${fills.length} 笔（NBA 比赛 ${nbaFills.length} 笔），整理出 ${mapped.fills.length} 条，跳过 ${mapped.skipped.length} 条，出结果 ${results.length} 场`;
  const out = await call('kalshi_ingest', { p_token: token, p_fills: mapped.fills, p_results: results, p_message: message });
  log(`${message}；新导入 ${out.imported} 条，自动结算 ${out.settled} 场`);
  // 汇率失败不影响同步
  const fx = await rate();
  if (fx) {
    try {
      await call('set_fx_rate', { p_token: token, p_rate: fx.rate, p_source: fx.source });
      log(`汇率 1 美元 = ${fx.rate} 元（${fx.source}）`);
    } catch (err) { log('汇率没更新：' + err.message); }
  } else log('汇率没取到，下次再试');
  return { ...out, mapped: mapped.fills.length, skipped: mapped.skipped.length, results: results.length, fx };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = ['KALSHI_KEY_ID', 'KALSHI_PRIVATE_KEY', 'KL_SYNC_TOKEN'];
  if (names.every((n) => !process.env[n])) {
    // 还没设置的时候每小时报错会一直发失败邮件，所以直接跳过
    console.log('还没设置 Kalshi 同步（GitHub Secrets 里没有 KALSHI_KEY_ID / KALSHI_PRIVATE_KEY / KL_SYNC_TOKEN），跳过');
    process.exit(0);
  }
  try {
    const get = kalshiClient(need('KALSHI_KEY_ID'), loadKey(need('KALSHI_PRIVATE_KEY')));
    await run({ get, call: rpc, token: need('KL_SYNC_TOKEN') });
  } catch (err) {
    console.error('同步失败：' + err.message);
    process.exit(1);
  }
}
