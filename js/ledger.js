// 记账核心：只做计算，不碰网络和页面。所有金额都是整数「分」。
// 张数可以有两位小数（Kalshi 按金额下单会成交 34.91 张这种）；内部按「百分之一张」的整数来算，
// 这样每 0.01 张赢了正好回 1 分钱，不会有浮点误差。
//
// 规则：
// - 每笔成交记在一个人名下（owner = Kalshi 账户持有人，partner = 跟单的朋友）。
// - 朋友余额 = 他转给持有人的钱 − 他买入花的钱 + 他卖出/结算拿回的钱 − 持有人转回给他的钱。
//   正数：持有人欠朋友；负数：朋友欠持有人。
// - 记录只加不改；撤销是一条新的 void 记录。

export const HOLDERS = ['owner', 'partner'];
export const SIDES = ['a', 'b'];

/** 张数 → 百分之一张的整数 */
export const toUnits = (contracts) => Math.round(Number(contracts) * 100);

/** Kalshi 手续费估算：向上取整到分，0.07 × 张数 × P × (1 − P)。以成交记录里的实际手续费为准。 */
export function estimateFee(contracts, priceCents) {
  const c = Number(contracts), p = Number(priceCents);
  if (!(c > 0) || Math.abs(toUnits(c) - c * 100) > 1e-6 || !Number.isInteger(p) || p < 1 || p > 99) return 0;
  return Math.ceil((7 * toUnits(c) * p * (100 - p)) / 1000000 - 1e-9);
}

/** 这条记录需要朋友确认吗：除了持有人自己的成交，其他都要。 */
export function needsConfirm(e) {
  return e.kind !== 'fill' || e.holder === 'partner';
}

/** 成交额（不含手续费）。按金额记的直接存 notional_cents；按单价记的旧记录用 张数 × 单价。 */
export function notional(e) {
  return e.notional_cents ?? Math.round(e.contracts * e.price_cents);
}

/** 这笔的平均成交价（分/张，可能带小数，比如分几档成交的 61.3¢） */
export function avgFillPrice(e) {
  return notional(e) / e.contracts;
}

/** 买入的总成本（含手续费）/ 卖出的到手金额（扣掉手续费） */
export function fillAmount(e) {
  return e.action === 'buy' ? notional(e) + e.fee_cents : notional(e) - e.fee_cents;
}

function newSide() {
  return { units: 0, basis: 0, boughtUnits: 0, boughtNotional: 0, firstBuyAt: null, realized: 0, closedCost: 0 };
}
function newHolder() {
  return { a: newSide(), b: newSide(), realized: 0, closedCost: 0, payout: 0, bought: false, buyCost: 0 };
}

/**
 * 把所有记录从头算一遍。
 * @param {Array} events  数据库里的 events 行（任意顺序）
 * @param {Array} games   数据库里的 games 行
 */
