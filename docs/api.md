# API 参考

服务端默认监听 `http://127.0.0.1:3000`，所有接口在 `/api` 下，请求和响应均为 JSON。

- 需要登录的接口带 `Authorization: Bearer <token>`。
- token 由 `/api/auth/login` 或 `/api/auth/register` 返回，默认 7 天过期；改密码、被停用后旧 token 立即失效。
- 管理接口还要求用户 `role = admin`。
- 分页参数：`page` 从 1 开始（默认 1），`pageSize` 默认 20、最大 100。
- 扩展在每个请求上带 `X-EG-Version: <扩展版本>`。功能开关 `min_extension_version` 不为空时，版本更低或没带这个头的 `POST /api/judge`、`POST /api/records/:gradingId/confirm` 返回 `426`。
- 限流：默认每用户/IP 每分钟 120 次；`/api/auth/*` 10 次；`/api/judge` 30 次。超限返回 `429`。

## 错误格式

```json
{
  "statusCode": 400,
  "message": "请填写满分（0.5–200）",
  "error": "Bad Request"
}
```

| 状态码 | 含义 |
| --- | --- |
| `400` | 参数不合法、余额不足、分数超过满分、兑换码/邀请令牌无效 |
| `401` | 未登录、token 过期或已失效 |
| `403` | 无权限、账号被停用、未开放注册 |
| `404` | 资源不存在（任务、记录、预设、用户等） |
| `426` | 扩展版本低于 `min_extension_version`，响应体额外带 `code: "EXTENSION_OUTDATED"`、`minVersion` |
| `429` | 触发限流 |
| `502` | 模型输出无法解析 |
| `503` | 模型上游持续失败/不可用 |

## 公共接口

### `GET /api/health`

探测服务和模型配置；不需要登录。

```json
{
  "ok": true,
  "name": "easy-grader",
  "version": "0.1.0",
  "allowRegister": true,
  "model": "qwen-vl-max"
}
```

未配置模型时 `model` 为 `mock`。

### `POST /api/auth/register`

注册必须携带邀请令牌；令牌由管理员创建，注册后用户自动加入令牌所属的管理单元。

