// 数据存取：Supabase（正式）或内存（示例模式），两者接口一样。
import { SUPABASE_URL, SUPABASE_ANON_KEY, PUBLIC_URL, VIA_PROXY } from './config.js';
import { sampleData, SAMPLE_OWNER_ID, SAMPLE_PARTNER_ID } from './sample.js';
import { compute } from './ledger.js';

export function createStore() {
  const wantsDemo = new URLSearchParams(location.search).has('demo');
  const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
  if (wantsDemo || !configured) return demoStore(!configured);
  return supabaseStore();
}

const MESSAGES = [
  [/invalid login credentials/i, '邮箱或密码不对'],
  [/user already registered/i, '这个邮箱已经注册过了，直接登录就行'],
  [/password should be at least/i, '密码至少要 6 位'],
  [/email not confirmed/i, '邮箱还没确认。去邮箱点确认链接，或者让持有人在 Supabase 里关掉「Confirm email」'],
  [/unable to validate email|invalid email/i, '邮箱格式不对'],
  [/rate limit|too many requests/i, '操作太频繁了，等一会儿再试'],
  [/failed to fetch|networkerror|load failed|fetch failed/i, VIA_PROXY || !PUBLIC_URL
    ? '连不上服务器。检查一下网络，或者关掉广告拦截插件再试'
    : `连不上 Supabase。国内请用 ${PUBLIC_URL} 打开`, true],
  [/jwt expired/i, '登录过期了，请重新登录'],
  [/could not find the (table|function)|schema cache|relation .* does not exist|PGRST20[2-5]/i, '数据库还没建好：到 Supabase 后台 SQL Editor 运行一次 supabase/schema.sql，再刷新这个页面'],
  [/invalid api key|no api key/i, 'Supabase 的 key 不对，检查 js/config.js'],
];
function friendly(error) {
  const msg = error?.message || String(error);
  for (const [re, text, showRaw] of MESSAGES) if (re.test(msg)) return showRaw ? `${text}（${msg}）` : text;
  return msg;
}
function unwrap({ data, error }) {
  if (error) throw new Error(friendly(error));
  return data;
}

