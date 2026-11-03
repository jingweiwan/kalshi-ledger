import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, stats, statement, estimateFee, toCSV, needsConfirm } from '../js/ledger.js';
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
  const st = statement(r, events, statements[statements.length - 1]);
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
  assert.match(lines[9], /阿杰.*掘金 vs 太阳.*掘金赢,30,61,0.50,18.80,-18.80,191.97,待确认/);
});