```json
{
  "username": "e2e_teacher",
  "password": "password-123",
  "inviteToken": "EGI-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

响应 `201`：

```json
{
  "token": "<jwt>",
  "user": { "id": 2, "username": "e2e_teacher", "role": "user", "credits": 5, "createdAt": "..." }
}
```

`ALLOW_REGISTER=false` 时返回 `403`。

### `POST /api/auth/login`

```json
{ "username": "e2e_teacher", "password": "password-123" }
```

响应 `200`，结构同注册。

### `GET /api/meta`

返回可选的学科和分数步长，供扩展/管理后台渲染下拉框。

```json
{ "subjects": ["语文", "数学", "英语", "历史", "地理", "道德与法治", "政治", "物理", "化学", "生物", "其他"], "scoreSteps": [0.5, 1, 2, 5] }
```

## 账号与额度

### `GET /api/auth/me`

返回当前用户：

```json
{ "id": 2, "username": "e2e_teacher", "role": "user", "credits": 18, "createdAt": "..." }
```

### `POST /api/auth/password`

```json
{ "oldPassword": "password-123", "newPassword": "新密码示例" }
```

响应 `200`，返回新的 `{ token, user }`；旧 token 立即失效。

### `POST /api/billing/redeem`

```json
{ "code": "EG-AB12-CD34" }
```

响应 `200`：

```json
{ "credits": 10, "balance": 28 }
```

同一个用户对同一个兑换码只能使用一次。

### `GET /api/billing/ledger?limit=50`

返回当前用户额度流水，`limit` 默认 50、最大 200。

```json
{
  "balance": 18,
  "items": [
    { "id": 9, "userId": 2, "delta": -1, "balanceAfter": 18, "reason": "judge", "refId": 31, "note": "任务 #4", "createdAt": "..." }
  ]
}
```

## 任务

任务结构对齐咖喱阅卷的 `taskInfo`：

```json
{
  "taskId": 12,
  "judgeId": "j_0123456789abcdef0123456789abcdef",
  "platformHost": "mark.xiaoxianai.cn",
  "scoreStep": 1,
  "exam": {
    "exam": "2026 秋季期中考试 高二语文",
    "subject": "语文",
    "q_index": "17"
  },
  "question": {
    "type": "阅读理解",
    "content": {
      "score": 6,
      "title": "概括文章内容",
      "reference": "思念外婆，怀念乡村生活",
      "command": "答出一点得 2 分，答出三点得满分"
    }
  },
  "majorInput": {
    "key": "command",
    "name": "评分细则",
    "content": "答出一点得 2 分，答出三点得满分"
  }
}
```

`question.content.score` 必填，范围 0.5–200；`majorInput` 省略时默认取 `question.content.command`。`majorInput.key` 指向 `question.content` 中的一个文本字段，不能是 `score`；只有显式传 `majorInput.content` 时才覆盖该字段，其他字段保持不变。

### `GET /api/tasks/lookup`

按平台 + 考试 + 题号找上次保存的任务（断点续阅）。

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `platformHost` | 是 | 平台 host |
| `exam` | 是 | `exam.exam` |
| `q_index` | 是 | 题号 |

```json
{ "task": { "taskId": 12, "judgeId": "j_...", "exam": { "...": "..." }, "question": { "...": "..." }, "majorInput": { "...": "..." } } }
```

没有找到时返回 `{ "task": null }`。

### `PUT /api/tasks`

按 `userId + platformHost + exam.exam + q_index` upsert：存在则更新，不存在则新建；新建时签发 `judgeId`。

```json
{
  "platformHost": "mark.xiaoxianai.cn",
  "exam": { "exam": "2026 秋季期中考试 高二语文", "subject": "语文", "q_index": "17" },
  "question": {
    "type": "阅读理解",
    "content": {
      "score": 6,
      "title": "概括文章内容",
      "reference": "思念外婆，怀念乡村生活",
      "command": "答出一点得 2 分，答出三点得满分"
    }
  },
  "majorInput": { "key": "command", "name": "评分细则", "content": "答出一点得 2 分，答出三点得满分" },
  "scoreStep": 1
}
```

`scoreStep` 可选，取值 `0.5` / `1` / `2` / `5`，默认 `1`。响应为完整的任务对象，包含 `taskId` / `judgeId`。

旧版的扁平字段（`examTitle`、`questionNo`、`maxScore` 等）已移除，带这些字段会返回 `400`。

### `GET /api/tasks`

返回当前用户的任务列表，按更新时间倒序，最多 200 条。每项是任务对象，另加：

| 字段 | 说明 |
| --- | --- |
| `judged` | 已完成的评分记录数 |
| `confirmed` | 已确认的评分记录数 |

### `GET /api/tasks/:id`

返回单个任务对象。

### `DELETE /api/tasks/:id`

删除任务，并连带删除它的评分记录。

```json
{ "ok": true }
```

## 评分

### `POST /api/judge`

```json
{
  "taskId": 12,
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "force": false
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `taskId` | 是 | 任务 ID |
| `image` | 是 | `data:image/png;base64,...`，支持 png/jpeg/webp；默认最大 4 MiB（`MAX_IMAGE_BYTES`） |
| `force` | 否 | 为 `true` 时跳过同图缓存，重新评分并扣费 |

同一用户、同一任务、同一张图（按 SHA-256）默认直接返回上次结果，`cached: true`，不扣次数；并发相同请求会合并成一次。

响应 `200`：

```json
{
  "gradingId": "g_0123456789abcdef0123456789abcdef",
  "taskId": 12,
  "score": 4,
  "maxScore": 6,
  "reason": "答出思念外婆，得 4 分",
  "ocr": "作者思念外婆，怀念乡村生活……",
  "modifiedScore": null,
  "isAuto": false,
  "confidence": 0.82,
  "reasons": ["答出思念外婆 +4"],
  "comment": "要点基本完整",
  "model": "qwen-vl-max",
  "cached": false,
  "balance": 18,
  "samples": [4, 4, 5],
  "scoreSpread": 1
}
```

- `reason` 是理由的文本形式，`reasons` 是逐条数组。
- `ocr` 是识别出的答卷文字。
- `modifiedScore` / `isAuto` 在确认前分别是 `null` / `false`。
- `samples` / `scoreSpread` 只在开启多次采样且本次实时评分时出现。
- 余额不足返回 `400`；模型输出无法解析返回 `502`，本次不扣次数；上游持续失败返回 `503`。

## 评分记录

### `POST /api/records/:gradingId/confirm`

老师确认最终分数。只按 `gradingId` 查找，不再接受内部数字 ID。

```json
{ "modifiedScore": 5, "isAuto": false }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `modifiedScore` | 是 | 最终分数，0–200，且不能超过任务满分 |
| `isAuto` | 否 | 是否自动提交，默认 `false` |

响应 `200`：`{ "ok": true }`。记录不存在或不是 `done` 返回 `404`。

`isAuto: true` 时服务端按功能开关再校验一次：`auto_mode` 关闭，或这条记录的置信度低于 `auto_min_confidence`，返回 `403`（分数不会被记为自动提交）。

## 功能开关

### `GET /api/flags`

当前用户的开关取值，只含下发给扩展的开关。

```json
{ "flags": { "auto_mode": true, "auto_min_confidence": 0.7, "min_extension_version": "" } }
```

以后可能增加字段；扩展对缺失的字段使用保守值。

### `GET /api/records`

查询当前用户的评分记录。

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `taskId` | 否 | 只看某个任务 |
| `page` | 否 | 默认 1 |
| `pageSize` | 否 | 默认 20，最大 100 |

```json
{
  "items": [
    {
      "gradingId": "g_...",
      "taskId": 12,
      "score": 4,
      "maxScore": 6,
      "reason": "...",
      "ocr": "...",
      "modifiedScore": 5,
      "isAuto": false,
      "confidence": 0.82,
      "reasons": ["..."],
      "comment": "...",
      "model": "qwen-vl-max",
      "cached": false,
      "balance": 18,
      "status": "done",
      "charged": true,
      "error": "",
      "createdAt": "...",
      "confirmedAt": "..."
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

## 平台适配

### `GET /api/adapters/resolve?host=...&path=...`

按 host + 路径查找最合适的预设；优先用户私有预设，其次公共预设。

```json
{ "preset": { "id": 1, "name": "本地演示", "hostPattern": "127.0.0.1", "pathPattern": "", "config": { "...": "..." }, "scope": "public", "ownerId": null } }
```

没有匹配时 `{ "preset": null }`。

### `GET /api/adapters/mine`

返回当前用户保存的私有预设数组。

### `POST /api/adapters/mine`

保存/覆盖私有预设（同 `hostPattern + pathPattern` 覆盖）。

```json
{
  "name": "本地演示",
  "hostPattern": "127.0.0.1",
  "pathPattern": "",
  "config": { "version": 1, "pics": { "...": "..." }, "scoreMode": "input", "...": "..." },
  "note": ""
}
```

`config` 结构见 `docs/implementation-notes.md` 的适配器契约。

### `DELETE /api/adapters/mine/:id`

```json
{ "ok": true }
```

## 管理接口

以下接口均要求 `role = admin`。

### `GET /api/admin/stats`

```json
{
  "users": 12,
  "tasks": 8,
  "records": 120,
  "failed": 3,
  "creditsOutstanding": 240,
  "avgLatencyMs": 3200,
  "avgConfidence": 0.81,
  "avgDrift": 0.4,
  "confirmed": 96,
  "daily": [{ "day": "2026-11-01", "done": 12, "failed": 0, "users": 3 }]
}
```

`daily` 是最近 14 天。

### 用户

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/admin/users?page=&pageSize=&q=` | 用户列表，含 `disabled`、`lastLoginAt`、`judged`、`lastJudgeAt` |
| `POST /api/admin/users` | 创建用户：`{ username, password, role?, credits? }` |
| `PATCH /api/admin/users/:id` | `{ role?, disabled?, password? }` |
| `POST /api/admin/users/:id/credits` | 调整额度：`{ delta, note? }`，返回 `{ balance }` |

管理员不能停用或降级自己。

### `GET /api/admin/ledger?page=&pageSize=&userId=`

返回 `{ items, total, page, pageSize }`。

### 兑换码

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/admin/codes?page=&pageSize=&q=` | 兑换码列表 |
| `POST /api/admin/codes` | `{ count, credits, maxUses?, expiresAt?, note? }`，返回 `{ codes: string[] }` |
| `PATCH /api/admin/codes/:id` | `{ disabled }` |

### 邀请令牌

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/admin/invites?page=&pageSize=&q=` | 列表；只返回 `tokenHash`，不返回明文 |
| `POST /api/admin/invites` | `{ unitId, credits, expiresAt, count?, maxUses?, note? }`，返回 `{ tokens: [{ id, token }] }`，明文只出现这一次 |
| `PATCH /api/admin/invites/:id` | `{ disabled }` |

### 管理单元

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/admin/units` | 单元列表，含 `memberCount` |
| `POST /api/admin/units` | `{ name, description? }`；创建者自动成为 `owner` |
| `PATCH /api/admin/units/:id` | `{ name?, description?, enabled? }` |
| `GET /api/admin/units/:id/members` | 成员列表；要求调用者是该单元 `owner`/`manager` |
| `POST /api/admin/units/:id/members` | `{ username, role }`；已存在则更新角色 |
| `PATCH /api/admin/units/:unitId/members/:userId` | `{ username, role }` |
| `DELETE /api/admin/units/:unitId/members/:userId` | 移除成员 |

`role` 取值：`owner` / `manager` / `grader` / `viewer`。

### `GET /api/admin/records?page=&pageSize=&q=&userId=`

管理端评分记录列表，字段为内部列名：

```json
{
  "items": [
    {
      "id": 31, "userId": 2, "username": "e2e_teacher",
      "taskId": 12, "examTitle": "期中考试", "questionNo": "17", "platformHost": "mark.xiaoxianai.cn",
      "maxScore": 6, "status": "done", "aiScore": 4, "finalScore": 5,
      "confidence": 0.82, "model": "qwen-vl-max", "latencyMs": 3200, "error": "", "createdAt": "..."
    }
  ],
  "total": 1, "page": 1, "pageSize": 20
}
```

管理端沿用 `id`、`finalScore` 等内部字段名；扩展/用户端使用 `gradingId`、`modifiedScore`。

### 功能开关

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/admin/flags` | 全部开关定义（类型、默认值、说明、负责人、计划删除时间）和覆盖列表，以及可选的模型方案 `modelProfiles` |
| `PUT /api/admin/flags/:key` | 新增或修改一条覆盖：`{ scope, targetId?, username?, value, percent? }`；`scope=user` 时可以用精确用户名代替 `targetId` |
| `DELETE /api/admin/flags/:key?scope=&targetId=` | 删除一条覆盖 |
| `GET /api/admin/flags/evaluate/:userId` | 某个用户每个开关的最终取值和来源：`{ key: { value, source, targetId? } }` |
| `GET /api/admin/flags-audit?key=&page=&pageSize=` | 修改记录，新的在前 |

`scope`：`global`（替代默认值）、`rollout`（按比例，需 `percent` 0–100）、`unit`（`targetId` 为单位 id）、`user`（`targetId` 为用户 id）。`value` 的类型必须和开关定义一致，并通过开关自己的校验（比如 `model_profile` 只能是已配置的方案）。

### 适配预设

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/admin/presets?q=` | 全部预设，最多 500 条 |
| `POST /api/admin/presets` | `{ name, hostPattern, pathPattern?, config, note?, scope?, enabled? }` |
| `PATCH /api/admin/presets/:id` | 同上字段，均可选 |
| `DELETE /api/admin/presets/:id` | `{ ok: true }` |

`scope` 为 `public` / `private`；公共预设的 `ownerId` 为 `null`。
