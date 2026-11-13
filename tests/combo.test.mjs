import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, statement, toCSV, insights, gameTitle, sideName, settlementLabel } from '../js/ledger.js';
import { statementModel, statementText } from '../js/statement-image.js';

const game = { id: 'combo', market_kind: 'combo', team_a: 'YES', team_b: 'NO',
  title: '勇士赢 ＋ Lakers vs Suns · Total points over 220.5 · YES' };
const ev = (id, fields) => ({ id, occurred_at: '2026-11-04T01:00:00Z', game_id: game.id, ...fields });
const events = [
  ev(1, { kind: 'transfer', direction: 'to_owner', amount_cents: 10000 }),
  ev(2, { kind: 'fill', holder: 'partner', action: 'buy', side: 'a', contracts: 10.25, notional_cents: 328, fee_cents: 12 }),
  ev(3, { kind: 'fill', holder: 'owner', action: 'buy', side: 'b', contracts: 5.33, notional_cents: 200, fee_cents: 5 }),
  ev(4, { kind: 'fill', holder: 'partner', action: 'sell', side: 'a', contracts: 2.25, notional_cents: 113, fee_cents: 3 }),
];

test('combo 小数张、部分卖出、YES/NO 非二元赔付，余额与对账拆解一致', () => {
  const settle = ev(5, { kind: 'settle', winner: null, a_payout_micros: 625000 });
  const all = [...events, settle];
  const r = compute(all, [game]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.balance, 10270); // 10000 - 340 + 110 + 500
  assert.equal(r.games[0].holders.partner.payout, 500);
  assert.equal(r.games[0].holders.owner.payout, 200); // 5.33 × $0.375 四舍五入到分
  assert.deepEqual(r.realized, { owner: -5, partner: 270 });
  assert.deepEqual(r.openBasis, { owner: 0, partner: 0 });
  const st = statement(r, all, null, [game]);
  assert.equal(st.transfersNet + st.realized - st.openBasis, st.balance);
  assert.equal(insights(r).accuracy.partner.n, 0, '非二元赔付不误报为输掉串关');
  assert.equal(insights(r).months[0].partner, 270, '盈亏走势仍包括实际收入');
  assert.match(settlementLabel(game, settle), /0.6250/);
});

test('串关对账单与 CSV 展示完整内容及方向，撤销结算恢复剩余持仓', () => {
  const settle = ev(5, { kind: 'settle', winner: 'a', a_payout_micros: 1000000 });
  const all = [...events, settle];
  const r = compute(all, [game]);
  const model = statementModel(statement(r, all, null, [game]), [game]);
  const text = statementText(model);
  assert.ok(text.includes(game.title));
  assert.match(text, /全部命中（YES）/);
  assert.ok(!text.includes('YES赢'));
  const csv = toCSV(all, [game], { owner: '我', partner: '朋友' });
  assert.ok(csv.includes(game.title));
  assert.ok(csv.includes(sideName(game, 'b')));
  assert.equal(gameTitle(game), 'Combo · ' + game.title);
  assert.equal(insights(r).best.length, 0, '串关不归入某一支球队');
  const restored = compute([...all, ev(6, { kind: 'void', voids: 5 })], [game]);
  assert.equal(restored.games[0].holders.partner.open, 8);
  assert.equal(restored.balance, 9770);
});

test('两人分持小数张时，实际赔付的分币尾差不重复入账', () => {
  const r = compute([
    ev(1, { kind: 'fill', holder: 'owner', action: 'buy', side: 'a', contracts: 0.01, notional_cents: 0, fee_cents: 0 }),
    ev(2, { kind: 'fill', holder: 'partner', action: 'buy', side: 'a', contracts: 0.01, notional_cents: 0, fee_cents: 0 }),
    ev(3, { kind: 'settle', winner: null, a_payout_micros: 500000 }),
  ], [game]);
  const h = r.games[0].holders;
  assert.equal(h.owner.payout + h.partner.payout, 1, '账户 0.02 张 × $0.50 = 1 分');
  assert.equal(r.balance, 1);
});
