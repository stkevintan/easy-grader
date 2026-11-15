# Easy Grader 通用控制台设计（草案 v3）

状态：已定稿（2026-11-14）。基于 main `496b1f3`（0.2.4）。P1 已开始。

v3 的变化：产品以老师个人为主，角色只剩「老师」和「系统管理员」两种。组织只是分组，由系统管理员维护，组织里的人没有额外权限。不做团队这一层。

## 1. 目标

- 用一个新的控制台（`console/`）替换现在的 `admin/` 管理后台。
- 所有登录用户都用同一个控制台。老师看到「我的」，系统管理员还多一组「系统管理」。
- 用「组织」代替「管理单元」，只作为分组：按学校发邀请、设功能开关、筛选统计。
- 技术栈：TypeScript + React + Tailwind CSS。
- 浏览器扩展里一键打开控制台，并且已经登录（不用再输一次密码），还能直接跳到相关页面（当前题目的任务、评分记录）。

不在本次范围：改评分流程、改扩展里的阅卷面板、改计费模型、团队/备课组、组织内的管理角色。

## 2. 现状

| 项 | 现状 |
|---|---|
| 管理后台 | `admin/`：867 行无构建原生 JS，hash 路由，9 个页面：概览、用户、兑换码、邀请令牌、评分记录、适配预设、管理单元、额度流水、功能开关 |
| 访问控制 | 整个后台只给 `role=admin`；`/api/admin/*` 全部 `@AdminOnly()` |
| 单元 | `management_units` + `unit_memberships`，带 `owner` / `manager` / `grader` / `viewer` 角色，但单元接口全是 `@AdminOnly()`，这些角色实际没有用上 |
| 老师自己的数据 | 只能在扩展 popup 里看额度、兑换；任务、评分记录、流水、私有预设虽然有 `/api/tasks`、`/api/records`、`/api/billing/ledger`、`/api/adapters/mine`，但没有界面 |
| 登录态 | 扩展 token 在 `chrome.storage.local`；后台 token 在 `sessionStorage`，两边各登各的 |
| 线上数据 | `management_units`、`unit_memberships`、`invite_tokens`、`feature_flag_overrides` 都是 0 行，共 3 个用户（2026-11-14 只读查询） |
| e2e | `e2e/run.mjs` 会打开 `/admin/` 用 `#login-user` 登录，并调 `/api/admin/units` 建单元、发邀请 |

## 3. 角色

| 角色 | 判定 | 能做什么 |
|---|---|---|
| 老师 | 任何登录用户 | 自己的一切：用扩展阅卷；在控制台管理自己的阅卷任务、评分记录、额度和兑换、私有适配预设、密码；看到自己属于哪个组织 |
| 系统管理员 | `users.role=admin` | 老师能做的一切，外加全站管理：用户、额度、兑换码、邀请、组织、公共适配预设、功能开关、全站统计和评分记录 |

- 老师只能看和改自己的数据，组织里的其他人也看不到。
- 系统管理员也是老师，同样能用「我的」阅卷。
- 只有系统管理员能看到别人的评分记录。OCR 文本只在单条记录详情里显示，列表不显示。

## 4. 信息架构

左侧导航两组：「我的」所有人都有，「系统管理」只给系统管理员。顶栏显示额度余额和用户菜单（改密码、退出）。

### 4.1 我的

| 页面 | 内容 | 用到的接口 |
|---|---|---|
| 首页 | 剩余额度、近 30 天评分量曲线、AI 分与最终分的平均偏差、最近的评分记录、扩展版本过低的提醒 | `GET /api/auth/me`、新 `GET /api/me/stats` |
| 阅卷任务 | 按平台/考试/题号列出；查看和编辑题目、参考答案、评分标准、满分、步长；删除 | `GET/PUT/DELETE /api/tasks` |
| 评分记录 | 按任务筛选；AI 分、置信度、理由、最终分、是否自动提交、耗时；点开看详情 | `GET /api/records`、新 `GET /api/records/:gradingId` |
| 额度 | 流水；兑换码输入框 | `GET /api/billing/ledger`、`POST /api/billing/redeem` |
| 我的适配 | 私有适配预设：列表、查看 JSON、删除。创建仍在扩展的向导里做 | `GET/DELETE /api/adapters/mine` |
| 账号 | 改密码；所属组织 | `POST /api/auth/password`、`GET /api/auth/me` |

