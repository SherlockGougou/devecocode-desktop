# Updater fixtures

这里只保存文本签名 fixture。`.app.tar.gz` 是测试时由
`scripts/updater/prepare-fixtures.mjs` 在临时目录生成的空文件，真实安装包不进入仓库。

```bash
node scripts/updater/prepare-fixtures.mjs --out /tmp/updater-fixture-assets
```
