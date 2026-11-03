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
  contracts integer check (contracts > 0),
  price_cents integer check (price_cents between 1 and 99),
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
    and side is not null and contracts is not null and price_cents is not null and fee_cents is not null)),
  constraint settle_fields check (kind <> 'settle' or (game_id is not null and winner is not null)),
  constraint void_fields check (kind <> 'void' or voids is not null)
);
create index if not exists events_ledger_idx on public.events (ledger_id, id);

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

-- 表权限：只给读和新增，不给改和删（改动只能走上面的函数）
revoke all on public.ledgers, public.games, public.events, public.statements from anon, authenticated;
grant select on public.ledgers, public.statements to authenticated;
grant select, insert on public.games, public.events to authenticated;

revoke all on function public.ledger_role(uuid), public.create_ledger(text), public.join_ledger(text, text),
  public.confirm_events(uuid, bigint), public.create_statement(uuid, integer, bigint),
  public.confirm_statement(bigint), public.check_event() from public, anon;
grant execute on function public.ledger_role(uuid), public.create_ledger(text), public.join_ledger(text, text),
  public.confirm_events(uuid, bigint), public.create_statement(uuid, integer, bigint),
  public.confirm_statement(bigint) to authenticated;
