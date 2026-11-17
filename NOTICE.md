# 来源与署名

Yanyu Sub 是 BABYANYU 维护的订阅格式转换站。

解析器、协议输出器和节点规范化代码来自 Sub-Store：
https://github.com/sub-store-org/Sub-Store

固定上游版本 2.44.16，提交 2a173b88dcbd7d232864f05087998855da59eec1。
保留上游源码版权与仓库 LICENSE（GNU AGPL v3）。

本站新增界面、固定配置模板、请求策略和部署脚本同按 AGPL-3.0-only 分发。
预编译的 Peggy 解析器来自上游 grammar，不在浏览器/Worker 中运行动态编译器。
上游许可证副本一并保留在 `vendor/LICENSE`。

**修改声明（AGPL-3.0 §5(a)）**：本项目于 2026-11-17 基于上述固定提交修改：
删除了日志/数据库/远程脚本执行/OpenAPI 等管理与运行时代码，仅保留解析器、协议输出器和节点规范化；
把三个 Peggy grammar 在构建期预编译为静态模块；新增固定 Surge/Mihomo 模板、来源校验和同源拉取接口。
修改后的完整源码随项目发布，不含任何订阅、节点或账户数据。

`vendor/UPSTREAM.json` 记录来源；`vendor/normalizer.js` 的证书文件读取功能禁用（浏览器环境），证书指纹派生不支持时明确报错。
本应用没有将用户订阅写入源码；源码公开不包含用户节点或订阅数据。
