import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as ledger from '../js/ledger.js';
import * as format from '../js/format.js';
import * as images from '../js/statement-image.js';
import { sampleData } from '../js/sample.js';

// 执行实际页面模块；只替换 DOM、表单和存取边界，不改写保存或刷新逻辑。
async function appFixture() {
  const source = await fs.readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import \{ (.+) \} from .+;$/gm)].flatMap(m => m[1].split(', '));
  const nodes = new Map();
  const handlers = {};
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { hidden: false, innerHTML: '', classList: { toggle() {} }, querySelectorAll: () => [], addEventListener() {}, removeAttribute() {} });
      return nodes.get(id);
    },
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const location = new URL('http://localhost/#/transfer');
  const bindings = { ...ledger, ...format, ...images, PUBLIC_URL: '', createStore() {} };
  const run = new Function('document', 'window', 'location', 'localStorage', 'FormData', 'setTimeout', 'clearTimeout', 'console', ...imports,
    source.replace(/^import .+;\n/gm, '').replace(/\nboot\(\);\s*$/, '\nreturn { S, FORMS, ACTIONS, render, ensureStatement };'));
  const app = run(document, { addEventListener() {}, scrollTo() {} }, location, { getItem() {} },
    class extends Map { constructor(form) { super(Object.entries(form.values)); } }, () => 0, () => {}, { error() {} }, ...imports.map(name => bindings[name]));
  const data = sampleData();
  let failRead = true, writes = 0;
  Object.assign(app.S, {
    user: { id: data.ledger.owner_id }, ledger: data.ledger, role: 'owner',
    data, r: ledger.compute(data.events, data.games),
    gameById: new Map(data.games.map(g => [g.id, g])), eventById: new Map(data.events.map(e => [e.id, e])),
    store: {
      async addEvent(row) { writes++; const event = { ...row, id: 9000 + writes }; data.events.push(event); return event; },
      async load() { if (failRead) throw new Error('请求超时，请检查网络后重试'); return data; },
      async myLedger() { if (failRead) throw new Error('请求超时，请检查网络后重试'); return data.ledger; },
      async setLedgerFx(_id, rate) { writes++; data.ledger = { ...data.ledger, fx_rate: rate }; },
    },
  });
  return { ...app, handlers, nodes, location, data, writes: () => writes, recover: () => { failRead = false; } };
}

test('转账已写入后刷新失败，显示已保存；反复读取和切换路由不会再次写入', async () => {
  const app = await appFixture();
  const form = { values: { amount: '10.00', at: '2026-11-19T10:00', direction: 'to_owner', method: 'Zelle', note: '' } };
  await app.FORMS.transfer(form);
  assert.equal(app.writes(), 1);
  assert.match(app.nodes.get('app').innerHTML, /已保存/);
  assert.match(app.nodes.get('app').innerHTML, /无需再次提交/);
  assert.doesNotMatch(app.nodes.get('app').innerHTML, /<form/);
  app.location.hash = '#/fill';
  app.render();
  assert.doesNotMatch(app.nodes.get('app').innerHTML, /<form/);
  await app.ACTIONS['refresh-saved']();
  assert.equal(app.writes(), 1);
  assert.ok(app.S.savedWrite);
  app.recover();
  await app.ACTIONS['refresh-saved']();
  assert.equal(app.writes(), 1);
  assert.equal(app.S.savedWrite, null);
  assert.equal(app.location.hash, '#/');
  assert.equal(app.S.data.events.filter(e => e.id > 9000).length, 1);
  assert.match(app.nodes.get('app').innerHTML, /overview-card/);
});

test('约定汇率已保存但账本信息刷新失败，重试只读并恢复最新汇率', async () => {
  const app = await appFixture();
  app.location.hash = '#/settings';
  await app.FORMS.fx({ values: { rate: '7.2' } });
  assert.equal(app.writes(), 1);
  assert.match(app.nodes.get('app').innerHTML, /约定汇率已保存/);
  assert.ok(app.S.savedWrite);
  app.recover();
  await app.ACTIONS['refresh-saved']();
  assert.equal(app.writes(), 1);
  assert.equal(app.S.ledger.fx_rate, 7.2);
  assert.equal(app.S.savedWrite, null);
});

test('对账单创建成功后刷新失败，恢复读取后分享复用原单，不会重复创建', async () => {
  const app = await appFixture();
  app.location.hash = '#/records';
  app.data.statements = [];
  let created = 0;
  app.S.store.createStatement = async (_id, balance, upto) => {
    created++;
    const row = { id: 8000, no: 1, balance_cents: balance, upto_event_id: upto, created_at: '2026-11-19T10:00:00Z' };
    app.data.statements.push(row);
    return row;
  };
  assert.equal(await app.ensureStatement(), null);
  assert.match(app.nodes.get('app').innerHTML, /对账单已创建/);
  app.recover();
  await app.ACTIONS['refresh-saved']();
  assert.equal((await app.ensureStatement()).row.id, 8000);
  assert.equal(created, 1);
});

test('表单处理中重复触发提交事件只写一笔，写入失败仍允许修正后重试', async () => {
  const app = await appFixture();
  let release, calls = 0;
  app.S.store.addEvent = async () => { calls++; await new Promise(resolve => { release = resolve; }); throw new Error('写入失败'); };
  const button = { isConnected: true, disabled: false };
  const error = { hidden: true, textContent: '' };
  const form = {
    dataset: { form: 'transfer' },
    values: { amount: '10', at: '2026-11-19T10:00', direction: 'to_owner', method: 'Zelle' },
    closest() { return this; }, querySelector(selector) { return selector === '[type="submit"]' ? button : error; },
  };
  const submit = () => app.handlers.submit({ target: form, preventDefault() {} });
  const first = submit();
  await submit();
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(button.disabled, false);
  assert.equal(form.dataset.submitting, undefined);
  assert.equal(app.S.savedWrite, null);
  assert.equal(error.textContent, '写入失败');
  const retry = submit();
  assert.equal(calls, 2);
  release();
  await retry;
});
