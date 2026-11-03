// 示例数据：和设计图里的一样。用于「先看看示例」和测试，不会写进数据库。
export const SAMPLE_OWNER_ID = 'demo-owner';
export const SAMPLE_PARTNER_ID = 'demo-partner';

export function sampleData() {
  const ledger = {
    id: 'demo-ledger',
    name: '合买账本',
    owner_id: SAMPLE_OWNER_ID,
    owner_name: '小明',
    partner_id: SAMPLE_PARTNER_ID,
    partner_name: '阿杰',
    invite_code: 'DEMO1234',
    created_at: '2026-11-01T17:00:00-08:00',
  };
  const games = [
    { id: 'g1', ledger_id: ledger.id, league: 'NBA', team_a: '湖人', team_b: '勇士', starts_at: '2026-11-01T19:30:00-08:00', created_at: '2026-11-01T19:01:00-08:00' },
    { id: 'g2', ledger_id: ledger.id, league: 'NBA', team_a: '尼克斯', team_b: '凯尔特人', starts_at: '2026-11-02T19:30:00-08:00', created_at: '2026-11-02T19:04:00-08:00' },
    { id: 'g3', ledger_id: ledger.id, league: 'NBA', team_a: '掘金', team_b: '太阳', starts_at: '2026-11-03T21:00:00-08:00', created_at: '2026-11-03T19:01:00-08:00' },
  ];
  const ev = (id, at, fields, confirm) => ({
    id, ledger_id: ledger.id, occurred_at: at, created_at: at, created_by: SAMPLE_OWNER_ID,
    direction: null, amount_cents: null, method: null, game_id: null, holder: null, action: null, side: null,
    contracts: null, price_cents: null, fee_cents: null, winner: null, voids: null, note: null,
    confirmed_at: confirm ? confirm.at : null, confirmed_via: confirm ? 'wechat' : null, statement_no: confirm ? confirm.no : null,
    ...fields,
  });
  const s1 = { at: '2026-11-01T23:05:00-08:00', no: 1 };
  const s2 = { at: '2026-11-02T22:40:00-08:00', no: 2 };
  const events = [
    ev(1, '2026-11-01T18:30:00-08:00', { kind: 'transfer', direction: 'to_owner', amount_cents: 20000, method: 'Zelle' }, s1),
    ev(2, '2026-11-01T19:02:00-08:00', { kind: 'fill', game_id: 'g1', holder: 'owner', action: 'buy', side: 'a', contracts: 100, price_cents: 40, fee_cents: 168 }),
    ev(3, '2026-11-01T19:20:00-08:00', { kind: 'fill', game_id: 'g1', holder: 'partner', action: 'buy', side: 'a', contracts: 50, price_cents: 45, fee_cents: 87 }, s1),
    ev(4, '2026-11-01T22:40:00-08:00', { kind: 'settle', game_id: 'g1', winner: 'a' }, s1),
    ev(5, '2026-11-02T19:05:00-08:00', { kind: 'fill', game_id: 'g2', holder: 'owner', action: 'buy', side: 'a', contracts: 60, price_cents: 35, fee_cents: 96 }),
    ev(6, '2026-11-02T19:30:00-08:00', { kind: 'fill', game_id: 'g2', holder: 'partner', action: 'buy', side: 'a', contracts: 40, price_cents: 38, fee_cents: 66 }, s2),
    ev(7, '2026-11-02T22:15:00-08:00', { kind: 'settle', game_id: 'g2', winner: 'b' }, s2),
    ev(8, '2026-11-03T19:02:00-08:00', { kind: 'fill', game_id: 'g3', holder: 'owner', action: 'buy', side: 'a', contracts: 80, price_cents: 58, fee_cents: 137 }),
    ev(9, '2026-11-03T19:41:00-08:00', { kind: 'fill', game_id: 'g3', holder: 'partner', action: 'buy', side: 'a', contracts: 30, price_cents: 61, fee_cents: 50 }),
  ];
  const statements = [
    { id: 1, ledger_id: ledger.id, no: 1, balance_cents: 22663, upto_event_id: 4, created_at: '2026-11-01T23:00:00-08:00', confirmed_at: s1.at, confirmed_via: 'wechat' },
    { id: 2, ledger_id: ledger.id, no: 2, balance_cents: 21077, upto_event_id: 7, created_at: '2026-11-02T22:30:00-08:00', confirmed_at: s2.at, confirmed_via: 'wechat' },
  ];
  return { ledger, games, events, statements };
}
