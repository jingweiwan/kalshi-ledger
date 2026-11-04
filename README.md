# 合买账本

和朋友合买 Kalshi 的记账本。你先下单，朋友看了也想跟，你再用同一个账户帮他买。账本把每一笔成交记在各自名下，随时算清你手里有多少是朋友的钱。

- 网址：https://ledger.ericpersonal.trade/ （经过 Cloudflare 转发，国内能直接用；见下面「国内访问：Cloudflare 转发」）
- 备用：https://jingweiwan.github.io/kalshi-ledger/ （国内打开时会自动跳到上面的网址）
- 先看看示例：在网址后面加 `?demo`

## 记账规则

1. **每笔成交单独记，标明是谁的。** 你 19:02 买的和他 19:20 买的是两笔，价格不同，各算各的成本。
2. **你自己的单不进你们之间的账**，只用来算你的盈亏和战绩。
3. **结算和卖出按张数回到各自名下。** 赢了每张回 $1，输了归零。提前卖出要选卖的是谁的张数，按平均成本算盈亏。
4. **只加不改。** 记错了就「撤销」那一条（原记录保留），再重新记。凡是动到朋友那份钱的记录，都要他确认。

```
朋友余额 = 他转给你的钱 − 他的单花掉的钱 + 他的单卖出和结算拿回的钱 − 你转回给他的钱
```

正数表示你欠他，负数表示他欠你。

手续费照 Kalshi 成交记录填。空着不填就按 `0.07 × 张数 × 价格 × (1 − 价格)` 向上取整估算。

## 第一次设置

### 1. Supabase（存数据和登录）

1. 在 https://supabase.com 注册，点 **New project**，名字填 `kalshi-ledger`。区域：朋友在国内就选 Tokyo 或 Singapore，否则选 West US。
2. 左边 **SQL Editor → New query**，把 [`supabase/schema.sql`](supabase/schema.sql) 整段粘贴进去，点 **Run**。
3. 左边 **Authentication → Sign In / Providers → Email**，关掉 **Confirm email**。这样注册时不用收确认邮件，QQ 邮箱经常收不到这类邮件。
4. 项目首页的 **Connect** 按钮里复制 **Project URL** 和 **anon public**（或 **publishable**）key，填进 [`js/config.js`](js/config.js)。
   这两个本来就是公开的；**service_role / secret key 不要填**。

### 2. GitHub Pages（网址）

仓库 **Settings → Pages**，Source 选 **Deploy from a branch**，分支选 `main`、目录选 `/ (root)`。

### 3. 国内访问：Cloudflare 转发

国内直接连不上 supabase.co，github.io 也不稳定。用 Cloudflare 上的一个小程序（[`proxy/worker.js`](proxy/worker.js)）转发：
你们只访问自己的域名，网页和数据都经过它。

1. 注册 Cloudflare：https://dash.cloudflare.com/sign-up
2. 买域名：https://dash.cloudflare.com/?to=/:account/domains/register
   搜一个名字买下来，比如 `xxx-ledger.com`（.com 大约一年 10 美元，要绑信用卡或 PayPal）。在 Cloudflare 买的域名不用再做别的设置。
3. 建转发程序：https://dash.cloudflare.com/?to=/:account/workers-and-pages/create
   选 **Create Worker**（从 Hello World 开始），名字填 `kalshi-ledger`，点 **Deploy**。
   然后点 **Edit code**，把 [`proxy/worker.js`](proxy/worker.js) 的内容整个替换进去，再点 **Deploy**。
4. 绑域名：在这个 Worker 的 **Settings → Domains & Routes → Add → Custom domain**，填 `ledger.你的域名`（比如 `ledger.xxx-ledger.com`），点 **Add**。等几分钟证书生效。
5. 打开 `https://ledger.你的域名/`，能看到登录页就好了。

注意：Supabase 的 **Confirm email** 一定要关掉。确认邮件里的链接指向 supabase.co，国内点不开。

从自己的域名打开时，网页会自动通过 `/sb` 走转发（见 [`js/config.js`](js/config.js)），不用改配置。

### 4. 你们俩注册

- **持有人**：打开网址 → 注册 → 选「我是 Kalshi 账户持有人」→ 首页会出现邀请码。
- **朋友**：打开网址 → 注册 → 选「我是跟单的朋友」→ 输入邀请码。

手机浏览器里点「分享 → 添加到主屏幕」，就能像 App 一样打开。

## 日常怎么用

**持有人**
- 在 Kalshi 下单后，点「记一笔成交」，填张数、成交价和手续费。帮朋友买的那笔，「这笔是谁的」选朋友。
- 朋友转钱给你、你转钱给他，都点「记转账」。
- 比赛结束后，进那场比赛点结果（比如「掘金赢」），你们俩的单一起结算。
- 提前卖出：进那场比赛点「提前卖出」，选卖谁的、卖几张。

