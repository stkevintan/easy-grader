# Easy Grader

浏览器阅卷助手：在网页阅卷平台上读取学生答卷图片，请求视觉大模型给出建议分和理由，老师确认后写回平台的评分框。

项目采用独立设计与实现，不包含第三方扩展的代码、接口或账号体系。

## 组成

| 目录 | 内容 |
| --- | --- |
| `server/` | NestJS + SQLite 服务端：账号、额度、兑换码、AI 评分、适配预设；同时托管管理后台和演示页 |
| `extension/` | Chrome / Edge MV3 扩展（TypeScript + esbuild） |
| `admin/` | 管理后台（原生 JS，无构建步骤，由服务端 `/admin/` 提供） |
| `demo/` | 两个本地模拟阅卷页（输入框给分、打分板给分），用于没有真实平台账号时联调 |
| `e2e/` | Playwright 端到端测试：真实 Chromium 加载扩展跑完整流程 |
| `tools/` | 原扩展版本追踪脚本 |

## 文档

- [数据库设计](docs/database.md)：表结构、索引、任务 JSON 结构和启动迁移
- [API 参考](docs/api.md)：登录、任务、评分、记录、适配预设和管理接口
- [实现说明](docs/implementation-notes.md)：整体设计、适配器契约和状态机

## 快速开始

需要 Node.js 22+ 和 pnpm。仓库是一个 pnpm workspace（server、extension、e2e、tools），根目录一个 `pnpm-lock.yaml`。根 `package.json` 里锁定了 pnpm 版本，执行 `corepack enable` 后会自动用对的版本。

```bash
corepack enable             # 首次：按 packageManager 字段启用 pnpm
pnpm install                # 在仓库根目录装全部依赖

cp server/.env.example server/.env   # 至少设置 ADMIN_PASSWORD；要真实评分再填 MODEL_*
pnpm build:dev              # 构建服务端和开发版扩展（产物在 extension/dist-dev）
pnpm dev                    # 启动服务端 http://127.0.0.1:3000
```

pnpm 默认不执行依赖的安装脚本。`pnpm-workspace.yaml` 的 `allowBuilds` 里只放行了 `better-sqlite3`（原生模块）和 `esbuild`（平台二进制）。以后新增需要编译的依赖，装的时候会报 `ERR_PNPM_IGNORED_BUILDS`，确认安全后加进这个列表即可。

在 Chrome 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开「开发者模式」，点「加载已解压的扩展程序」，选 `extension/dist-dev`。

### 扩展的两种构建

| | 发布版 `pnpm build` | 开发版 `pnpm build:dev` |
| --- | --- | --- |
| 产物目录 | `extension/dist` | `extension/dist-dev` |
| 服务端 | 固定 `https://grader.flyfly.top`，界面里看不到、改不了 | 默认 `http://127.0.0.1:3000`，popup「设置」里可以改 |
| 主机权限 | 只有线上服务端 | 本机 127.0.0.1 / localhost |
| 演示页内容脚本 | 无 | 有（`/demo/*`） |
| 代码 | 压缩，不带 sourcemap | 不压缩，带 sourcemap |

发布版里修改服务端的代码在构建时会被整段删掉，不只是把界面藏起来。即使有人直接给扩展后台发 `settings.set` 消息，服务端地址也不会变。开发版名字后面带「（开发版）」，两个版本可以同时装着，互不影响。

要给另一个服务端打发布包（比如测试环境），构建时传入地址，必须是 https：

```bash
SERVER_URL=https://staging.example.com pnpm --filter easy-grader-extension build
```

如果发布版的 `background.ts`、`popup.ts` 或 `panel.ts` 里出现只该给开发版用的逻辑，要直接写 `if (__DEV__) { ... }`，不要先把 `__DEV__` 赋给别的变量。只有这样 esbuild 才能在发布版里把这段删干净，原因见 `extension/src/globals.d.ts`。

### 打包与商店素材

发布版构建后，`extension/dist` 可以直接加载，也可以打成 Chrome 应用商店的 zip（`manifest.json` 必须在压缩包根目录）：

```bash
pnpm --filter easy-grader-extension build
cd extension/dist && zip -qr ../release/easy-grader-0.1.0.zip .
```

`extension/store/` 里是商店需要的图片：