### 4.2 系统管理

| 页面 | 内容 |
|---|---|
| 概览 | 现有统计；可以按组织筛选 |
| 用户 | 现有功能（建、停用、改角色、加减额度）；多一列「组织」，可以按组织筛选，可以改用户的组织 |
| 组织（新，替代「管理单元」） | 建、改名、停用；看成员和成员的用量 |
| 邀请令牌 | 现有功能；生成时可以选组织，注册后自动加入 |
| 兑换码、评分记录、适配预设、额度流水 | 现有功能；评分记录可以按组织筛选 |
| 功能开关 | 现有功能；「单元」级改为「组织」级 |

## 5. 数据模型

删掉旧的 `management_units` 和 `unit_memberships`。线上这两张表是空的，不用迁移数据。

| 表 | 改动 |
|---|---|
| `orgs`（新） | id、name（唯一）、description、enabled、createdAt、updatedAt |
| `users` | 加 `orgId`（可空）：一个老师最多属于一个组织，见 Q1 |
| `invite_tokens` | `unitId` 改为可空的 `orgId`：可以发不属于任何组织的邀请 |
| `feature_flag_overrides` | scope `unit` 改为 `org`，`targetId` 存 orgId。取值优先级：user > org > rollout > global > 默认值 |

停用组织时，组织级功能开关不再生效，邀请不能再用；老师的账号和数据不受影响。

TypeORM 用的是 `synchronize: true`，新表和新列会自动建出来。删旧表、改 `invite_tokens` 的列要写一个启动时执行的小迁移，执行前照例备份数据库。

## 6. 接口

原则：`/api` 里扩展用到的接口只增不改，旧扩展继续能用。`/api/admin/units/*` 是例外，直接删掉：扩展从没调过它，只有旧后台和 e2e 在用，这两处会在同一批改动里换掉。`@UnitAccess` 装饰器和 `x-unit-id` 头也一起删掉。

| 接口 | 权限 | 说明 |
|---|---|---|
| `GET /api/auth/me` | 登录 | 只增字段：`org: { id, name } \| null` |
| `GET /api/me/stats?days=30` | 登录 | 个人每日评分量、失败数、平均偏差、自动提交比例 |
| `GET /api/records/:gradingId` | 本人 | 单条记录详情（理由、评语、OCR 文本） |
| `GET/POST/PATCH /api/admin/orgs[/:id]` | 系统管理员 | 组织列表（带成员数）、建、改名、停用 |
| `PATCH /api/admin/users/:id` | 系统管理员 | 只增字段：`orgId`（null 表示移出组织） |
| `GET /api/admin/users`、`/records`、`/stats` | 系统管理员 | 只增参数：`orgId` 筛选 |
| `POST /api/admin/invites` | 系统管理员 | `unitId` 改为可选的 `orgId` |
| `POST /api/auth/handoff`、`POST /api/auth/handoff/redeem` | 见第 7 节 | 从扩展打开控制台时免登录 |

前端只用 `role` 判断显示不显示「系统管理」，真正的校验仍在服务端（`@AdminOnly()`）。

## 7. 从扩展打开控制台

### 7.1 入口

| 位置 | 入口 | 打开到 |
|---|---|---|
| popup 账号区 | 「打开控制台」按钮（登录后显示） | 控制台首页 |
| popup 账号区 | 额度数字可点 | 额度页 |
| popup 未登录 | 「在控制台注册/登录」链接 | 控制台登录页 |
| 阅卷面板菜单 | 「在控制台查看此题」 | 当前任务的详情页 |
| 阅卷面板，某条评分结果旁 | 「详情」 | 该评分记录详情 |
| 面板里额度不足的提示 | 「去兑换」 | 额度页，聚焦兑换框 |

打开统一由 background 处理：content script 发消息 `openConsole { to }`，background 调 `chrome.tabs.create`。已经有控制台标签页时，切到那个标签页并跳转，不再新开。

控制台和服务端同源，发布版固定是 `PROD_SERVER`，已经在 `host_permissions` 里；`chrome.tabs.create` 也不需要新权限。所以这次不会让老用户重新授权。

### 7.2 免登录交接（handoff）

扩展里的 token 不能直接放进 URL，否则会留在浏览器历史里。所以改用一次性交接码：

