# 本站托管短订阅链接 — 2026-11-17

在订阅转换页面新增“生成订阅链接”：把刚生成的配置存进 Cloudflare KV，返回一个本站短链，可直接导入 Surge / Mihomo。短链形如 `https://sub.fakeyou.eu.org/s/Ab3dE9kZ`（路径固定为 8 位 `[A-Za-z0-9]` token，示例中为 `Ab3dE9kZ`）。

**默认永久：** 不传有效期时链接不过期，KV 记录不带 `expirationTtl`，响应里 `expiresAt` 为 `null`。要自动失效必须显式传 `ttlSeconds`（1 小时 / 1 天 / 7 天 / 30 天）。页面已移除有效期选择，只生成永久链接；`ttlSeconds` 仅为脚本或旧调用方保留，不是 UI 默认值。

## 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/publish` | 正文 `{content, target, ttlSeconds?}`，返回 `{url, manageToken, expiresAt}`（永久时为 `null`） |
| `GET`/`HEAD` | `/s/<token>` | 返回配置文本（`text/plain; charset=utf-8`），不存在则 404 |
| `DELETE` | `/api/publish/<token>` | 撤销，需请求头 `X-Manage-Token`，成功 204 |

- `target` 只接受 `Surge` / `Mihomo`；空配置、非法 UTF-8、超 2 MiB 均拒绝。
- `ttlSeconds` **可选**：省略即永久；显式传入时只接受 `3600`、`86400`、`604800`、`2592000`，其它值（含 `null`、字符串、小数）返回 400，不做静默夹取或截断。
- 永久链接的 KV 写入不带 `expirationTtl`，记录里 `expiresAt` 为 `null`；这类链接不会自动失效，撤销（`DELETE`）是唯一的下线方式。
- `POST /api/publish` 与 `DELETE` 共用同一限流桶：每 IP 每 5 分钟 15 次（`/api/fetch` 单独限制为每分钟 20 次）。
- `POST`/`DELETE` 要求同源 `Origin` 且 JSON 请求头，跨源 403，且限流在校验之后（跨源请求不消耗配额）。
- 未绑定 KV 时返回 503「短链接服务未配置」，不会静默退化为一次性下载。

## 凭据模型

**链接即凭据（等同于密码）。** 任何拿到 `/s/Ab3dE9kZ` 的人都能取到完整配置，不需要再输入密码，也没有第二因子，因此：

- 不要把链接贴到公开群组、issue、截图或日志里；泄露后请立刻撤销。
- 链接不写入 URL 之外的任何地方：不上 cookie、不上 localStorage、不进 Worker 日志（`observability.enabled` 仍为 `false`）。
- 管理令牌（`manageToken`，32 字节随机数的十六进制）只在生成时返回一次，页面仅保存在内存中，刷新即失。丢失令牌就无法撤销；**永久链接没有到期兜底**，这时只能请维护者从 KV 删除对应 `s:<token>` 记录。
- 服务端只保存管理令牌的 **SHA-256 哈希**（`manageHash`），并以定长时间比较；KV 被读也无法还原令牌。KV 记录的字段为 `content`、`target`、`createdAt`、`expiresAt`（永久链接为 `null`）、`manageHash`、`ownerHash` —— 即配置文本 + 元数据 + 令牌哈希 + IP 的 SHA-256；没有原始 IP、UA、来源 URL 或账号信息。每个地址最多 50 条存活链接，另维护 30 天过期的 `own:<ownerHash>` 计数键。
- `GET /s/<token>` 的响应带 `Cache-Control: private, no-store`、`nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`；非 8 位 token 一律 404，不回显路径、不做目录探测。
- token 用 `crypto.getRandomValues` 拒绝采样生成（跳过 256/62 的偏置），并在写入前检查是否已存在，避免枚举命中。

## 永久、可选 TTL 与撤销

- **默认永久，不设过期**：不传 `ttlSeconds` 时不写 `expirationTtl`，记录里 `expiresAt` 为 `null`，也没有过期判定；KV 会一直保留该记录，直到被撤销。页面没有有效期选择，生成的就是永久链接。
- **显式 TTL 仍支持（仅接口）**：需要自动失效时可以显式传 1 小时 / 1 天 / 7 天 / 30 天（`3600` / `86400` / `604800` / `2592000`）。此时 KV `expirationTtl` 是权威过期时间，读取时再校验一次 `expiresAt` 以覆盖过期记录残留；过期即 404，记录由 KV 自动删除。旧数据里带时间戳的 `expiresAt` 仍按原时间过期，永久记录（`null`）不会。
- TTL 是可选的高级选项，不是推荐默认：面向长期导入的订阅用永久即可，临时分享建议由脚本显式传短 TTL，让链接自己消失。
- **撤销即删除**：`DELETE /api/publish/<token>` 立即 `kv.delete`，不可恢复；永久链接和带 TTL 的链接都一样。撤销后同一 token 立刻 404。
- 页面重新生成会替换当前显示的链接，但**旧链接不会自动失效**：永久链接会一直可用，直到被手动撤销；带 TTL 的旧链接在原 TTL 内仍然可用。换链接后请撤销旧的。
- 永久链接的风险：因为不会自动过期，泄露的链接在被撤销前持续可下载完整配置。默认行为不是“更安全”，而是“不打扰”；请只在确定长期使用时保留永久链接。

