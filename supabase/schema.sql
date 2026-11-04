-- 合买账本 · 数据库结构
-- 用法：Supabase 后台 → SQL Editor → New query → 整段粘贴 → Run。只需要运行一次。
--
-- 权限设计：
-- - 只有账本的两个人能看到这个账本的数据。
-- - 只有 Kalshi 账户持有人（owner）能记账；朋友（partner）只能看和确认。
-- - 记录只加不改：没有人能修改或删除记录，记错了就加一条「撤销」。

-- ───────────── 表 ─────────────

create table if not exists public.ledgers (
  id uuid primary key default gen_random_uuid(),
  name text not null default '合买账本',
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_name text not null check (char_length(owner_name) between 1 and 20),
  partner_id uuid references auth.users(id) on delete set null,
  partner_name text check (partner_name is null or char_length(partner_name) between 1 and 20),
  invite_code text not null unique,
  created_at timestamptz not null default now(),
  check (partner_id is null or partner_id <> owner_id)
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  league text not null default 'NBA' check (char_length(league) <= 20),
  team_a text not null check (char_length(team_a) between 1 and 20),
  team_b text not null check (char_length(team_b) between 1 and 20),
  starts_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id),
  unique (ledger_id, id)
);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  kind text not null check (kind in ('transfer', 'fill', 'settle', 'void')),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id),
  -- 转账
  direction text check (direction in ('to_owner', 'to_partner')),
  amount_cents integer check (amount_cents > 0),
  method text check (char_length(method) <= 20),
  -- 成交
  game_id uuid,
  holder text check (holder in ('owner', 'partner')),
  action text check (action in ('buy', 'sell')),
  side text check (side in ('a', 'b')),
  contracts numeric(12, 2) check (contracts > 0),              -- 张数，最多两位小数（Kalshi 会成交 34.91 张这种）
  price_cents integer check (price_cents between 1 and 99),   -- 按单价记时的单价；按金额记、均价不是整数时为空
  notional_cents integer check (notional_cents >= 0),           -- 成交额（不含手续费）= 张数 × 均价，四舍五入到分
  fee_cents integer check (fee_cents >= 0),
  -- 结算
  winner text check (winner in ('a', 'b')),
  -- 撤销
  voids bigint references public.events(id),
  note text check (char_length(note) <= 200),
  -- 确认
  needs_confirm boolean generated always as (kind <> 'fill' or holder = 'partner') stored,
  confirmed_at timestamptz,
  confirmed_via text check (confirmed_via in ('app', 'wechat')),
  statement_no integer,
  foreign key (ledger_id, game_id) references public.games (ledger_id, id),
  constraint transfer_fields check (kind <> 'transfer' or (direction is not null and amount_cents is not null)),
  constraint fill_fields check (kind <> 'fill' or (game_id is not null and holder is not null and action is not null
    and side is not null and contracts is not null and fee_cents is not null
    and (price_cents is not null or notional_cents is not null))),
  constraint fill_notional check (notional_cents is null or contracts is null or notional_cents <= ceil(contracts * 100)),
  constraint settle_fields check (kind <> 'settle' or (game_id is not null and winner is not null)),
  constraint void_fields check (kind <> 'void' or voids is not null)
);
create index if not exists events_ledger_idx on public.events (ledger_id, id);

-- 升级：之前运行过旧版本的，再运行一次这个文件就会补上「成交额」这一列
alter table public.events add column if not exists notional_cents integer check (notional_cents > 0);
alter table public.events drop constraint if exists fill_fields;
alter table public.events add constraint fill_fields check (kind <> 'fill' or (game_id is not null and holder is not null
  and action is not null and side is not null and contracts is not null and fee_cents is not null
  and (price_cents is not null or notional_cents is not null)));
alter table public.events drop constraint if exists fill_notional;
-- 升级：张数支持两位小数
alter table public.events alter column contracts type numeric(12, 2);
alter table public.events drop constraint if exists events_notional_cents_check;
alter table public.events add constraint events_notional_cents_check check (notional_cents >= 0);
alter table public.events add constraint fill_notional check (notional_cents is null or contracts is null
  or notional_cents <= ceil(contracts * 100));
