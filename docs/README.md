# 早期研究资料

- [逆向设计文档](./reverse-design-notes.md)
- [实现文档](./implementation-notes.md)
- 下载包：research/third-party-grader.crx
- 解包目录：research/extension2/
- 版本追踪：在仓库根目录 `pnpm install` 后（会装好 tools/ 里的 prettier），运行 `python3 -I tools/track_third_party_grader.py`，查询 Edge 商店最新版，有新版就下载到 research/versions/<版本>/，并生成 report.md（与上一版对比域名、接口、适配器路由和选择器的变化）和 *.diff（格式化后的代码差异）