- `icon-128.png`：128×128 商店图标
- `icon-300.png`：300×300 Edge 商店图标
- `01-result.png`、`02-settings.png`、`03-submitted.png`：1280×800 截图（商店要求 1280×800 或 640×400，至少 1 张、最多 5 张）
- `small-promotional-tile.png`：440×280 Small promotional tile
- `large-promotional-tile.png`：1400×560 Large promotional tile

截图是真实扩展 UI + 本地演示阅卷页 + 本地假模型生成的，不含学生数据，也不会调用外部模型。改了面板 UI 后重新生成：

```bash
pnpm --filter easy-grader-server build
pnpm --filter easy-grader-extension build:dev
pnpm --filter easy-grader-e2e run store-assets
```

manifest 已声明 16/32/48/128 四个尺寸的图标，构建时从 `extension/icons/` 一起复制；16/32 用只有对勾的简化图标，48/128 保留文档细节。

然后：

1. 点工具栏的 Easy Grader 图标，注册一个账号（默认送 20 次）。
2. 打开 http://127.0.0.1:3000/demo/ ，再点图标里的「打开阅卷面板」。
3. 演示页已内置适配预设，面板会直接进入「题目设置」：填满分、参考答案、评分细则，保存。
4. 点「获取建议分」→ 检查分数和理由 →「写入并提交」，演示页会切到下一份。

管理后台在 http://127.0.0.1:3000/admin/ ，用 `.env` 里的管理员账号登录。没设 `ADMIN_PASSWORD` 的话，首次启动会在日志里打印一个随机密码。

隐私政策文档在 `privacy/privacy-policy.md`，请将它发布到任意公开、无需登录的 HTTPS 静态托管地址，再把该 URL 填到 Chrome/Edge 应用商店的隐私政策字段。隐私政策不由 Easy Grader 服务端托管，也不会进入 Docker 镜像。

## 接入模型

服务端用 OpenAI 兼容的 Chat Completions 接口，模型必须支持图片输入。在 `server/.env` 里配置：

```bash
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_API_KEY=sk-...
MODEL_NAME=qwen-vl-max
```

豆包（火山方舟）、自部署 vLLM 等同理。`MODEL_API_KEY` 为空时走 mock：分数由图片哈希生成，面板会明确提示，只用于联调。

推理模型（DeepSeek 等先输出 `reasoning_content` 再写正文的模型）会先消耗输出额度。`MODEL_MAX_TOKENS` 默认 8000；如果日志报「模型把 N 个输出 token 用完了，正文为空」，就把它调大。

`MODEL_REASONING_EFFORT` 控制思考强度，默认 `low`。同一份 6 分阅读理解实测：`none` 约 2~3 秒（不输出思考过程），`minimal` 约 20 秒，`low` 约 25~35 秒，`medium` / `high` 更慢且没有稳定收益；不传该参数（`off`）反而最慢。

用保存的 trace 做过重复实验：同一张图用 `low` 重跑，两次只有 30% 完全一致（MAE 1.1 分）；`none` 重跑有 60% 一致（MAE 0.6 分），而且快 10 倍。`none` 整体比 `low` 严格约 0.7 分，抽查分歧样本主要是 `low` 把边界要点放宽了。所以在 DeepSeek 这类支持 `reasoning_effort=none` 的模型上，建议用 `none` 加「半自动判题 + 老师确认」收集真实标签；`low` 适合需要完整思考过程做人工复核的场合。注意 `none` / `low` 都是直接发给服务商的参数，模型不认识时请用 `off`。上面这些耗时是单次调用；默认的两阶段评分会多一次转录，总耗时大约翻倍。

### 两阶段评分

默认 `OCR_TWO_PASS=true`：第一次调用只转录手写内容，提示词里**没有题目、参考答案和评分标准**；第二次调用拿固定的转录文字 + 评分标准打分，并明确要求以转录为准。这样切断了“模型看到评分标准，就把模糊字迹补成得分点”的路径。

