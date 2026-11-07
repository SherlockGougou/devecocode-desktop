# 官网

这是 DevEco Code Desktop 的静态官网，不依赖前端框架或构建工具。入口页是 `index.html`，
安装说明是独立的 `install.html`。

## 本地预览

在仓库根目录运行：

```bash
python3 -m http.server 4173 --directory website
```

然后打开 <http://localhost:4173>。不要直接双击 HTML 用 `file://` 打开，否则相对资源和
剪贴板 API 的行为可能与 Pages 不一致。

提交前可以检查 HTML 结构：

```bash
npx --yes html-validate@9 --config website/.htmlvalidate.json website/index.html website/install.html
```

## GitHub Pages

`.github/workflows/pages.yml` 会在以下情况部署：

- `website/` 或 workflow 改动推送到 `main`；
- 在 Actions 中手动运行 `Pages`。

首次使用需要在 GitHub 仓库设置中完成：

1. **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；
2. 确认 workflow 有 `pages: write` 与 `id-token: write` 权限（已配置）；
3. 运行一次 `Pages` workflow，或推送一次 `website/` 改动。

项目站点地址通常为：

```text
https://<owner>.github.io/<repo>/
```

站点使用相对路径，因此项目 Pages 的二级路径可以直接工作。

## 自定义域名

使用自定义域名时，`script.js` 无法从 `*.github.io` 推导仓库地址。请把文件顶部的
`REPO_URL` 改成实际的仓库地址，例如：

```js
const REPO_URL = "https://github.com/example/deveco-code-desktop";
```

并在 Pages 设置中配置自定义域名和 DNS；需要时同时在 `website/` 添加 `CNAME`。

## 内容维护

- 下载版本、架构名称和发布提示必须与 `docs/installation.md` 保持一致；
- 版本升级时同步更新 `index.html` 和 `install.html` 页脚的版本号；
- 页面不包含真实工作区、消息、设备截图或用户路径；
- 新增外链使用 `rel="noreferrer"`，静态资源使用相对路径；
- 修改导航、按钮或安装步骤后，用桌面和窄屏视口各检查一次。
