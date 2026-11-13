// Kalshi 成交 → 账本里的「待分配」记录。只做换算，不联网，方便测试。
//
// Kalshi 一场 NBA 比赛是一个 event（KXNBAGAME-26NOV02PHXGSW），下面两个 market，各问「某队赢吗」：
//   KXNBAGAME-26NOV02PHXGSW-PHX（太阳赢？）、KXNBAGAME-26NOV02PHXGSW-GSW（勇士赢？）
// 账本里一场比赛只有两边：a = 第一个队赢，b = 第二个队赢。
//   买「勇士赢」的 YES  → 勇士赢那边（b）买入
//   买「勇士赢」的 NO   → 太阳赢那边（a）买入
// 同一个 market 里 Kalshi 只有一个净仓位：持有 NO 时再成交 YES 方向，是先平掉 NO（卖出），多出来的才是买 YES。

export const SERIES = 'KXNBAGAME';

export const TEAMS = {
  ATL: '老鹰', BOS: '凯尔特人', BKN: '篮网', BRK: '篮网', CHA: '黄蜂', CHO: '黄蜂', CHI: '公牛', CLE: '骑士',
  DAL: '独行侠', DEN: '掘金', DET: '活塞', GSW: '勇士', GS: '勇士', HOU: '火箭', IND: '步行者', LAC: '快船',
  LAL: '湖人', MEM: '灰熊', MIA: '热火', MIL: '雄鹿', MIN: '森林狼', NOP: '鹈鹕', NO: '鹈鹕', NYK: '尼克斯',
  NY: '尼克斯', OKC: '雷霆', ORL: '魔术', PHI: '76人', PHX: '太阳', PHO: '太阳', POR: '开拓者', SAC: '国王',
  SAS: '马刺', SA: '马刺', TOR: '猛龙', UTA: '爵士', UTAH: '爵士', WAS: '奇才', WSH: '奇才',
};

/** "0.8500" → 850000（百万分之一美元，整数，没有浮点误差） */
export function micros(dollars) {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(String(dollars ?? '').trim());
  if (!m) throw new Error(`金额格式不认识：${dollars}`);
  const v = Number(m[2]) * 1e6 + Number((m[3] || '').padEnd(6, '0'));
  return m[1] ? -v : v;
}
/** 百万分之一美元 → 分（四舍五入） */
export const microsToCents = (u) => Math.round(u / 1e4);
/** "34.91" → 3491（百分之一张） */
export function units(countFp) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(countFp ?? '').trim());
  if (!m) throw new Error(`张数格式不认识：${countFp}`);
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

/** event + market ticker → 两队代码，以及这个 market 问的是哪一队 */
export function parseTickers(eventTicker, marketTicker) {
  const teams = eventTicker.split('-')[1]?.replace(/^\d{2}[A-Z]{3}\d{2}/, '') || '';
  const code = marketTicker.slice(eventTicker.length + 1);
  if (!code || !teams.includes(code)) throw new Error(`看不懂这个市场：${marketTicker}`);
  if (teams.startsWith(code)) return { a: code, b: teams.slice(code.length), code, mySide: 'a' };
  if (teams.endsWith(code)) return { a: teams.slice(0, teams.length - code.length), b: code, code, mySide: 'b' };
  throw new Error(`看不懂这个市场：${marketTicker}`);
}

export const teamName = (code, fallback) => TEAMS[code] || fallback || code;

/** market ticker → event ticker（去掉最后一段队名） */
export const eventOf = (marketTicker) => marketTicker.slice(0, marketTicker.lastIndexOf('-'));

// Combo 的 event 可能包含多个不同合约，账本必须按 market ticker 隔离。
export const isCombo = (market) => !!market?.mve_collection_ticker || !!market?.mve_selected_legs?.length;

export function comboDetails(market, markets = {}) {
  const legs = (market.mve_selected_legs || []).map((leg) => {
    let label;
    if (leg.event_ticker.startsWith(SERIES + '-')) {
      const t = parseTickers(leg.event_ticker, leg.market_ticker);
      const code = leg.side === 'yes' ? t.code : t.mySide === 'a' ? t.b : t.a;
      label = `${teamName(code)}赢`;
    } else {
      const m = markets[leg.market_ticker];
      const sub = leg.side === 'yes' ? m?.yes_sub_title : m?.no_sub_title;
      label = [m?.title || leg.market_ticker, sub, leg.side.toUpperCase()].filter(Boolean).join(' · ');
    }
    return { ...leg, label };
  });
  return { market_kind: 'combo', title: legs.map((l) => l.label).join(' ＋ ') || market.title || market.ticker, legs };
}

/**
 * 把 Kalshi 的 fills 换成账本的待分配记录。
 * @param {Array} fills  GET /portfolio/fills 的结果（可以包含别的系列，会被跳过）
 * @param {object} opts  { sinceMs: 只输出这之后的成交; names: 队名; markets: 按 market ticker 索引的市场详情 }
 */
