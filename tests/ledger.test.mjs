import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, stats, statement, estimateFee, toCSV, needsConfirm, notional, avgFillPrice, fillAmount, insights } from '../js/ledger.js';
import { sampleData } from '../js/sample.js';

test('手续费估算和设计图一致', () => {
  assert.equal(estimateFee(100, 40), 168);
  assert.equal(estimateFee(50, 45), 87);
  assert.equal(estimateFee(60, 35), 96);
  assert.equal(estimateFee(40, 38), 66);
  assert.equal(estimateFee(80, 58), 137);
  assert.equal(estimateFee(30, 61), 50);
  assert.equal(estimateFee(0, 50), 0);
  assert.equal(estimateFee(10, 100), 0);
});

test('示例数据：余额、盈亏、持仓', () => {
  const { events, games } = sampleData();
  const r = compute(events, games);
  assert.equal(r.balance, 19197); // 我欠朋友 $191.97
  assert.equal(r.realized.partner, 1077);
  assert.equal(r.realized.owner, 3636);
  assert.equal(r.openBasis.partner, 1880);
  assert.equal(r.openBasis.owner, 4777);
  // 从头算的恒等式
  assert.equal(r.transfersIn - r.transfersOut + r.realized.partner - r.openBasis.partner, r.balance);
  // 第一场之后的余额
  assert.equal(r.effects.get(4).balanceAfter, 22663);
  assert.equal(r.effects.get(7).balanceAfter, 21077);
  // 持有人自己的单不动余额
  assert.equal(r.effects.get(2).partnerDelta, 0);
  const g1 = r.games.find((g) => g.id === 'g1');
  assert.equal(g1.holders.owner.realized, 5832);
  assert.equal(g1.holders.partner.realized, 2663);
  assert.equal(g1.holders.partner.payout, 5000);
  assert.deepEqual(r.problems, []);
});

test('战绩和跟单滑点', () => {
  const { events, games } = sampleData();
  const s = stats(compute(events, games));
  assert.equal(s.per.owner.realized, 3636);
  assert.equal(s.per.owner.closedCost, 6364);
  assert.equal(s.per.partner.closedCost, 3923);
  assert.equal(s.per.owner.wins, 1);
  assert.equal(s.per.owner.losses, 1);
  assert.equal(Math.round(s.per.owner.roi * 1000), 571);
  assert.equal(Math.round(s.per.partner.roi * 1000), 275);
  assert.equal(s.slipExtra, 460);
  assert.equal(Math.round(s.slipAvg * 10), 38);
});

test('对账单 #3 只列朋友那笔新买入', () => {
  const { events, games, statements } = sampleData();
  const r = compute(events, games);
  const st = statement(r, events, statements[statements.length - 1], games);
  assert.equal(st.no, 3);
  assert.equal(st.prevBalance, 21077);
  assert.equal(st.balance, 19197);
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].event.id, 9);
  assert.equal(st.items[0].delta, -1880);
  assert.equal(st.openPositions.length, 1);
  assert.equal(st.openPositions[0].contracts, 30);
  assert.equal(st.transfersNet + st.realized - st.openBasis, st.balance);
  assert.equal(st.uptoEventId, 9);
});

test('撤销已对过账的转账，新对账单里列出撤销和金额，前后对得上', () => {
  const { events, games, statements } = sampleData();
  const all = [...events, { id: 10, kind: 'void', voids: 1, note: '记重了', occurred_at: '2026-11-03T20:00:00-08:00' }];
  const r = compute(all, games);
  const st = statement(r, all, statements[1], games);
  assert.equal(st.items.length, 2);
  assert.equal(st.items[1].event.id, 10);
  assert.equal(st.items[1].delta, -20000);
  assert.equal(st.prevBalance + st.items.reduce((s, x) => s + x.delta, 0), st.balance);
  assert.equal(st.transfersNet + st.realized - st.openBasis, st.balance);
});

test('撤销朋友已结算那场的买入，结算回款也跟着变，对账单仍然对得上', () => {
  const { events, games, statements } = sampleData();
  const all = [...events, { id: 10, kind: 'void', voids: 3, occurred_at: '2026-11-03T20:00:00-08:00' }];
  const r = compute(all, games);
  const st = statement(r, all, statements[1], games);
  // 撤掉 −23.37 的买入，同时那场赢的 +50 也没了：净 −26.63
  assert.equal(st.items.find((x) => x.event.id === 10).delta, -2663);
  assert.equal(st.prevBalance + st.items.reduce((s, x) => s + x.delta, 0), st.balance);
});

