# Release Notes

每个发布标签对应一份 Markdown 文件：

```text
docs/releases/v0.2.5.md
```

发布 workflow 在普通版和 Offline 版产物都上传完成后，读取与标签同版本的文件并更新
GitHub Release 正文。文件必须同时包含以下二级标题：

```markdown
## 中文
## English
```

版本文件应说明：

- 本版本的变更和两种安装包的区别；
- Apple Silicon / Intel 的 DMG 文件名；
- CLI 是否内置、是否需要单独安装；
- 未签名、未公证的首次打开流程；
- 应用内更新的适用范围；首个带更新功能的版本要说明更早版本需手动安装一次；
- `latest.json`、`latest-offline.json`、`.app.tar.gz` 和 `.sig` 的作用；
- `SHA256SUMS.txt` 与 artifact attestation 的校验入口；
- 已知限制和完整安装文档链接。

新增版本时复制上一版本文件，更新版本号、日期、变更内容和资产文件名，不要把凭据或未脱敏
截图写入 Release notes。
