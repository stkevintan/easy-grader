# 隐私政策页面

`index.html` 是一个自包含的静态页面：没有外部字体、脚本、Cookie 或第三方分析。

Easy Grader 服务端会自动把本目录挂在 `/privacy/`（`/privacy` 会 301 到 `/privacy/`），Docker 镜像也已经把该目录复制到 `/app/privacy`。所以用本项目服务端部署时，不需要额外的 Nginx 配置，直接访问：

```
https://grader.flyfly.top/privacy/
```

就可以填到 Chrome 应用商店。如果服务端部署在其他域名，换成对应域名即可。也可以通过 `PRIVACY_DIR` 指定其他目录。

下面的独立静态部署方式只在你不使用 Easy Grader 服务端、或想把隐私页放到另一个域名时使用。

## 部署前替换

页面里有 4 处黄色占位内容，必须替换：

- `[请填写学校或机构名称]`
- `[请填写联系邮箱]`
- `[请填写本页面的公开网址]`
- 英文摘要里的 `[contact email]`

生效日期也可以按实际发布时间修改。

## 部署方式

要求：**公网可访问、不需要登录、使用 HTTPS**。Chrome 应用商店只检查这个 URL 能打开，不要求它和扩展的服务端同域。

### Nginx（和 Easy Grader 服务端放在同一台机器）

把 `privacy/` 目录上传到服务器，例如 `/srv/easy-grader/privacy/`，然后在现有站点的 `server { ... }` 里加：

```nginx
location = /privacy { return 301 /privacy/; }
location /privacy/ {
    alias /srv/easy-grader/privacy/;
    index index.html;
}
```

放在反向代理 `location /` 前面即可。最终地址形如：

```
https://grader.flyfly.top/privacy/
```

### Caddy

```caddy
handle_path /privacy/* {
    root * /srv/easy-grader/privacy
    file_server
}
```

### GitHub Pages / 其他静态托管

把 `privacy/` 目录作为站点根目录（或仓库里的 `privacy/` 子目录）发布，得到形如：

```
https://<用户名>.github.io/<仓库名>/privacy/
```

也可以直接拖到 Netlify、Cloudflare Pages、对象存储静态网站等处。不要给页面加登录或访问控制。

## 填到 Chrome 应用商店

在开发者后台的「隐私权规范 / Privacy practices」里填写这个公开 URL。建议同时确认：

- 单一用途、权限理由按 `extension/store/permission-justifications.md` 填写；
- 数据使用类型勾选与页面描述一致（账号信息、网站内容）；
- 不使用远程代码；
- 隐私政策 URL 能在无痕窗口直接打开。