-- 升级：和 Kalshi 同步的成交、比赛对上号
alter table public.events add column if not exists kalshi_fill_id text;
create index if not exists events_kalshi_fill_idx on public.events (ledger_id, kalshi_fill_id) where kalshi_fill_id is not null;
alter table public.games add column if not exists kalshi_event_ticker text;
create unique index if not exists games_kalshi_event_uidx on public.games (ledger_id, kalshi_event_ticker)
  where kalshi_event_ticker is not null;

create table if not exists public.statements (
  id bigint generated always as identity primary key,
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  no integer not null,
  balance_cents integer not null,
  upto_event_id bigint not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_via text check (confirmed_via in ('app', 'wechat')),
  unique (ledger_id, no)
);

-- ───────────── 汇率 ─────────────
-- 约定汇率：你们俩约好按固定汇率算人民币时填（1 美元 = ? 元），空着就用自动汇率
alter table public.ledgers add column if not exists fx_rate numeric(10, 4) check (fx_rate is null or fx_rate > 0);
-- 自动汇率：同步程序每小时更新
create table if not exists public.fx_rates (
  pair text primary key,                    -- 'USDCNY'
  rate numeric(12, 6) not null check (rate > 0),
  source text,
  updated_at timestamptz not null default now()
);

-- ───────────── Kalshi 同步 ─────────────
-- 同步程序（GitHub Actions，每小时一次）把 Kalshi 账户里的 NBA 比赛成交写进 kalshi_fills（待分配），
-- 持有人在账本里点「我的 / 朋友的」后变成正式记录。同步程序只拿一个「同步令牌」，
-- 只能调用 kalshi_sync_info / kalshi_ingest 两个函数，别的数据碰不到。

create table if not exists public.kalshi_sync (
  ledger_id uuid primary key references public.ledgers(id) on delete cascade,
  token_hash text not null unique,          -- 同步令牌的 SHA-256（令牌本身不存）
  since date not null,                      -- 从哪天的成交开始导入
  last_run_at timestamptz,
  last_imported integer,
  last_message text
);

create table if not exists public.kalshi_fills (
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  id text not null,                         -- Kalshi fill_id；一笔里既平仓又开仓时拆成两段，第二段加 #2
  order_id text,                            -- Kalshi 订单号：同一个订单分几次成交时，账本里合成一行
  event_ticker text not null,
  market_ticker text not null,
  team_a text not null,
  team_b text not null,
  starts_at timestamptz,
  side text not null check (side in ('a', 'b')),
  action text not null check (action in ('buy', 'sell')),
  contracts numeric(12, 2) not null check (contracts > 0),
  price_cents integer check (price_cents between 1 and 99),
  notional_cents integer not null check (notional_cents >= 0),
  fee_cents integer not null check (fee_cents >= 0),
  fee_dollars text,                         -- Kalshi 原始手续费（精确到 0.0001）
  occurred_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'assigned', 'ignored')),
  event_id bigint references public.events(id),
  synced_at timestamptz not null default now(),
  primary key (ledger_id, id)
);

alter table public.kalshi_fills add column if not exists order_id text;

create table if not exists public.kalshi_results (
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  event_ticker text not null,
  winner text not null check (winner in ('a', 'b')),
  decided_at timestamptz not null default now(),
  primary key (ledger_id, event_ticker)
);

-- ───────────── 辅助函数 ─────────────

-- 当前登录的人在这个账本里是什么身份：'owner' / 'partner' / null
create or replace function public.ledger_role(p_ledger uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when owner_id = auth.uid() then 'owner'
              when partner_id = auth.uid() then 'partner' end
  from public.ledgers where id = p_ledger
$$;

-- 新记录的检查：撤销只能撤本账本的、没撤过的记录；结算过的比赛不能再记成交或结算
create or replace function public.check_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t public.events;
begin
  if new.kind = 'void' then
    select * into t from public.events where id = new.voids;
    if t.id is null or t.ledger_id <> new.ledger_id or t.kind = 'void' then
      raise exception '只能撤销本账本里的记录';
    end if;
    if exists (select 1 from public.events where kind = 'void' and voids = new.voids) then
      raise exception '这条已经撤销过了';
    end if;
  end if;
  if new.kind in ('fill', 'settle') and exists (
    select 1 from public.events s
    where s.ledger_id = new.ledger_id and s.game_id = new.game_id and s.kind = 'settle'
      and not exists (select 1 from public.events v where v.kind = 'void' and v.voids = s.id)
  ) then
    raise exception '这场比赛已经结算了';
  end if;
  return new;
end $$;

drop trigger if exists events_check on public.events;
create trigger events_check before insert on public.events
  for each row execute function public.check_event();

-- ───────────── 操作（只能通过这些函数改账本、确认） ─────────────

-- 持有人创建账本，拿到邀请码
create or replace function public.create_ledger(p_owner_name text) returns public.ledgers
language plpgsql security definer set search_path = public as $$
declare
  r public.ledgers;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if exists (select 1 from public.ledgers where auth.uid() in (owner_id, partner_id)) then
    raise exception '你已经在一个账本里了';
  end if;
  insert into public.ledgers (owner_id, owner_name, invite_code)
  values (auth.uid(), trim(p_owner_name), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)))
  returning * into r;
  return r;
