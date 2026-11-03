// 合买账本 · 页面
import { compute, stats, statement, estimateFee, needsConfirm, fillAmount, notional, avgFillPrice, toCSV, SIDES } from './ledger.js';
import { createStore } from './store.js';
import { PUBLIC_URL } from './config.js';
import { esc, money, signed, price, pct, tone, dt, day, when, full, localInput, parseMoney, parseCount } from './format.js';
import { statementModel, statementText, drawStatement } from './statement-image.js';

const $app = document.getElementById('app');
const $tabbar = document.getElementById('tabbar');
const $toast = document.getElementById('toast');
const $sheet = document.getElementById('sheet');

const S = {
  store: null, user: null, ledger: null, role: null,
  data: { games: [], events: [], statements: [] }, r: null,
  gameById: new Map(), eventById: new Map(),
  params: { id: null, q: new URLSearchParams() },
  authMode: 'signin', after: null, lastHash: null,
};

const TEAMS = ['老鹰', '凯尔特人', '篮网', '黄蜂', '公牛', '骑士', '独行侠', '掘金', '活塞', '勇士', '火箭', '步行者', '快船', '湖人', '灰熊', '热火', '雄鹿', '森林狼', '鹈鹕', '尼克斯', '雷霆', '魔术', '76人', '太阳', '开拓者', '国王', '马刺', '猛龙', '爵士', '奇才'];

const ICON = {
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
};

// ───────────── 小工具 ─────────────
const L = () => S.ledger;
const other = (h) => (h === 'owner' ? 'partner' : 'owner');
const fullName = (h) => (h === 'owner' ? L().owner_name : L().partner_name || '朋友');
const nameOf = (h) => (h === S.role ? '我' : fullName(h));
const initial = (h) => (h === S.role ? '我' : [...fullName(h)][0] || '?');
const av = (h, cls = '') => `<i class="av ${h === 'owner' ? 'me' : 'fr'} ${cls}">${esc(initial(h))}</i>`;
const gameTitle = (g) => (g ? `${g.team_a} vs ${g.team_b}` : '已删除的比赛');
const sideName = (g, s) => (g ? (s === 'a' ? g.team_a : g.team_b) : '?') + '赢';
const isOwner = () => S.role === 'owner';

function balanceLabel(b) {
  if (b === 0) return '两清';
  const debtor = b > 0 ? 'owner' : 'partner';
  return `${nameOf(debtor)}欠${nameOf(other(debtor))}`;
}

function pendingEvents() {
  return S.data.events.filter((e) => needsConfirm(e) && !e.confirmed_at);
}

function toast(msg, bad = false) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (bad ? ' bad' : '');
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, bad ? 4200 : 2200);
}

