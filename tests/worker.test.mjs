import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../proxy/worker.js';

const realFetch = globalThis.fetch;
let calls = [];
function mockFetch(respond) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? await new Response(init.body).text() : null;
    calls.push({ url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body, redirect: init.redirect });
    return respond(String(url));
  };
}
afterEach(() => { globalThis.fetch = realFetch; });

test('/sb/ 开头的请求原样转给 Supabase，去掉 /sb', async () => {
  mockFetch(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const req = new Request('https://ledger.example.com/sb/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: 'sb_publishable_x', authorization: 'Bearer abc', 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify({ email: 'a@b.com', password: 'secret' }),
  });
  const res = await worker.fetch(req);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ofjchymwuwqbinbgczys.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.get('apikey'), 'sb_publishable_x');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer abc');
  assert.equal(calls[0].headers.get('cf-connecting-ip'), null);
  assert.equal(calls[0].redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].body), { email: 'a@b.com', password: 'secret' });
});

test('读账本的 GET 请求带着查询参数转发', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  await worker.fetch(new Request('https://ledger.example.com/sb/rest/v1/events?select=*&ledger_id=eq.L1&order=id.asc', {
    headers: { 'x-client-info': 'kalshi-ledger/2' },
  }));
  assert.equal(calls[0].url, 'https://ofjchymwuwqbinbgczys.supabase.co/rest/v1/events?select=*&ledger_id=eq.L1&order=id.asc');
  assert.equal(calls[0].body, null);
  assert.equal(calls[0].headers.get('x-client-info'), 'kalshi-ledger/2');
});

test('其他路径转给 GitHub Pages，首页补上 index.html 并且不缓存', async () => {
  mockFetch(() => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'max-age=600' } }));
  const res = await worker.fetch(new Request('https://ledger.example.com/?demo'));
  assert.equal(calls[0].url, 'https://jingweiwan.github.io/kalshi-ledger/index.html');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(await res.text(), '<!doctype html>');
});

test('静态文件按原路径转发，保留 GitHub 的缓存设置', async () => {
  mockFetch(() => new Response('js', { status: 200, headers: { 'content-type': 'application/javascript', 'cache-control': 'max-age=600' } }));
  const res = await worker.fetch(new Request('https://ledger.example.com/js/app.js'));
  assert.equal(calls[0].url, 'https://jingweiwan.github.io/kalshi-ledger/js/app.js');
  assert.equal(res.headers.get('cache-control'), 'max-age=600');
});

test('网页路径不接受 POST', async () => {
  mockFetch(() => new Response('x'));
  const res = await worker.fetch(new Request('https://ledger.example.com/index.html', { method: 'POST', body: 'x' }));
  assert.equal(res.status, 405);
  assert.equal(calls.length, 0);
});

test('/sbx 这种不是 /sb/ 开头的路径不会转给 Supabase', async () => {
  mockFetch(() => new Response('nf', { status: 404 }));
  await worker.fetch(new Request('https://ledger.example.com/sbx'));
  assert.equal(calls[0].url, 'https://jingweiwan.github.io/kalshi-ledger/sbx');
});
