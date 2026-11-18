# Yanyu Sub

部署域名：https://sub.fakeyou.eu.org/

只生成 Surge（iPhone）和 Mihomo（Windows Bettbox）两种完整配置：

- 一个手动选择组 `Proxy`，包含全部节点。
- DNS：`223.5.5.5`。
- Mihomo 规则：`GEOIP,cn,DIRECT`、`MATCH,Proxy`。
- Surge 规则：`GEOIP,CN,DIRECT`、`FINAL,Proxy`。

## 使用

粘贴订阅 HTTPS 链接或节点文本，可添加多个来源；选择格式，生成后下载或复制。
支持常见 URI、Base64 URI、Mihomo YAML 的内联 `proxies` 和 Surge `[Proxy]` 节点。
输入配置里的其他策略组、规则、脚本、MITM、外部 provider 不会继承，输出固定使用上面的简洁模板。
不支持的节点会阻止生成，不静默删掉节点。名称中与 Surge 语法冲突的符号会换成空格，重名加序号。

### 订阅链接（本站托管）

生成配置后可点“生成订阅链接”，得到形如 `https://sub.fakeyou.eu.org/s/Ab3dE9kZ` 的短链（8 位 token），可直接导入 Surge / Mihomo。**默认永久有效、不过期**：页面只生成永久链接，没有有效期选项。接口 `POST /api/publish` 仍接受显式 `ttlSeconds`（1 小时 / 1 天 / 7 天 / 30 天），供脚本或旧调用方使用，不是 UI 默认，也不是推荐默认。链接可随时在本页撤销。

- **链接即凭据**：任何拿到链接的人都能下载完整配置，无需再输密码。配置含你的节点密码/凭据，不要公开分享。**永久链接不会自己失效，撤销即删除**：泄露后必须立即撤销，撤不掉就一直可用。
- 撤销用的管理令牌只在生成时返回一次，仅存在于当前页面内存；丢失即无法撤销。永久链接没有“等它过期”这条兜底路径，只能请维护者在 KV 里删除该 key。
- KV 保存配置文本、格式、时间戳、**管理令牌的 SHA-256 哈希**，以及 **IP 的 SHA-256**（仅用于每地址 100 条存活链接的上限，不保存原始 IP）；永久链接的记录不写 `expirationTtl`（KV 无过期时间），不存 UA 或来源 URL。
- 接口：`POST /api/publish`、`GET|HEAD /s/<token>`、`DELETE /api/publish/<token>`（`X-Manage-Token`）。详见 [documentation/HOSTED-LINKS-2026-11-17.md](documentation/HOSTED-LINKS-2026-11-17.md)。

## 隐私和边界

- 直接粘贴的节点在浏览器内转换，不提交给转换 API。
- HTTPS 链接只在 POST 正文提交给本站 Cloudflare Worker 拉取，Cloudflare 和源订阅服务会处理该请求；无第三方公共转换后端。
- 默认不保存任何配置：只有你主动点“生成订阅链接”时，才把该配置文本、格式、时间戳和管理令牌哈希写入 Cloudflare KV（`CONFIGS`）；永久链接不设过期时间，只在撤销时删除，用接口显式设了有效期的记录在到期或撤销时删除；不写 D1、R2、浏览器 localStorage，禁用 Worker 可观测日志，不记录完整链接或节点。
- 短链 token 即凭据；KV 里没有原始 IP、UA 或来源地址（只存 IP 哈希与一个 30 天过期的计数键）。每个地址最多 100 条存活链接，超出需先撤销；`/s/` 响应 `private, no-store` 且 `noindex`。所有明文 HTTP 请求（loopback 除外）都会 301 到 HTTPS。
- 限制 HTTPS/443、地址检查、零跳转、超时、正文 1 MiB。DNS 预检不是连接级 IP pinning，不能宣称彻底防止 DNS rebinding；Worker 无私网/VPC绑定。
- 一次性下载为默认行为；只有选择“生成订阅链接”才会创建可撤销的托管短链，托管短链默认永久有效，页面不提供有效期选项；接口调用方仍可显式传 1 小时 / 1 天 / 7 天 / 30 天让该条链接自动失效。它不会自动刷新内容或跟随源订阅更新：内容变了请重新生成并撤销旧链接。
- 永久托管意味着你写入的内容会一直留在 KV 里，直到你撤销。长期不用的链接请主动撤销，避免旧凭据长期可下载。
- 语法转换不等于实际节点连通。Surge VLESS 需要 iOS 6+；部分 Mihomo 内核与新 Xray REALITY 服务端存在兼容性差异。
- 源订阅中的 YAML 引用需先展开；仅外部 provider 的配置请先导出实际节点内容。