test('提前卖出一部分：按平均成本结转，回款进朋友余额', () => {
  const { events, games } = sampleData();
  const sell = { id: 10, ledger_id: 'demo-ledger', kind: 'fill', occurred_at: '2026-11-03T20:00:00-08:00', game_id: 'g3', holder: 'partner', action: 'sell', side: 'a', contracts: 10, price_cents: 70, fee_cents: estimateFee(10, 70) };
  assert.equal(sell.fee_cents, 15);
  const r = compute([...events, sell], games);
  assert.equal(r.effects.get(10).partnerDelta, 685);
  assert.equal(r.balance, 19197 + 685);
  const g3 = r.games.find((g) => g.id === 'g3');
  assert.equal(g3.holders.partner.sides.a.contracts, 20);
  assert.equal(g3.holders.partner.sides.a.basis, 1880 - 627);
  assert.equal(r.realized.partner, 1077 + 58);
  assert.equal(r.transfersIn - r.transfersOut + r.realized.partner - r.openBasis.partner, r.balance);
});

test('卖出超过持有张数会被标出来', () => {
  const { events, games } = sampleData();
  const sell = { id: 10, kind: 'fill', occurred_at: '2026-11-03T20:00:00-08:00', game_id: 'g3', holder: 'partner', action: 'sell', side: 'a', contracts: 50, price_cents: 70, fee_cents: 0 };
  const r = compute([...events, sell], games);
  assert.equal(r.problems.length, 1);
  assert.equal(r.games.find((g) => g.id === 'g3').holders.partner.sides.a.contracts, 0);
});

test('撤销一条记录后从头重算，撤销结算会让比赛回到进行中', () => {
  const { events, games } = sampleData();
  const voidSettle = { id: 10, kind: 'void', voids: 7, occurred_at: '2026-11-03T20:00:00-08:00' };
  const r = compute([...events, voidSettle], games);
  const g2 = r.games.find((g) => g.id === 'g2');
  assert.equal(g2.settled, null);
  assert.equal(g2.holders.partner.sides.a.contracts, 40);
  assert.equal(r.balance, 19197); // 输的那场结算回款是 0，余额不变
  assert.equal(r.openBasis.partner, 1880 + 1586);
  const voidTransfer = { id: 11, kind: 'void', voids: 1, occurred_at: '2026-11-03T20:01:00-08:00' };
  const r2 = compute([...events, voidTransfer], games);
  assert.equal(r2.balance, 19197 - 20000);
});

test('转回给朋友，余额减少', () => {
  const { events, games } = sampleData();
  const back = { id: 10, kind: 'transfer', direction: 'to_partner', amount_cents: 19197, occurred_at: '2026-11-04T10:00:00-08:00' };
  const r = compute([...events, back], games);
  assert.equal(r.balance, 0);
});

test('哪些记录需要朋友确认', () => {
  assert.equal(needsConfirm({ kind: 'fill', holder: 'owner' }), false);
  assert.equal(needsConfirm({ kind: 'fill', holder: 'partner' }), true);
  assert.equal(needsConfirm({ kind: 'transfer' }), true);
  assert.equal(needsConfirm({ kind: 'settle' }), true);
});

test('CSV 导出有表头和每条记录', () => {
  const { events, games } = sampleData();
  const csv = toCSV(events, games, { owner: '小明', partner: '阿杰' });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, events.length + 1);
  assert.match(lines[0], /编号,时间,类型/);
  assert.match(lines[9], /阿杰.*掘金 vs 太阳.*掘金赢,30,61,18.30,0.50,18.80,-18.80,191.97,待确认/);
});

test('按 Cost / Fee / Max payout 记：成交额直接用，均价可以带小数', () => {
  const e = { kind: 'fill', action: 'buy', contracts: 30, price_cents: null, notional_cents: 1840, fee_cents: 50 };
  assert.equal(notional(e), 1840);
  assert.equal(fillAmount(e), 1890);
  assert.equal(avgFillPrice(e).toFixed(2), '61.33');
  const old = { kind: 'fill', action: 'buy', contracts: 30, price_cents: 61, fee_cents: 50 };
  assert.equal(notional(old), 1830);
});

test('按金额记的买入和卖出，余额、持仓、滑点都按成交额算', () => {
  const { events, games } = sampleData();
  const buy = { id: 10, kind: 'fill', occurred_at: '2026-11-03T19:50:00-08:00', game_id: 'g3', holder: 'partner', action: 'buy', side: 'a', contracts: 30, price_cents: null, notional_cents: 1840, fee_cents: 50 };
  const sell = { id: 11, kind: 'fill', occurred_at: '2026-11-03T20:10:00-08:00', game_id: 'g3', holder: 'partner', action: 'sell', side: 'a', contracts: 20, price_cents: null, notional_cents: 1410, fee_cents: 30 };
  const r = compute([...events, buy, sell], games);
  assert.equal(r.effects.get(10).partnerDelta, -1890);
  assert.equal(r.effects.get(11).partnerDelta, 1380);
  const pos = r.games.find((g) => g.id === 'g3').holders.partner.sides.a;
  assert.equal(pos.contracts, 40);
  // 60 张总成本 1880 + 1890 = 3770，卖 20 张结转 1257
  assert.equal(pos.basis, 3770 - 1257);
  assert.equal(r.transfersIn - r.transfersOut + r.realized.partner - r.openBasis.partner, r.balance);
  // 均价 (1830 + 1840) / 60 = 61.17¢，比持有人 58¢ 贵
  const s = stats(r);
  const slip = s.slips.find((x) => x.gameId === 'g3');
  assert.equal(slip.diff.toFixed(2), (3670 / 60 - 58).toFixed(2));
});