1. background 用自己的 token 调 `POST /api/auth/handoff`，拿到交接码。码只能用一次，60 秒后过期，服务端只存它的哈希。
2. 打开 `${server}/console/#/handoff?code=…&to=/tasks/12`。码放在 `#` 后面，不会出现在服务端访问日志里。
3. 控制台调 `POST /api/auth/handoff/redeem` 换到自己的 JWT，立刻用 `history.replaceState` 把码从地址栏去掉，再跳到 `to`。`to` 只接受控制台内部路径。
4. 控制台已经登录同一个用户时跳过交接。登录的是另一个用户时，提示「当前控制台登录的是 xx，是否切换到扩展里的账号」。

交接码存在服务端内存里，单实例部署够用。服务器重启后码会丢，再点一次就行。控制台退出登录不影响扩展，反过来也一样。

## 8. 技术方案

| 项 | 选择 | 说明 |
|---|---|---|
| 位置 | 新 workspace 包 `console/` | 删掉 `admin/` |
| 构建 | Vite + TypeScript（strict） | 输出 `console/dist`，静态文件 |
| UI | React 19 + Tailwind CSS v4 | 组件用 shadcn/ui（基于 Radix，代码拷进仓库，不是运行时依赖） |
| 路由 | React Router，hash 模式 | 服务端只托管静态文件，不用做 SPA 回退 |
| 数据请求 | TanStack Query | 缓存、分页、失败重试、401 统一跳登录 |
| 表单 | react-hook-form + zod | 和服务端 class-validator 的限制保持一致 |
| 图表 | Recharts | 首页和概览的用量曲线 |
| 接口类型 | 手写共享类型 `console/src/api/types.ts` | 以后可以考虑从服务端 DTO 生成 |
| 测试 | Vitest + Testing Library（关键页面）；e2e 改为打开 `/console/` | |

部署：

- 服务端在 `/console/` 托管 `console/dist`。新配置项 `CONSOLE_DIR`，用法和现在的 `ADMIN_DIR` 一样。
- `/admin` 和 `/admin/*` 一律 302 到 `/console/#/admin`，老书签不会失效。
- Dockerfile 的 build 阶段加一步 `pnpm --filter easy-grader-console build`，镜像里只放 `dist`。
- 开发时用 `pnpm --filter easy-grader-console dev` 起 Vite，`/api` 代理到 `localhost:3000`。

界面要求：
- 中文界面。
- 桌面优先，平板也能用。
- 支持暗色模式。
- 表格可以搜索和分页。
- 危险操作要二次确认，比如停用用户、停用组织、删任务。

## 9. 分阶段落地

每个阶段一个 PR，各自走完 Copilot review 和 CI。

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P1 骨架和「我的」 | `console/` 包、登录/注册、布局、「我的」全部页面；`me/stats`、`records/:gradingId` | 普通老师能在控制台看到和管理自己的数据；服务端测试通过 |
| P2 系统管理 | 把 `admin/` 除「管理单元」外的 8 个页面搬过来，功能对齐；`/admin` 重定向；删除 `admin/`；e2e 改到新控制台 | 原后台能做的事新控制台都能做；e2e 通过 |
| P3 组织 | `orgs` 表、`users.orgId` 和迁移；`/api/admin/orgs`；邀请和功能开关改到组织；各处的组织筛选；删 `/api/admin/units` 和 `@UnitAccess`；组织页 | 系统管理员能建组织、按组织发邀请和设开关；e2e 改为建组织 |
| P4 扩展入口 | handoff 接口；popup 和面板的入口；控制台的 handoff 页 | 从扩展点一下就打开对应页面且已登录 |
| 发版 | 版本号升到 0.3.0，发正式版；更新服务器前先备份 | 服务器和两个商店都是 0.3.0 |

P1 到 P3 可以先合进 main，不发版。P2 合并之前，`admin/` 和新控制台并存；P2 和 P3 之间，系统管理里暂时没有「组织」页，因为线上本来就没有单元数据。

## 10. 已定的问题

- **一个老师只属于一个组织。** 真有需要时，再把 `users.orgId` 换成成员表。
- **控制台地址用 `/console/`**，根路径留给以后的介绍页。
- **控制台登录态存在 `sessionStorage`**，关掉标签页就退出；从扩展打开时用一次性交接码重新登录。
