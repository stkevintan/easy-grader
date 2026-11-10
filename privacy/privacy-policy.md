# Easy Grader 阅卷助手 · 隐私政策

**生效日期：2026 年 11 月 10 日**

## 摘要

- 扩展不投放广告、不出售数据，也不做用户画像。
- 扩展只与部署方自己配置的 Easy Grader 服务端通信。
- 服务端默认不保存答卷图片，只保存图片哈希用于去重。
- 登录令牌和设置只保存在浏览器本地，退出登录即清除令牌。
- 学生答卷数据由部署该服务端的学校或阅卷组织方管理。

## 1. 适用范围

本政策适用于浏览器扩展「Easy Grader 阅卷助手」（以下简称“扩展”）以及配套的 Easy Grader 服务端（以下简称“服务端”）。扩展用于在网页阅卷平台上辅助老师批阅主观题：读取当前答卷图片，请求 AI 建议分和理由，由老师确认后把最终分数写回平台。

本扩展面向老师、阅卷人员和管理员，不面向学生直接使用。

## 2. 我们处理哪些信息

- **账号信息：**注册或登录时提交的用户名和密码。密码仅用于向服务端验证身份，扩展不保存密码明文；服务端保存的是密码的 scrypt 哈希值。
- **阅卷内容：**当前答卷图片、题目文本、参考答案、评分标准、AI 建议分、置信度、评分理由，以及老师最终确认的分数。
- **设置与站点授权：**服务端地址、自动阅卷的置信度阈值和间隔、用户主动启用的阅卷站点列表。
- **运行日志：**服务端可能记录请求时间、错误信息和评分耗时，用于故障排查、额度核算和安全防护。

## 3. 信息如何使用

- 读取答卷图片并请求 AI 建议分和理由；
- 在老师确认后把最终分数写回阅卷平台；
- 保存评分记录、额度流水，并生成管理员统计；
- 排查故障、防止滥用和保障服务安全。

我们不会把上述信息用于广告、用户画像、信用评估或出售。

## 4. 数据流向与第三方

扩展只与用户在扩展中配置的 Easy Grader 服务端通信，不直接连接 AI 模型服务商。服务端会把当前答卷图片、题目和评分标准文本发送给部署方在服务端配置的 OpenAI 兼容模型服务商（例如 DeepSeek、通义千问等），用于生成建议分。

具体使用哪家模型服务商、数据存储在哪个地区，由服务端部署方决定。除模型服务商和部署方使用的云主机、对象存储等基础设施外，我们不会向其他第三方提供这些信息，除非法律法规要求。

## 5. 存储与保留

- **扩展本地：**登录令牌、账号信息和设置保存在浏览器的 `chrome.storage.local` 中。退出登录会清除令牌和账号信息。
- **服务端：**账号、题目和评分记录保存在部署方的 SQLite 数据库中。默认只保存答卷图片的 SHA-256 哈希用于去重，不保存图片本身。
- **离线评测：**如果部署方在服务端开启 `SAVE_TRACES`，答卷图片和模型输出会保存到部署方自己的本地磁盘，用于评估评分质量。该开关默认关闭。
- **保留期限：**由部署方（学校或阅卷组织方）根据阅卷、成绩统计和审计需要决定，通常为完成上述目的所需的最短时间。

## 6. 安全措施

- 生产环境应通过 HTTPS 访问服务端；扩展在发布版中固定使用 HTTPS 服务端地址。
- 密码使用 scrypt 哈希保存；登录令牌带版本号，修改密码或停用账号后旧令牌立即失效。
- 数据访问限于部署方管理员和授权老师；管理员操作通过账号和权限控制。
- 任何系统都无法保证绝对安全。如发现安全问题，请通过下方联系方式告知部署方。

## 7. 你的权利

- 老师和管理员可以通过服务端管理后台查看、更正或删除评分记录，管理账号和额度。
- 你可以随时退出登录、在扩展设置中停用站点并撤销该站点的访问权限，或直接停用/卸载扩展。
- 学生如需查询、更正或删除自己的答卷数据，请联系所在学校或阅卷组织方（即服务端部署方）。
- 如需行使其他权利，请通过下方联系方式联系部署方。

## 8. 未成年人

本扩展由老师和阅卷人员使用。学生答卷数据由部署方在学校教学和阅卷场景中处理。如涉及未成年人，部署方应按照当地法律法规和学校制度取得必要授权，并采取相应的保护措施。

## 9. 政策更新

我们可能根据功能变化或法律要求更新本政策。更新后的版本会在本页面顶部标注新的生效日期；涉及重大变更时，部署方应通过适当方式通知使用者。

## 10. 联系方式

- 运营者：Kevin
- 联系邮箱：stkevintan@hotmail.com

## English summary

Easy Grader is a grading assistant for teachers. It processes account credentials, the current answer image, question and rubric text, and scores in order to request an AI-suggested grade and write the teacher-confirmed score back to the grading page.

The extension communicates only with the Easy Grader server configured by the deployer. The server may forward answer content to the AI model provider chosen by the deployer. Data is not sold, used for advertising, or used for profiling. Login tokens and settings are stored locally in the browser. Answer images are not stored by the server by default; only a SHA-256 hash is kept for de-duplication. Student data is controlled by the deploying school or grading organization.

Contact: stkevintan@hotmail.com