export function mapFills(fills, { sinceMs = 0, names = {}, markets = {} } = {}) {
  const supported = fills
    .filter((f) => (f.ticker || f.market_ticker || '').startsWith(SERIES + '-') || isCombo(markets[f.ticker || f.market_ticker]))
    .sort((x, y) => (x.created_time || '').localeCompare(y.created_time || '') || String(x.fill_id).localeCompare(String(y.fill_id)));
  const position = new Map(); // market → 净仓位（百分之一张，YES 为正、NO 为负）
  const out = [];
  const skipped = [];
  for (const f of supported) {
    const market = f.ticker || f.market_ticker;
    const combo = isCombo(markets[market]);
    const event = combo ? market : eventOf(market);
    let t;
    let details;
    try {
      t = combo ? { a: 'YES', b: 'NO', mySide: 'a' } : parseTickers(event, market);
      details = combo ? comboDetails(markets[market], markets) : {};
    } catch (err) { skipped.push({ id: f.fill_id, reason: err.message }); continue; }
    const outcome = f.outcome_side || (f.action === 'buy' ? f.side : f.side === 'yes' ? 'no' : 'yes');
    if (outcome !== 'yes' && outcome !== 'no') { skipped.push({ id: f.fill_id, reason: '不知道方向' }); continue; }
    const q = units(f.count_fp);
    const before = position.get(market) || 0;
    const signed = outcome === 'yes' ? q : -q;
    position.set(market, before + signed);
    // 先平掉反方向的仓位，剩下的才是开仓
    const closing = Math.min(q, outcome === 'yes' ? Math.max(0, -before) : Math.max(0, before));
    const opening = q - closing;
    const legs = [];
    if (closing) legs.push({ instrument: outcome === 'yes' ? 'no' : 'yes', action: 'sell', q: closing });
    if (opening) legs.push({ instrument: outcome, action: 'buy', q: opening });
    if (Date.parse(f.created_time) < sinceMs) continue;

    const feeCents = microsToCents(micros(f.fee_cost ?? '0'));
    const nm = names[event] || {};
    let feeLeft = feeCents;
    legs.forEach((leg, i) => {
      const priceMicros = micros(leg.instrument === 'yes' ? f.yes_price_dollars : f.no_price_dollars);
      const fee = i === legs.length - 1 ? feeLeft : Math.round((feeCents * leg.q) / q);
      feeLeft -= fee;
      const side = leg.instrument === 'yes' ? t.mySide : t.mySide === 'a' ? 'b' : 'a';
      out.push({
        id: i === 0 ? String(f.fill_id) : `${f.fill_id}#${i + 1}`,
        order_id: f.order_id ? String(f.order_id) : null,
        event_ticker: event,
        market_ticker: market,
        ...details,
        team_a: teamName(t.a, nm.a),
        team_b: teamName(t.b, nm.b),
        starts_at: null,
        side,
        action: leg.action,
        contracts: leg.q / 100,
        price_cents: priceMicros % 10000 === 0 && priceMicros > 0 && priceMicros < 1e6 ? priceMicros / 10000 : null,
        notional_cents: microsToCents((leg.q * priceMicros) / 100),
        fee_cents: fee,
        fee_dollars: String(f.fee_cost ?? ''),
        occurred_at: f.created_time,
      });
    });
  }
  return { fills: out, skipped };
}

/** Combo 只按这个合约自己的官方结算值结算，不从各条腿猜结果。 */
export function comboResult(market) {
  if (!['finalized', 'settled'].includes(market.status)) return null;
  let payout;
  if (market.settlement_value_dollars != null && market.settlement_value_dollars !== '') {
    payout = micros(market.settlement_value_dollars);
  } else if (market.result === 'yes' || market.result === 'no') {
    payout = market.result === 'yes' ? 1e6 : 0;
  } else return null;
  if (payout < 0 || payout > 1e6) throw new Error('Combo 结算值超出范围');
  return {
    event_ticker: market.ticker,
    winner: payout === 1e6 ? 'a' : payout === 0 ? 'b' : null,
    a_payout_micros: payout,
    decided_at: market.settlement_ts || market.close_time,
  };
}

/**
 * 从 GET /markets?event_ticker=... 的结果判断谁赢。
 * @returns {{ winner: 'a'|'b', decided_at: string } | null}
 */
export function resultOf(eventTicker, markets) {
  for (const m of markets) {
    if (!['finalized', 'settled', 'determined', 'amended'].includes(m.status)) continue;
    if (m.result !== 'yes' && m.result !== 'no') continue;
    let t;
    try { t = parseTickers(eventTicker, m.ticker); } catch { continue; }
    const winner = m.result === 'yes' ? t.mySide : t.mySide === 'a' ? 'b' : 'a';
    return { event_ticker: eventTicker, winner, decided_at: m.settlement_ts || m.close_time || new Date().toISOString() };
  }
  return null;
}
