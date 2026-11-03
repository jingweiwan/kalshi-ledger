-- 权限测试：先运行 tests/supabase_stub.sql 和 supabase/schema.sql，再运行本文件（不要在 Supabase 上运行）
-- 身份：1111 = 持有人，2222 = 朋友，3333 = 陌生人
\set ON_ERROR_STOP 1
\set QUIET 1

create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); end $$;

-- 期望失败的语句
create or replace function pg_temp.must_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice 'PASS (被拒绝) %: %', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % 应该被拒绝但成功了', label;
end $$;
grant execute on function pg_temp.must_fail(text, text) to authenticated;
grant execute on function pg_temp.as_user(text) to authenticated;

set role authenticated;

-- 持有人建账本
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select id as ledger_id, invite_code from public.create_ledger('小明') \gset
select pg_temp.must_fail('select public.create_ledger(''再建一个'')', '同一个人建两个账本');

-- 陌生人什么都看不到
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin if (select count(*) from public.ledgers) <> 0 then raise exception 'FAIL: 陌生人看到了账本'; end if; raise notice 'PASS 陌生人看不到账本'; end $$;
select pg_temp.must_fail('select public.join_ledger(''WRONGCODE'', ''路人'')', '错误邀请码');

-- 朋友加入
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_ledger(lower(:'invite_code'), '阿杰') is not null as joined;

-- 陌生人不能再用同一个邀请码加入
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.must_fail(format('select public.join_ledger(%L, %L)', :'invite_code', '路人'), '账本已满还能加入');

-- 持有人记账
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into public.games (ledger_id, team_a, team_b) values (:'ledger_id', '湖人', '勇士') returning id as g1 \gset
insert into public.events (ledger_id, kind, direction, amount_cents, method) values (:'ledger_id', 'transfer', 'to_owner', 20000, 'Zelle');
insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, price_cents, fee_cents)
  values (:'ledger_id', 'fill', :'g1', 'owner', 'buy', 'a', 100, 40, 168);
insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, price_cents, fee_cents)
  values (:'ledger_id', 'fill', :'g1', 'partner', 'buy', 'a', 50, 45, 87) returning id as e_partner_fill \gset
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, direction, amount_cents, confirmed_at) values (%L, ''transfer'', ''to_owner'', 1, now())', :'ledger_id'), '持有人自己写确认时间');
select pg_temp.must_fail(format('update public.events set amount_cents = 1 where ledger_id = %L', :'ledger_id'), '修改记录');
select pg_temp.must_fail(format('delete from public.events where ledger_id = %L', :'ledger_id'), '删除记录');
select pg_temp.must_fail(format('update public.ledgers set partner_name = ''x'' where id = %L', :'ledger_id'), '直接改账本');
select pg_temp.must_fail(format('select public.confirm_events(%L, 999)', :'ledger_id'), '持有人替朋友在 App 里确认');
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, price_cents, fee_cents) values (%L, ''fill'', %L, ''owner'', ''buy'', ''a'', 1, 100, 0)', :'ledger_id', :'g1'), '价格 100¢');
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id) values (%L, ''fill'', %L)', :'ledger_id', :'g1'), '成交缺字段');
-- 按 Cost / Fee / Max payout 记：只有成交额，没有整数单价
insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, notional_cents, fee_cents)
  values (:'ledger_id', 'fill', :'g1', 'owner', 'buy', 'a', 30, 1840, 50);
\echo PASS 按金额记的成交（均价 61.3¢）可以保存
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, notional_cents, fee_cents) values (%L, ''fill'', %L, ''owner'', ''buy'', ''a'', 30, 3001, 0)', :'ledger_id', :'g1'), '均价超过每张 $1');
-- 小数张
insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, notional_cents, fee_cents)
  values (:'ledger_id', 'fill', :'g1', 'owner', 'buy', 'a', 34.91, 2967, 31);
\echo PASS 小数张（34.91 张）可以保存
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, fee_cents) values (%L, ''fill'', %L, ''owner'', ''buy'', ''a'', 30, 0)', :'ledger_id', :'g1'), '没有单价也没有成交额');

-- 朋友只能看，不能记
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin if (select count(*) from public.events) <> 5 then raise exception 'FAIL: 朋友看到的记录数不对'; end if; raise notice 'PASS 朋友能看到 5 条记录'; end $$;
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, direction, amount_cents) values (%L, ''transfer'', ''to_partner'', 100)', :'ledger_id'), '朋友记账');
select pg_temp.must_fail(format('insert into public.games (ledger_id, team_a, team_b) values (%L, ''a'', ''b'')', :'ledger_id'), '朋友建比赛');
select pg_temp.must_fail(format('update public.events set confirmed_at = now() where ledger_id = %L', :'ledger_id'), '朋友直接改确认字段');
select public.confirm_events(:'ledger_id', :e_partner_fill) as confirmed_count;
do $$ begin
  if (select count(*) from public.events where confirmed_at is not null) <> 2 then raise exception 'FAIL: 应该确认 2 条（转账 + 朋友的买入）'; end if;
  if exists (select 1 from public.events where holder = 'owner' and confirmed_at is not null) then raise exception 'FAIL: 持有人自己的单不该被确认'; end if;
  raise notice 'PASS 朋友确认了 2 条，持有人自己的单不需要确认';
