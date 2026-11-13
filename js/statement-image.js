// 对账单：生成发微信用的图片和文字。站在持有人的角度写给朋友（「我欠你」）。
import { money, signed, price, dt, full, day, qty } from './format.js?v=mwemrsas';
import { avgFillPrice, gameTitle as title, sideName, settlementLabel } from './ledger.js?v=mwemrsas';

function describe(e, gameById) {
  const g = e.game_id ? gameById.get(e.game_id) : null;
  if (e.kind === 'transfer') {
    return {
      label: e.direction === 'to_owner' ? '你转给我' : '我转给你',
      sub: [e.method, dt(e.occurred_at)].filter(Boolean).join(' · '),
    };
  }
  if (e.kind === 'fill') {
    return {
      label: `${e.action === 'buy' ? '买入' : '卖出'} ${sideName(g, e.side)} ${qty(e.contracts)}张 @${price(avgFillPrice(e))}`,
      sub: `${title(g)} · ${dt(e.occurred_at)}`,
    };
  }
  if (e.kind === 'settle') {
    return { label: `结算 ${settlementLabel(g, e)}`, sub: `${title(g)} · ${dt(e.occurred_at)}` };
  }
  return { label: `撤销 #${e.voids}`, sub: [e.note, dt(e.occurred_at)].filter(Boolean).join(' · ') };
}

/** 把 statement() 的结果整理成要显示的几块内容 */
export function statementModel(st, games, createdAt = new Date().toISOString(), fx = null) {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const owe = st.balance > 0 ? '我欠你' : st.balance < 0 ? '你欠我' : '两清';
  const items = st.items.map((it) => {
    const d = describe(it.event, gameById);
    if (it.event.kind === 'void' && it.target) {
      const t = describe(it.target, gameById);
      d.sub = `${t.label}${it.event.note ? ' · ' + it.event.note : ''}`;
    }
    if (it.voided) d.sub += ' · 已撤销';
    return { ...d, amount: it.delta };
  });
  const positions = st.openPositions.map((p) => ({
    label: `${sideName(p.game, p.side)} · ${title(p.game)}`,
    sub: `${qty(p.contracts)}张 · 成本 ${money(p.basis)}`,
  }));
  const summary = [
    { label: st.transfersNet >= 0 ? '你转给我（净）' : '我转给你（净）', value: money(Math.abs(st.transfersNet)) },
    { label: '已结算盈亏', value: signed(st.realized), tone: st.realized },
    { label: '持仓成本', value: st.openBasis ? '−' + money(st.openBasis) : money(0) },
    { label: '余额', value: money(Math.abs(st.balance)) + (st.balance < 0 ? '（你欠我）' : ''), bold: true },
  ];
  const prev = st.prevBalance == null ? '第一张对账单' : `上次 ${money(Math.abs(st.prevBalance))}${st.prevBalance < 0 ? '（你欠我）' : ''}`;
  return {
    no: st.no,
    owe,
    amount: money(Math.abs(st.balance)),
    cny: fx ? `≈ ¥${(Math.round(Math.abs(st.balance) * fx.rate) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}（汇率 ${fx.rate.toFixed(4)}${fx.kind === 'agreed' ? '，约定' : ''}）` : null,
    meta: `${full(createdAt)}${st.prevAt ? ' · 上次对账 ' + day(st.prevAt) : ''}`,
    change: `${prev} · 新增 ${items.length} 笔`,
    items,
    positions,
    summary,
    footer: `没问题回复「#${st.no} 确认」`,
  };
}

export function statementText(m) {
  const lines = [`合买对账单 #${m.no}`, m.meta, `${m.owe}：${m.amount}${m.cny ? ' ' + m.cny : ''}`, m.change, ''];
  lines.push('【新增】');
  if (!m.items.length) lines.push('没有新记录');
  for (const it of m.items) lines.push(`· ${it.label}  ${signed(it.amount)}（${it.sub}）`);
  lines.push('', '【你手里的单】');
  if (!m.positions.length) lines.push('没有');
  for (const p of m.positions) lines.push(`· ${p.label}，${p.sub}`);
  lines.push('', '【从头算】');
  for (const s of m.summary) lines.push(`${s.label}：${s.value}`);
  lines.push('', m.footer);
  return lines.join('\n');
}

