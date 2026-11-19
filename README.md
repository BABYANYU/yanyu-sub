# Yanyu Sub

订阅格式转换站：<https://sub.fakeyou.eu.org/>。将订阅转换为 Surge 或 Mihomo 配置，供 iPhone 上的 Surge、Windows 上的 Bettbox 等兼容客户端使用。

## 使用与安装

先在设备上安装 Surge 或 Mihomo 兼容客户端（例如 Windows 上的 Bettbox），然后：

1. 粘贴 HTTPS 订阅链接，或直接粘贴节点文本。
2. 选择 Surge 或 Mihomo，生成配置后下载或复制。
3. 在客户端导入文件，或粘贴配置文本。

输出使用固定简洁模板：包含手动选择组 `Proxy`、DNS `223.5.5.5`，以及国内直连、其余流量走 `Proxy` 的规则。原配置中的其他策略组、规则、脚本、MITM 和外部 provider 不会继承。

支持常见节点 URI、Base64 URI、Mihomo YAML 内联 `proxies` 和 Surge `[Proxy]` 节点。每次可添加 1–4 个来源，最多处理 2,000 个节点；单个输入上限为 1 MiB，节点名称最长 120 个字符。YAML 引用需预先展开；外部 provider 需先导出实际节点。遇到不支持的节点时会停止生成，不会静默丢弃；节点名称中与 Surge 语法冲突的符号会转为空格，重名节点会加序号。配置生成不代表节点连通性已验证。

## 托管分享链接

生成配置后可选择“生成订阅链接”，得到形如 `https://sub.fakeyou.eu.org/s/Ab3dE9kZ` 的短链，可直接作为订阅地址使用。短链默认永久有效，页面不提供有效期选项；永久记录没有 KV 过期时间（不写 `expirationTtl`）。旧链接不会因重新生成而自动失效。

**链接即凭据：**任何拿到链接的人都能下载完整配置，其中可能包含节点密码和凭据。泄露后请立即撤销；永久链接只有撤销后才会失效。

管理令牌只在创建时返回一次，页面仅暂存在当前会话内存。请立即妥善保存；令牌丢失或刷新页面后，无法再用该令牌撤销链接。撤销会删除托管记录。

### API

- `POST /api/publish`：正文为 `{ "content": "配置文本", "target": "Surge" }` 或将 `target` 设为 `Mihomo`；返回 `url`、`manageToken`、`expiresAt`。`ttlSeconds` 可省略（永久），也可显式设为 `3600`、`86400`、`604800` 或 `2592000`。
- `GET` / `HEAD /s/<token>`：读取托管配置。
- `DELETE /api/publish/<token>`：携带 `X-Manage-Token: <manageToken>` 撤销链接。

```sh
curl -X POST 'https://sub.fakeyou.eu.org/api/publish' \
  -H 'Origin: https://sub.fakeyou.eu.org' \
  -H 'Content-Type: application/json' \
  --data '{"content":"配置文本","target":"Surge"}'

curl -X DELETE 'https://sub.fakeyou.eu.org/api/publish/<token>' \
  -H 'Origin: https://sub.fakeyou.eu.org' \
  -H 'Content-Type: application/json' \
  -H 'X-Manage-Token: <manageToken>'
```

API 使用、响应字段、限制和管理说明见[托管链接 API 与管理指南](documentation/HOSTED-LINKS-2026-11-17.md)。该指南面向用户，不是维护日志。

## 隐私与存储

- 直接粘贴的节点文本在浏览器内转换，不提交给转换 API。HTTPS 订阅 URL 会在 POST 正文中提交给本站 Cloudflare Worker，由 Worker 拉取；Cloudflare 与订阅源服务会处理该请求。本服务不使用第三方公共转换后端。
- 默认不保存配置。只有主动创建托管链接时，配置文本与格式、时间戳、管理令牌的 SHA-256 哈希及用于链接数量限制的 IP SHA-256 才会写入 Cloudflare KV（`CONFIGS`）。不保存原始 IP、UA 或来源 URL；不写入 D1、R2 或浏览器 `localStorage`，Worker 可观测日志关闭。
- 每个 IP 地址最多保留 100 条存活链接。永久记录只在撤销时删除；显式设置有效期的记录在到期或撤销时删除。短链响应设为 `private, no-store` 和 `noindex`。
- URL 拉取仅接受 HTTPS/443，限制跳转、超时与正文大小，并进行地址检查。DNS 预检并非连接级 IP pinning。
- 明文 HTTP 请求（loopback 除外）会重定向到 HTTPS。

## 许可证

本项目代码按 **AGPL-3.0-only** 发布；第三方组件来源与许可见 `LICENSE`、`vendor/LICENSE` 和 `NOTICE.md`。可构建源码通过站点 [`/source.tar.gz`](https://sub.fakeyou.eu.org/source.tar.gz) 提供。生成的节点配置属于用户数据，不是本项目源码；含有节点凭据时请妥善保管。
