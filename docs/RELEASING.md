# 发版

发版由 tag 触发，全部在 GitHub Actions 上完成。

```bash
git switch main && git pull
npm version patch   # 或 minor / major / prerelease --preid beta
```

`npm version` 会依次：

1. `preversion`：检查当前在 main、工作区干净、和 `origin/main` 一致，再跑类型检查（完整测试交给 CI）；
2. 改 `package.json` / `package-lock.json` 的版本号，提交并打 `vX.Y.Z` tag；
3. `postversion`：`git push --follow-tags`。

tag 推上去后，[`release.yml`](../.github/workflows/release.yml) 会：

1. 调用完整的 [`ci.yml`](../.github/workflows/ci.yml)（类型检查、构建、单元测试矩阵、打包冒烟测试、E2E），任何一项失败都不会发布；
2. 确认 tag 和 `package.json` 的版本一致；
3. 构建、`npm pack`，用 `--provenance` 发布到 npm。版本号带 `-`（如 `0.2.0-beta.1`）的发到 `next` 标签，否则发到 `latest`；该版本已在 npm 上时跳过；
4. 创建 GitHub Release（自动生成更新说明），附上 npm 包 tarball。

## npm 认证（只需设置一次）

推荐用 **Trusted Publishing**，不需要任何令牌：

1. 包至少要在 npm 上存在一次（第一次可以本地 `npm publish`，或先走下面的令牌方式）；
2. 在 npmjs.com 打开 `@vauntlek/pi-web` → Settings → Trusted Publisher → GitHub Actions，填写：
   - Organization or user：`VauntlekV`
   - Repository：`pi-web`
   - Workflow filename：`release.yml`
   - Environment：`npm`
3. 之后发布不再需要令牌，可以删掉 `NPM_TOKEN` secret。

备用方式：在 npm 上建一个 granular access token（对 `@vauntlek/pi-web` 有读写权限，勾选 bypass 2FA），然后在本地运行

```bash
gh secret set NPM_TOKEN
```

按提示粘贴令牌（不要把令牌写进命令行或发给别人）。

## 发布环境保护（可选）

发布 job 使用名为 `npm` 的 GitHub environment。想在发布前人工确认，可以在仓库 Settings → Environments → npm 里加上 Required reviewers。

## 演示站点

[`pages.yml`](../.github/workflows/pages.yml) 在每次推送 main 时重新录制并部署 <https://vauntlekv.github.io/pi-web/>，PR 上只构建不部署。仓库 Settings → Pages 的 Source 需要是 “GitHub Actions”。