export function compute(events, games = []) {
  const sorted = [...events].sort((x, y) => x.id - y.id);
  const voidOf = new Map(); // 被撤销的记录 id -> 撤销它的记录
  for (const e of sorted) if (e.kind === 'void') voidOf.set(e.voids, e);

  const gameById = new Map(games.map((g) => [g.id, g]));
  const gameStates = new Map();
  const gs = (id) => {
    if (!gameStates.has(id)) {
      gameStates.set(id, {
        id,
        game: gameById.get(id) || null,
        settled: null,
        holders: { owner: newHolder(), partner: newHolder() },
        events: [],
      });
    }
    return gameStates.get(id);
  };
  for (const g of games) gs(g.id);

  const realized = { owner: 0, partner: 0 };
  const closedCost = { owner: 0, partner: 0 };
  let balance = 0;
  let transfersIn = 0; // 朋友 → 持有人
  let transfersOut = 0; // 持有人 → 朋友
  const effects = new Map(); // event id -> { partnerDelta, balanceAfter, involvesPartner, warning }
  const timeline = [];
  const problems = [];
  const realizedLog = []; // 每一笔落袋的盈亏：{ at, holder, gameId, side, pnl }

  for (const e of sorted) {
    if (e.kind === 'void' || voidOf.has(e.id)) continue;
    let partnerDelta = 0;
    let involvesPartner = false;
    let warning = null;

    if (e.kind === 'transfer') {
      involvesPartner = true;
      if (e.direction === 'to_owner') { partnerDelta = e.amount_cents; transfersIn += e.amount_cents; }
      else { partnerDelta = -e.amount_cents; transfersOut += e.amount_cents; }
    } else if (e.kind === 'fill') {
      const st = gs(e.game_id);
      st.events.push(e);
      const h = st.holders[e.holder];
      const pos = h[e.side];
      let cash;
      if (st.settled) {
        warning = '这场已经结算过，这笔不计入';
        problems.push({ id: e.id, message: warning });
        cash = 0;
      } else if (e.action === 'buy') {
        const cost = fillAmount(e);
        pos.units += toUnits(e.contracts);
        pos.basis += cost;
        pos.boughtUnits += toUnits(e.contracts);
        pos.boughtNotional += notional(e);
        if (!pos.firstBuyAt) pos.firstBuyAt = e.occurred_at;
        h.bought = true;
        h.buyCost += cost;
        cash = -cost;
      } else {
        const want = toUnits(e.contracts);
        const n = Math.min(want, pos.units);
        if (n < want) {
          warning = `卖出 ${want / 100} 张，但只持有 ${pos.units / 100} 张`;
          problems.push({ id: e.id, message: warning });
        }
        const removed = pos.units > 0 ? Math.round((pos.basis * n) / pos.units) : 0;
        const proceeds = fillAmount(e);
        pos.units -= n;
        pos.basis -= removed;
        const pnl = proceeds - removed;
        pos.realized += pnl;
        pos.closedCost += removed;
        realizedLog.push({ at: e.occurred_at, holder: e.holder, gameId: st.id, side: e.side, pnl });
        h.realized += pnl;
        h.closedCost += removed;
        realized[e.holder] += pnl;
        closedCost[e.holder] += removed;
        cash = proceeds;
      }
      if (e.holder === 'partner') { partnerDelta = cash; involvesPartner = true; }
    } else if (e.kind === 'settle') {
      const st = gs(e.game_id);
      st.events.push(e);
      if (st.settled) {
        warning = '这场已经结算过';
        problems.push({ id: e.id, message: warning });
      } else {
        st.settled = { winner: e.winner, at: e.occurred_at, eventId: e.id };
        for (const who of HOLDERS) {
          const h = st.holders[who];
          let payout = 0, removed = 0, held = 0;
          for (const side of SIDES) {
            const pos = h[side];
            held += pos.units;
            const sidePayout = side === e.winner ? pos.units : 0; // 每 0.01 张回 1 分
            if (pos.units || pos.basis) {
              pos.realized += sidePayout - pos.basis;
              pos.closedCost += pos.basis;
              realizedLog.push({ at: e.occurred_at, holder: who, gameId: st.id, side, pnl: sidePayout - pos.basis });
            }
            payout += sidePayout;
            removed += pos.basis;
            pos.units = 0;
            pos.basis = 0;
          }
          const pnl = payout - removed;
          h.realized += pnl;
          h.closedCost += removed;
          h.payout += payout;
          realized[who] += pnl;
          closedCost[who] += removed;
          if (who === 'partner') {
            partnerDelta = payout;
            involvesPartner = held > 0 || h.bought;
          }
        }
      }
    }

    balance += partnerDelta;
    effects.set(e.id, { partnerDelta, balanceAfter: balance, involvesPartner, warning });
    timeline.push({ id: e.id, at: e.occurred_at, balance, realized: realized.partner });
  }

  // 每场比赛的汇总
  const gameList = [...gameStates.values()].map((st) => {
    const holders = {};
    for (const who of HOLDERS) {
      const h = st.holders[who];
      const sides = {};
      for (const side of SIDES) {
        const p = h[side];
        sides[side] = {
          units: p.units,
          contracts: p.units / 100,
          basis: p.basis,
          boughtContracts: p.boughtUnits / 100,
          avgPrice: p.boughtUnits ? (p.boughtNotional * 100) / p.boughtUnits : null,
          firstBuyAt: p.firstBuyAt,
          realized: p.realized,
          closedCost: p.closedCost,
        };
      }
      holders[who] = {
        sides,
        open: (sides.a.units + sides.b.units) / 100,
        openBasis: sides.a.basis + sides.b.basis,
        realized: h.realized,
        closedCost: h.closedCost,
        payout: h.payout,
        bought: h.bought,
        buyCost: h.buyCost,
      };
    }
    const last = st.events.length ? st.events[st.events.length - 1].occurred_at : st.game?.created_at;
    return { id: st.id, game: st.game, settled: st.settled, holders, events: st.events, lastAt: last };
  });

  const openBasis = { owner: 0, partner: 0 };
  for (const g of gameList) for (const who of HOLDERS) openBasis[who] += g.holders[who].openBasis;

  return {
    balance,
    transfersIn,
    transfersOut,
    realized,
    closedCost,
    openBasis,
    games: gameList,
    effects,
    voidOf,
    timeline,
    problems,
    realizedLog,
  };
}

