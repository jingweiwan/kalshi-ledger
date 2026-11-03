import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micros, units, parseTickers, mapFills, resultOf, eventOf } from '../sync/kalshi-map.mjs';
import { run } from '../sync/kalshi-sync.mjs';

// 字段和 GET /portfolio/fills 返回的一样，数字是编的
const fill = (o) => ({
  fill_id: o.id, trade_id: o.id, order_id: 'o-' + o.id, ticker: o.ticker, market_ticker: o.ticker,
  outcome_side: o.outcome, book_side: o.outcome === 'yes' ? 'bid' : 'ask',
  action: o.action, side: o.side,
  count_fp: o.count, yes_price_dollars: o.yes, no_price_dollars: (1 - Number(o.yes)).toFixed(4),
  fee_cost: o.fee, is_taker: true, created_time: o.t, ts: Math.floor(Date.parse(o.t) / 1000),
});
const GSW = 'KXNBAGAME-26NOV02PHXGSW-GSW';
const PHX = 'KXNBAGAME-26NOV02PHXGSW-PHX';

test('金额和张数按字符串精确换算', () => {
  assert.equal(micros('0.8500'), 850000);
  assert.equal(micros('0.311600'), 311600);
  assert.equal(micros('1.7233'), 1723300);
  assert.equal(units('34.91'), 3491);
  assert.equal(units('200.00'), 20000);
  assert.equal(units('2.5'), 250);
  assert.throws(() => units('abc'));
});

test('从 ticker 认出两队和这个市场问的是哪一队', () => {
  assert.deepEqual(parseTickers('KXNBAGAME-26NOV02PHXGSW', GSW), { a: 'PHX', b: 'GSW', code: 'GSW', mySide: 'b' });
  assert.deepEqual(parseTickers('KXNBAGAME-26NOV04ATLWAS', 'KXNBAGAME-26NOV04ATLWAS-ATL'), { a: 'ATL', b: 'WAS', code: 'ATL', mySide: 'a' });
  assert.equal(eventOf(GSW), 'KXNBAGAME-26NOV02PHXGSW');
});

test('买「勇士赢」YES：勇士赢那边买入，成交额和手续费换成分', () => {
  const { fills } = mapFills([fill({ id: 'f1', ticker: GSW, outcome: 'yes', action: 'buy', side: 'yes', count: '34.91', yes: '0.8500', fee: '0.311600', t: '2026-11-03T05:47:09Z' })]);
  assert.equal(fills.length, 1);
  assert.deepEqual(
    (({ id, event_ticker, team_a, team_b, side, action, contracts, price_cents, notional_cents, fee_cents }) => ({ id, event_ticker, team_a, team_b, side, action, contracts, price_cents, notional_cents, fee_cents }))(fills[0]),
    { id: 'f1', event_ticker: 'KXNBAGAME-26NOV02PHXGSW', team_a: '太阳', team_b: '勇士', side: 'b', action: 'buy', contracts: 34.91, price_cents: 85, notional_cents: 2967, fee_cents: 31 },
  );
});

test('买「勇士赢」NO 等于押太阳赢：太阳那边买入，价格用 NO 的价格', () => {
  const { fills } = mapFills([fill({ id: 'f1', ticker: GSW, outcome: 'no', action: 'buy', side: 'no', count: '10.00', yes: '0.8500', fee: '0.07', t: '2026-11-03T05:00:00Z' })]);
  assert.equal(fills[0].side, 'a');
  assert.equal(fills[0].price_cents, 15);
  assert.equal(fills[0].notional_cents, 150);
});

test('持有 NO 时再成交 YES 方向：先卖掉 NO，多出来的才是买 YES，手续费按张数分', () => {
  const { fills } = mapFills([
    fill({ id: 'f1', ticker: GSW, outcome: 'no', action: 'buy', side: 'no', count: '10.00', yes: '0.6000', fee: '0.17', t: '2026-11-03T01:00:00Z' }),
    fill({ id: 'f2', ticker: GSW, outcome: 'yes', action: 'buy', side: 'yes', count: '15.00', yes: '0.7000', fee: '0.30', t: '2026-11-03T02:00:00Z' }),
  ]);
  assert.equal(fills.length, 3);
  const [, sell, buy] = fills;
  assert.deepEqual([sell.id, sell.side, sell.action, sell.contracts, sell.price_cents, sell.notional_cents, sell.fee_cents], ['f2', 'a', 'sell', 10, 30, 300, 20]);
  assert.deepEqual([buy.id, buy.side, buy.action, buy.contracts, buy.price_cents, buy.notional_cents, buy.fee_cents], ['f2#2', 'b', 'buy', 5, 70, 350, 10]);
});

