# Edge Add-ons 发布说明

服务端不需要改动。Edge 版使用同一套 Chromium Manifest V3 扩展和同一个 Easy Grader 服务端。

## 已准备

- 扩展版本：`0.1.1`
- 发布版服务端：`https://grader.flyfly.top`
- Edge 商店图标：`extension/store/icon-300.png`
- 商店截图：`extension/store/01-result.png`、`02-settings.png`、`03-submitted.png`
- 权限理由：`extension/store/permission-justifications.md`
- 隐私政策页面：`https://你的域名/privacy/`

## 构建发布包

在仓库根目录执行：

```bash
pnpm --filter easy-grader-extension check
pnpm --filter easy-grader-extension test
pnpm --filter easy-grader-extension build
rm -f extension/release/easy-grader-edge-0.1.1.zip
cd extension/dist
zip -qr ../release/easy-grader-edge-0.1.1.zip .
```

生成的 `extension/release/easy-grader-edge-0.1.1.zip` 可以上传到 Microsoft Edge Add-ons Partner Center。

## 生成/更新 Edge 图标

Edge 商店图标使用 300×300 PNG：

```bash
pnpm --filter easy-grader-e2e run edge-store-icon
```

## Partner Center 填写建议

- **名称**：Easy Grader 阅卷助手
- **简短描述**：读取网页阅卷答卷，提供 AI 建议分和理由，由老师确认后写回评分平台。
- **详细描述**：可参考根目录 `README.md`，重点说明半自动判题、老师确认、支持自定义阅卷平台适配。
- **隐私政策 URL**：部署服务端后的 `https://你的域名/privacy/`
- **截图**：上传 `extension/store/01-result.png`、`02-settings.png`、`03-submitted.png`
- **图标**：上传 `extension/store/icon-300.png`
- **Small promotional tile**：上传 `extension/store/small-promotional-tile.png`（440×280）
- **Large promotional tile**：上传 `extension/store/large-promotional-tile.png`（1400×560）
- **权限说明**：按 `extension/store/permission-justifications.md` 填写
- **远程代码**：选择不使用远程代码

## 上传前检查

确认 zip 根目录直接包含：

```text
manifest.json
background.js
content.js
insert.js
popup.html
popup.js
icons/
```

不要上传：

- `extension/dist-dev/`
- sourcemap 文件
- `.env`、API Key、管理员密码
- `server/data/`、trace、HAR 或学生答卷
- `research/`