- 转录阶段要求看不清的字写 □，禁止按常识或上下文补全；如果整页没有手写内容，直接返回 0 分，不再调用第二次。
- 最终展示和入库的识别文字来自第一阶段，第二阶段的 `ocr_text` 会被忽略。
- 评分阶段默认 `SCORE_WITH_IMAGE=false`，不再把图片发给模型，学生作答只以转录文字为准，从机制上杜绝“重新读图又编出一个得分点”。需要模型参考卷面版式时改回 `true`。
- 模型必须逐点输出 `points`：每个标准点的 level（full / partial / none）、得分 delta 和 quote。quote 必须能在转录文字里找到连续原文，找不到就把该点得分清零，并在理由里注明“未采信”。总分由各点 delta 相加后取整、夹到满分，不让模型自己心算。引用校验会忽略空白、标点和序号，也会忽略转录里「（划掉：…）」的标注；划掉内容本身仍保留。
- 评分提示词明确「要点句」是得分单位：学生答出要点句指向的措施或方向即算答出，解释里的具体例子、效果和措辞不要求全部出现；评分标准里用“如……”举的典型事例，同样是判断该点是否答出的依据。只有笼统沾边或只答出一半才给 partial。这条规则是按下面 OCR 对照实验的结果加上的。
- `MODEL_SAMPLE_COUNT` 控制评分阶段并行采样次数（默认 1，`.env` 里建议 3）。多次采样取中位数，分差大于 0 时降低置信度，面板会显示「多次评分：4 / 4 / 6（不一致，请重点核对）」。
- 每次评分仍然只扣一次额度；上游计费会多一次转录和 N 次采样。不需要时可以设 `OCR_TWO_PASS=false`、`MODEL_SAMPLE_COUNT=1` 回到单次调用。
- trace 里 `ocr` 字段保存转录阶段的提示词、文字、耗时和原始回复；`samples` 保存每次采样的分数、逐点判定和原始回复；`prompt` / `response` 是评分阶段（`response` 取中位数那一次）。`--replay` 重放的是评分阶段（转录文字已经在保存的提示词里）。

#### OCR 与评分方式对照实验

用 24 份老师人工确认过、保留了 trace 和原图的答卷做对照（2026-11，DeepSeek `reasoning_effort=none`，评分阶段不带图，每个版本采样 3 次取中位数）：

| 方案 | 完全一致 | ±1 分内 | MAE | 偏差 |
| --- | --- | --- | --- | --- |
| 旧版单阶段（原始记录） | 66.7% | 79.2% | 0.58 | +0.42 |
| A 旧 OCR + 新逐点评分 | 25.0% | 62.5% | 1.29 | −0.71 |
| B 纯转录 + 新逐点评分 | 16.7% | 62.5% | 1.38 | −1.04 |
| 纯转录 + 只加 gold 示例 | 16.7% | 54.2% | 1.46 | −0.96 |
| 纯转录 + 要点句/事例规则 + gold | 33.3% | 83.3% | 0.88 | −0.46 |

第一行不能直接当作准确率：24 份里有 15 份（65%）老师是直接接受旧 AI 的分，标签本身被旧模型锚定。只看老师改过分的 8 份（相对无锚定），旧版 MAE 1.75，B 1.25，加上规则和 gold 后 0.88，±1 分内 100%。新旧 OCR 文本平均相似度 0.85，纯转录没有明显损失识别内容；主要误差来自逐点映射，而不是转录。只加 gold 示例、不改标准点读法反而更差，说明 gold 只能校准尺度，纠正不了“把解释当必答内容”这类系统性错误。

实验脚本在 `server/scripts/ocr-compare.mjs`、`ocr-gold.mjs`、`ocr-prompt.mjs`，结果写到 `data/traces/ocr-*.jsonl`（含学生答卷，不要提交）。

上游返回 5xx、429、连接失败或请求超时时，服务端会按 `MODEL_MAX_RETRIES`（默认 2 次）指数退避重试；其他 4xx 不重试，直接退还次数并报错。扩展等待单次评分的最长时间相应放宽到 4 分钟，够 3 次 60 秒超时加退避。

提示词在 `server/src/judge/model.service.ts` 的 `buildPrompt`，要求模型只回 JSON（逐点判定、置信度、理由、评语）。服务端会校验每条引用、汇总分数并按步长取整、夹到 0 和满分之间；模型回复解析失败或上游出错时退还次数。

## 在真实阅卷平台上使用

扩展默认只在 `127.0.0.1` / `localhost` 上运行。要在别的平台用：

1. 打开阅卷平台的批阅页面，点扩展图标 →「在此站点启用」，授权该站点。
2. 刷新页面，点「打开阅卷面板」。没有预设时会进入「点选适配」：
   - 答卷图片：点一下答卷（支持 img、canvas、CSS 背景图；都不行就用「区域截图」）
   - 给分位置：输入框模式下，用键盘在平台分数框里真实输入一次；只能点分数的平台选「打分板」
   - 提交按钮、考试名、题号：各点一下（点选时会拦截点击，不会真的提交）
   - 「试读一次」确认能读到图片和题目信息，再「保存适配」