const C = {
  bg: '#FFFFFF', ink: '#0B0F12', sub: '#69737C', line: '#ECEFF1', fill: '#F3F5F6',
  up: '#0A9B57', upSoft: '#E2F5EA', down: '#DE4348', friend: '#C8670A', friendSoft: '#FBEBD9',
};
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "WenQuanYi Zen Hei", sans-serif';
const font = (w, s) => `${w} ${s}px ${FONT}`;

function wrap(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      const at = line.lastIndexOf(' ');
      if (at > 0) { lines.push(line.slice(0, at)); line = line.slice(at + 1); }
      else { lines.push(line); line = ''; }
    }
    line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

/** 画成 750 像素宽的图片（手机上 2 倍清晰度） */
export function drawStatement(m) {
  const W = 750, P = 44, IW = W - P * 2;
  const canvas = document.createElement('canvas');
  const run = (ctx, draw) => {
    let y = P;
    const text = (s, x, yy, f, color, align = 'left') => {
      if (!draw) return;
      ctx.font = f; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
      ctx.fillText(s, x, yy);
    };
    const line = (yy) => { if (draw) { ctx.fillStyle = C.line; ctx.fillRect(P, yy, IW, 2); } };
    const rowLR = (left, sub, right, rightColor, bold) => {
      ctx.font = font(bold ? 800 : 700, 27);
      const rw = right ? ctx.measureText(right).width : 0;
      const labels = wrap(ctx, left, IW - rw - 24);
      labels.forEach((s, i) => text(s, P, y + 34 + i * 36, font(bold ? 800 : 700, 27), C.ink));
      if (right) text(right, W - P, y + 34, font(800, 27), rightColor || C.ink, 'right');
      y += Math.max(1, labels.length) * 36;
      if (sub) {
        ctx.font = font(600, 22);
        const lines = wrap(ctx, sub, IW);
        lines.forEach((s, i) => text(s, P, y + 30 + i * 30, font(600, 22), C.sub));
        y += lines.length * 30 + 12;
      }
      y += 20;
    };
    const section = (s) => { y += 18; text(s, P, y + 32, font(800, 30), C.ink); y += 50; };

    if (draw) { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, canvas.height); }
    // 头部
    if (draw) {
      ctx.fillStyle = C.friendSoft;
      roundRect(ctx, P, y, IW, m.cny ? 300 : 260, 28); ctx.fill();
    }
    text('合买对账单', P + 28, y + 52, font(800, 32), C.ink);
    text(`#${m.no}`, W - P - 28, y + 52, font(700, 28), C.sub, 'right');
    text(m.meta, P + 28, y + 92, font(600, 22), C.sub);
    text(m.owe, P + 28, y + 140, font(800, 28), C.friend);
    text(m.amount, P + 28, y + 222, font(800, 76), C.ink);
    if (m.cny) text(m.cny, P + 28, y + 268, font(700, 26), C.sub);
    y += m.cny ? 300 : 260;
    text(m.change, P, y + 44, font(600, 24), C.sub);
    y += 60;

    section('新增');
    if (!m.items.length) { text('没有新记录', P, y + 30, font(600, 24), C.sub); y += 50; }
    m.items.forEach((it, i) => {
      if (i) line(y);
      rowLR(it.label, it.sub, signed(it.amount), it.amount > 0 ? C.up : it.amount < 0 ? C.down : C.ink);
    });

    section('你手里的单');
    if (!m.positions.length) { text('没有', P, y + 30, font(600, 24), C.sub); y += 50; }
    m.positions.forEach((p, i) => { if (i) line(y); rowLR(p.label, p.sub, '持仓中', C.sub); });

    section('从头算');
    m.summary.forEach((s, i) => {
      if (i) line(y);
      rowLR(s.label, null, s.value, s.tone > 0 ? C.up : s.tone < 0 ? C.down : C.ink, s.bold);
    });

    y += 24;
    if (draw) { ctx.fillStyle = C.upSoft; roundRect(ctx, P, y, IW, 76, 38); ctx.fill(); }
    text(m.footer, W / 2, y + 48, font(800, 28), C.up, 'center');
    y += 76 + 28;
    text('合买账本', W / 2, y + 22, font(600, 20), C.sub, 'center');
    y += 30;
    return y + P;
  };
  canvas.width = W;
  canvas.height = 2000;
  const h = run(canvas.getContext('2d'), false);
  canvas.height = h;
  run(canvas.getContext('2d'), true);
  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
