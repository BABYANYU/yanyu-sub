# 来源与署名

Yanyu Sub 是 BABYANYU 维护的订阅格式转换站。

解析器、协议输出器和节点规范化代码来自 Sub-Store：
https://github.com/sub-store-org/Sub-Store

固定上游版本 2.44.16，提交 2a173b88dcbd7d232864f05087998855da59eec1。
保留上游源码版权与仓库 LICENSE（GNU AGPL v3）。

本站新增界面、固定配置模板、请求策略和部署脚本同按 AGPL-3.0-only 分发。
预编译的 Peggy 解析器来自上游 grammar，不在浏览器/Worker 中运行动态编译器。

`vendor/UPSTREAM.json` 记录来源；`vendor/normalizer.js` 的证书文件读取功能禁用（浏览器环境），证书指纹派生不支持时明确报错。
本应用没有将用户订阅写入源码；源码公开不包含用户节点或订阅数据。