3. 适配保存在你自己账号下。管理员在后台确认可用后，可以改成公共预设给所有人用。

也可以不授权站点，直接点「在本页临时打开面板」，只对当前标签页生效。

### xiaoxianai.cn

原扩展 1.9.16 只在 manifest 匹配规则里列了 `xiaoxianai.cn`，代码里没有它的专用适配器，走的是服务端下发配置的通用路径。所以这里没法提供预先写好的选择器，需要按上面的步骤点选适配一次。如果答卷是画在 canvas 上的跨域图片，`insert.js` 会把 `drawImage` 的原始图片地址记在 canvas 的 `data-eg-src` 属性上（通常是平台的原图 PNG，比画到面板上的 canvas 分辨率高）。扩展会优先下载这张原图；单张图在尺寸和体积允许时直接原样上传，不再转 JPEG。这条路径已在端到端测试里验证过。适配成功后，建议管理员在后台把这份配置设为公共预设。

## 评分 trace 与离线评测

在 `server/.env` 打开 `SAVE_TRACES=true` 后，每次真正调用模型都会在 `data/traces/` 写两份文件：

- `<记录ID>-<图片哈希>.json`：题目快照、两阶段提示词、转录文字、模型配置（含思考强度）、多次采样的逐点判定和原始回复、token 用量、耗时、解析后的分数；失败时记录错误
- `<记录ID>-<图片哈希>.jpg`：发给模型的那张答卷图片

trace 里有两个版本号：`version` 是文件结构版本（当前 2），`promptVersion` 是评分提示词/解析规则版本（当前 4）。改提示词、引用校验或分数汇总规则时把 `PROMPT_VERSION` 加一，旧 trace 不用迁移也能区分：

| promptVersion | 含义 |
| --- | --- |
| 无 / 1 | 单阶段整体评分（旧格式） |
| 2 | 两阶段 + 逐点判定 + 引用校验 |
| 3 | 引用忽略「（划掉：…）」标注；要点句是得分单位、标准里的典型事例也算依据 |
| 4 | majorInput 指向参考答案/题干时，额外带上 question.content.command 作为评分细则 |

同一张图命中缓存不会重复写。数据只存本地，包含学生答卷，不要上传或提交到仓库。

```bash
pnpm --filter easy-grader-server run bench                              # 汇总耗时、思考 token、与老师最终分的偏差
pnpm --filter easy-grader-server run bench -- --json                    # 另存 data/traces/dataset.jsonl
pnpm --filter easy-grader-server run bench -- --replay=none --limit=20  # 用保存的图片和提示词重跑 20 份
```

`bench` 会把 trace 和数据库里老师确认的 `finalScore` 对齐，统计完全一致率、±1 分率、MAE 和平均偏差；同时区分「人工确认」和「自动提交」的样本，避免只拿自动提交的数据高估准确率。`--replay` 会真实调用模型并消耗额度，用来对比 `low` / `none` 等不同思考强度的速度和一致率。

## 自动学习

在 `server/.env` 打开 `GOLD_ENABLED=true` 后，每次评分会从**同一道题**下老师人工确认过的记录里挑最多 `GOLD_MAX_EXAMPLES` 条（默认 4），把「学生作答识别文字 → 老师最终评分」写进提示词，让模型校准本题的评分尺度。

- 只取 `autoSubmitted=false` 的人工确认记录。自动提交的 `finalScore` 就是模型自己的分，拿来当示例只会自我强化。
- 按分数段轮转挑选，避免示例全是高分把模型往上锚；同一份卷子不会被自己当示例。
- 示例包含其他学生的作答文字，会和答卷图片一样发给模型服务商；不需要这个功能就保持 `GOLD_ENABLED=false`。
- trace 里的 `goldExamples` 记录了用了哪些记录 ID。用这些 trace 做离线评测时，要把对应的卷子排除掉，避免“答案泄漏”。

老师用得越多，确认记录越全，示例覆盖的分数段也越完整。`pnpm bench` 里「仅人工确认」那一行的统计才是可信的准确率。

## 安全设计

