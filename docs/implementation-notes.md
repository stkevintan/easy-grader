# 独立阅卷助手：实现文档

## 技术栈与目录

推荐 Chrome/Edge Manifest V3、TypeScript + Vite、Vue 3 + Element Plus；服务端可用 Node.js/Fastify 或 Go，PostgreSQL 保存任务元数据，对象存储保存短期图片。

目录：src/background（service worker、消息路由、API 客户端）；src/content（入口、平台适配器、任务状态机、浮层）；src/popup（账户、任务、设置 UI）；src/shared（协议与存储）；server/routes（judge/account/billing）；tests（fixture 与协议测试）。

## 最小清单与协议

Manifest 只声明 storage、activeTab 和授权域名；生产环境使用域名 allowlist，不照搬原扩展的全网 host 权限。

JudgeRequest 包含 taskId、adapter、subject、question、answerText、answerImageUrl、rubric；JudgeResult 包含 score、maxScore、confidence、reasons、warnings、modelVersion。Service worker 只接受 judge.create、judge.status、judge.cancel、account.get、settings.get、settings.set；未知命令拒绝。

任务结构对齐咖喱阅卷的 `taskInfo`：`{ taskId, judgeId, exam: { exam, subject, q_index }, question: { type, content: { score, title, reference, command, … } }, majorInput: { key, name, content } }`；评分结果用 `gradingId`、`score`、`reason`、`ocr`、`modifiedScore`、`isAuto`，分别对应原版的 `grading_id`、`score`、`reason`、`ocr`、`modified_score`、`is_auto`。数据库的扁平列（examTitle、questionNo 等）继续用于索引和提示词，JSON 列是任务结构的来源。

## 适配器契约

每个平台实现：id、matches、detect、readQuestion、readAnswer、readScoreControls、setScore、goNext。使用稳定语义选择器和 MutationObserver；导航、题号变化、图片 src 变化后重新建立快照；找不到唯一评分控件时停止并提示人工处理。

## 任务状态机

IDLE -> COLLECTING -> READY -> RUNNING -> RESULT；任意阶段可进入 BLOCKED 或 CANCELLED。RUNNING 使用 AbortController、超时和指数退避；RESULT 展示建议分、理由、置信度和风险提示。

## 数据、安全、测试与验收

只保存短期 accessToken、settings、adapterOverrides、clientTraceId 和任务摘要；原始答卷和图片不写入 chrome.storage.local。服务端校验扩展/适配器版本、图片大小、内容类型、请求频率和授权状态；支付凭证不保存在扩展内。

测试覆盖适配器 fixture、未知命令拒绝、超时取消、幂等、安全策略、日志脱敏和授权测试平台冒烟。验收要求：稳定识别题目/答卷/评分框；服务异常、DOM 变化或低置信度时不会写分；用户可查看理由、修改、取消和删除历史；权限、域名、保留期和人工复核责任可见。
