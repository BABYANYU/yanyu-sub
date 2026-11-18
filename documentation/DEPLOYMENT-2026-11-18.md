# 构建、源码包与部署验收加固 — 2026-11-18

本轮只改构建/部署/验收层（`scripts/build.mjs`、`scripts/source-archive.mjs`、`scripts/verify-live.mjs`、`scripts/deployment.json`、`wrangler.json`、`.github/workflows/*`、`test/deployment-contract.test.mjs`、`README.md`、`documentation/*`），`src/`、`public/` 与其它测试不动。

## 1. 资产映射改为遍历 `public/`（修“新增文件静默 404”）

**问题：** `scripts/build.mjs` 原来写死 `['index.html','app.js','style.css','converter.js','theme.js']`。往 `public/` 加任何文件（`robots.txt`、`favicon.png`、`icons/*.svg`…）不会进入 `src/assets.generated.js`，Worker 直接按未命中返回 404 JSON，构建与测试全绿——线上才发现资源缺失。

**修复：**

- `collectAssets()` 递归遍历 `public/`，目录里有什么就映射什么；`source.tar.gz` 单独处理（二进制 gzip、base64 传输、**必须存在**）。
- 每个扩展名必须在 `assetTypeFor()` 里声明 Content-Type（文本/二进制分开），**未知扩展名直接让构建失败**，不再猜类型、不再静默跳过。
- `index.html`/`app.js`/`style.css`/`theme.js`/`converter.js` 缺失即失败；生成的 `converter.js` 在映射前构建。
- 测试用临时目录证明“新增文件自动被映射”，并证明缺少必需文件或 `source.tar.gz` 时 `collectAssets()` 抛错。

## 2. 源码包必需文件缺失即失败（修 AGPL 源码包可能不完整）

**问题：** `source-archive.mjs` 的 `selected` 里写着不存在的 `CHANGELOG.md`，`excluded` 里写着不存在的 `scripts/*.cjs`；`walk()` 遇到 `ENOENT` 直接 `return`，所以“清单里少了一半文件”这件事永远不会报警。同时 `public/` 只列了 4 个文件名，新增的 public 源文件不会进包。

**修复：**

- 删除幽灵条目（`CHANGELOG.md`、`scripts/*.cjs`）；`SOURCES` + `REQUIRED_PUBLIC_SOURCES` 全部**先 `lstat` 校验**，缺失则一次性报 `Source archive is missing required paths: …` 并中止构建。
- `public/` 改为整目录遍历，只排除构建产物 `public/converter.js` 与 `public/source.tar.gz`；`theme.js` 等 public 源文件必定进包。
- `GENERATED` 明确列出生成文件；`node_modules`、`dist`、`.wrangler`、`.git`、`.env`/`.dev.vars` 一律拒绝（`Refusing to archive …`），符号链接照样中止。
- `collectSources()` 排序去重（确定性打包），`tarEntryNames()` 给测试/验收复用。
- 测试断言：包内含 `public/theme.js` 与全部 public 源文件、必含 `LICENSE`/`NOTICE.md`/`package-lock.json`/`scripts/*`/`.github/workflows/*`，不含生成物与依赖；临时目录缺 `src` 时 `buildSourceArchive()` 抛错且**不写** `public/source.tar.gz`。

## 3. `scripts/verify-live.mjs` 验收覆盖

原有：`/api/health` 版本轮询、首页契约、静态资源、CSP/nosniff/Referrer-Policy、`/source.tar.gz` gzip 魔数、`/api/fetch` 405/403/422/404、`/s/AAAAAAAA` 404 且非 HTML。

新增（依旧**只读**，不写 KV、不创建发布）：