- 面板顶部有「手动 / 半自动 / 全自动」三档模式，当前模式常驻显示，评分中、结果页也能切换或停止。模式只在本次打开面板期间有效，每次打开都从手动开始。
- 手动和半自动下，每一份都是老师确认分数后才写入、提交。半自动只是在页面切到新答卷时自动请求建议分。老师改了分再写入时，最终成绩会作为自动学习的示例（见上一节）。
- 全自动会自动写分并提交，第一次开启要在面板里确认。置信度低时暂停在结果页，老师核对后点「确认并继续自动」；写分校验失败、换卷超时、额度不足时自动停止并回到手动。
- 结果页可以按 Enter 写入并提交，按 Esc 放弃。评分请求发出后就会扣次数，「不看这次结果」只是丢弃结果。
- 写分前会核对答卷指纹，防止把分数写到已经换掉的另一份卷子上。指纹变化但实际抓到的答卷图片一致时照常写入；图片确实变了则自动对当前答卷重新评分，由老师核对后再写。
- 服务端不保存答卷图片，只存 SHA-256，用于去重和防重复扣费。打开 `SAVE_TRACES=true` 后，为了离线评测会把图片和模型输出保存到本地 `data/traces/`，这份数据含学生答卷，不要上传或提交。
- 打开 `GOLD_ENABLED=true` 后，评分示例里会带上同一道题其他学生答卷的识别文字，和当前答卷一样发给模型服务商；不允许跨卷学习时关掉即可。
- 密码用 scrypt；JWT 带版本号，改密码或停用账号后旧令牌立即失效。
- 额度扣减和兑换在 SQLite 同步事务里完成，不会扣成负数，兑换码不会超用。
- 登录、兑换、评分接口分别限流。
- CORS 只放行浏览器扩展来源（以及 `CORS_ORIGINS` 里配置的网页来源）。
- 扩展后台只接受白名单命令。代页面下载答卷图片时，只对同源图片携带 cookie。

**部署到公网前**：放在 HTTPS 反向代理后面（扩展里改服务端地址需要 https），设置 `JWT_SECRET` 和 `ADMIN_PASSWORD`，按需关闭 `ALLOW_REGISTER`，定期备份 `server/data/app.db`。

**使用前**：确认学校和阅卷平台允许使用这类辅助工具。学生答卷是敏感数据，会发给你配置的模型服务商，请先确认这样做合规。最终分数由老师负责。

## 测试

```bash
pnpm test                      # 服务端 36 个用例 + 扩展 21 个用例（jsdom）

pnpm --filter easy-grader-e2e exec playwright install chromium   # 首次
pnpm test:e2e                  # 先构建，再用真实 Chromium 跑：注册 → 适配 → 评分 → 提交 → 后台 → 兑换
```

`e2e` 会在 3000 端口启动服务端，跑之前请先停掉 `pnpm dev`。

## GitHub Actions 发布

`.github/workflows/ci.yml` 会在每个 Pull Request 上安装依赖、运行服务端/扩展测试并构建服务端和扩展。

`.github/workflows/release.yml` 会在 GitHub Release 发布后：

- 检查 release tag 对应代码的测试和构建；
- 构建并推送 `stkevintan/easy-grader-server:<tag>` 的 `linux/amd64` Docker 镜像；正式 release 另外更新 `latest`，预发布 release 不更新 `latest`；
- 构建生产版扩展，并将相同内容分别打包为 Chrome / Edge zip，上传到该 GitHub Release。

在仓库 Settings → Secrets and variables → Actions 中设置：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名；
- `DOCKERHUB_TOKEN`：Docker Hub Access Token（不要使用密码）。

创建 GitHub Release 时，tag 应与 `server/package.json` 和 `extension/manifest.json` 的版本一致，例如 `0.1.1`；如果使用 `v0.1.1`，Docker 镜像标签也会是 `v0.1.1`。

## Docker 部署

