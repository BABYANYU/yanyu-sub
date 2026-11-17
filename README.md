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

## 隐私和边界

- 直接粘贴的节点在浏览器内转换，不提交给转换 API。
- HTTPS 链接只在 POST 正文提交给本站 Cloudflare Worker 拉取，Cloudflare 和源订阅服务会处理该请求；无第三方公共转换后端。
- 不把订阅写入 KV、D1、R2、浏览器 localStorage；禁用 Worker 可观测日志，不记录完整链接或节点。
- 限制 HTTPS/443、地址检查、零跳转、超时、正文 1 MiB。DNS 预检不是连接级 IP pinning，不能宣称彻底防止 DNS rebinding；Worker 无私网/VPC绑定。
- 本站提供一次性配置下载，不创建持久订阅或自动刷新链接。要更新配置时重新转换。
- 语法转换不等于实际节点连通。Surge VLESS 需要 iOS 6+；部分 Mihomo 内核与新 Xray REALITY 服务端存在兼容性差异。
- 上游 YAML 引用需先展开；仅外部 provider 的配置请先导出实际节点内容。

## 维护

代码与维护记录统一在 GitHub：https://github.com/BABYANYU/yanyu-sub

推送到 `main` 后自动执行：`npm ci` → 构建 → 测试 → 生产依赖审计 → 部署 Worker → 核对线上 `/api/health` 返回的 `revision` 是否等于本次提交。
任一步失败即中断，不会把未通过的版本上线。手动触发在 Actions 页运行 `Deploy`。

`sub.fakeyou.eu.org` 的自定义域名绑定是 Cloudflare 侧的一次性配置，不随每次部署重建；部署令牌只需脚本上传权限。
如需迁移到新账号，先在 CF 绑定域名，再更新 `CF_ACCOUNT_ID` 与 `CF_API_TOKEN` 两个仓库密钥。

回滚：在 Actions 里对上一个成功提交重跑 `Deploy`，或本地 `npx wrangler rollback`。

Node 24：`npm ci --ignore-scripts`，`npm run build`，`npm test`。
`src/converter.js` 为输入校验和固定模板；`src/worker.js` 为同源拉取与静态服务；`public/` 为网页。
`vendor/` 是固定版本的 Sub-Store 解析/输出器子集，三个 Peggy grammar 已预编译，运行时没有动态编译或用户脚本。
上游提交、版本记录在 `vendor/UPSTREAM.json`。修改后先运行测试，再更新 Cloudflare Worker `yanyu-sub`。
保留既有域名、Pages 和其他 Worker，不清理无关项目。

## 许可证

本项目包含并修改 Sub-Store AGPL-3.0 代码，保留其许可证与原作者署名。
对应可构建源码通过站点 `/source.tar.gz` 提供，不包含任何个人订阅、密钥或账号数据。
转换输出的节点配置不是本项目源码，包含你的节点凭据，请自行保管。
