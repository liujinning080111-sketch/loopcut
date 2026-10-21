# GitHub Pages 部署

这个项目是纯静态 PWA。视频与导出 GIF 只在浏览器内处理。仓库只需要源代码，不要上传个人录屏、node_modules、test-results 或密钥。

## 自动部署

1. 在 GitHub 新建独立仓库，将本项目目录中的所有源文件（包括 `.github/workflows/pages.yml`、锁文件、`public/`、`scripts/`）提交到 `main`。
2. 打开仓库 Settings → Pages → Build and deployment → Source，选择 **GitHub Actions**。
3. 首次设置完成后在 Actions → Test and deploy Pages → Run workflow 运行。后续推送 main 会自动进行单元测试、构建、Chromium/WebKit 浏览器测试，再部署。PR 只检查不部署。
4. 在 Actions 的 `deploy` 任务查看真实部署 URL。只有任务成功且地址能打开，才算完成发布。
5. iPhone Safari 打开 HTTPS 地址，导入短录屏完成验收后，在分享菜单选择「添加到主屏幕」。

仓库项目地址通常为 `https://<账号>.github.io/<仓库>/`。构建 `base: './'`，manifest、Worker、service worker 和图标使用相对路径，不需要写死账号或仓库名。可以部署在根域或仓库子路径，需以目录 URL（末尾斜杠）打开。

## 本地检查

```sh
npm ci
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
npm run preview
```

开发模式没有注册离线缓存；`npm run build` 后 `npm run preview` 才能检查生产 Worker 和 service worker。电脑上的 localhost 可以测试安全上下文功能。iPhone 上通过电脑的 HTTP 局域网 IP 访问不等于 HTTPS，不能据此判断文件分享与 PWA 是否支持。

## 静态发布备选

若没有 GitHub CLI 凭据，浏览器也能上传构建好的站点目录。可将 `dist/` 内容提交到独立 `gh-pages` 分支，再在 Settings → Pages 选 Deploy from a branch → gh-pages → / (root)。这条路径必须在上传前本地完成检查，每次更新都重新构建；它不会自动运行源码仓库里的测试。生产包中的 `.nojekyll` 必须保留。

## 更新与回退

- 应用壳由构建产物内容哈希版本化。新 service worker 等旧页面关闭后再接管，避免处理录屏时强制刷新。关闭所有该站点标签和主屏幕应用后重开以更新。
- 只清理当前 scope 的旧缓存，避免影响同域其他 Pages 项目。
- 自动部署时用 GitHub Revert 撤回出问题的提交，再等新的成功部署；分支静态部署时回退对应产物提交。回退后也需要关闭旧页面再打开。
- 缓存可被 iOS 清除。无法离线打开时联网重新访问；不会恢复被关闭页面里尚未保存的 GIF。

## 权限与验证范围

GitHub Pages 使用 HTTPS；Actions 部署仅授予 `contents: read`、`pages: write`、`id-token: write`。不要关闭仓库保护或给工作流添加密钥。没有设置服务器、数据库、视频上传端点、分析追踪或第三方 CDN。

真实 iPhone、系统分享接收方和当前微信客户端仍需执行 [DEVICE-TESTS.md](DEVICE-TESTS.md)。浏览器测试的 WebKit 并不等于 iPhone Safari 真机验证。

参考：[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[发布源设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。核实日期：2026-10-21。