服务端镜像发布在 Docker Hub 的公开仓库 [`stkevintan/easy-grader-server`](https://hub.docker.com/r/stkevintan/easy-grader-server)，只有 linux/amd64 版本。镜像里有编译好的服务端、生产依赖和管理后台，不带演示页（`SERVE_DEMO=false`）。数据库和自动生成的 JWT 密钥存在容器的 `/data` 目录里。

镜像是公开的，任何人都能拉下来看到服务端代码和评分提示词。镜像里不含任何密钥，API Key、管理员密码这些都在运行时通过 `.env` 传进去，**千万别把 `.env` 打进镜像，也别写进 Dockerfile**。`.dockerignore` 已经排除了 `server/.env`、本地数据库和 `.jwt-secret`。

**发布**（在开发机上，需要 Docker Desktop 或 docker buildx）：

```bash
docker login                          # 首次；建议用 Docker Hub 的 Access Token
./server/scripts/publish.sh           # 推送 <package.json 版本> 和 latest
./server/scripts/publish.sh 0.2.0     # 指定版本；带 -rc 等后缀的不会覆盖 latest
DRY_RUN=1 ./server/scripts/publish.sh # 只构建到本地，不推送
```

**部署**（在服务器上，拉镜像不用登录）：

```bash
cd server && cp .env.example .env     # 设置 ADMIN_PASSWORD、JWT_SECRET、MODEL_*、ALLOW_REGISTER
docker compose up -d
```

`docker-compose.yml` 只把端口绑在 `127.0.0.1:3000`，前面需要用 Nginx 或 Caddy 做 HTTPS 反向代理。数据在名为 `easy-grader-data` 的卷里，备份时复制卷中的 `app.db` 即可（先停容器，或者用 `sqlite3 .backup`）。

## 管理后台

- 概览：用户数、评分量、老师确认率、AI 与终分的平均偏差、近 14 天趋势
- 用户：新建、调额度、重置密码、停用、设为管理员
- 兑换码：批量生成（次数、可用人数、过期时间）、停用
- 评分记录：AI 分、终分、改分幅度、置信度、耗时、失败原因
- 适配预设：查看老师点选生成的配置，验证后设为公共；也可以直接编辑 JSON
- 额度流水：每一次加减的来源
- 功能开关：按全局 / 百分比 / 单位 / 用户改开关取值，带修改记录（见下）

## 功能开关

服务端有一套轻量的功能开关，用来灰度和紧急止损，不用发新版扩展。开关在 `server/src/flags/flag-definitions.ts` 里定义（类型、默认值、负责人、计划删除时间），管理后台「功能开关」页只能改取值。

取值优先级：**用户 > 单位 > 按比例 > 全局 > 默认值**。用户在多个单位时取加入最早的、设置了覆盖的单位；按比例放量用 `sha256(key:userId)` 稳定分桶，调大比例时已拿到新值的用户不会变回去。每次修改都记录操作人和修改前后的值。

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `auto_mode` | 开 | 全自动是否可用。关掉后扩展的「全自动」按钮置灰、正在全自动的面板切回手动；服务端也拒绝 `isAuto: true` 的确认 |
| `auto_min_confidence` | 0.7 | 全自动置信度下限。老师在扩展里只能设得更严，实际取两者较大值；服务端确认时同样校验 |
| `min_extension_version` | 空 | 最低扩展版本。扩展每个请求带 `X-EG-Version`，低于它的评分/确认返回 `426`，面板提示更新 |
| `model_profile` | `default` | 用哪套模型方案（只在服务端用）。评分记录和 trace 记下方案名，便于对比 |

扩展在登录、打开面板、开启全自动前和全自动每一份之前读开关（后台缓存 5 分钟，面板开着时每 5 分钟刷新）。拉取失败用上次的缓存；从没拉到过时按保守取值，全自动不可用。服务端每个进程缓存 10 秒。

模型方案在 `MODEL_PROFILES` 里定义，是一个 JSON 对象，每个方案覆盖 `MODEL_*` 的一部分字段（`baseUrl`、`apiKey`、`name`、`timeoutMs`、`temperature`、`maxTokens`、`reasoningEffort`、`scoreWithImage`、`sampleCount`），没写的沿用 `MODEL_*`（`timeoutMs` 最多 60000，保证重试也能在扩展的评分期限内完成）：

```bash
MODEL_PROFILES='{"qwen-max":{"name":"qwen-vl-max","sampleCount":3},"fast":{"reasoningEffort":"none"}}'
```

然后在后台把 `model_profile` 对某个单位设为 `qwen-max`，或按 10% 放量，对比两边的改分率后再决定是否全量。格式不对时服务端启动直接报错。

## 已知限制

- 没有在任何真实阅卷平台上验证过，只在两个演示页上跑通。各平台 DOM 差异大，第一次用通常要点选适配，部分平台可能需要调整选择器或改用区域截图。
- 一次只评一道题。一张答卷上有多个小题分数框的平台还不支持。
- 没有接支付，额度只能由管理员调整或通过兑换码发放。
- SQLite 适合单机部署。多实例部署需要换数据库，额度事务也要重写。
