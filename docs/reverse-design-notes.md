# 第三方扩展行为研究：逆向设计文档

## 范围与证据

本文档基于 2026-10-10 从 Microsoft Edge Add-ons 获取的第三方阅卷扩展 1.9.13 CRX3 安装包整理。原始包位于 research/third-party-grader.crx，解包目录为 research/extension2/。商店页面显示开发者 第三方开发者，更新时间 2026-09-27。本文只提炼可验证行为和独立实现边界，不复制原扩展的品牌、密钥、账号体系或受版权保护代码。

## 已确认能力

- 对多个在线阅卷平台注入内容脚本，支持语文、历史、地理、道法、数学、英语。
- 覆盖阅读理解、高中作文、语言文字运用、诗歌鉴赏、古诗文翻译、论述题。
- 读取题目、答卷图像、评分控件和题号；请求 OCR、建议分、理由和置信度。
- 将结果写回评分控件，支持自动给分、半自动确认、提交下一份。
- 弹窗包含登录/扫码、兑换码、剩余次数、订单/充值、历史任务、设置和帮助。
- 使用扩展本地存储保存登录令牌、设置、适配域名和客户端追踪 ID。

## 逆向结构

| 组件 | 文件 | 结论 |
| --- | --- | --- |
| Service worker | background.js | 网络代理、消息路由、动态适配注册、安装初始化 |
| 内容脚本 | content.js + content.css | 平台识别、DOM/图片观察、任务编排、写分和浮层 |
| MAIN world | insert.js | 页面主世界兼容逻辑 |
| Popup | index.html + assets/index-ef40aaba.js | 账户、任务、支付、设置 UI |

Manifest V3；权限为 storage、declarativeContent、activeTab，可选 scripting；主机权限为 http://*/* 与 https://*/*。第一组内容脚本约 261 条匹配规则，all_frames=true，普通脚本 document_idle；MAIN world 脚本 document_start。

## 服务接口证据

服务根地址为 https://api.third_party_grader.com/。可确认接口：

- 任务：/v1/judge/judge、/v1/judge/createTask、/v1/judge/ocr、/v1/judge/taskInputOcr、/v1/judge/taskInputOptimize、/v1/judge/taskInputCheck、/v1/judge/updateTask、/v1/judge/getTaskInfo、/v1/judge/submitScore。
- 账号：/v1/judge/account/loginscene、/v1/judge/account/loginstatus、/v1/judge/account/get_user_count。
- 兑换/支付：/v1/order/wechatpay_create_order、/v1/order/get_gifts_info、/v1/order/cdkey/exchange_cdkey、/v1/pay/card_info、/v1/pay/create_order、/v1/pay/cancel_order、/v1/pay/activate_card。
- 适配与分析：/v1/judge/platformInfo、/v1/judge/getQuestionTypes、/v1/judge/setting、/v1/judge/pluginVerion、/v1/judge/reportCompatInfo、/v1/judge/automatorCreate、/v1/judge/automatorUpdate。
- 审计与记录：/v1/judge/getUserRecords、/v1/privacy/query_audit_log、/v1/privacy/create_audit_log、/v1/judge/reportMetricLogs。

## 独立复刻架构

阅卷页面 -> 内容脚本 -> 平台适配器 -> 任务状态机 -> Service Worker -> 评分 API

平台适配器负责 matches、readQuestion、readAnswer、readScoreControls、setScore、goNext；任务编排负责去重、取消、重试、超时、额度预检和缓存；界面层不直接访问第三方 DOM。

## 非功能与风险

- 默认人工确认；自动提交必须显式开启并二次确认。
- DOM 变化或无法唯一定位评分控件时停止写分。
- 学生答卷按敏感教育数据处理，传输前脱敏，服务端加密并设置 TTL。
- 第三方平台可能禁止自动化或高频访问，必须先获得授权。
- 独立实现使用新品牌、新接口和可审计实现，不发布原包修改版。