**朋友**
- 打开就能看到余额、自己的单和所有记录。
- 有新记录时首页会提示，看过没问题点「全部确认」。

## Kalshi 自动同步

每小时自动把 Kalshi 账户里 **NBA 比赛输赢**（`KXNBAGAME`）的成交拉进首页的「待分配」。你点「我的」或「朋友的」就记进账本，张数、价格、手续费都是 Kalshi 的原始数据。同一个订单分几次成交的会合成一行。比赛出结果、这场的成交都分配完之后，账本自动结算。

- 只导入 NBA 比赛输赢；球员数据、让分、别的市场一律跳过。和合买无关的单点「忽略」，在设置里可以恢复。
- 张数支持两位小数（Kalshi 按金额下单会成交 34.91 张这种）。手续费 Kalshi 精确到 0.0001 美元，账本每笔四舍五入到分。
- 分错了：在记录里撤销那一条，它会回到待分配，重新分就行。

**设置一次就好：**

1. Supabase 的 SQL Editor 里把最新的 [`supabase/schema.sql`](supabase/schema.sql) 再运行一次。
2. 账本「设置 → Kalshi 自动同步」，选从哪天开始导入，点「生成同步令牌」，复制。
3. GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret**，加三个：

   | Name | Secret |
   | --- | --- |
   | `KALSHI_KEY_ID` | Kalshi API key 的 Key ID |
   | `KALSHI_PRIVATE_KEY` | Kalshi 私钥整段，包括 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----` 两行（只读权限就够） |
   | `KL_SYNC_TOKEN` | 第 2 步复制的同步令牌 |

4. 仓库 **Actions → Kalshi 同步 → Run workflow** 先手动跑一次，以后每小时自动跑。

同步程序（[`sync/kalshi-sync.mjs`](sync/kalshi-sync.mjs)）只拿着同步令牌，只能往账本里加「待分配」和比赛结果，别的数据碰不到。运行日志是公开的，只打印条数。

## 人民币显示

首页右上角「$ / ¥」切换显示货币（每台手机各自记住）。汇率有两种：

- **约定汇率**：持有人在「设置 → 汇率」里填（比如 7.2），你们俩看到的人民币都按它算。
- **自动汇率**：没填约定汇率时用。Kalshi 同步程序每小时顺便从 open.er-api.com 取一次美元兑人民币（取不到再用欧洲央行的数据），存进账本。国内打开账本不用访问境外汇率网站。

账本记账始终用美元；人民币只是换算显示。对账单图片和文字上也会多一行人民币金额。

## 对账单（发微信）

朋友在国内、网页打不开或者很慢的时候用。首页右上角「对账单」：

- 生成一张图：上次对账以来新增了什么、现在余额多少、他手里还有什么单，以及从头算的拆解。两种算法的结果一样，他自己就能核对。
- 「分享图片」直接发到微信，或者长按图片保存；也可以「复制文字」。
- 他回「#3 确认」后，你在对账单页点「他回了确认」。截至这张对账单的记录都会标成「微信确认 #3」。

## 要注意

- **看法相反时不能用同一个账户。** 同一个市场一个账户只有一个合并仓位，你买 YES、他买 NO，Kalshi 会直接对冲掉。
- **提前卖出要说清卖的是谁的。** Kalshi 那边分不出来，只能在账本里选。
- **账户在你名下。** Kalshi 的规则一般不允许替别人交易，合买前看一下会员协议。税表也只开给你，这个账本可以作为朋友那部分收益的记录，报税时问一下会计。

## 代码

纯静态网页，不需要编译。Supabase 客户端放在 `vendor/` 里，不依赖外部 CDN，国内打开更稳。

| 文件 | 内容 |
| --- | --- |
| `js/ledger.js` | 记账计算：余额、盈亏、持仓、战绩、对账单、CSV |
| `js/app.js` | 页面 |
| `js/store.js` | 读写 Supabase；没配置时用示例数据 |
| `js/statement-image.js` | 对账单图片和文字 |
| `sync/` | Kalshi 同步：拉成交、换算成账本记录、查比赛结果 |
| `proxy/worker.js` | Cloudflare 转发：`/sb/...` 转给 Supabase，其他转给 GitHub Pages |
| `supabase/schema.sql` | 数据库表、权限（只有持有人能记账，记录不能改不能删）、确认和对账单函数 |
| `tests/` | 计算测试、转发测试、数据库权限测试 |

本地运行：

```bash
python3 -m http.server 8000
```

然后打开 http://localhost:8000/?demo 。

测试：

```bash
npm test
```

改完网页代码提交前，运行一次 `node scripts/stamp-version.mjs` 给 JS / CSS 加版本号，推送后浏览器马上用新版本。

数据库权限测试需要本地 Postgres：依次运行 `tests/supabase_stub.sql`、`supabase/schema.sql`、`tests/rls_test.sql`。