function supabaseStore() {
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const pageAll = async (query) => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = unwrap(await query().range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };
  return {
    demo: false,
    async user() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuth(cb) {
      sb.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
    },
    async signIn(email, password) {
      unwrap(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password) {
      const data = unwrap(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
      return { needsEmailConfirm: !data.session };
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async myLedger() {
      return unwrap(await sb.from('ledgers').select('*').maybeSingle());
    },
    async createLedger(ownerName) {
      return unwrap(await sb.rpc('create_ledger', { p_owner_name: ownerName }));
    },
    async joinLedger(code, partnerName) {
      return unwrap(await sb.rpc('join_ledger', { p_code: code, p_partner_name: partnerName }));
    },
    async load(ledgerId) {
      const [games, events, statements] = await Promise.all([
        pageAll(() => sb.from('games').select('*').eq('ledger_id', ledgerId).order('created_at')),
        pageAll(() => sb.from('events').select('*').eq('ledger_id', ledgerId).order('id')),
        pageAll(() => sb.from('statements').select('*').eq('ledger_id', ledgerId).order('no')),
      ]);
      return { games, events, statements };
    },
    async addGame(row) {
      return unwrap(await sb.from('games').insert(row).select().single());
    },
    async addEvent(row) {
      return unwrap(await sb.from('events').insert(row).select().single());
    },
    async confirmEvents(ledgerId, upto) {
      return unwrap(await sb.rpc('confirm_events', { p_ledger: ledgerId, p_upto: upto }));
    },
    async createStatement(ledgerId, balance, upto) {
      return unwrap(await sb.rpc('create_statement', { p_ledger: ledgerId, p_balance_cents: balance, p_upto: upto }));
    },
    async confirmStatement(id) {
      return unwrap(await sb.rpc('confirm_statement', { p_statement: id }));
    },
  };
}

// 示例模式：数据只在这个页面里，刷新就恢复成示例。规则和数据库保持一致。
function demoStore(notConfigured) {
  const d = sampleData();
  let role = 'owner';
  let nextEvent = d.events.length + 1;
  let nextGame = d.games.length + 1;
  let nextStatement = d.statements.length + 1;
  const now = () => new Date().toISOString();
  const userFor = (r) => ({ id: r === 'owner' ? SAMPLE_OWNER_ID : SAMPLE_PARTNER_ID, email: 'demo@example.com' });
  const mustOwner = () => { if (role !== 'owner') throw new Error('只有账户持有人可以记账'); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let listener = null;
  return {
    demo: true,
    notConfigured,
    get demoRole() { return role; },
    setDemoRole(r) { role = r; listener?.(userFor(r)); },
    async user() { return userFor(role); },
    onAuth(cb) { listener = cb; },
    async signIn() {}, async signUp() { return { needsEmailConfirm: false }; }, async signOut() {},
    async myLedger() { return clone(d.ledger); },
    async createLedger() { return clone(d.ledger); },
    async joinLedger() { return clone(d.ledger); },
    async load() { return clone({ games: d.games, events: d.events, statements: d.statements }); },
    async addGame(row) {
      mustOwner();
      const g = { id: `g${nextGame++}`, league: 'NBA', starts_at: null, created_at: now(), ...row };
      d.games.push(g);
      return clone(g);
    },
    async addEvent(row) {
      mustOwner();
      const e = {
        id: nextEvent, created_at: now(), occurred_at: now(), created_by: SAMPLE_OWNER_ID,
        direction: null, amount_cents: null, method: null, game_id: null, holder: null, action: null, side: null,
        contracts: null, price_cents: null, notional_cents: null, fee_cents: null, winner: null, voids: null, note: null,
        confirmed_at: null, confirmed_via: null, statement_no: null, ...row,
      };
      if (e.kind === 'void') {
        const t = d.events.find((x) => x.id === e.voids);
        if (!t || t.kind === 'void') throw new Error('只能撤销本账本里的记录');
        if (d.events.some((x) => x.kind === 'void' && x.voids === e.voids)) throw new Error('这条已经撤销过了');
      }
      if ((e.kind === 'fill' || e.kind === 'settle')) {
        const st = compute(d.events, d.games).games.find((g) => g.id === e.game_id);
        if (st?.settled) throw new Error('这场比赛已经结算了');
      }
      nextEvent++;
      d.events.push(e);
      return clone(e);
    },
    async confirmEvents(_ledgerId, upto) {
      if (role !== 'partner') throw new Error('只有朋友本人可以在这里确认');
      let n = 0;
      for (const e of d.events) {
        const needs = e.kind !== 'fill' || e.holder === 'partner';
        if (e.id <= upto && needs && !e.confirmed_at) { e.confirmed_at = now(); e.confirmed_via = 'app'; n++; }
      }
      return n;
    },
    async createStatement(_ledgerId, balance, upto) {
      mustOwner();
      const s = { id: nextStatement, ledger_id: d.ledger.id, no: nextStatement, balance_cents: balance, upto_event_id: upto, created_at: now(), confirmed_at: null, confirmed_via: null };
      nextStatement++;
      d.statements.push(s);
      return clone(s);
    },
    async confirmStatement(id) {
      const s = d.statements.find((x) => x.id === id);
      if (!s) throw new Error('找不到这张对账单');
      if (s.confirmed_at) throw new Error('这张对账单已经确认过了');
      const via = role === 'partner' ? 'app' : 'wechat';
      s.confirmed_at = now(); s.confirmed_via = via;
      for (const e of d.events) {
        const needs = e.kind !== 'fill' || e.holder === 'partner';
        if (e.id <= s.upto_event_id && needs && !e.confirmed_at) { e.confirmed_at = now(); e.confirmed_via = via; e.statement_no = s.no; }
      }
      return clone(s);
    },
  };
}
