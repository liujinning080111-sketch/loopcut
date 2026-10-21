# iPhone Safari 兼容性与技术边界

核实日期：2026-10-21。本文区分 Web 平台能力、项目设计选择与尚待真机确认的行为。**目标平台为 iOS 17 及以上的 Safari 和主屏幕 Web App；这是一项产品兼容目标，不代表已经完成所有版本、机型的实测。** 真机记录见 [DEVICE-TESTS.md](./DEVICE-TESTS.md)。

## 已核实的能力与实现选择

| 功能 | 核实结果 | 本项目采用的方式与限制 |
| --- | --- | --- |
| 导入手机录屏 | 用户可通过文件选择器交付本地视频，文件名后缀不等于编码格式 | 用本地 File / blob URL 交给浏览器原生视频解码；不把录屏上传到处理服务器。读取元数据和实际帧是否成功才是最终判断。 |
| 视频解码 | Apple 推荐静态视频使用 H.264 MP4；Safari 也有 HEVC 能力，但具体容器、编码配置、硬件和系统版本仍影响解码 | 优先 H.264 MP4；MOV / HEVC 交由当前设备尝试。不内置通用转码器，失败时提示转为 H.264 MP4 或重新导出。不能承诺“所有 MOV 都支持”。[Apple 视频说明](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)、[WebKit Safari 17](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) |
| 视频逐帧提取 | Canvas 可以绘制 HTMLVideoElement；正确绘制要求视频有当前帧，seek 操作异步完成 | 使用 videoWidth / videoHeight，等待 seeked 和可用画面后裁剪。顺序 seek，设超时和取消，不并发抢同一个视频元素。[Canvas drawImage](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage)、[seeked](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seeked_event) |
| 内联播放 | iPhone 的 playsinline 避免自动进入全屏；静音视频可符合放宽后的播放条件，play() 仍可能被拒绝 | 视频保持 muted / playsinline；以用户导入、点击操作启动流程，处理播放或解码失败。不能把可播放推断成任何后台情境都能解码。[WebKit 视频策略](https://webkit.org/blog/6784/new-video-policies-for-ios/) |
| GIF | GIF 使用索引颜色和二值透明：像素只能完全透明或完全不透明 | 本地量化和编码；透明边缘不能保留 PNG 式半透明，不承诺无损颜色或毛发级抠图。[MDN GIF 格式](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types#gif_graphics_interchange_format) |
| 文件分享 | Web Share 要求安全上下文、用户激活，文件支持还需实际检测 | **先生成 GIF，再让用户点击分享。** 对最终 File 调用 canShare({files})，点击事件中立即 share({files})。不在长时间编码结束后自动弹分享；不支持时提供下载或打开 GIF。[share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)、[canShare](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/canShare) |
| 保存到照片 | 网页的文件分享不是原生 PhotoKit 的图库写入授权 | 用户自行在系统菜单选择可用的保存方式。菜单可能随 iOS、来源应用或文件而变化；分享完成不等于已存入照片。网页不能无权限静默写入照片图库。[Apple 原生媒体保存授权](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)、[Web Share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share) |
| 添加到主屏幕 | Safari 支持用户通过分享菜单添加 Web App | 提供 manifest、图标、standalone 展示。由用户手动“添加到主屏幕”；当前系统若显示“作为 Web App 打开”应启用。[Apple iPhone 操作说明](https://support.apple.com/guide/iphone/iphea86e5236/ios) |
| 离线使用 | Service Worker 在 HTTPS / localhost 可缓存应用资源；缓存受配额及回收策略影响 | 缓存应用壳，第一次完整加载后可离线打开。离线不表示录屏、编辑会话或 GIF 被永久保存；清理网站数据或系统回收后需重新联网。[Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)、[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/) |
| 后台处理 | iOS 可以挂起后台网页，动画回调和计时器会暂停或限流 | 处理期间保持前台、避免锁屏；返回后若任务失效，重新导入。Service Worker 不为视频处理提供持续后台执行保证。[WebKit 电量与后台行为](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) |

`canPlayType()` 仅返回浏览器对媒体类型的估计，不能代替实际载入测试；也不要仅按 User-Agent 宣布兼容。[MDN canPlayType](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType)

## 图像与时间处理的固有限制

以下是根据输入信息和所选算法推导出的边界，不是浏览器兼容性结论：

- 录屏已经把透明表情与评论区背景合成。恢复透明是从背景颜色估计出的蒙版，无法凭空恢复原始 alpha；白色主体、阴影、渐变、背景同色边缘可能误删或留边。
- 智能模式应在边缘背景足够一致时建议透明，否则保留矩形；用户可随时改回矩形。透明模式的结果必须在不同底色预览中检查。
- 运动区域并不必然是表情。评论区滚动、点赞动画、多个表情或视频背景都会制造候选。自动区域是建议，手动画框是必要路径。
- 完整循环检测需要录到足够的重复内容。建议固定画面录下至少两遍，最好三遍，开始与结束不要遮住表情。不足一遍时任何算法都不能恢复缺失动作。
- 相同姿势可能出现在一个循环内部，因此只比较两张相同帧不足以证明周期；还需序列匹配及置信度。重复静止帧合并时必须累加停留时间，否则动画会加速。
- HTMLMediaElement 按时间 seek 的结果取决于解码器、时间精度与源文件。采样提取不是原始 GIF 帧的精确重建；可变帧率视频及短于采样间隔的动作可能丢失。
- 微信对个人表情的接收、大小限制与分享目标由微信版本和系统决定。本项目导出标准 GIF，不宣称固定大小阈值在所有微信版本通用；应在真实微信中验证动画与透明效果。

## 为什么使用纯前端处理

本项目以浏览器原生视频解码、Canvas 图像处理和 JavaScript GIF 编码为基础，避免要求用户安装转码插件。项目只需静态资源，适合 GitHub Pages。[GitHub Pages 定义](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

不把多线程 ffmpeg.wasm / SharedArrayBuffer 作为必需依赖。共享内存通常要求 cross-origin isolation，包含 COOP / COEP HTTP 响应头等条件；不能用普通 HTML meta 标签替代这些响应头，也不能假定任意 Pages 地址自动满足要求。这里的选择是部署可移植性决策，不是声称所有 WebAssembly 都无法使用。[MDN crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)

桌面 localhost 是安全上下文例外；iPhone 打开局域网 `http://电脑IP:端口` 不能等同于 localhost。可用它做部分界面检查，完整分享、Service Worker、安装和离线验收必须使用可信 HTTPS。

## GitHub Pages 部署检查

1. 项目站通常位于 `https://用户名.github.io/仓库名/`，不是域名根路径。JS、CSS、manifest、图标、Service Worker 与 worker 脚本都必须在该子路径下解析。[Pages 站点路径](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
2. 使用 GitHub Actions 构建并上传静态产物，仓库 Settings → Pages → Source 选 GitHub Actions。工作流通过并返回地址才是上线证据；本地构建成功不代表已经部署。[GitHub 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
3. 打开 HTTPS 地址，并检查无混合内容。`.github.io` 与正确配置的自定义域名支持 HTTPS。[GitHub HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
4. 在真实子路径下做一次首次加载、刷新、安装、断网重开及 GIF 导出；不能只测 `/`。
5. 应用本地处理录屏与静态托管访问日志是不同事项。GitHub 会记录访问者 IP；“不上传录屏”不等于托管服务完全没有访问日志。[GitHub Pages 数据收集](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection)

## 仍需设备验证

文档研究可以确认 API 的设计和限制；不能据此断言某台 iPhone 上的 HEVC 解码、长视频内存、系统分享菜单、照片中的动画或微信导入已经成功。请依据 [DEVICE-TESTS.md](./DEVICE-TESTS.md) 记录机型、iOS、素材与实际结果。