test('只有旧字段 action/side 时也能认方向；卖 YES = 减少这一队的仓位', () => {
  const f1 = fill({ id: 'f1', ticker: PHX, outcome: 'yes', action: 'buy', side: 'yes', count: '20.00', yes: '0.4000', fee: '0.34', t: '2026-11-03T01:00:00Z' });
  const f2 = fill({ id: 'f2', ticker: PHX, outcome: 'no', action: 'sell', side: 'yes', count: '5.00', yes: '0.5500', fee: '0.09', t: '2026-11-03T02:00:00Z' });
  delete f2.outcome_side;
  const { fills } = mapFills([f1, f2]);
  assert.deepEqual([fills[1].side, fills[1].action, fills[1].price_cents, fills[1].notional_cents], ['a', 'sell', 55, 275]);
});

test('起始日期之前的成交不导入，但会用来算仓位；别的系列跳过', () => {
  const { fills } = mapFills([
    fill({ id: 'old', ticker: GSW, outcome: 'yes', action: 'buy', side: 'yes', count: '8.00', yes: '0.5000', fee: '0.14', t: '2026-10-31T10:00:00Z' }),
    fill({ id: 'new', ticker: GSW, outcome: 'no', action: 'sell', side: 'yes', count: '3.00', yes: '0.6000', fee: '0.05', t: '2026-11-02T10:00:00Z' }),
    fill({ id: 'oil', ticker: 'KXBRENTD-26NOV03-T80', outcome: 'yes', action: 'buy', side: 'yes', count: '5.00', yes: '0.3000', fee: '0.07', t: '2026-11-02T10:00:00Z' }),
  ], { sinceMs: Date.parse('2026-11-01T00:00:00+08:00') });
  assert.equal(fills.length, 1);
  assert.deepEqual([fills[0].id, fills[0].side, fills[0].action], ['new', 'b', 'sell']);
});

test('比赛结果：「太阳赢」结果 no、「勇士赢」结果 yes → 勇士那边赢', () => {
  const r = resultOf('KXNBAGAME-26NOV02PHXGSW', [
    { ticker: PHX, status: 'finalized', result: 'no', settlement_ts: '2026-11-03T05:55:27Z' },
    { ticker: GSW, status: 'finalized', result: 'yes', settlement_ts: '2026-11-03T05:55:27Z' },
  ]);
  assert.deepEqual(r, { event_ticker: 'KXNBAGAME-26NOV02PHXGSW', winner: 'b', decided_at: '2026-11-03T05:55:27Z' });
  assert.equal(resultOf('KXNBAGAME-26NOV02PHXGSW', [{ ticker: GSW, status: 'active', result: '' }]), null);
});

test('同步流程：读起始日期 → 拉成交 → 查结果 → 写入账本，日志只有条数', async () => {
  const calls = [];
  const get = async (path, q) => {
    calls.push(['get', path, q]);
    if (path === '/portfolio/fills') {
      return q.cursor
        ? { fills: [fill({ id: 'f2', ticker: 'KXBRENTD-26NOV03-T80', outcome: 'yes', action: 'buy', side: 'yes', count: '1.00', yes: '0.3000', fee: '0.02', t: '2026-11-03T03:00:00Z' })], cursor: '' }
        : { fills: [fill({ id: 'f1', ticker: GSW, outcome: 'yes', action: 'buy', side: 'yes', count: '10.00', yes: '0.8000', fee: '0.12', t: '2026-11-03T02:00:00Z' })], cursor: 'next' };
    }
    if (path === '/markets') {
      return q.event_ticker === 'KXNBAGAME-26NOV02PHXGSW'
        ? { markets: [{ ticker: GSW, status: 'finalized', result: 'yes', settlement_ts: '2026-11-03T05:55:27Z' }] }
        : { markets: [{ ticker: 'KXNBAGAME-26NOV05BOSNYK-BOS', status: 'active', result: '' }] };
    }
    throw new Error('unexpected ' + path);
  };
  let ingested;
  const call = async (name, args) => {
    calls.push(['rpc', name]);
    if (name === 'kalshi_sync_info') return { since: '2026-11-01', open_events: ['KXNBAGAME-26NOV05BOSNYK'] };
    ingested = args;
    return { imported: args.p_fills.length, settled: 0 };
  };
  const logs = [];
  const out = await run({ get, call, token: 't', log: (m) => logs.push(m) });
  assert.equal(calls.filter((c) => c[1] === '/portfolio/fills').length, 2, '翻页');
  assert.equal(calls.find((c) => c[1] === '/portfolio/fills')[2].min_ts, Math.floor(Date.parse('2026-11-01T00:00:00+08:00') / 1000) - 7 * 86400);
  assert.deepEqual(ingested.p_fills.map((f) => f.id), ['f1']);
  assert.equal(ingested.p_fills[0].order_id, 'o-f1');
  assert.deepEqual(ingested.p_results, [{ event_ticker: 'KXNBAGAME-26NOV02PHXGSW', winner: 'b', decided_at: '2026-11-03T05:55:27Z' }]);
  assert.equal(out.imported, 1);
  assert.equal(logs.length, 1);
  assert.ok(!/KXNBA|0\.8|勇士/.test(logs[0]), '日志里没有交易内容');
});
