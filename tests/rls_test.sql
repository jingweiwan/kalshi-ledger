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
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, notional_cents, fee_cents) values (%L, ''fill'', %L, ''owner'', ''buy'', ''a'', 30, 3000, 0)', :'ledger_id', :'g1'), '均价 100¢');
select pg_temp.must_fail(format('insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, fee_cents) values (%L, ''fill'', %L, ''owner'', ''buy'', ''a'', 30, 0)', :'ledger_id', :'g1'), '没有单价也没有成交额');

-- 朋友只能看，不能记
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin if (select count(*) from public.events) <> 4 then raise exception 'FAIL: 朋友看到的记录数不对'; end if; raise notice 'PASS 朋友能看到 4 条记录'; end $$;
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
\echo ALL RLS TESTS PASSED