- 首页契约扩到 `#theme-toggle`、`#about-dialog`、`#publish`、`src="./theme.js"`；安全头补 `X-Frame-Options: DENY` 与 `object-src 'none'`。
- **资产映射清扫**：导入本次构建的 `src/assets.generated.js`，逐个 `HEAD` 每个映射路径并比对 Content-Type；再把线上 HTML 里 `src="./…"`/`href="./…"` 引用逐个探测 200。既抓“映射里的文件没上线”，也抓“页面引用了没映射的文件”，这是第 1 条线上侧的对偶检查。
- `/source.tar.gz` 不只嗅魔数：`gunzipSync` **解压**后检查 tar 里确实有 `LICENSE`、`NOTICE.md`、`src/worker.js`、`src/converter.js`、`public/index.html`、`public/theme.js`、`package-lock.json`，防止空 gzip 或错包混过。
- 短链与发布护栏（永久短链语义，不依赖任何记录过期）：`GET /s/AAAAAAAA`、`HEAD /s/AAAAAAAA` 必须 404 且 `Cache-Control` 含 `no-store` 且不是 HTML；`/s/not-a-token`、`/s/AAAAAAAA/extra` 必须 404；`GET /api/publish` 必须 405 + `Allow: POST`；跨源 `POST /api/publish` 必须 403 且在落库前拒绝（响应不含 64 位十六进制管理令牌）；跨源 `DELETE /api/publish/…` 必须 403。
- 校验逻辑抽成 `export async function verifyLive({base, expectedRevision, fetchImpl, assets, …})`，测试可拿 `src/worker.js` + KV 桩跑通，并证明“资源 404 / 版本不符 / 归档不完整”都会失败——验收脚本自身也受测。

## 4. Workflow 与部署配置一致性

- `.github/workflows/deploy.yml`：并发组 `yanyu-sub-production` + `cancel-in-progress: false`（不中途取消上传），`timeout-minutes: 15`，`permissions: contents: read`，`environment: production`。
- **令牌权限写进 workflow 注释**：`CF_API_TOKEN` 需要 *Workers Scripts: Edit*（上传 Worker）与 **Workers KV Storage: Edit**（每次部署写入 `CONFIGS` 绑定）；缺 KV 权限表现为 `authentication error` / `unauthorized to access KV namespace`，旧版本继续服务、流量不切换。
- **失败可回滚**：部署前 `wrangler deployments list --json` 记录当前 serving 的 `version_id`；上传用 `--tag ci-<sha>` 标记；`verify-live` 失败后执行 `wrangler rollback <version_id> --yes`，再轮询 `/api/health` 与首页确认旧版本恢复。回滚步骤条件为 `if: failure() && steps.deploy.outcome == 'success'`——测试/构建失败时绝不碰生产；首次部署没有回滚目标时明确报错要求人工处理。
- `npm test` 在部署前运行，其中包含 `wrangler.json` ↔ `scripts/deployment.json` 的严格一致性断言：`wrangler.json` 的每个键必须与 `deployment.json` 深相等，`deployment.json` 只允许额外出现 `routes`（自定义域名是 Cloudflare 侧一次性配置，不随每次部署重建）。

## 5. 文档与实现对齐

- 本文件记录上述变更。
- `documentation/HOSTED-LINKS-2026-11-17.md` 的“上线验收”一节补齐本轮新增探测项（资产映射、解压校验、发布/撤销护栏）。
- `documentation/UI-2026-11-17.md` 的验收描述补上 `theme.js` 与资产映射清扫，避免仍写“只校验 3 个资源”。
- `README.md` 维护章节补上“资产映射由 `public/` 目录生成”“源码包缺必需文件会构建失败”“部署失败自动回滚”。

## 验证

- `npm run build`：`Packaged N corresponding source files` + `mapped M assets from public/`（当前 6 个：`index.html`、`app.js`、`style.css`、`theme.js`、`converter.js`、`source.tar.gz`）。
- `npm test`：含本轮新增的资产映射、源码包、verify-live、workflow、文档一致性断言。
- 未推送、未部署；`verify-live.mjs` 的线上探测由下一次 Deploy 执行。
