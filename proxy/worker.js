// 合买账本 · Cloudflare 转发
//
// 国内直接连不上 supabase.co，github.io 也时好时坏。这个小程序部署在 Cloudflare 上，
// 绑定你自己的域名后，国内只需要访问这一个域名：
//   https://你的域名/sb/...   → 转给 Supabase（登录、读写账本）
//   https://你的域名/其他路径  → 转给 GitHub Pages 上的网页
//
// 部署方法见 README「国内访问：Cloudflare 转发」。

const SUPABASE_URL = 'https://ofjchymwuwqbinbgczys.supabase.co';
const PAGES_URL = 'https://jingweiwan.github.io/kalshi-ledger';
const PREFIX = '/sb';

// 不往 Supabase 转的请求头（由 Cloudflare 自己重新生成）
const DROP_HEADERS = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-real-ip'];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/')) {
      const target = SUPABASE_URL + url.pathname.slice(PREFIX.length) + url.search;
      const headers = new Headers(request.headers);
      for (const h of DROP_HEADERS) headers.delete(h);
      const init = { method: request.method, headers, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
        init.duplex = 'half';
      }
      return fetch(target, init);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let path = url.pathname;
    if (path.endsWith('/')) path += 'index.html';
    const upstream = await fetch(PAGES_URL + path, { method: request.method });
    const headers = new Headers(upstream.headers);
    headers.delete('set-cookie');
    // 网页本身每次都检查更新，这样推送新版本后马上生效
    if (path.endsWith('.html')) headers.set('cache-control', 'no-cache');
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
  },
};