end $$;

-- 陌生人不能确认、不能看
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.must_fail(format('select public.confirm_events(%L, 999)', :'ledger_id'), '陌生人确认');
do $$ begin if (select count(*) from public.events) <> 0 then raise exception 'FAIL: 陌生人看到了记录'; end if; raise notice 'PASS 陌生人看不到记录'; end $$;

-- 结算、结算后不能再记、撤销、对账单
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into public.events (ledger_id, kind, game_id, winner) values (:'ledger_id', 'settle', :'g1', 'a') returning id as e_settle \gset
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, winner) values (%L, ''settle'', %L, ''b'')', :'ledger_id', :'g1'), '重复结算');
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, price_cents, fee_cents) values (%L, ''fill'', %L, ''owner'', ''buy'', ''a'', 1, 50, 0)', :'ledger_id', :'g1'), '结算后再成交');
insert into public.events (ledger_id, kind, voids, note) values (:'ledger_id', 'void', :e_settle, '结果点错了');
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, voids) values (%L, ''void'', %s)', :'ledger_id', :e_settle), '重复撤销');
insert into public.events (ledger_id, kind, game_id, winner) values (:'ledger_id', 'settle', :'g1', 'b');
select no, upto_event_id from public.create_statement(:'ledger_id', 17663, (select max(id) from public.events)) \gset
\echo 对账单编号 :no 截至 :upto_event_id
select pg_temp.must_fail(format('insert into public.statements (ledger_id, no, balance_cents, upto_event_id) values (%L, 99, 0, 1)', :'ledger_id'), '直接写对账单');
-- 持有人记下朋友在微信里确认了
select confirmed_via from public.confirm_statement((select id from public.statements where no = 1));
select pg_temp.must_fail('select public.confirm_statement((select id from public.statements where no = 1))', '重复确认对账单');
do $$ begin
  if exists (select 1 from public.events where needs_confirm and confirmed_at is null) then raise exception 'FAIL: 还有没确认的'; end if;
  if (select count(*) from public.events where confirmed_via = 'wechat' and statement_no = 1) <> 3 then raise exception 'FAIL: 微信确认条数不对'; end if;
  raise notice 'PASS 对账单确认后，剩下 3 条标记为微信确认 #1';
end $$;

-- 朋友不能生成对账单
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.must_fail(format('select public.create_statement(%L, 0, 1)', :'ledger_id'), '朋友生成对账单');

-- anon（没登录）什么都碰不到
reset role; set role anon;
select pg_temp.must_fail('select * from public.events', '未登录读记录');
select pg_temp.must_fail('select public.create_ledger(''x'')', '未登录建账本');
reset role;
-- ───────── Kalshi 同步 ─────────
grant execute on function pg_temp.must_fail(text, text) to anon;
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_kalshi_sync(:'ledger_id', encode(sha256(convert_to('tok-123', 'UTF8')), 'hex'), '2026-11-01');
\echo PASS 持有人设置同步令牌
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.must_fail(format('select public.set_kalshi_sync(%L, %L, ''2026-11-01'')', :'ledger_id', repeat('a', 64)), '朋友设置同步令牌');
select pg_temp.must_fail('select token_hash from public.kalshi_sync', '登录用户读令牌哈希');

reset role; set role anon;
select pg_temp.must_fail('select public.kalshi_sync_info(''wrong'')', '错误令牌读同步信息');
select pg_temp.must_fail('select * from public.kalshi_fills', '没登录读 Kalshi 成交');
select pg_temp.must_fail('select public.assign_kalshi_fill(gen_random_uuid(), ''x'', ''owner'')', '没登录分配');
do $$ begin
  if (public.kalshi_sync_info('tok-123')->>'since') <> '2026-11-01' then raise exception 'FAIL: since 不对'; end if;
  raise notice 'PASS 同步程序用令牌拿到起始日期';