test('小数张：34.91 张按百分之一张算，赢了正好回 $34.91', () => {
  const games = [{ id: 'g', team_a: '太阳', team_b: '勇士' }];
  const evs = [
    { id: 1, kind: 'transfer', direction: 'to_owner', amount_cents: 5000, occurred_at: 't1' },
    { id: 2, kind: 'fill', game_id: 'g', holder: 'partner', action: 'buy', side: 'b', contracts: 34.91, price_cents: 85, notional_cents: 2967, fee_cents: 31, occurred_at: 't2' },
    { id: 3, kind: 'fill', game_id: 'g', holder: 'partner', action: 'sell', side: 'b', contracts: 10.5, price_cents: 90, notional_cents: 945, fee_cents: 4, occurred_at: 't3' },
    { id: 4, kind: 'settle', game_id: 'g', winner: 'b', occurred_at: 't4' },
  ];
  const r = compute(evs, games);
  const g = r.games[0];
  assert.equal(r.effects.get(2).partnerDelta, -2998);
  assert.equal(r.effects.get(3).partnerDelta, 941);
  // 剩 24.41 张，赢了回 $24.41
  assert.equal(r.effects.get(4).partnerDelta, 2441);
  assert.equal(g.holders.partner.sides.b.boughtContracts, 34.91);
  assert.equal(g.holders.partner.open, 0);
  assert.equal(r.balance, 5000 - 2998 + 941 + 2441);
  assert.equal(r.transfersIn - r.transfersOut + r.realized.partner - r.openBasis.partner, r.balance);
  assert.equal(estimateFee(34.91, 85), Math.ceil(7 * 3491 * 85 * 15 / 1000000));
});

test('更细的战绩：押中率、比市场准多少、热门冷门、球队、每月和累计曲线', () => {
  const { events, games } = sampleData();
  const r = compute(events, games);
  const x = insights(r, { monthOf: (iso) => iso.slice(0, 7) });
  // 两场已结算，每人每场押一边
  assert.equal(x.picks.length, 4);
  assert.equal(x.accuracy.owner.n, 2);
  assert.equal(x.accuracy.owner.hits, 1);
  assert.equal(x.accuracy.owner.avgPrice, 37.5);      // (40 + 35) / 2
  assert.equal(x.accuracy.owner.edge, 12.5);          // 50% − 37.5%
  assert.equal(x.accuracy.partner.edge, 50 - 41.5);   // (45 + 38) / 2
  // 40¢、45¢ 算五五开；35¢、38¢ 算冷门
  assert.equal(x.buckets.owner.even.n, 1);
  assert.equal(x.buckets.owner.even.pnl, 5832);
  assert.equal(x.buckets.owner.dog.pnl, -2196);
  assert.equal(x.buckets.partner.fav.n, 0);
  // 球队：押湖人赢两人合计 +84.95，押尼克斯赢合计 −37.82
  assert.deepEqual(x.best.map((t) => [t.team, t.pnl, t.n, t.hits]), [['湖人', 5832 + 2663, 2, 2]]);
  assert.deepEqual(x.worst.map((t) => [t.team, t.pnl, t.n, t.hits]), [['尼克斯', -2196 - 1586, 2, 0]]);
  // 每月（示例都在 11 月）和累计曲线
  assert.deepEqual(x.months, [{ month: '2026-11', owner: 3636, partner: 1077 }]);
  const last = x.curve[x.curve.length - 1];
  assert.deepEqual([last.owner, last.partner], [3636, 1077]);
  // 每一边的盈亏加起来等于总盈亏
  assert.equal(x.picks.filter((p) => p.holder === 'owner').reduce((t, p) => t + p.pnl, 0), r.realized.owner);
});

test('提前卖出的盈亏也进曲线，算在卖出的那一边', () => {
  const { events, games } = sampleData();
  const sell = { id: 10, kind: 'fill', occurred_at: '2026-11-03T20:00:00-08:00', game_id: 'g3', holder: 'partner', action: 'sell', side: 'a', contracts: 10, price_cents: 70, fee_cents: 15 };
  const settle = { id: 11, kind: 'settle', occurred_at: '2026-11-03T23:00:00-08:00', game_id: 'g3', winner: 'b' };
  const r = compute([...events, sell, settle], games);
  const x = insights(r, { monthOf: (iso) => iso.slice(0, 7) });
  const p = x.picks.find((q) => q.holder === 'partner' && q.gameId === 'g3');
  assert.equal(p.hit, false);
  // 卖 10 张赚 58，剩下 20 张输掉成本 1253
  assert.equal(p.pnl, 58 - 1253);
  assert.equal(x.curve.length, 1 + r.realizedLog.length);
});
