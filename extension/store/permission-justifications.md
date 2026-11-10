# Chrome 应用商店权限说明

发布版权限以 `extension/dist/manifest.json` 为准：

- `permissions`: `storage`, `activeTab`, `scripting`, `tabs`
- `host_permissions`: `https://grader.flyfly.top/*`
- `optional_host_permissions`: `https://*/*`, `http://*/*`

如果构建时改了 `SERVER_URL`，把下面所有 `https://grader.flyfly.top` 换成实际域名。

---

## 中文（可直接粘贴）

### 单一用途说明

Easy Grader 的唯一用途是辅助老师批阅网页阅卷平台上的主观题：读取当前答卷图片，向用户自己配置的 Easy Grader 服务端请求 AI 建议分和理由，由老师确认后把最终分数写回平台。扩展不提供浏览、搜索、广告或其他功能。

### storage

在本地保存登录令牌、当前账号信息、用户设置（服务端地址、自动阅卷置信度阈值、间隔）以及用户主动启用的阅卷站点列表。这些数据通过 `chrome.storage.local` 保存在本机，仅用于恢复登录状态和记住用户选择，不上传到第三方，也不用于广告或分析。

### activeTab

用户点击工具栏图标或 popup 中的「打开阅卷面板」时，扩展需要临时访问当前标签页：注入阅卷面板、读取当前答卷图片，并在老师确认后把分数写入页面。activeTab 只在用户主动点击后授予当前标签页，扩展不会因此获得其他页面或浏览历史的访问权。

### scripting

在用户已授权或主动启用的阅卷站点注入内容脚本（`content.js`、`insert.js`），用于显示评分面板、读取答卷图片和题目信息、在老师确认后写入分数；以及在用户启用或停用站点时动态注册、注销这些脚本。扩展不会在未授权的页面执行脚本。

### tabs

读取当前活动标签页的网址，判断它是否属于用户已启用的阅卷站点，并向该标签页发送打开或关闭面板的消息。扩展只读取当前窗口的活动标签页，不读取浏览历史，也不访问其他标签页的内容。

### 主机权限 `https://grader.flyfly.top/*`

访问 Easy Grader 服务端 API，完成登录/注册、获取题目和适配预设、提交评分请求、取回 AI 建议分以及确认最终分数。该服务端是扩展唯一通信的服务器；扩展不会把数据发送到其他域名。

### 可选主机权限 `https://*/*`、`http://*/*`

阅卷平台的域名因学校、地区而异，无法在发布时穷举。扩展默认不访问任何网站；只有用户在 popup 中点击「在此站点启用」并同意 Chrome 的权限提示后，才会申请当前阅卷站点这一个 origin 的访问权限，用于注入面板、读取答卷和写回分数。扩展不会自动申请或访问其他网站，用户也可以随时在扩展里停用站点并撤销权限。保留 `http://` 是为了兼容部分学校内网或本地部署的阅卷平台。

### 是否使用远程代码

否。扩展的所有 JavaScript 都打包在安装包内，不使用 `eval`、`new Function`、远程脚本或运行时动态加载的代码。

### 数据使用说明

扩展会把当前答卷图片、题目/评分标准文本和账号凭证发送到用户自己配置的 Easy Grader 服务端；服务端再按部署方的配置转发给 AI 模型服务商。扩展本身不收集浏览历史、不投放广告、不出售数据。登录令牌和设置只保存在本机 `chrome.storage.local`，不保存密码明文。

---

## English (for an English dashboard)

### Single purpose

Easy Grader helps teachers grade handwritten answers on web-based grading platforms. It reads the current answer image, requests an AI-suggested score and reasons from the user's own Easy Grader server, and writes the teacher-confirmed score back to the page. It does not provide browsing, search, advertising, or any other functionality.

### storage

Stores the login token, account profile, user settings (server URL, confidence threshold, interval), and the list of grading sites the user explicitly enabled. Data is kept locally in `chrome.storage.local` to restore the login session and remember user choices. It is not used for advertising or analytics.

### activeTab

When the user clicks the toolbar icon or the "open grading panel" button, the extension temporarily accesses the current tab to inject the grading panel, read the current answer image, and write the confirmed score back. activeTab is granted only for the current tab after a user gesture; it does not grant access to other pages or browsing history.

### scripting

Injects content scripts (`content.js`, `insert.js`) into grading sites the user has authorized, to display the grading panel, read the answer image and question information, and write the confirmed score. It also registers/unregisters these scripts when the user enables or disables a site. No script runs on unauthorized pages.

### tabs

Reads the URL of the active tab to determine whether it is an enabled grading site, and sends open/close-panel messages to that tab. The extension only reads the active tab in the current window; it does not read browsing history or access the content of other tabs.

### Host permission `https://grader.flyfly.top/*`

Used to call the Easy Grader server API for sign-in/sign-up, loading tasks and adapter presets, requesting a grading result, and confirming the final score. This is the only server the extension communicates with; it does not send data to any other domain.

### Optional host permissions `https://*/*`, `http://*/*`

Grading platforms use different domains across schools and regions, so they cannot be enumerated at publish time. The extension accesses no website by default. Only after the user clicks "Enable on this site" and accepts Chrome's permission prompt does it request access to that single origin, in order to inject the panel, read the answer, and write the score. It never requests or accesses other sites automatically, and the user can disable a site and revoke the permission at any time. `http://` is kept for school intranets and locally deployed platforms.

### Remote code

No. All JavaScript is packaged with the extension. It does not use `eval`, `new Function`, remote scripts, or dynamically loaded code.

### Data usage

The extension sends the current answer image, question/rubric text, and account credentials to the user's own Easy Grader server; the server may forward them to the configured AI model provider. The extension does not collect browsing history, show ads, or sell data. The login token and settings stay in local `chrome.storage.local`; the password is not stored in plaintext.

---

## 隐私政策要点（商店还需要一个可公开访问的 URL）

- 收集内容：账号用户名/密码（仅用于登录注册）、当前答卷图片、题目和评分标准文本、评分结果。
- 用途：请求 AI 建议分并辅助老师确认；不用于广告、画像或出售。
- 数据流向：扩展 → 用户自己配置的 Easy Grader 服务端 → 部署方配置的 AI 模型服务商。
- 存储：登录令牌和设置保存在浏览器本地；服务端保存评分记录和账号数据，答卷图片默认不保存（部署方开启 `SAVE_TRACES` 时才会保存到其本地磁盘）。
- 用户控制：可退出登录清除本地令牌；站点权限可随时撤销；服务端数据由部署方管理员管理。
- 联系方式：`<填你的邮箱>`。
