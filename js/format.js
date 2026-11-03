// 显示用的格式化工具

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const amt = (v) => (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** $1,234.56 / −$18.80 */
export const money = (c) => (c < 0 ? '−' : '') + '$' + amt(Math.abs(c));
/** +$10.77 / −$18.80 / $0.00 */
export const signed = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + '$' + amt(Math.abs(c));
/** 61¢ / 3.8¢ */
export const price = (p) => (p == null ? '—' : (Number.isInteger(p) ? p : (Math.round(p * 10) / 10).toFixed(1)) + '¢');
/** +57.1% */
export const pct = (x) => (x == null ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(1) + '%');
export const tone = (c) => (c > 0 ? 'up' : c < 0 ? 'down' : '');

const pad = (n) => String(n).padStart(2, '0');
/** 11/03 19:41 */
export function dt(iso) {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 11/03 */
export function day(iso) {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}
/** 今天 21:00 / 明天 19:30 / 11/05 19:30 */
export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const dayDiff = Math.round((new Date(d.toDateString()) - new Date(today.toDateString())) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  if (dayDiff === -1) return `昨天 ${hm}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
}
/** 2026-11-03 21:00 */
export function full(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** <input type="datetime-local"> 用的本地时间 */
export function localInput(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** "$1,234.5" → 123450；不合法返回 NaN */
export function parseMoney(s) {
  const t = String(s ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}
/** 只接受正整数字符串 */
export function parseCount(s) {
  const t = String(s ?? '').trim();
  return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}