end $$;

-- 朋友用邀请码加入
create or replace function public.join_ledger(p_code text, p_partner_name text) returns public.ledgers
language plpgsql security definer set search_path = public as $$
declare
  r public.ledgers;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if exists (select 1 from public.ledgers where auth.uid() in (owner_id, partner_id)) then
    raise exception '你已经在一个账本里了';
  end if;
  update public.ledgers
     set partner_id = auth.uid(), partner_name = trim(p_partner_name)
   where invite_code = upper(trim(p_code)) and partner_id is null and owner_id <> auth.uid()
  returning * into r;
  if r.id is null then raise exception '邀请码不对，或者这个账本已经有人加入了'; end if;
  return r;
end $$;

-- 朋友在 App 里确认到某一条为止的所有待确认记录
create or replace function public.confirm_events(p_ledger uuid, p_upto bigint) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if public.ledger_role(p_ledger) is distinct from 'partner' then
    raise exception '只有朋友本人可以在这里确认';
  end if;
  update public.events
     set confirmed_at = now(), confirmed_via = 'app'
   where ledger_id = p_ledger and id <= p_upto and needs_confirm and confirmed_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- 持有人生成一张对账单（编号自动加一）
create or replace function public.create_statement(p_ledger uuid, p_balance_cents integer, p_upto bigint)
returns public.statements
language plpgsql security definer set search_path = public as $$
declare
  s public.statements;
begin
  if public.ledger_role(p_ledger) is distinct from 'owner' then
    raise exception '只有账户持有人可以生成对账单';
  end if;
  insert into public.statements (ledger_id, no, balance_cents, upto_event_id)
  values (p_ledger,
          coalesce((select max(no) from public.statements where ledger_id = p_ledger), 0) + 1,
          p_balance_cents, p_upto)
  returning * into s;
  return s;
end $$;

-- 确认一张对账单：朋友在 App 里点（via app），或者持有人记下朋友在微信里回了确认（via wechat）
create or replace function public.confirm_statement(p_statement bigint) returns public.statements
language plpgsql security definer set search_path = public as $$
declare
  s public.statements;
  role text;
  via text;
begin
  select * into s from public.statements where id = p_statement;
  if s.id is null then raise exception '找不到这张对账单'; end if;
  role := public.ledger_role(s.ledger_id);
  if role is null then raise exception '没有权限'; end if;
  via := case role when 'partner' then 'app' else 'wechat' end;
  update public.statements set confirmed_at = now(), confirmed_via = via
   where id = s.id and confirmed_at is null
  returning * into s;
  if s.id is null then raise exception '这张对账单已经确认过了'; end if;
  update public.events
     set confirmed_at = now(), confirmed_via = via, statement_no = s.no
   where ledger_id = s.ledger_id and id <= s.upto_event_id and needs_confirm and confirmed_at is null;
  return s;
end $$;

-- ───────────── Kalshi 同步用的函数 ─────────────

create or replace function public.kalshi_ledger_for_token(p_token text) returns uuid
language sql stable security definer set search_path = public as $$
  select ledger_id from public.kalshi_sync
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;