/** 战绩：各自盈亏、回报率、胜负，以及朋友跟单比持有人贵了多少。 */
export function stats(result) {
  const per = {};
  for (const who of HOLDERS) {
    let wins = 0, losses = 0;
    for (const g of result.games) {
      const h = g.holders[who];
      if (!g.settled || !h.bought) continue;
      if (h.realized > 0) wins++; else if (h.realized < 0) losses++;
    }
    per[who] = {
      realized: result.realized[who],
      closedCost: result.closedCost[who],
      roi: result.closedCost[who] > 0 ? result.realized[who] / result.closedCost[who] : null,
      wins,
      losses,
    };
  }
  // 跟单滑点：同一场同一边，两人都买了，朋友的平均成交价比持有人高多少
  const slips = [];
  for (const g of result.games) {
    for (const side of SIDES) {
      const o = g.holders.owner.sides[side], p = g.holders.partner.sides[side];
      if (o.boughtContracts && p.boughtContracts) {
        const diff = p.avgPrice - o.avgPrice; // 分/张
        slips.push({ gameId: g.id, game: g.game, side, diff, contracts: p.boughtContracts, extra: diff * p.boughtContracts });
      }
    }
  }
  const slipContracts = slips.reduce((s, x) => s + x.contracts, 0);
  const slipExtra = slips.reduce((s, x) => s + x.extra, 0);
  return {
    per,
    slips,
    slipAvg: slipContracts ? slipExtra / slipContracts : null,
    slipExtra: Math.round(slipExtra),
  };
}

/** 买入价分档：价格就是市场给的胜率 */
export const BUCKETS = [
  { key: 'fav', label: '热门', range: '≥60¢', test: (p) => p >= 60 },
  { key: 'even', label: '五五开', range: '40–59¢', test: (p) => p >= 40 && p < 60 },
  { key: 'dog', label: '冷门', range: '<40¢', test: (p) => p < 40 },
];

/**
 * 更细的战绩：只看已经结算的比赛。每个人在一场比赛里押的每一边算一次「押注」。
 * @param {object} result compute() 的结果
 * @param {object} opts { monthOf(iso) → 'YYYY-MM' }，默认按本地时间
 */
