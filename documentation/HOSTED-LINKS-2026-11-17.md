# 本站托管短订阅链接 — 2026-11-17

在订阅转换页面新增“生成订阅链接”：把刚生成的配置存进 Cloudflare KV，返回一个本站短链，可直接导入 Surge / Mihomo。短链形如 `https://sub.fakeyou.eu.org/s/Ab3dE9kZ`（路径固定为 8 位 `[A-Za-z0-9]` token，示例中为 `Ab3dE9kZ`）。

## 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/publish` | 正文 `{content, target, ttlSeconds?}`，返回 `{url, expiresAt, manageToken}` |
| `GET`/`HEAD` | `/s/<token>` | 返回配置文本（`text/plain; charset=utf-8`），不存在则 404 |
| `DELETE` | `/api/publish/<token>` | 撤销，需请求头 `X-Manage-Token`，成功 204 |

- `target` 只接受 `Surge` / `Mihomo`；空配置、非法 UTF-8、超 2 MiB 均拒绝。
- `ttlSeconds` 只接受 `3600`、`86400`、`604800`（默认）、`2592000`；其它值返回 400，不做静默夹取或截断。
- `POST /api/publish` 与 `DELETE` 共用同一限流桶：每 IP 每 10 分钟 5 次（`/api/fetch` 仍是每分钟 10 次，互不影响）。
- `POST`/`DELETE` 要求同源 `Origin` 且 JSON 请求头，跨源 403，且限流在校验之后（跨源请求不消耗配额）。
- 未绑定 KV 时返回 503「短链接服务未配置」，不会静默退化为一次性下载。

## 凭据模型

**链接即凭据（等同于密码）。** 任何拿到 `/s/Ab3dE9kZ` 的人都能取到完整配置，不需要再输入密码，也没有第二因子，因此：

- 不要把链接贴到公开群组、issue、截图或日志里；泄露后请立刻撤销。
- 链接不写入 URL 之外的任何地方：不上 cookie、不上 localStorage、不进 Worker 日志（`observability.enabled` 仍为 `false`）。
- 管理令牌（`manageToken`，32 字节随机数的十六进制）只在生成时返回一次，页面仅保存在内存中，刷新即失。丢失令牌就无法撤销，只能等 TTL 到期。
- 服务端只保存管理令牌的 **SHA-256 哈希**（`manageHash`），并以定长时间比较；KV 被读也无法还原令牌。KV 记录的字段只有 `content`、`target`、`createdAt`、`expiresAt`、`manageHash` —— 即配置文本 + 元数据 + 令牌哈希，没有 IP、UA、来源 URL 或账号信息。
- `GET /s/<token>` 的响应带 `Cache-Control: private, no-store`、`nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`；非 8 位 token 一律 404，不回显路径、不做目录探测。
- token 用 `crypto.getRandomValues` 拒绝采样生成（跳过 256/62 的偏置），并在写入前检查是否已存在，避免枚举命中。

## TTL 与删除

- **TTL 上限 30 天**（`2592000` 秒）。KV `expirationTtl` 是权威过期时间，读取时再校验一次 `expiresAt` 以覆盖过期记录残留。
- 过期即 404，记录由 KV 自动删除；撤销是立即 `kv.delete`，不可恢复。
- 页面重新生成会把旧链接顶掉（旧链接在 TTL 内仍然可用，直到被手动撤销或过期）。

## 部署与配置

`wrangler.json` 与 `scripts/deployment.json` 都声明同一个 KV 绑定，缺一不可：

```json
"kv_namespaces": [
  { "binding": "CONFIGS", "id": "e7205f12788c4a2098c538a230f8f915" }
]
```

- 绑定名就是 Worker 里的 `env.CONFIGS`，namespace id 为 `e7205f12788c4a2098c538a230f8f915`。
- 该 namespace 必须在部署目标账号里已存在，否则 `wrangler deploy` 直接失败（不会自动创建）。
- 部署令牌（`CF_API_TOKEN`）需要 **Workers KV Storage: Edit** 与 **Workers Scripts: Edit** 权限，否则绑定写入被拒；权限不足时表现为部署时报 “authentication error / unauthorized to access KV namespace”。
- `name` / `main` / `compatibility_date` / `workers_dev` / `preview_urls` / `observability` 保持原值；`routes` 仍只写在 `scripts/deployment.json`（自定义域名是一次性配置），不要加回 `wrangler.json`。
- 部署仍是 `wrangler deploy --config wrangler.json --no-bundle`：绑定随配置生效，无需额外命令，也没有 migrations。

## 上线验收

`scripts/verify-live.mjs` 在原有健康版本、首页契约、静态资源、CSP/nosniff/Referrer-Policy、`/source.tar.gz` gzip、`/api/fetch` 403/405/422/404 护栏之外，新增：

- `GET /s/AAAAAAAA`（一个从未发布过的 8 位 token）必须 **404**；
- 该响应 `content-type` 必须存在且 **不是 `text/html`**，正文里也不能出现 HTML 首行 —— 防止短链路由缺失时回落到网页外壳（那会让“失效链接”看起来像成功）；
- 该响应不得 `Cache-Control: public`。

验收只做只读探测：**不调用 `/api/publish`、不创建任何真实发布内容**，因此不会污染 KV，也不需要在 CI 里提供 KV 写权限。

## 合规与提醒

- 短链里是**含节点密码/凭据的完整配置**。生成前请确认对方可信；不要把链接当作“只读分享链接”发给不可信的人。
- 站点仍是 AGPL-3.0，修改后的完整可构建源码继续通过 `https://sub.fakeyou.eu.org/source.tar.gz` 提供，短链功能不改变这一点，也不把任何用户配置打进源码包。
- 配置文本属于用户数据，不是本项目源码；KV 中存的是用户自己生成的配置文本，撤销/过期即删除。

## 相关改动文件

- `wrangler.json`、`scripts/deployment.json`：新增 `CONFIGS` KV 绑定。
- `scripts/verify-live.mjs`：新增短链 404 / 非 HTML 探测。
- `test/deployment-contract.test.mjs`：新增 KV 绑定一致性、无硬编码密钥、短链探测、本文档契约断言。
- `README.md`：使用说明与隐私边界同步。
- `src/worker.js`、`public/*`、`test/publish.test.mjs`、`test/api-contract`、`test/ui-contract`：由订阅托管功能的其他改动负责。
