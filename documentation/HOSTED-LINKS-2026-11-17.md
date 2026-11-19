# 托管订阅链接使用指南

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
- 服务端只保存管理令牌的 **SHA-256 哈希**（`manageHash`），并以定长时间比较；KV 被读也无法还原令牌。KV 记录的字段为 `content`、`target`、`createdAt`、`expiresAt`（永久链接为 `null`）、`manageHash`、`ownerHash` —— 即配置文本 + 元数据 + 令牌哈希 + IP 的 SHA-256；没有原始 IP、UA、来源 URL 或账号信息。每个地址最多 100 条存活链接，另维护 30 天过期的 `own:<ownerHash>` 计数键。
- `GET /s/<token>` 的响应带 `Cache-Control: private, no-store`、`nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`；非 8 位 token 一律 404，不回显路径、不做目录探测。
- token 用 `crypto.getRandomValues` 拒绝采样生成（跳过 256/62 的偏置），并在写入前检查是否已存在，避免枚举命中。

## 永久、可选 TTL 与撤销

- **默认永久，不设过期**：不传 `ttlSeconds` 时不写 `expirationTtl`，记录里 `expiresAt` 为 `null`，也没有过期判定；KV 会一直保留该记录，直到被撤销。页面没有有效期选择，生成的就是永久链接。
- **显式 TTL 仍支持（仅接口）**：需要自动失效时可以显式传 1 小时 / 1 天 / 7 天 / 30 天（`3600` / `86400` / `604800` / `2592000`）。此时 KV `expirationTtl` 是权威过期时间，读取时再校验一次 `expiresAt` 以覆盖过期记录残留；过期即 404，记录由 KV 自动删除。旧数据里带时间戳的 `expiresAt` 仍按原时间过期，永久记录（`null`）不会。
- TTL 是可选的高级选项，不是推荐默认：面向长期导入的订阅用永久即可，临时分享建议由脚本显式传短 TTL，让链接自己消失。
- **撤销即删除**：`DELETE /api/publish/<token>` 立即 `kv.delete`，不可恢复；永久链接和带 TTL 的链接都一样。撤销后同一 token 立刻 404。
- 页面重新生成会替换当前显示的链接，但**旧链接不会自动失效**：永久链接会一直可用，直到被手动撤销；带 TTL 的旧链接在原 TTL 内仍然可用。换链接后请撤销旧的。
- 永久链接的风险：因为不会自动过期，泄露的链接在被撤销前持续可下载完整配置。默认行为不是“更安全”，而是“不打扰”；请只在确定长期使用时保留永久链接。

## 合规与提醒

- 短链里是**含节点密码/凭据的完整配置**。生成前请确认对方可信；不要把链接当作“只读分享链接”发给不可信的人。
- **默认永久意味着没有自动回收。** 发出去就等于长期授权，撤销是唯一的下线手段；请把“撤销链接”当作常规操作，而不是等它过期。
- 站点仍是 AGPL-3.0，修改后的完整可构建源码继续通过 `https://sub.fakeyou.eu.org/source.tar.gz` 提供，短链功能不改变这一点，也不把任何用户配置打进源码包。
- 配置文本属于用户数据，不是本项目源码；KV 中存的是用户自己生成的配置文本，撤销即删除（带 TTL 的链接在到期时也删除）。