## 运维：如何删除一条永久链接

没有管理令牌时，撤销只能由维护者操作 KV：

```bash
npx wrangler kv key delete 's:Ab3dE9kZ' --namespace-id $KV_NAMESPACE_ID --remote
```

（key 名在代码中是 `s:<8 位 token>`；删除后该链接立即 404，无需重新部署。）

## 部署与配置

`wrangler.json` 与 `scripts/deployment.json` 都声明同一个 KV 绑定，缺一不可：

```json
"kv_namespaces": [
  { "binding": "CONFIGS", "id": "$KV_NAMESPACE_ID" }
]
```

- 绑定名就是 Worker 里的 `env.CONFIGS`，namespace id 为 `$KV_NAMESPACE_ID`。
- 该 namespace 必须在部署目标账号里已存在，否则 `wrangler deploy` 直接失败（不会自动创建）。
- 部署令牌（`CF_API_TOKEN`）需要 **Workers KV Storage: Edit** 与 **Workers Scripts: Edit** 权限，否则绑定写入被拒；权限不足时表现为部署时报 “authentication error / unauthorized to access KV namespace”。
- `name` / `main` / `compatibility_date` / `workers_dev` / `preview_urls` / `observability` 保持原值；`routes` 仍只写在 `scripts/deployment.json`（自定义域名是一次性配置），不要加回 `wrangler.json`。
- 部署仍是 `wrangler deploy --config wrangler.json --no-bundle`：绑定随配置生效，无需额外命令，也没有 migrations。

## 上线验收

`scripts/verify-live.mjs` 在原有健康版本、首页契约、静态资源、CSP/nosniff/Referrer-Policy、`/source.tar.gz` gzip、`/api/fetch` 403/405/422/404 护栏之外，新增：

- 首页契约扩到 `#theme-toggle`、`#about-dialog`、`#publish` 与 `src="./theme.js"`，安全头补 `X-Frame-Options: DENY` 与 `object-src 'none'`；
- **资产映射清扫**：导入本次构建的 `src/assets.generated.js`（asset map 由 `public/` 目录生成），逐个 `HEAD` 每个映射路径并比对 `Content-Type`，再把线上 HTML 的 `src="./…"`/`href="./…"` 引用逐个探测 200——既抓“映射里的文件没上线”，也抓“页面引用了没映射的文件”；
- `/source.tar.gz` 不只嗅 gzip 魔数，而是**解压**（gunzip）后确认 tar 内确有 `LICENSE`、`NOTICE.md`、`src/worker.js`、`src/converter.js`、`public/index.html`、`public/theme.js`、`package-lock.json`，防止空包或错包混过；
- 短链发布/撤销护栏：`GET`/`HEAD /s/AAAAAAAA` 必须 404 且 `Cache-Control` 含 `no-store`、不是 HTML；`/s/not-a-token`、`/s/AAAAAAAA/extra` 必须 404；`GET /api/publish` 必须 405 + `Allow: POST`；跨源 `POST /api/publish` 与跨源 `DELETE /api/publish/<token>` 必须 403，且在落库前拒绝（响应里不出现 64 位管理令牌）；

下面三条是永久化时就有的短链探测：

- `GET /s/AAAAAAAA`（一个从未发布过的 8 位 token）必须 **404**；
- 该响应 `content-type` 必须存在且 **不是 `text/html`**，正文里也不能出现 HTML 首行 —— 防止短链路由缺失时回落到网页外壳（那会让“失效链接”看起来像成功）；
- 该响应不得 `Cache-Control: public`。

验收只做只读探测：**不调用 `/api/publish`、不创建任何真实发布内容**，因此不会污染 KV，也不需要在 CI 里提供 KV 写权限。默认改永久后这条探针保持不变：不存在的 token 仍然必须 404，与记录是否设了 TTL 无关；永久记录只是不会再因为 KV 过期而消失，探测不能依赖“过期”来制造 404。

## 合规与提醒

- 短链里是**含节点密码/凭据的完整配置**。生成前请确认对方可信；不要把链接当作“只读分享链接”发给不可信的人。
- **默认永久意味着没有自动回收。** 发出去就等于长期授权，撤销是唯一的下线手段；请把“撤销链接”当作常规操作，而不是等它过期。
- 站点仍是 AGPL-3.0，修改后的完整可构建源码继续通过 `https://sub.fakeyou.eu.org/source.tar.gz` 提供，短链功能不改变这一点，也不把任何用户配置打进源码包。
- 配置文本属于用户数据，不是本项目源码；KV 中存的是用户自己生成的配置文本，撤销即删除（带 TTL 的链接在到期时也删除）。

## 相关改动文件

- `wrangler.json`、`scripts/deployment.json`：新增 `CONFIGS` KV 绑定。
- `scripts/verify-live.mjs`：短链 404 / 非 HTML 探测（永久化后不变，仍不创建发布）。
- `test/deployment-contract.test.mjs`：KV 绑定一致性、无硬编码密钥、短链探测、本文档契约断言（含“默认永久”）。
- `README.md`：使用说明与隐私边界同步（默认永久、显式 TTL 可选、撤销即删除）。
- `src/worker.js`、`public/*`、`test/publish.test.mjs`、`test/api-contract`、`test/ui-contract`：由短链永久化的其他改动负责。
