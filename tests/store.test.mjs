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