end $$;
select public.kalshi_ingest('tok-123', '[
  {"id":"K1","event_ticker":"KXNBAGAME-26NOV02PHXGSW","market_ticker":"KXNBAGAME-26NOV02PHXGSW-GSW","team_a":"太阳","team_b":"勇士","starts_at":"2026-11-03T03:00:00Z","side":"b","action":"buy","contracts":34.91,"price_cents":85,"notional_cents":2967,"fee_cents":31,"fee_dollars":"0.311600","occurred_at":"2026-11-03T02:47:09Z"},
  {"id":"K2","event_ticker":"KXNBAGAME-26NOV02PHXGSW","market_ticker":"KXNBAGAME-26NOV02PHXGSW-GSW","team_a":"太阳","team_b":"勇士","starts_at":"2026-11-03T03:00:00Z","side":"b","action":"buy","contracts":10,"price_cents":80,"notional_cents":800,"fee_cents":12,"fee_dollars":"0.112000","occurred_at":"2026-11-03T02:50:00Z"}
]'::jsonb, '[]'::jsonb, 'test') ->> 'imported' as imported \gset
do $$ begin if current_setting('vars.dummy', true) is null then null; end if; end $$;
\echo 导入条数 :imported
select (public.kalshi_ingest('tok-123', '[{"id":"K1","event_ticker":"KXNBAGAME-26NOV02PHXGSW","market_ticker":"x","team_a":"太阳","team_b":"勇士","side":"b","action":"buy","contracts":34.91,"notional_cents":2967,"fee_cents":31,"occurred_at":"2026-11-03T02:47:09Z"}]'::jsonb, '[]'::jsonb) ->> 'imported') as reimported \gset
\echo 重复导入条数 :reimported
select pg_temp.must_fail('select public.kalshi_ingest(''wrong'', ''[]''::jsonb, ''[]''::jsonb)', '错误令牌写入');

reset role; set role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin if (select count(*) from public.kalshi_fills) <> 0 then raise exception 'FAIL: 陌生人看到了 Kalshi 成交'; end if; raise notice 'PASS 陌生人看不到 Kalshi 成交'; end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin if (select count(*) from public.kalshi_fills) <> 2 then raise exception 'FAIL: 朋友应该能看到 2 笔待分配'; end if; raise notice 'PASS 朋友能看到待分配的 Kalshi 成交'; end $$;
select pg_temp.must_fail(format('select public.assign_kalshi_fill(%L, ''K1'', ''partner'')', :'ledger_id'), '朋友自己分配');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select id as k1_event from public.assign_kalshi_fill(:'ledger_id', 'K1', 'partner') \gset
do $$ begin
  if not exists (select 1 from public.games where kalshi_event_ticker = 'KXNBAGAME-26NOV02PHXGSW' and team_a = '太阳' and team_b = '勇士') then raise exception 'FAIL: 没有自动建比赛'; end if;
  if not exists (select 1 from public.events where kalshi_fill_id = 'K1' and holder = 'partner' and contracts = 34.91 and notional_cents = 2967 and fee_cents = 31) then raise exception 'FAIL: 分配后的记录不对'; end if;
  if (select status from public.kalshi_fills where id = 'K1') <> 'assigned' then raise exception 'FAIL: 状态没变'; end if;
  raise notice 'PASS 分配给朋友：自动建比赛、生成成交记录';
end $$;
select pg_temp.must_fail(format('select public.assign_kalshi_fill(%L, ''K1'', ''owner'')', :'ledger_id'), '重复分配');
select pg_temp.must_fail(format('select public.ignore_kalshi_fill(%L, ''K1'', true)', :'ledger_id'), '忽略已分配的');
-- 分错了：撤销后可以重新分
insert into public.events (ledger_id, kind, voids, note) values (:'ledger_id', 'void', :k1_event, '分错人了');
select id as k1_event2 from public.assign_kalshi_fill(:'ledger_id', 'K1', 'owner') \gset
\echo PASS 撤销后重新分配
-- 出结果，但 K2 还没分配：不结算
reset role; set role anon;
select (public.kalshi_ingest('tok-123', '[]'::jsonb, '[{"event_ticker":"KXNBAGAME-26NOV02PHXGSW","winner":"b","decided_at":"2026-11-03T05:55:27Z"}]'::jsonb) ->> 'settled') as settled1 \gset
\echo 还有待分配时结算场数 :settled1
reset role; set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.ignore_kalshi_fill(:'ledger_id', 'K2', true);
do $$ begin
  if not exists (select 1 from public.events e join public.games g on g.id = e.game_id
                 where e.kind = 'settle' and e.winner = 'b' and g.kalshi_event_ticker = 'KXNBAGAME-26NOV02PHXGSW' and e.note = 'Kalshi 自动结算') then
    raise exception 'FAIL: 剩下的忽略后应该自动结算';
  end if;
  raise notice 'PASS 最后一笔处理完后自动结算';
end $$;
select public.ignore_kalshi_fill(:'ledger_id', 'K2', false);
select pg_temp.must_fail(format('select public.assign_kalshi_fill(%L, ''K2'', ''owner'')', :'ledger_id'), '比赛结算后再分配（要先撤销结算）');
reset role;
do $$ begin
  if (select last_imported from public.kalshi_sync) is null then raise exception 'FAIL: 没记录同步时间'; end if;
  raise notice 'PASS 记录了上次同步';
end $$;
\echo ALL RLS TESTS PASSED