-- 比赛有结果、所有成交都分配完、账本里还没结算 → 自动结算
create or replace function public.kalshi_try_settle(p_ledger uuid, p_event_ticker text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  res public.kalshi_results;
  g public.games;
  owner uuid;
begin
  select * into res from public.kalshi_results where ledger_id = p_ledger and event_ticker = p_event_ticker;
  if res.ledger_id is null then return false; end if;
  select * into g from public.games where ledger_id = p_ledger and kalshi_event_ticker = p_event_ticker;
  if g.id is null then return false; end if;
  if exists (select 1 from public.kalshi_fills where ledger_id = p_ledger and event_ticker = p_event_ticker and status = 'pending') then
    return false;
  end if;
  if exists (select 1 from public.events s where s.ledger_id = p_ledger and s.game_id = g.id and s.kind = 'settle'
             and not exists (select 1 from public.events v where v.kind = 'void' and v.voids = s.id)) then
    return false;
  end if;
  select owner_id into owner from public.ledgers where id = p_ledger;
  insert into public.events (ledger_id, kind, game_id, winner, occurred_at, created_by, note)
  values (p_ledger, 'settle', g.id, res.winner, res.decided_at, owner, 'Kalshi 自动结算');
  return true;
end $$;

-- 持有人在账本设置里生成同步令牌（只存哈希）
create or replace function public.set_kalshi_sync(p_ledger uuid, p_token_hash text, p_since date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.ledger_role(p_ledger) is distinct from 'owner' then raise exception '只有账户持有人可以设置 Kalshi 同步'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception '同步令牌格式不对'; end if;
  insert into public.kalshi_sync (ledger_id, token_hash, since) values (p_ledger, p_token_hash, p_since)
  on conflict (ledger_id) do update set token_hash = excluded.token_hash, since = excluded.since;
end $$;

-- 账本里看同步状态（不含令牌）
create or replace function public.kalshi_sync_status(p_ledger uuid) returns json
language sql stable security definer set search_path = public as $$
  select case when public.ledger_role(p_ledger) is null then null else (
    select json_build_object('since', since, 'last_run_at', last_run_at, 'last_imported', last_imported, 'last_message', last_message)
    from public.kalshi_sync where ledger_id = p_ledger) end
$$;

-- 同步程序：从哪天开始导入、哪些比赛还没出结果
create or replace function public.kalshi_sync_info(p_token text) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  l uuid := public.kalshi_ledger_for_token(p_token);
begin
  if l is null then raise exception '同步令牌不对'; end if;
  return json_build_object(
    'since', (select since from public.kalshi_sync where ledger_id = l),
    'open_events', coalesce((
      select json_agg(distinct f.event_ticker) from public.kalshi_fills f
      where f.ledger_id = l and f.status <> 'ignored'
        and not exists (select 1 from public.kalshi_results r where r.ledger_id = l and r.event_ticker = f.event_ticker)
    ), '[]'::json));
end $$;

-- 同步程序：写入新成交（已有的跳过）和比赛结果
create or replace function public.kalshi_ingest(p_token text, p_fills jsonb, p_results jsonb, p_message text default null)
returns json
language plpgsql security definer set search_path = public as $$
declare
  l uuid := public.kalshi_ledger_for_token(p_token);
  n_fills integer;
  n_settled integer := 0;
  r record;
begin
  if l is null then raise exception '同步令牌不对'; end if;
  insert into public.kalshi_fills (ledger_id, id, order_id, event_ticker, market_ticker, team_a, team_b, starts_at, side, action,
    contracts, price_cents, notional_cents, fee_cents, fee_dollars, occurred_at)
  select l, x.id, x.order_id, x.event_ticker, x.market_ticker, left(x.team_a, 20), left(x.team_b, 20), x.starts_at, x.side, x.action,
    x.contracts, x.price_cents, x.notional_cents, x.fee_cents, x.fee_dollars, x.occurred_at
  from jsonb_to_recordset(coalesce(p_fills, '[]'::jsonb)) as x(id text, order_id text, event_ticker text, market_ticker text, team_a text,
    team_b text, starts_at timestamptz, side text, action text, contracts numeric, price_cents integer,
    notional_cents integer, fee_cents integer, fee_dollars text, occurred_at timestamptz)
  on conflict (ledger_id, id) do nothing;
  get diagnostics n_fills = row_count;

  insert into public.kalshi_results (ledger_id, event_ticker, winner, decided_at)
  select l, x.event_ticker, x.winner, coalesce(x.decided_at, now())
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as x(event_ticker text, winner text, decided_at timestamptz)
  on conflict (ledger_id, event_ticker) do nothing;

  for r in select event_ticker from public.kalshi_results where ledger_id = l loop
    if public.kalshi_try_settle(l, r.event_ticker) then n_settled := n_settled + 1; end if;
  end loop;

  update public.kalshi_sync set last_run_at = now(), last_imported = n_fills, last_message = left(p_message, 200)
  where ledger_id = l;
  return json_build_object('imported', n_fills, 'settled', n_settled);
end $$;

-- 同步程序：更新自动汇率
create or replace function public.set_fx_rate(p_token text, p_rate numeric, p_source text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.kalshi_ledger_for_token(p_token) is null then raise exception '同步令牌不对'; end if;
  if p_rate is null or p_rate < 1 or p_rate > 20 then raise exception '汇率不对：%', p_rate; end if;
  insert into public.fx_rates (pair, rate, source, updated_at) values ('USDCNY', p_rate, left(p_source, 60), now())
  on conflict (pair) do update set rate = excluded.rate, source = excluded.source, updated_at = now();
end $$;

-- 持有人设置约定汇率（传 null 清除）
create or replace function public.set_ledger_fx(p_ledger uuid, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.ledger_role(p_ledger) is distinct from 'owner' then raise exception '只有账户持有人可以设置约定汇率'; end if;
  if p_rate is not null and (p_rate < 1 or p_rate > 20) then raise exception '汇率填 1 到 20 之间的数，比如 7.2'; end if;
  update public.ledgers set fx_rate = round(p_rate, 4) where id = p_ledger;
end $$;

-- 持有人把一笔 Kalshi 成交分给自己或朋友（分错了可以撤销那条记录，再重新分）
create or replace function public.assign_kalshi_fill(p_ledger uuid, p_id text, p_holder text) returns public.events
language plpgsql security definer set search_path = public as $$
declare
  f public.kalshi_fills;
  g public.games;
  e public.events;
  owner uuid;
begin
  if public.ledger_role(p_ledger) is distinct from 'owner' then raise exception '只有账户持有人可以分配'; end if;
  if p_holder not in ('owner', 'partner') then raise exception '要选我的或朋友的'; end if;
  select * into f from public.kalshi_fills where ledger_id = p_ledger and id = p_id for update;
  if f.ledger_id is null then raise exception '找不到这笔 Kalshi 成交'; end if;
  if f.status = 'assigned' and exists (
    select 1 from public.events x where x.id = f.event_id
      and not exists (select 1 from public.events v where v.kind = 'void' and v.voids = x.id)) then
    raise exception '这笔已经分配过了';
  end if;
  select owner_id into owner from public.ledgers where id = p_ledger;
  select * into g from public.games where ledger_id = p_ledger and kalshi_event_ticker = f.event_ticker;
  if g.id is null then
    insert into public.games (ledger_id, team_a, team_b, starts_at, created_by, kalshi_event_ticker)
    values (p_ledger, f.team_a, f.team_b, f.starts_at, owner, f.event_ticker)
    returning * into g;
  end if;
  insert into public.events (ledger_id, kind, game_id, holder, action, side, contracts, price_cents, notional_cents,
    fee_cents, occurred_at, created_by, kalshi_fill_id)
  values (p_ledger, 'fill', g.id, p_holder, f.action, f.side, f.contracts, f.price_cents, f.notional_cents,
    f.fee_cents, f.occurred_at, owner, f.id)
  returning * into e;
  update public.kalshi_fills set status = 'assigned', event_id = e.id where ledger_id = p_ledger and id = p_id;
  perform public.kalshi_try_settle(p_ledger, f.event_ticker);
  return e;
end $$;

-- 持有人忽略一笔（或者取消忽略）
create or replace function public.ignore_kalshi_fill(p_ledger uuid, p_id text, p_ignore boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  f public.kalshi_fills;
begin
  if public.ledger_role(p_ledger) is distinct from 'owner' then raise exception '只有账户持有人可以操作'; end if;
  select * into f from public.kalshi_fills where ledger_id = p_ledger and id = p_id;
  if f.ledger_id is null then raise exception '找不到这笔 Kalshi 成交'; end if;
  if f.status = 'assigned' then raise exception '已经分配的不能忽略，先撤销那条记录'; end if;
  update public.kalshi_fills set status = case when p_ignore then 'ignored' else 'pending' end
  where ledger_id = p_ledger and id = p_id;
  if p_ignore then perform public.kalshi_try_settle(p_ledger, f.event_ticker); end if;
end $$;

-- ───────────── 权限 ─────────────

alter table public.ledgers enable row level security;
alter table public.games enable row level security;
alter table public.events enable row level security;
alter table public.statements enable row level security;

drop policy if exists ledgers_read on public.ledgers;
create policy ledgers_read on public.ledgers for select to authenticated
  using (auth.uid() in (owner_id, partner_id));

drop policy if exists games_read on public.games;
create policy games_read on public.games for select to authenticated
  using (public.ledger_role(ledger_id) is not null);
drop policy if exists games_insert on public.games;
create policy games_insert on public.games for insert to authenticated
  with check (public.ledger_role(ledger_id) = 'owner' and created_by = auth.uid());

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated
  using (public.ledger_role(ledger_id) is not null);
drop policy if exists events_insert on public.events;
create policy events_insert on public.events for insert to authenticated
  with check (public.ledger_role(ledger_id) = 'owner' and created_by = auth.uid()
              and confirmed_at is null and confirmed_via is null and statement_no is null);

drop policy if exists statements_read on public.statements;
create policy statements_read on public.statements for select to authenticated
  using (public.ledger_role(ledger_id) is not null);

alter table public.fx_rates enable row level security;
drop policy if exists fx_rates_read on public.fx_rates;
create policy fx_rates_read on public.fx_rates for select to authenticated using (true);

alter table public.kalshi_sync enable row level security;
alter table public.kalshi_fills enable row level security;
alter table public.kalshi_results enable row level security;
drop policy if exists kalshi_fills_read on public.kalshi_fills;
create policy kalshi_fills_read on public.kalshi_fills for select to authenticated
  using (public.ledger_role(ledger_id) is not null);
drop policy if exists kalshi_results_read on public.kalshi_results;
create policy kalshi_results_read on public.kalshi_results for select to authenticated
  using (public.ledger_role(ledger_id) is not null);

-- 表权限：只给读和新增，不给改和删（改动只能走上面的函数）
revoke all on public.ledgers, public.games, public.events, public.statements,
  public.kalshi_sync, public.kalshi_fills, public.kalshi_results, public.fx_rates from anon, authenticated;
grant select on public.ledgers, public.statements to authenticated;
grant select, insert on public.games, public.events to authenticated;
grant select on public.kalshi_fills, public.kalshi_results, public.fx_rates to authenticated;

revoke all on function public.ledger_role(uuid), public.create_ledger(text), public.join_ledger(text, text),
  public.confirm_events(uuid, bigint), public.create_statement(uuid, integer, bigint),
  public.confirm_statement(bigint), public.check_event() from public, anon;
grant execute on function public.ledger_role(uuid), public.create_ledger(text), public.join_ledger(text, text),
  public.confirm_events(uuid, bigint), public.create_statement(uuid, integer, bigint),
  public.confirm_statement(bigint) to authenticated;

-- Kalshi 同步：内部函数谁都不能直接调；同步程序（没登录，只有令牌）只能调这两个
revoke all on function public.kalshi_ledger_for_token(text), public.kalshi_try_settle(uuid, text)
  from public, anon, authenticated;
revoke all on function public.kalshi_sync_info(text), public.kalshi_ingest(text, jsonb, jsonb, text) from public;
grant execute on function public.kalshi_sync_info(text), public.kalshi_ingest(text, jsonb, jsonb, text) to anon, authenticated;
revoke all on function public.set_kalshi_sync(uuid, text, date), public.kalshi_sync_status(uuid),
  public.assign_kalshi_fill(uuid, text, text), public.ignore_kalshi_fill(uuid, text, boolean) from public, anon;
grant execute on function public.set_kalshi_sync(uuid, text, date), public.kalshi_sync_status(uuid),
  public.assign_kalshi_fill(uuid, text, text), public.ignore_kalshi_fill(uuid, text, boolean) to authenticated;

-- 汇率
revoke all on function public.set_fx_rate(text, numeric, text), public.set_ledger_fx(uuid, numeric) from public, anon;
grant execute on function public.set_fx_rate(text, numeric, text) to anon, authenticated;
grant execute on function public.set_ledger_fx(uuid, numeric) to authenticated;