## 维护

代码与维护记录统一在 GitHub：https://github.com/BABYANYU/yanyu-sub

推送到 `main` 后自动执行：`npm ci` → 构建 → 测试 → 生产依赖审计 → 部署 Worker → 核对线上 `/api/health` 返回的 `revision` 是否等于本次提交。
任一步失败即中断，不会把未通过的版本上线。手动触发在 Actions 页运行 `Deploy`。

`sub.fakeyou.eu.org` 的自定义域名绑定是 Cloudflare 侧的一次性配置，不随每次部署重建；部署令牌需要脚本上传权限（见下）。
订阅短链依赖 KV 绑定 `CONFIGS`（namespace `$KV_NAMESPACE_ID`），已写入 `wrangler.json` 与 `scripts/deployment.json`：namespace 必须先在部署账号里创建，且 `CF_API_TOKEN` 需要 **Workers KV Storage: Edit** 权限，否则部署会因绑定失败而中断（功能本身在未绑定时返回 503，不会退化上传）。
如需迁移到新账号，先在 CF 绑定域名，再更新 `CF_ACCOUNT_ID` 与 `CF_API_TOKEN` 两个仓库密钥。

回滚：`Deploy` 在上传前会记录当前线上版本，`verify-live.mjs` 失败时自动 `wrangler rollback` 回上一版并轮询 `/api/health` 确认恢复；也可以手动在 Actions 里对上一个成功提交重跑 `Deploy`，或本地 `npx wrangler rollback`。生产部署串行执行（同一 concurrency 组、不中途取消）、限时 15 分钟。

构建与源码包（`npm run build`）：
- 资产映射由 `public/` 目录**整目录生成**，不再写死文件名：新增 `public/` 文件自动上线；扩展名没有声明 Content-Type 或缺少 `index.html`/`app.js`/`style.css`/`theme.js`/`converter.js`/`source.tar.gz` 时直接构建失败，避免新增文件静默 404。
- `public/source.tar.gz`（完整可构建源码）会把 `public/` 源文件（含 `theme.js`）全部打进去，生成物与依赖排除；清单里任何一个必需文件缺失都会中止构建，不再静默跳过。

Node 24：`npm ci --ignore-scripts`，`npm run build`，`npm test`。
`src/converter.js` 为输入校验和固定模板；`src/worker.js` 为同源拉取与静态服务；`public/` 为网页。
`vendor/` 是固定版本的第三方解析/输出器子集，三个 Peggy grammar 已预编译，运行时没有动态编译或用户脚本。
第三方组件的版本记录在 `vendor/UPSTREAM.json`。修改后先运行测试，再更新 Cloudflare Worker `yanyu-sub`。
保留既有域名、Pages 和其他 Worker，不清理无关项目。

## 许可证

代码版权归 YANYU。第三方组件的许可证见 `LICENSE` 与 `NOTICE.md`，不在本 README 展开。
对应可构建源码通过站点 `/source.tar.gz` 提供，不包含任何个人订阅、密钥或账号数据。
转换输出的节点配置不是本项目源码，包含你的节点凭据，请自行保管。
