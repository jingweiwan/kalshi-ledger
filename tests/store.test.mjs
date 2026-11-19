import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('正式存取通过实际 Supabase SDK 把兼容标识传到请求，不使用示例存取', async () => {
  const saved = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  const calls = [];
  try {
    const source = await fs.readFile(new URL('../vendor/supabase.js', import.meta.url), 'utf8');
    globalThis.window = { supabase: new Function(source + '\nreturn supabase;')() };
    globalThis.location = new URL('http://localhost/');
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    };
    const { createStore } = await import('../js/store.js');
    const store = createStore();
    assert.equal(store.demo, false);
    assert.equal(await store.myLedger(), null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/rest/v1/ledgers'));
    assert.ok(calls[0].headers.get('x-client-info').split(/\s*,\s*/).includes('kalshi-ledger/2'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('登录通知不占用 SDK 登录锁，回调中读取账本能够完成', { timeout: 3000 }, async () => {
  const saved = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  try {
    const source = await fs.readFile(new URL('../vendor/supabase.js', import.meta.url), 'utf8');
    globalThis.window = { supabase: new Function(source + '\nreturn supabase;')() };
    globalThis.location = new URL('http://localhost/');
    const user = { id: '11111111-1111-1111-1111-111111111111', email: 'qa@example.com' };
    const token = ['{"alg":"HS256"}', JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }), 'test-signature'].map((s) => Buffer.from(s).toString('base64url')).join('.');
    globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/auth/')
      ? { access_token: token, refresh_token: 'fixture', token_type: 'bearer', expires_in: 3600, user } : []), { headers: { 'Content-Type': 'application/json' } });
    const { createStore } = await import('../js/store.js');
    const store = createStore();
    let complete;
    const read = new Promise((resolve) => { complete = resolve; });
    store.onAuth(async (u) => { if (u) complete(await store.myLedger()); });
    await store.signIn('qa@example.com', 'fixture');
    assert.equal(await read, null);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('加载进度包含真实资源名称，分页成交全部读完后才到完成状态', async () => {
  const saved = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  try {
    const source = await fs.readFile(new URL('../vendor/supabase.js', import.meta.url), 'utf8');
    globalThis.window = { supabase: new Function(source + '\nreturn supabase;')() };
    globalThis.location = new URL('http://localhost/');
    let release, secondPage;
    const waiting = new Promise((resolve) => { secondPage = resolve; });
    const paused = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (raw) => {
      const url = new URL(raw);
      let rows = [];
      if (url.pathname.endsWith('/events')) {
        if (url.searchParams.get('offset') === '0') rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, contracts: '1.00' }));
        else { secondPage(); await paused; rows = [{ id: 1000, contracts: '2.00' }]; }
      }
      return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
    };
    const { createStore } = await import('../js/store.js');
    const reports = [];
    const loading = createStore().load('fixture', (p) => reports.push(p));
    await waiting;
    assert.ok(reports.at(-1).pending.includes('成交与转账记录'));
    assert.ok(reports.at(-1).completed < 6);
    release();
    const data = await loading;
    assert.equal(data.events.length, 1001);
    assert.equal(data.events.at(-1).contracts, 2);
    assert.deepEqual(reports.at(-1), { completed: 6, total: 6, pending: [] });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('网络无响应时请求超时返回可重试错误，不会永久等待', { timeout: 3000 }, async (t) => {
  const saved = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const source = await fs.readFile(new URL('../vendor/supabase.js', import.meta.url), 'utf8');
    globalThis.window = { supabase: new Function(source + '\nreturn supabase;')() };
    globalThis.location = new URL('http://localhost/');
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      started();
    });
    const { createStore } = await import('../js/store.js');
    const request = createStore().myLedger();
    const rejected = assert.rejects(request, /请求超时/);
    await waiting;
    t.mock.timers.tick(15000);
    await rejected;
  } finally {
    t.mock.timers.reset();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('新增读取超时不会取消记账写入，避免误导用户重复提交', async (t) => {
  const saved = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const source = await fs.readFile(new URL('../vendor/supabase.js', import.meta.url), 'utf8');
    globalThis.window = { supabase: new Function(source + '\nreturn supabase;')() };
    globalThis.location = new URL('http://localhost/');
    let signal, finish, started;
    const waiting = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = (_url, init) => new Promise((resolve) => { signal = init.signal; finish = resolve; started(); });
    const { createStore } = await import('../js/store.js');
    const writing = createStore().addEvent({ kind: 'transfer', amount_cents: 100 });
    await waiting;
    t.mock.timers.tick(15000);
    assert.ok(!signal?.aborted);
    finish(new Response('{"id":1}', { headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await writing).id, 1);
  } finally {
    t.mock.timers.reset();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