function ask({ title, body = '', ok = '确定', danger = false, input = null }) {
  return new Promise((resolve) => {
    $sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>${body ? `<p class="sub">${body}</p>` : ''}
      ${input ? `<input class="in" id="sheet-input" placeholder="${esc(input)}" maxlength="200">` : ''}
      <div class="btns"><button class="cta ghost" data-r="0" type="button">取消</button><button class="cta ${danger ? 'danger' : ''}" data-r="1" type="button">${esc(ok)}</button></div>
    </div>`;
    $sheet.hidden = false;
    const done = (v) => { $sheet.hidden = true; $sheet.innerHTML = ''; $sheet.onclick = null; resolve(v); };
    $sheet.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1' ? (input ? $sheet.querySelector('#sheet-input').value.trim() : true) : null);
      else if (e.target === $sheet) done(null);
    };
    $sheet.querySelector(input ? '#sheet-input' : '[data-r="1"]')?.focus();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('复制失败，请手动选择文字复制');
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ───────────── 数据 ─────────────
async function reload() {
  S.data = await S.store.load(S.ledger.id);
  S.r = compute(S.data.events, S.data.games);
  S.gameById = new Map(S.data.games.map((g) => [g.id, g]));
  S.eventById = new Map(S.data.events.map((e) => [e.id, e]));
}

async function enter() {
  S.ledger = null;
  if (!S.user) return render();
  S.ledger = await S.store.myLedger();
  if (S.ledger) {
    S.role = S.ledger.owner_id === S.user.id ? 'owner' : 'partner';
    await reload();
  }
  render();
}

// ───────────── 路由 ─────────────
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, q] = h.split('?');
  const [name, id] = path.split('/');
  return { name: name || '', id: id ? decodeURIComponent(id) : null, q: new URLSearchParams(q || '') };
}

const ROUTES = {
  '': [viewHome, 'home'],
  games: [viewGames, 'games'],
  game: [viewGame, 'games'],
  stats: [viewStats, 'stats'],
  records: [viewRecords, 'records'],
  fill: [viewFill, null],
  transfer: [viewTransfer, null],
  statement: [viewStatement, null],
  settings: [viewSettings, null],
};

function render() {
  S.after = null;
  let html, tab = null;
  if (!S.user) html = viewLogin();
  else if (!S.ledger) html = viewSetup();
  else {
    const { name, id, q } = parseHash();
    const [view, t] = ROUTES[name] || ROUTES[''];
    S.params = { id, q };
    html = view();
    tab = t;
  }
  $app.innerHTML = demoBanner() + html;
  $tabbar.hidden = !tab;
  for (const a of $tabbar.querySelectorAll('[data-tab]')) a.classList.toggle('on', a.dataset.tab === tab);
  if (location.hash !== S.lastHash) { window.scrollTo(0, 0); S.lastHash = location.hash; }
  S.after?.();
}

function demoBanner() {
  if (!S.store?.demo) return '';
  const text = S.store.notConfigured
    ? '还没连上数据库，现在看到的是示例数据。改动只在这个页面里，刷新就恢复。'
    : '示例模式：数据是假的，刷新就恢复。';
  const exit = S.store.notConfigured ? '' : `<a class="pill small" href="${location.pathname}">‹ 返回登录</a>`;
  return `<div class="demo"><span>${text}</span>${exit}</div>`;
}

// ───────────── 登录 / 建账本 ─────────────
function viewLogin() {
  const signup = S.authMode === 'signup';
  return `<div class="auth">
    <div class="logo" aria-hidden="true"><i class="av me">合</i><i class="av fr">买</i></div>
    <h1 class="h-t">合买账本</h1>
    <p class="sub">和朋友合买 Kalshi 的记账本：每笔成交各记各的，随时算清谁欠谁。</p>
    <div class="tabs2" role="tablist">
      <button type="button" role="tab" class="${signup ? '' : 'on'}" data-act="auth-mode" data-mode="signin">登录</button>
      <button type="button" role="tab" class="${signup ? 'on' : ''}" data-act="auth-mode" data-mode="signup">注册</button>
    </div>
    <form data-form="auth" class="form" novalidate>
      <label class="field"><span>邮箱</span><input class="in" type="email" name="email" id="auth-email" autocomplete="email" inputmode="email" required></label>
      <label class="field"><span>密码${signup ? '（至少 6 位）' : ''}</span><input class="in" type="password" name="password" id="auth-password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required></label>
      <p class="err" id="auth-err" hidden></p>
      <button class="cta" type="submit">${signup ? '注册' : '登录'}</button>
    </form>
    <a class="link" href="?demo">先看看示例</a>
  </div>`;
}

function viewSetup() {
  return `<div class="auth">
    <h1 class="h-t">你是哪一位？</h1>
    <p class="sub">${esc(S.user.email || '')}</p>
    <form data-form="create" class="card-form" novalidate>
      <b>我是 Kalshi 账户持有人</b>
      <span class="sub">下单和记账都是你。建好之后把邀请码发给朋友。</span>
      <input class="in" name="name" id="owner-name" placeholder="你的称呼，比如 小明" maxlength="20" required>
      <button class="cta" type="submit">创建账本</button>
    </form>
    <form data-form="join" class="card-form" novalidate>
      <b>我是跟单的朋友</b>
      <span class="sub">输入持有人发给你的邀请码。</span>
      <input class="in" name="code" id="invite-code" placeholder="邀请码" autocapitalize="characters" autocomplete="off" required>
      <input class="in" name="name" id="partner-name" placeholder="你的称呼" maxlength="20" required>
      <button class="cta ghost" type="submit">加入账本</button>
    </form>
    <p class="err" id="setup-err" hidden></p>
    <button class="link" type="button" data-act="signout">换个账号登录</button>
  </div>`;
}

// ───────────── 首页 ─────────────
function chartSVG() {
  const pts = [0];
  for (const t of S.r.timeline) if (t.realized !== pts[pts.length - 1]) pts.push(t.realized);
  if (pts.length < 2) return '';
  const W = 268, H = 92, pad = 7;
  let min = Math.min(0, ...pts), max = Math.max(0, ...pts);
  if (max === min) max = min + 1;
  const x = (i) => 3 + (i * (W - 10)) / (pts.length - 1);
  const y = (v) => pad + ((max - v) / (max - min)) * (H - pad * 2);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const col = last >= 0 ? 'var(--up)' : 'var(--down)';
  const who = isOwner() ? fullName('partner') : '我';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(who)}的已结算盈亏走势，现在 ${signed(last)}">
    <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="base"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="${col}"/>
  </svg>`;
}

function openGames() {
  return S.r.games
    .filter((g) => g.game && !g.settled)
    .sort((a, b) => (a.game.starts_at || a.game.created_at || '').localeCompare(b.game.starts_at || b.game.created_at || ''));
}
function settledGames() {
  return S.r.games.filter((g) => g.game && g.settled).sort((a, b) => b.settled.at.localeCompare(a.settled.at));
}

function holdingsText(g) {
  const parts = [];
  for (const side of SIDES) {
    const o = g.holders.owner.sides[side].contracts, p = g.holders.partner.sides[side].contracts;
    if (!o && !p) continue;
    const who = [o ? `${nameOf('owner')}${o}` : '', p ? `${nameOf('partner')}${p}` : ''].filter(Boolean).join(' ');
    parts.push(`${sideName(g.game, side)} ${who}`);
  }
  return parts.join('；');
}

function gameRow(g) {
  if (!g.settled) {
    const sub = [g.game.starts_at ? when(g.game.starts_at) : '进行中', holdingsText(g) || '还没有单'].join(' · ');
    return `<a class="li" href="#/game/${esc(g.id)}"><div class="li-main"><b>${esc(gameTitle(g.game))}</b><span class="sub">${esc(sub)}</span></div><span class="chev" aria-hidden="true">›</span></a>`;
  }
  const lines = ['owner', 'partner']
    .filter((h) => g.holders[h].bought)
    .map((h) => `<span class="${tone(g.holders[h].realized)}">${esc(nameOf(h))} ${signed(g.holders[h].realized)}</span>`)
    .join('');
  const won = g.holders.owner.realized > 0 || g.holders.partner.realized > 0;
  return `<a class="li" href="#/game/${esc(g.id)}"><span class="ic-c ${won ? 'ok' : 'no'}">${won ? '✓' : '✗'}</span><div class="li-main"><b>${esc(sideName(g.game, g.settled.winner))}</b><span class="sub">${esc(gameTitle(g.game))} · ${day(g.settled.at)}</span></div><span class="amt2 num">${lines}</span></a>`;
}

function describe(e) {
  const g = S.gameById.get(e.game_id);
  if (e.kind === 'transfer') {
    const from = e.direction === 'to_owner' ? 'partner' : 'owner';
    return { title: `转账 ${nameOf(from)} → ${nameOf(other(from))}`, sub: e.method || '' };
  }
  if (e.kind === 'fill') {
    return { title: `${nameOf(e.holder)}${e.action === 'buy' ? '买入' : '卖出'} ${sideName(g, e.side)} ${e.contracts}张`, sub: `@${price(avgFillPrice(e))} · ${gameTitle(g)}` };
  }
  if (e.kind === 'settle') return { title: `结算 ${sideName(g, e.winner)}`, sub: gameTitle(g) };
  const t = S.eventById.get(e.voids);
  return { title: `撤销 #${e.voids}`, sub: [t ? describe(t).title : '', e.note].filter(Boolean).join(' · ') };
}

function statusTag(e) {
  if (S.r.voidOf.has(e.id)) return '<span class="tag">已撤销</span>';
  if (!needsConfirm(e)) return '';
  if (!e.confirmed_at) return '<span class="tag wait">待确认</span>';
  return `<span class="tag ok">${e.confirmed_via === 'wechat' ? `微信确认${e.statement_no ? ' #' + e.statement_no : ''}` : '已确认'}</span>`;
}

function eventRow(e) {
  const d = describe(e);
  const voided = S.r.voidOf.has(e.id);
  const eff = S.r.effects.get(e.id);
  let icon;
  if (e.kind === 'fill') icon = `<span class="ic-c ${e.holder === 'owner' ? 'me' : 'fr'}">${esc(initial(e.holder))}</span>`;
  else if (e.kind === 'transfer') icon = '<span class="ic-c">⇄</span>';
  else if (e.kind === 'settle') icon = '<span class="ic-c ok">✓</span>';
  else icon = '<span class="ic-c no">↺</span>';
  let amount = '';
  if (e.kind === 'fill' && e.holder === 'owner') {
    amount = `<span class="amt num muted">${signed(e.action === 'buy' ? -fillAmount(e) : fillAmount(e))}</span>`;
  } else if (eff && eff.involvesPartner) {
    amount = `<span class="amt num ${tone(eff.partnerDelta)}">${signed(eff.partnerDelta)}</span>`;
  }
  return `<button type="button" class="li" data-act="event" data-id="${e.id}">${icon}
    <div class="li-main"><b class="${voided ? 'strike' : ''}">${esc(d.title)}</b><span class="sub">#${e.id} · ${esc(dt(e.occurred_at))}${d.sub ? ' · ' + esc(d.sub) : ''}</span></div>
    <div class="r">${amount}${statusTag(e)}</div></button>`;
}

function viewHome() {
  const r = S.r, b = r.balance, real = r.realized.partner;
  const pending = pendingEvents();
  const realLabel = isOwner() ? `${fullName('partner')}已结算盈亏` : '我的已结算盈亏';
  let banners = '';
  if (isOwner() && !L().partner_id) {
    banners += `<div class="banner"><div><b>把邀请码发给朋友</b><span class="sub">他注册登录后选「我是跟单的朋友」，输入邀请码。</span></div>
      <button type="button" class="pill" data-act="copy" data-text="${esc(L().invite_code)}">${esc(L().invite_code)} · 复制</button></div>`;
  }
  if (!isOwner() && pending.length) {
    banners += `<div class="banner warn"><div><b>${pending.length} 条记录等你确认</b><span class="sub">在「记录」里可以逐条看。没问题就点确认。</span></div>
      <button type="button" class="pill" data-act="confirm-all">全部确认</button></div>`;
  }
  if (isOwner() && L().partner_id && pending.length) {
    banners += `<div class="banner"><div><b>${pending.length} 条等${esc(fullName('partner'))}确认</b><span class="sub">他在 App 里点确认，或者发张对账单给他。</span></div>
      <a class="pill" href="#/statement">对账单</a></div>`;
  }
  if (r.problems.length) {
    banners += `<div class="banner bad"><div><b>有 ${r.problems.length} 条记录对不上</b><span class="sub">${r.problems.map((p) => `#${p.id} ${esc(p.message)}`).join('；')}。撤销它再重记。</span></div></div>`;
  }
  const open = openGames();
  const recent = [...S.data.events].sort((a, b2) => b2.id - a.id).slice(0, 5);
  return `
    <div class="hdr"><a class="avs" href="#/settings" aria-label="设置">${av('owner')}${av('partner')}</a>
      <a class="chip-btn" href="#/statement">${ICON.share}对账单</a></div>
    <div class="hero-n">
      <span class="lbl">${esc(balanceLabel(b))}</span>
      <span class="big num">${money(Math.abs(b))}</span>
      <span class="chg"><span class="${tone(real)}">${real >= 0 ? '▲' : '▼'} ${money(Math.abs(real))}</span> ${esc(realLabel)}${r.openBasis.partner ? ` · 持仓成本 ${money(r.openBasis.partner)}` : ''}</span>
    </div>
    ${chartSVG()}
    ${banners}
    ${isOwner() ? '<div class="btns"><a class="cta" href="#/fill">记一笔成交</a><a class="cta ghost" href="#/transfer">记转账</a></div>' : ''}
    <div class="sec-t">进行中</div>
    ${open.length ? `<div class="list">${open.map(gameRow).join('')}</div>` : `<p class="empty">没有进行中的比赛。${isOwner() ? '点「记一笔成交」开始。' : ''}</p>`}
    <div class="sec-t row">最近记录 <a class="more" href="#/records">全部 ›</a></div>
    ${recent.length ? `<div class="list">${recent.map(eventRow).join('')}</div>` : '<p class="empty">还没有记录。</p>'}`;
}

// ───────────── 比赛 ─────────────
function viewGames() {
  const open = openGames(), done = settledGames();
  return `<div class="hdr"><span class="h-t">比赛</span>${isOwner() ? '<a class="chip-btn" href="#/fill">＋ 记一笔</a>' : ''}</div>
    <div class="sec-t">进行中</div>
    ${open.length ? `<div class="list">${open.map(gameRow).join('')}</div>` : '<p class="empty">没有进行中的比赛。</p>'}
    <div class="sec-t">已结算</div>
    ${done.length ? `<div class="list">${done.map(gameRow).join('')}</div>` : '<p class="empty">还没有结算过的比赛。</p>'}`;
}

function posCard(g, h) {
  const x = g.holders[h];
  const sides = SIDES.filter((s) => x.sides[s].boughtContracts)
    .map((s) => `${sideName(g.game, s)} ${x.sides[s].boughtContracts}张 · 均价 ${price(x.sides[s].avgPrice)}`).join('；');
  let grid;
  if (x.open === 0) {
    const back = x.closedCost + x.realized;
    grid = `<div><span class="sub">成本</span><b class="num">${money(x.closedCost)}</b></div>
      <div><span class="sub">回款</span><b class="num">${money(back)}</b></div>
      <div><span class="sub">盈亏</span><b class="num ${tone(x.realized)}">${signed(x.realized)}</b><span class="sub num ${tone(x.realized)}">${pct(x.closedCost ? x.realized / x.closedCost : null)}</span></div>`;
  } else {
    const heldSides = SIDES.filter((s) => x.sides[s].contracts);
    const ifWin = heldSides.length === 1 ? `${money(x.sides[heldSides[0]].contracts * 100)}` : '—';
    grid = `<div><span class="sub">持有</span><b class="num">${x.open}张</b></div>
      <div><span class="sub">持仓成本</span><b class="num">${money(x.openBasis)}</b></div>
      <div><span class="sub">${x.realized ? '已卖出盈亏' : '赢了回款'}</span><b class="num ${x.realized ? tone(x.realized) : 'up'}">${x.realized ? signed(x.realized) : ifWin}</b></div>`;
  }
  return `<div class="pos"><div class="pos-h">${av(h, 'sm')}${esc(nameOf(h))}<span class="sub num">${esc(sides)}</span></div><div class="pos-g">${grid}</div></div>`;
}

function viewGame() {
  const g = S.r.games.find((x) => x.id === S.params.id);
  if (!g || !g.game) return `<div class="nav"><a class="x" href="#/games">‹</a><div class="nav-t"><b>找不到这场比赛</b></div><span></span></div>`;
  const G = g.game;
  const evs = S.data.events
    .filter((e) => e.game_id === g.id || (e.kind === 'void' && S.eventById.get(e.voids)?.game_id === g.id))
    .sort((a, b) => b.id - a.id);
  const partnerNet = g.events.reduce((s, e) => s + (S.r.effects.get(e.id)?.partnerDelta || 0), 0);
  const holders = ['owner', 'partner'].filter((h) => g.holders[h].bought);
  const openCount = g.holders.owner.open + g.holders.partner.open;
  return `
    <div class="nav"><a class="x" href="#/games" aria-label="返回">‹</a>
      <div class="nav-t"><b>${esc(gameTitle(G))}</b><span class="sub">${esc(G.league || 'NBA')}${G.starts_at ? ' · ' + esc(when(G.starts_at)) : ''}</span></div>
      <span class="done r">${g.settled ? '已结算' : '进行中'}</span></div>
    ${g.settled ? `<div class="outcome"><span class="ok-big">✓</span><div><div class="big2">${esc(sideName(G, g.settled.winner))}</div><div class="sub">${dt(g.settled.at)} 结算 · 每张回 $1.00</div></div></div>` : ''}
    <div class="sec-t">仓位</div>
    ${holders.length ? holders.map((h) => posCard(g, h)).join('') : '<p class="empty">这场还没有单。</p>'}
    ${g.holders.partner.bought ? `<div class="kv"><span class="sub">${esc(isOwner() ? fullName('partner') : '我')}这场的余额变化</span><span class="num ${tone(partnerNet)}">${signed(partnerNet)}</span></div>` : ''}
    ${isOwner() && !g.settled ? `
      <div class="sec-t">比赛结果</div>
      <div class="yn"><button type="button" class="yn-b yes" data-act="settle" data-game="${esc(g.id)}" data-side="a">${esc(sideName(G, 'a'))}</button>
        <button type="button" class="yn-b no" data-act="settle" data-game="${esc(g.id)}" data-side="b">${esc(sideName(G, 'b'))}</button></div>
      <span class="sub center">点结果，这场 ${openCount} 张单一起结算</span>
      <div class="btns"><a class="cta ghost" href="#/fill?game=${encodeURIComponent(g.id)}">再记一笔</a><a class="cta ghost" href="#/fill?game=${encodeURIComponent(g.id)}&action=sell">提前卖出</a></div>` : ''}
    <div class="sec-t">这场的记录</div>
    ${evs.length ? `<div class="list">${evs.map(eventRow).join('')}</div>` : '<p class="empty">没有记录。</p>'}`;
}

// ───────────── 记一笔成交 ─────────────
function viewFill() {
  if (!isOwner()) return '<p class="empty">只有账户持有人可以记账。</p>';
  const q = S.params.q;
  const open = openGames();
  let gameId = q.get('game') || (open[0]?.id ?? 'new');
  if (gameId !== 'new' && !open.some((g) => g.id === gameId)) gameId = open[0]?.id ?? 'new';
  const st = open.find((g) => g.id === gameId);
  // 默认值：持有人已经买过这场、朋友还没买 → 默认记朋友的、同一边
  let holder = q.get('holder') || 'owner';
  let side = q.get('side') || 'a';
  if (st && !q.get('holder')) {
    const ownerSide = SIDES.find((s) => st.holders.owner.sides[s].boughtContracts);
    if (ownerSide && !st.holders.partner.bought) { holder = 'partner'; side = ownerSide; }
    else if (ownerSide) side = ownerSide;
  }
  const action = q.get('action') === 'sell' ? 'sell' : 'buy';
  let mode = 'price';
  try { if (localStorage.getItem('kl.fillMode') === 'amount') mode = 'amount'; } catch { /* 无痕模式等读不到，用默认 */ }
  const radio = (name, value, checked, label, cls = '') =>
    `<label class="${cls}"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
  S.after = () => updateFill(document.querySelector('form[data-form="fill"]'));
  return `
    <div class="nav"><button type="button" class="x" data-act="back" aria-label="关闭">✕</button>
      <div class="nav-t"><b>记一笔成交</b><span class="sub">照 Kalshi 成交记录填</span></div><span></span></div>
    <form data-form="fill" class="form" novalidate>
      <div class="tabs2 radios">${radio('action', 'buy', action === 'buy', '买入')}${radio('action', 'sell', action === 'sell', '卖出')}</div>
      <label class="field"><span>比赛</span>
        <select class="in" name="game" id="f-game">
          ${open.map((g) => `<option value="${esc(g.id)}" ${g.id === gameId ? 'selected' : ''}>${esc(gameTitle(g.game))}${g.game.starts_at ? ' · ' + esc(when(g.game.starts_at)) : ''}</option>`).join('')}
          <option value="new" ${gameId === 'new' ? 'selected' : ''}>＋ 新比赛</option>
        </select></label>
      <div class="newgame" id="f-newgame" ${gameId === 'new' ? '' : 'hidden'}>
        <div class="two"><input class="in" name="team_a" id="f-team-a" placeholder="球队，比如 掘金" list="teams" maxlength="20" autocomplete="off">
          <input class="in" name="team_b" id="f-team-b" placeholder="对手，比如 太阳" list="teams" maxlength="20" autocomplete="off"></div>
        <label class="field"><span>开赛时间（可不填）</span><input class="in" type="datetime-local" name="starts_at" id="f-starts"></label>
      </div>
      <span class="field-l">这笔是谁的</span>
      <div class="seg radios">${radio('holder', 'owner', holder === 'owner', `${av('owner', 'sm')}我`)}${radio('holder', 'partner', holder === 'partner', `${av('partner', 'sm')}${esc(fullName('partner'))}`)}</div>
      <span class="field-l" id="f-side-l">${action === 'sell' ? '卖哪边' : '买哪边'}</span>
      <div class="yn radios">${radio('side', 'a', side === 'a', '<span id="f-side-a">A赢</span>')}${radio('side', 'b', side === 'b', '<span id="f-side-b">B赢</span>')}</div>
      <span class="field-l">怎么填</span>
      <div class="seg radios small">${radio('mode', 'price', mode === 'price', '张数 + 单价')}${radio('mode', 'amount', mode === 'amount', '<span id="f-mode-amount">Cost / Fee / Max payout</span>')}</div>
      <div class="tk-rows">
        <label class="tk" id="row-contracts"><span>张数</span><input class="tk-in num" name="contracts" id="f-contracts" inputmode="numeric" placeholder="0" autocomplete="off"></label>
        <label class="tk" id="row-price"><span>成交价（¢）</span><input class="tk-in num" name="price" id="f-price" inputmode="numeric" placeholder="1–99" autocomplete="off"></label>
        <label class="tk" id="row-cost" hidden><span id="f-cost-l">Cost（$）</span><input class="tk-in num" name="cost" id="f-cost" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
        <label class="tk"><span>手续费 Fee（$）</span><input class="tk-in num" name="fee" id="f-fee" inputmode="decimal" placeholder="自动估算" autocomplete="off"></label>
        <label class="tk" id="row-max" hidden><span>Max payout（$）</span><input class="tk-in num" name="maxpayout" id="f-max" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
        <label class="tk check" id="row-hasfee" hidden><span id="f-hasfee-l">Cost 已经包含手续费</span><input type="checkbox" name="has_fee" id="f-hasfee"></label>
        <label class="tk"><span>成交时间</span><input class="tk-in small" type="datetime-local" name="at" id="f-at" value="${localInput()}"></label>
      </div>
      <div id="f-summary" class="summary"></div>
      <input class="in" name="note" id="f-note" placeholder="备注（可不填）" maxlength="200">
      <p class="err" id="f-err" hidden></p>
      <button class="cta" type="submit" id="f-submit">保存</button>
    </form>
    <datalist id="teams">${TEAMS.map((t) => `<option value="${t}">`).join('')}</datalist>`;
}

function readFill(f) {
  const v = Object.fromEntries(new FormData(f));
  const out = { action: v.action, holder: v.holder, side: v.side, game: v.game, note: (v.note || '').trim() || null };
  const st = v.game !== 'new' ? S.r.games.find((g) => g.id === v.game) : null;
  out.st = st;
  out.teamA = v.game === 'new' ? (v.team_a || '').trim() : st?.game.team_a;
  out.teamB = v.game === 'new' ? (v.team_b || '').trim() : st?.game.team_b;
  out.startsAt = v.starts_at ? new Date(v.starts_at).toISOString() : null;
  out.mode = v.mode === 'amount' ? 'amount' : 'price';
  out.hasFee = v.has_fee === 'on';
  const feeBlank = String(v.fee || '').trim() === '';
  let amount = NaN, maxPayoutBad = false;
  if (out.mode === 'price') {
    out.contracts = parseCount(v.contracts);
    out.price = parseCount(v.price);
    out.notional = out.contracts * out.price;
    out.feeEstimate = estimateFee(out.contracts, out.price);
    out.fee = feeBlank ? out.feeEstimate : parseMoney(v.fee);
    out.feeIsEstimate = feeBlank;
  } else {
    // 照 Kalshi 显示的金额记：买入填 Cost / Fee / Max payout（每张最多赔付 $1，所以 Max payout 就是张数）
    amount = parseMoney(v.cost);
    if (out.action === 'buy') {
      const mp = parseMoney(v.maxpayout);
      maxPayoutBad = mp > 0 && mp % 100 !== 0;
      out.contracts = mp > 0 && !maxPayoutBad ? mp / 100 : NaN;
    } else {
      out.contracts = parseCount(v.contracts);
    }
    out.feeEstimate = 0;
    out.feeIsEstimate = false;
    out.fee = feeBlank ? NaN : parseMoney(v.fee);
    out.notional = Number.isNaN(amount) || Number.isNaN(out.fee) ? NaN
      : out.hasFee ? (out.action === 'buy' ? amount - out.fee : amount + out.fee) : amount;
    out.price = out.contracts > 0 ? out.notional / out.contracts : NaN;
  }
  out.at = v.at ? new Date(v.at) : null;
  out.held = st && out.holder && out.side ? st.holders[out.holder].sides[out.side].contracts : 0;
  const errs = [];
  if (v.game === 'new') {
    if (!out.teamA || !out.teamB) errs.push('填上两支球队');
    else if (out.teamA === out.teamB) errs.push('两支球队不能一样');
  }
  if (out.action === 'sell' && v.game === 'new') errs.push('卖出要选一场已有的比赛');
  if (out.mode === 'amount' && out.action === 'buy') {
    if (maxPayoutBad) errs.push('Max payout 应该是整数美元（每张赔付 $1）');
    else if (!(out.contracts > 0)) errs.push('填上 Max payout');
  } else if (!(out.contracts > 0)) errs.push('张数要是正整数');
  if (out.contracts > 1000000) errs.push('张数太大了');
  if (out.mode === 'price') {
    if (!(out.price >= 1 && out.price <= 99)) errs.push('成交价是 1 到 99 之间的整数（单位：美分）');
    if (Number.isNaN(out.fee) || out.fee < 0) errs.push('手续费格式不对，比如 0.50');
  } else {
    if (Number.isNaN(amount)) errs.push(out.action === 'buy' ? '填上 Cost，比如 18.30' : '填上卖出金额，比如 21.00');
    if (feeBlank) errs.push('填上 Fee（Kalshi 上显示的手续费）');
    else if (Number.isNaN(out.fee) || out.fee < 0) errs.push('Fee 格式不对，比如 0.50');
    if (out.contracts > 0 && out.notional > 0 && !(out.notional >= out.contracts && out.notional <= out.contracts * 99)) {
      errs.push(`算出来均价是 ${price(out.price)}，不在 1¢–99¢ 之间，检查一下数字`);
    } else if (out.contracts > 0 && !Number.isNaN(out.notional) && out.notional <= 0) {
      errs.push('Cost 要大于 Fee');
    }
  }
  if (!out.at || Number.isNaN(out.at.getTime())) errs.push('填一下成交时间');
  if (out.action === 'sell' && out.contracts > out.held) errs.push(`${nameOf(out.holder)}在这边只持有 ${out.held} 张`);
  out.errors = errs;
  return out;
}

function updateFill(f) {
  if (!f) return;
  const v = readFill(f);
  f.querySelector('#f-newgame').hidden = v.game !== 'new';
  f.querySelector('#f-side-a').textContent = `${v.teamA || 'A'}赢`;
  f.querySelector('#f-side-b').textContent = `${v.teamB || 'B'}赢`;
  f.querySelector('#f-side-l').textContent = v.action === 'sell' ? '卖哪边' : '买哪边';
  const amountMode = v.mode === 'amount', buy = v.action === 'buy';
  f.querySelector('#row-contracts').hidden = amountMode && buy;
  f.querySelector('#row-price').hidden = amountMode;
  f.querySelector('#row-cost').hidden = !amountMode;
  f.querySelector('#row-max').hidden = !(amountMode && buy);
  f.querySelector('#row-hasfee').hidden = !amountMode;
  f.querySelector('#f-cost-l').textContent = buy ? 'Cost（$）' : '卖出金额（$）';
  f.querySelector('#f-hasfee-l').textContent = buy ? 'Cost 已经包含手续费' : '卖出金额已经扣掉手续费';
  f.querySelector('#f-mode-amount').textContent = buy ? 'Cost / Fee / Max payout' : '张数 + 金额';
  try { localStorage.setItem('kl.fillMode', v.mode); } catch { /* 存不了就算了 */ }
  f.querySelector('#f-fee').placeholder = amountMode ? 'Kalshi 上的 Fee' : v.feeEstimate ? `估算 $${(v.feeEstimate / 100).toFixed(2)}` : '自动估算';
  f.querySelector('#f-submit').textContent = v.holder === 'partner' ? `保存，等${fullName('partner')}确认` : '保存';
  const sum = f.querySelector('#f-summary');
  const c = v.contracts, p = v.price;
  if (!(c > 0) || !(p >= 1 && p <= 99) || Number.isNaN(v.fee) || Number.isNaN(v.notional)) {
    sum.innerHTML = v.action === 'sell' && v.st ? `<div class="kv"><span class="sub">${esc(nameOf(v.holder))}在这边持有</span><b class="num">${v.held}张</b></div>` : '';
    return;
  }
  const feeTxt = v.feeIsEstimate ? `（手续费按估算 ${money(v.fee)}）` : '';
  const derived = amountMode ? `<div class="kv"><span class="sub">折算</span><b class="num">${c}张 · 均价 ${price(p)}</b></div>` : '';
  if (v.action === 'buy') {
    const cost = v.notional + v.fee;
    const win = c * 100;
    let note = '';
    if (v.holder === 'partner' && v.st) {
      const o = v.st.holders.owner.sides[v.side];
      if (o.boughtContracts) {
        const diff = p - o.avgPrice;
        if (diff !== 0) {
          note = `<div class="note">${ICON.info}<span>比${esc(nameOf('owner'))}的均价 ${price(o.avgPrice)} ${diff > 0 ? '贵' : '便宜'} ${price(Math.abs(diff))}/张，${diff > 0 ? '多花' : '少花'} ${money(Math.round(Math.abs(diff) * c))}</span></div>`;
        }
      }
    }
    sum.innerHTML = `${derived}<div class="tk sum"><span class="sub">成本 ${esc(feeTxt)}</span><b class="num">${money(cost)}</b></div>
      <div class="tk sum"><span class="sub">${esc(v.side === 'a' ? v.teamA || 'A' : v.teamB || 'B')}赢的话回款</span><b class="num up">${money(win)} <span class="sub up">${signed(win - cost)}</span></b></div>${note}`;
  } else {
    const proceeds = v.notional - v.fee;
    const pos = v.st ? v.st.holders[v.holder].sides[v.side] : null;
    const basisOut = pos && pos.contracts ? Math.round((pos.basis * Math.min(c, pos.contracts)) / pos.contracts) : 0;
    sum.innerHTML = `${derived}<div class="kv"><span class="sub">${esc(nameOf(v.holder))}在这边持有</span><b class="num">${v.held}张</b></div>
      <div class="tk sum"><span class="sub">卖出回款 ${esc(feeTxt)}</span><b class="num">${money(proceeds)}</b></div>
      <div class="tk sum"><span class="sub">这几张的盈亏（按平均成本）</span><b class="num ${tone(proceeds - basisOut)}">${signed(proceeds - basisOut)}</b></div>`;
  }
}

// ───────────── 记转账 ─────────────
function viewTransfer() {
  if (!isOwner()) return '<p class="empty">只有账户持有人可以记账。</p>';
  const pn = esc(fullName('partner'));
  const methods = ['Zelle', 'Venmo', '微信', '支付宝', '现金', '其他'];
  S.after = () => updateTransfer(document.querySelector('form[data-form="transfer"]'));
  return `
    <div class="nav"><button type="button" class="x" data-act="back" aria-label="关闭">✕</button>
      <div class="nav-t"><b>记转账</b><span class="sub">你们之间实际转的钱</span></div><span></span></div>
    <form data-form="transfer" class="form" novalidate>
      <span class="field-l">谁转给谁</span>
      <div class="seg radios">
        <label><input type="radio" name="direction" value="to_owner" checked><span>${pn} → 我</span></label>
        <label><input type="radio" name="direction" value="to_partner"><span>我 → ${pn}</span></label></div>
      <div class="tk-rows">
        <label class="tk"><span>金额（$）</span><input class="tk-in num" name="amount" id="t-amount" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
        <label class="tk"><span>时间</span><input class="tk-in small" type="datetime-local" name="at" id="t-at" value="${localInput()}"></label>
      </div>
      <span class="field-l">方式</span>
      <div class="chips radios">${methods.map((m, i) => `<label><input type="radio" name="method" value="${m}" ${i === 0 ? 'checked' : ''}><span>${m}</span></label>`).join('')}</div>
      <input class="in" name="note" id="t-note" placeholder="备注（可不填）" maxlength="200">
      <div id="t-summary" class="summary"></div>
      <p class="err" id="t-err" hidden></p>
      <button class="cta" type="submit">保存，等${pn}确认</button>
    </form>`;
}

function updateTransfer(f) {
  if (!f) return;
  const v = Object.fromEntries(new FormData(f));
  const amt = parseMoney(v.amount);
  const b = S.r.balance;
  const sum = f.querySelector('#t-summary');
  let html = '';
  if (v.direction === 'to_partner' && b > 0) {
    html += `<button type="button" class="link left" data-act="fill-amount" data-amount="${(b / 100).toFixed(2)}">填入 ${money(b)}，正好结清</button>`;
  }
  if (amt > 0) {
    const after = b + (v.direction === 'to_owner' ? amt : -amt);
    html += `<div class="kv"><span class="sub">记完之后</span><b class="num">${esc(balanceLabel(after))} ${after ? money(Math.abs(after)) : ''}</b></div>`;
  }
  sum.innerHTML = html;
}

// ───────────── 战绩 ─────────────
function viewStats() {
  const s = stats(S.r);
  const row = (k, f) => `<span class="k">${k}</span>${['owner', 'partner'].map((h) => f(s.per[h], h)).join('')}`;
  const settled = settledGames();
  const maxSlip = Math.max(...s.slips.map((x) => Math.abs(x.diff)), 1);
  return `
    <div class="hdr"><span class="h-t">战绩</span><span class="chip-btn">全部</span></div>
    <div class="cmp">
      <span></span><span class="hd">${av('owner', 'sm')}${esc(nameOf('owner'))}</span><span class="hd">${av('partner', 'sm')}${esc(nameOf('partner'))}</span>
      ${row('已结算盈亏', (p) => `<span class="v num ${tone(p.realized)}">${signed(p.realized)}</span>`)}
      ${row('回报率', (p) => `<span class="v num ${tone(p.realized)}">${pct(p.roi)}</span>`)}
      ${row('胜负', (p) => `<span class="v num">${p.wins}–${p.losses}</span>`)}
      ${row('投入', (p) => `<span class="v num">${money(p.closedCost)}</span>`)}
    </div>
    <span class="sub">只算已经结算或卖出的部分。投入 = 这些单的成本（含手续费）。</span>
    ${s.slips.length ? `
      <div class="sec-t">跟单晚买的代价</div>
      <div class="slip">
        <span class="big2 num">${s.slipAvg >= 0 ? '+' : '−'}${price(Math.abs(s.slipAvg))}<span class="sub"> /张</span></span>
        <span class="sub">${esc(fullName('partner'))}平均比${esc(fullName('owner'))}${s.slipAvg >= 0 ? '贵' : '便宜'}，${s.slips.length} 次共${s.slipExtra >= 0 ? '多花' : '少花'} ${money(Math.abs(s.slipExtra))}</span>
        <div class="bars">${s.slips.map((x) => `<div class="bar-row"><span>${esc(sideName(x.game, x.side).replace(/赢$/, ''))}</span><span class="bar"><i style="width:${Math.round((Math.abs(x.diff) / maxSlip) * 100)}%" class="${x.diff < 0 ? 'neg' : ''}"></i></span><span class="num">${x.diff < 0 ? '−' : ''}${price(Math.abs(x.diff))}</span></div>`).join('')}</div>
      </div>` : ''}
    <div class="sec-t">比赛</div>
    ${settled.length ? `<div class="list">${settled.map(gameRow).join('')}</div>` : '<p class="empty">还没有结算过的比赛。</p>'}`;
}

// ───────────── 记录 ─────────────
function viewRecords() {
  const onlyPending = S.params.q.get('f') === 'pending';
  const pending = pendingEvents();
  const list = (onlyPending ? pending : S.data.events).slice().sort((a, b) => b.id - a.id);
  return `
    <div class="hdr"><span class="h-t">记录</span><button type="button" class="chip-btn" data-act="csv">${ICON.down}导出</button></div>
    <div class="tabs2"><a href="#/records" class="${onlyPending ? '' : 'on'}">全部</a><a href="#/records?f=pending" class="${onlyPending ? 'on' : ''}">待确认 ${pending.length || ''}</a></div>
    ${!isOwner() && pending.length ? `<div class="banner warn"><div><b>${pending.length} 条等你确认</b><span class="sub">点某一条可以看详情。</span></div><button type="button" class="pill" data-act="confirm-all">全部确认</button></div>` : ''}
    ${list.length ? `<div class="list">${list.map(eventRow).join('')}</div>` : `<p class="empty">${onlyPending ? '没有待确认的记录。' : '还没有记录。'}</p>`}
    <span class="sub center">记录只加不改。记错了点那一条，选「撤销」，再重新记。</span>`;
}

function openEvent(id) {
  const e = S.eventById.get(id);
  if (!e) return;
  const d = describe(e);
  const eff = S.r.effects.get(e.id);
  const voided = S.r.voidOf.get(e.id);
  const g = S.gameById.get(e.game_id);
  const rows = [['时间', full(e.occurred_at)]];
  if (e.kind === 'fill') {
    rows.push(['比赛', gameTitle(g)], ['方向', `${e.action === 'buy' ? '买入' : '卖出'} ${sideName(g, e.side)}`],
      ['张数 · 均价', `${e.contracts} 张 · ${price(avgFillPrice(e))}`], ['成交额', money(notional(e))], ['手续费', money(e.fee_cents)],
      [e.action === 'buy' ? '成本' : '回款', money(fillAmount(e))]);
  }
  if (e.kind === 'transfer') rows.push(['金额', money(e.amount_cents)], ['方式', e.method || '—']);
  if (e.kind === 'settle') rows.push(['比赛', gameTitle(g)], ['结果', sideName(g, e.winner)]);
  if (eff && eff.involvesPartner) rows.push([`${isOwner() ? fullName('partner') : '我'}的余额`, `${signed(eff.partnerDelta)} → ${money(eff.balanceAfter)}`]);
  if (e.note) rows.push(['备注', e.note]);
  if (needsConfirm(e)) rows.push(['确认', e.confirmed_at ? `${full(e.confirmed_at)}${e.confirmed_via === 'wechat' ? ' · 微信' + (e.statement_no ? ' 对账单 #' + e.statement_no : '') : ' · App'}` : '待确认']);
  if (voided) rows.push(['状态', `已被 #${voided.id} 撤销`]);
  const canVoid = isOwner() && e.kind !== 'void' && !voided;
  $sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-label="记录 #${e.id}">
    <h3>#${e.id} ${esc(d.title)}</h3>
    <dl class="dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="num">${esc(v)}</dd>`).join('')}</dl>
    <div class="btns">${canVoid ? `<button type="button" class="cta danger" data-act="void" data-id="${e.id}">撤销这条</button>` : ''}
      <button type="button" class="cta ghost" data-close>关闭</button></div></div>`;
  $sheet.hidden = false;
  $sheet.onclick = (ev) => { if (ev.target === $sheet || ev.target.closest('[data-close]')) closeSheet(); };
}
function closeSheet() { $sheet.hidden = true; $sheet.innerHTML = ''; $sheet.onclick = null; }

// ───────────── 对账单 ─────────────
function statementFor(row) {
  const evs = S.data.events.filter((e) => e.id <= row.upto_event_id);
  const r = compute(evs, S.data.games);
  const prev = S.data.statements.find((s) => s.no === row.no - 1) || null;
  const st = statement(r, evs, prev, S.data.games);
  st.no = row.no;
  return st;
}

function currentStatement() {
  const list = S.data.statements;
  const latest = list[list.length - 1] || null;
  const maxId = S.data.events.reduce((m, e) => Math.max(m, e.id), 0);
  if (latest && latest.upto_event_id >= maxId) return { row: latest, st: statementFor(latest) };
  if (!isOwner()) return latest ? { row: latest, st: statementFor(latest) } : null;
  return { row: null, st: statement(S.r, S.data.events, latest, S.data.games) };
}

function viewStatement() {
  const pick = S.params.q.get('no');
  let cur;
  if (pick) {
    const row = S.data.statements.find((s) => String(s.no) === pick);
    cur = row ? { row, st: statementFor(row) } : null;
  } else cur = currentStatement();
  const history = S.data.statements.slice().reverse();
  if (cur) {
    S.after = () => {
      const m = statementModel(cur.st, S.data.games, cur.row?.created_at);
      const img = document.getElementById('stmt-img');
      if (img) img.src = drawStatement(m).toDataURL('image/png');
    };
  }
  const status = (s) => s.confirmed_at
    ? `<span class="tag ok">${s.confirmed_via === 'wechat' ? '微信确认' : '已确认'}</span>`
    : (isOwner()
      ? `<button type="button" class="pill small" data-act="statement-confirm" data-id="${s.id}">他回了确认</button>`
      : `<button type="button" class="pill small" data-act="statement-confirm" data-id="${s.id}">确认</button>`);
  const isNew = cur && !cur.row;
  return `
    <div class="nav"><a class="x" href="#/" aria-label="返回">‹</a><div class="nav-t"><b>对账单</b><span class="sub">${cur ? `#${cur.st.no}${isNew ? ' · 还没发' : ''}` : ''}</span></div><span></span></div>
    ${cur ? `
      <p class="sub">${isOwner() ? '点「分享图片」发到微信，或者长按图片保存。他看完回一句确认，你在下面点「他回了确认」。' : '持有人发给你的对账单。没问题就点确认。'}</p>
      <div class="stmt-preview"><img id="stmt-img" alt="对账单 #${cur.st.no}"></div>
      ${isOwner() ? `<div class="btns"><button type="button" class="cta" data-act="statement-share">${ICON.share}分享图片</button><button type="button" class="cta ghost" data-act="statement-copy">复制文字</button></div>` : ''}`
      : '<p class="empty">还没有对账单。</p>'}
    <div class="sec-t">历史对账单</div>
    ${history.length ? `<div class="list">${history.map((s) => `<div class="li"><a class="li-main" href="#/statement?no=${s.no}"><b>#${s.no} · ${esc(balanceLabel(s.balance_cents))} ${money(Math.abs(s.balance_cents))}</b><span class="sub">${dt(s.created_at)}${s.confirmed_at ? ' · 确认于 ' + dt(s.confirmed_at) : ''}</span></a>${status(s)}</div>`).join('')}</div>` : '<p class="empty">还没发过对账单。</p>'}`;
}

async function ensureStatement() {
  const cur = currentStatement();
  if (cur.row) return cur;
  const row = await S.store.createStatement(S.ledger.id, cur.st.balance, cur.st.uptoEventId);
  await reload();
  render();
  const st = statementFor(row);
  return { row, st };
}

// ───────────── 设置 ─────────────
function viewSettings() {
  const store = S.store;
  return `
    <div class="nav"><a class="x" href="#/" aria-label="返回">‹</a><div class="nav-t"><b>设置</b></div><span></span></div>
    <div class="list">
      <div class="li">${av('owner')}<div class="li-main"><b>${esc(L().owner_name)}${isOwner() ? '（我）' : ''}</b><span class="sub">Kalshi 账户持有人，负责下单和记账</span></div></div>
      <div class="li">${av('partner')}<div class="li-main"><b>${esc(L().partner_name || '还没加入')}${!isOwner() ? '（我）' : ''}</b><span class="sub">跟单的朋友，查看和确认</span></div></div>
    </div>
    ${isOwner() ? `<div class="kv"><span class="sub">邀请码${L().partner_id ? '（已加入）' : ''}</span><button type="button" class="pill" data-act="copy" data-text="${esc(L().invite_code)}">${esc(L().invite_code)} · 复制</button></div>` : ''}
    ${store.demo ? `<div class="sec-t">示例模式</div><div class="seg"><button type="button" class="${store.demoRole === 'owner' ? 'on' : ''}" data-act="demo-role" data-role="owner">持有人视角</button><button type="button" class="${store.demoRole === 'partner' ? 'on' : ''}" data-act="demo-role" data-role="partner">朋友视角</button></div>` : ''}
    <div class="sec-t">帮助</div>
    <a class="li" href="https://github.com/jingweiwan/kalshi-ledger#readme" target="_blank" rel="noopener"><div class="li-main"><b>使用说明</b><span class="sub">记账规则、怎么对账</span></div><span class="chev">›</span></a>
    ${store.demo ? '' : `<p class="sub">登录邮箱：${esc(S.user?.email || '')}</p><button type="button" class="cta ghost" data-act="signout">退出登录</button>`}`;
}

// ───────────── 点击 ─────────────
const ACTIONS = {
  back() { if (history.length > 1) history.back(); else location.hash = '#/'; },
  'auth-mode'(el) { S.authMode = el.dataset.mode; render(); },
  async signout() { await S.store.signOut(); S.user = null; S.ledger = null; render(); },
  async copy(el) { await copyText(el.dataset.text); toast('已复制'); },
  event(el) { openEvent(Number(el.dataset.id)); },
  async 'confirm-all'() {
    const pending = pendingEvents();
    if (!pending.length) return;
    const ok = await ask({ title: `确认 ${pending.length} 条记录？`, body: '确认表示你看过这些记录，金额没问题。', ok: '确认' });
    if (!ok) return;
    const upto = Math.max(...pending.map((e) => e.id));
    const n = await S.store.confirmEvents(S.ledger.id, upto);
    await reload(); render(); toast(`已确认 ${n} 条`);
  },
  async settle(el) {
    const g = S.r.games.find((x) => x.id === el.dataset.game);
    const winner = el.dataset.side;
    const n = g.holders.owner.open + g.holders.partner.open;
    const pPay = g.holders.partner.sides[winner].contracts * 100;
    const ok = await ask({
      title: `结果是${sideName(g.game, winner)}？`,
      body: `这场 ${n} 张单一起结算，结算后不能再记这场的成交。${g.holders.partner.bought ? `${esc(fullName('partner'))}拿回 ${money(pPay)}。` : ''}点错了可以在记录里撤销。`,
      ok: '确认结算',
    });
    if (!ok) return;
    await S.store.addEvent({ ledger_id: S.ledger.id, kind: 'settle', game_id: g.id, winner });
    await reload(); render(); toast('已结算');
  },
  async void(el) {
    const id = Number(el.dataset.id);
    closeSheet();
    const reason = await ask({ title: `撤销 #${id}？`, body: '原记录会保留，加一条撤销记录，所有数字重新计算。', input: '原因（可不填），比如 价格记错了', ok: '撤销', danger: true });
    if (reason === null) return;
    await S.store.addEvent({ ledger_id: S.ledger.id, kind: 'void', voids: id, note: reason || null });
    await reload(); render(); toast(`已撤销 #${id}`);
  },
  csv() {
    const csv = toCSV(S.data.events, S.data.games, { owner: L().owner_name, partner: L().partner_name || '朋友' });
    const d = new Date();
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `合买账本-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`);
  },
  'fill-amount'(el) {
    const f = el.closest('form');
    f.querySelector('#t-amount').value = el.dataset.amount;
    updateTransfer(f);
  },
  async 'statement-share'(el) {
    el.disabled = true;
    try {
      const { row, st } = await ensureStatement();
      const m = statementModel(st, S.data.games, row.created_at);
      const canvas = drawStatement(m);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const file = new File([blob], `对账单-${m.no}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `合买对账单 #${m.no}` }); }
        catch (e) { if (e.name !== 'AbortError') throw e; }
      } else {
        download(blob, file.name);
        toast('图片已下载。手机上也可以长按图片保存');
      }
    } finally { el.disabled = false; }
  },
  async 'statement-copy'() {
    const { row, st } = await ensureStatement();
    await copyText(statementText(statementModel(st, S.data.games, row.created_at)));
    toast('文字已复制，去微信粘贴');
  },
  async 'statement-confirm'(el) {
    const s = S.data.statements.find((x) => x.id === Number(el.dataset.id));
    const ok = await ask(isOwner()
      ? { title: `${fullName('partner')}确认了 #${s.no}？`, body: `截至这张对账单的待确认记录都会标成「微信确认 #${s.no}」。`, ok: '他确认了' }
      : { title: `确认对账单 #${s.no}？`, body: '确认表示这张对账单上的金额没问题。', ok: '确认' });
    if (!ok) return;
    await S.store.confirmStatement(s.id);
    await reload(); render(); toast('已确认');
  },
  'demo-role'(el) { S.store.setDemoRole(el.dataset.role); },
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  ev.preventDefault();
  try { await fn(el, ev); } catch (err) { console.error(err); toast(err.message || String(err), true); }
});

// ───────────── 表单 ─────────────
function showErr(f, id, msg) {
  const p = f.querySelector('#' + id) || document.getElementById(id);
  if (!p) return toast(msg, true);
  p.textContent = msg;
  p.hidden = !msg;
}

const FORMS = {
  async auth(f) {
    const { email, password } = Object.fromEntries(new FormData(f));
    if (!email || !password) return showErr(f, 'auth-err', '填上邮箱和密码');
    if (S.authMode === 'signup') {
      const { needsEmailConfirm } = await S.store.signUp(email.trim(), password);
      if (needsEmailConfirm) return showErr(f, 'auth-err', '注册成功。去邮箱点确认链接，然后回来登录。');
    } else {
      await S.store.signIn(email.trim(), password);
    }
    S.user = await S.store.user();
    await enter();
  },
  async create(f) {
    const name = new FormData(f).get('name').trim();
    if (!name) return showErr(f, 'setup-err', '填一下你的称呼');
    S.ledger = await S.store.createLedger(name);
    await enter();
    toast('账本建好了，把邀请码发给朋友');
  },
  async join(f) {
    const v = Object.fromEntries(new FormData(f));
    if (!v.code.trim() || !v.name.trim()) return showErr(f, 'setup-err', '填上邀请码和你的称呼');
    await S.store.joinLedger(v.code.trim(), v.name.trim());
    await enter();
    toast('加入成功');
  },
  async fill(f) {
    const v = readFill(f);
    if (v.errors.length) return showErr(f, 'f-err', v.errors.join('；'));
    showErr(f, 'f-err', '');
    let gameId = v.game;
    if (gameId === 'new') {
      const g = await S.store.addGame({ ledger_id: S.ledger.id, team_a: v.teamA, team_b: v.teamB, starts_at: v.startsAt });
      gameId = g.id;
    }
    await S.store.addEvent({
      ledger_id: S.ledger.id, kind: 'fill', game_id: gameId, holder: v.holder, action: v.action, side: v.side,
      contracts: v.contracts, price_cents: Number.isInteger(v.price) ? v.price : null, notional_cents: v.notional,
      fee_cents: v.fee, occurred_at: v.at.toISOString(), note: v.note,
    });
    await reload();
    toast('已保存');
    location.hash = `#/game/${encodeURIComponent(gameId)}`;
  },
  async transfer(f) {
    const v = Object.fromEntries(new FormData(f));
    const amt = parseMoney(v.amount);
    const at = v.at ? new Date(v.at) : null;
    if (!(amt > 0)) return showErr(f, 't-err', '金额格式不对，比如 200 或 191.97');
    if (!at || Number.isNaN(at.getTime())) return showErr(f, 't-err', '填一下时间');
    await S.store.addEvent({
      ledger_id: S.ledger.id, kind: 'transfer', direction: v.direction, amount_cents: amt, method: v.method,
      occurred_at: at.toISOString(), note: (v.note || '').trim() || null,
    });
    await reload();
    toast('已保存');
    location.hash = '#/';
  },
};

document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]');
  if (!f) return;
  ev.preventDefault();
  const btn = f.querySelector('[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await FORMS[f.dataset.form](f);
  } catch (err) {
    console.error(err);
    const errEl = f.querySelector('.err') || document.getElementById('setup-err');
    if (errEl) { errEl.textContent = err.message || String(err); errEl.hidden = false; } else toast(err.message, true);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

const LIVE = { fill: updateFill, transfer: updateTransfer };
for (const type of ['input', 'change']) {
  document.addEventListener(type, (ev) => {
    const f = ev.target.closest('form[data-form]');
    if (f && LIVE[f.dataset.form]) LIVE[f.dataset.form](f);
  });
}

// ───────────── 启动 ─────────────
window.addEventListener('hashchange', () => { closeSheet(); render(); });

const $top = document.getElementById('totop');
const toTop = () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
window.addEventListener('scroll', () => { $top.hidden = window.scrollY < 400; }, { passive: true });
$top.addEventListener('click', toTop);
$tabbar.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]');
  if (a && a.classList.contains('on') && (location.hash || '#/') === a.getAttribute('href')) { e.preventDefault(); toTop(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$sheet.hidden) closeSheet(); });
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !S.ledger) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // 别打断正在填的表单
  try { await reload(); render(); } catch { /* 下次再试 */ }
});

// 从 github.io 打开时，如果国内用的新网址能访问，就跳过去（打不开就留在这里）
async function moveToPublicUrl() {
  if (!PUBLIC_URL || !/(^|\.)github\.io$/.test(location.hostname)) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(PUBLIC_URL + 'manifest.webmanifest', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    location.replace(PUBLIC_URL + location.search + location.hash);
  } catch { /* 新网址打不开 */ } finally {
    clearTimeout(timer);
  }
}

async function boot() {
  moveToPublicUrl();
  try {
    S.store = createStore();
    S.user = await S.store.user();
    S.store.onAuth(async (u) => {
      if ((u?.id ?? null) === (S.user?.id ?? null)) return;
      S.user = u;
      try { await enter(); } catch (err) { toast(err.message, true); }
    });
    await enter();
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<div class="auth"><h1 class="h-t">打不开</h1><p class="sub">${esc(err.message || String(err))}</p><button class="cta" type="button" onclick="location.reload()">重试</button></div>`;
  }
}
boot();
