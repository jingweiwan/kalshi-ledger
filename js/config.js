// Supabase 项目的地址和公开 key（anon 或 publishable，项目首页的 Connect 按钮里能看到）。
// 这两个本来就是给网页用的公开值，安全靠数据库里的权限规则保证。
// 千万不要把 service_role / secret key 填在这里。
// 两个都空着时，网站会打开示例模式。
const SUPABASE_DIRECT_URL = 'https://ofjchymwuwqbinbgczys.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_RoHUK-K1TdEbz0XVnIly9Q_5LKXHduK';

// 从自己的域名打开时（经过 Cloudflare 转发，见 proxy/worker.js），数据也走同一个域名的 /sb，
// 国内不用直接连 supabase.co。从 github.io 或本机打开时直接连 Supabase。
const direct = /(^|\.)github\.io$|^localhost$|^127\.0\.0\.1$/.test(location.hostname);
export const SUPABASE_URL = direct ? SUPABASE_DIRECT_URL : `${location.origin}/sb`;