export function insights(result, { monthOf } = {}) {
  const month = monthOf || ((iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const picks = [];
  for (const g of result.games) {
    if (!g.settled || !g.game) continue;
    for (const holder of HOLDERS) {
      for (const side of SIDES) {
        const s = g.holders[holder].sides[side];
        if (!s.boughtContracts) continue;
        picks.push({
          holder, gameId: g.id, game: g.game, side,
          team: side === 'a' ? g.game.team_a : g.game.team_b,
          price: s.avgPrice, contracts: s.boughtContracts,
          cost: s.closedCost, pnl: s.realized, hit: side === g.settled.winner, at: g.settled.at,
        });
      }
    }
  }
  const sum = (list) => {
    const n = list.length, hits = list.filter((p) => p.hit).length;
    const pnl = list.reduce((t, p) => t + p.pnl, 0), cost = list.reduce((t, p) => t + p.cost, 0);
    const avgPrice = n ? list.reduce((t, p) => t + p.price, 0) / n : null;
    return {
      n, hits, pnl, cost,
      rate: n ? hits / n : null,
      roi: cost > 0 ? pnl / cost : null,
      avgPrice,
      // 押中率比市场给的胜率高几个百分点（正数 = 比市场准）
      edge: n ? (hits / n) * 100 - avgPrice : null,
    };
  };
  const accuracy = {}, buckets = {};
  for (const holder of HOLDERS) {
    const mine = picks.filter((p) => p.holder === holder);
    accuracy[holder] = sum(mine);
    buckets[holder] = Object.fromEntries(BUCKETS.map((b) => [b.key, sum(mine.filter((p) => b.test(p.price)))]));
  }
  // 球队：押这个队赢，你们俩合起来赚了多少
  const byTeam = new Map();
  for (const p of picks) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const teams = [...byTeam.entries()].map(([team, list]) => ({ team, ...sum(list) }));
  // 每月盈亏和累计曲线（按落袋时间，含提前卖出）
  const log = [...result.realizedLog].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const months = new Map();
  const curve = [{ at: null, owner: 0, partner: 0 }];
  const run = { owner: 0, partner: 0 };
  for (const r of log) {
    const m = month(r.at);
    if (!months.has(m)) months.set(m, { month: m, owner: 0, partner: 0 });
    months.get(m)[r.holder] += r.pnl;
    run[r.holder] += r.pnl;
    curve.push({ at: r.at, owner: run.owner, partner: run.partner });
  }
  return {
    picks,
    accuracy,
    buckets,
    best: teams.filter((t) => t.pnl > 0).sort((x, y) => y.pnl - x.pnl).slice(0, 3),
    worst: teams.filter((t) => t.pnl < 0).sort((x, y) => x.pnl - y.pnl).slice(0, 3),
    months: [...months.values()].sort((x, y) => y.month.localeCompare(x.month)),
    curve,
  };
}

/**
 * 对账单：上一张对账单之后，和朋友有关的新记录 + 当前余额 + 从头算的拆解。
 * @param {object} result compute() 的结果
 * @param {Array} events 所有记录
 * @param {object|null} lastStatement 上一张对账单（statements 表的行）
 */
export function statement(result, events, lastStatement, games = []) {
  const after = lastStatement ? lastStatement.upto_event_id : 0;
  const sorted = [...events].sort((x, y) => x.id - y.id);
  const byId = new Map(sorted.map((x) => [x.id, x]));
  const uptoEventId = sorted.length ? sorted[sorted.length - 1].id : 0;
  // 每条新记录的金额 = 算到这条为止的余额 − 算到上一条为止的余额。
  // 这样撤销旧记录、撤销影响到后面的结算，都能如实反映，且「上次余额 + 各条 = 本次余额」一定成立。
  const balanceUpTo = (k) => compute(sorted.filter((x) => x.id <= k), games).balance;
  const related = (x) => {
    if (!x) return false;
    if (x.kind === 'transfer') return true;
    if (x.kind === 'fill') return x.holder === 'partner';
    if (x.kind === 'settle') return result.effects.get(x.id)?.involvesPartner ?? true;
    return related(byId.get(x.voids));
  };
  const items = [];
  let prev = balanceUpTo(after);
  for (const e of sorted) {
    if (e.id <= after) continue;
    const b = balanceUpTo(e.id);
    const delta = b - prev;
    prev = b;
    if (delta === 0 && !related(e)) continue;
    items.push({
      event: e,
      target: e.kind === 'void' ? byId.get(e.voids) || null : null,
      voided: result.voidOf.has(e.id),
      delta,
    });
  }
  const openPositions = [];
  for (const g of result.games) {
    if (g.settled) continue;
    for (const side of SIDES) {
      const s = g.holders.partner.sides[side];
      if (s.contracts > 0) openPositions.push({ game: g.game, gameId: g.id, side, contracts: s.contracts, basis: s.basis });
    }
  }
  return {
    no: lastStatement ? lastStatement.no + 1 : 1,
    prevBalance: lastStatement ? lastStatement.balance_cents : null,
    prevAt: lastStatement ? lastStatement.created_at : null,
    balance: result.balance,
    items,
    openPositions,
    transfersNet: result.transfersIn - result.transfersOut,
    realized: result.realized.partner,
    openBasis: result.openBasis.partner,
    uptoEventId,
  };
}

/** 导出 CSV（Excel 能直接打开）。 */
export function toCSV(events, games, names) {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const result = compute(events, games);
  const head = ['编号', '时间', '类型', '谁', '比赛', '方向', '张数', '均价(¢)', '成交额($)', '手续费($)', '金额($)', '朋友余额变化($)', '朋友余额($)', '状态', '备注'];
  const kindName = { transfer: '转账', fill: '成交', settle: '结算', void: '撤销' };
  const rows = [...events].sort((x, y) => x.id - y.id).map((e) => {
    const g = e.game_id ? gameById.get(e.game_id) : null;
    const eff = result.effects.get(e.id);
    const who = e.kind === 'fill' ? names[e.holder] : e.kind === 'transfer' ? (e.direction === 'to_owner' ? `${names.partner}→${names.owner}` : `${names.owner}→${names.partner}`) : '';
    const sideName = g && (e.side || e.winner) ? `${(e.side || e.winner) === 'a' ? g.team_a : g.team_b}赢` : '';
    const amount = e.kind === 'fill' ? fillAmount(e) : e.kind === 'transfer' ? e.amount_cents : null;
    const status = result.voidOf.has(e.id) ? '已撤销' : !needsConfirm(e) ? '' : e.confirmed_at ? '已确认' : '待确认';
    return [
      e.id,
      new Date(e.occurred_at).toISOString(),
      e.kind === 'fill' ? (e.action === 'buy' ? '买入' : '卖出') : kindName[e.kind],
      who,
      g ? `${g.team_a} vs ${g.team_b}` : '',
      sideName,
      e.contracts ?? '',
      e.kind === 'fill' ? +avgFillPrice(e).toFixed(2) : '',
      e.kind === 'fill' ? (notional(e) / 100).toFixed(2) : '',
      e.fee_cents != null ? (e.fee_cents / 100).toFixed(2) : '',
      amount != null ? (amount / 100).toFixed(2) : '',
      eff ? (eff.partnerDelta / 100).toFixed(2) : '',
      eff ? (eff.balanceAfter / 100).toFixed(2) : '',
      status,
      e.kind === 'void' ? `撤销 #${e.voids}${e.note ? '：' + e.note : ''}` : e.note || e.method || '',
    ];
  });
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}
