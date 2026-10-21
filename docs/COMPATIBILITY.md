# iPhone Safari 兼容性与技术边界

基础核实日期：2026-10-21；VideoFrame 裁剪与动画短延时规则重新核实于 2026-10-22。本文区分 Web 平台能力、项目设计选择与尚待真机确认的行为。**目标平台为 iOS 17 及以上的 Safari 和主屏幕 Web App；这是一项产品兼容目标，不代表已经完成所有版本、机型的实测。** 真机记录见 [DEVICE-TESTS.md](./DEVICE-TESTS.md)。

## 已核实的能力与实现选择

| 功能 | 核实结果 | 本项目采用的方式与限制 |
| --- | --- | --- |
| 导入手机录屏 | 用户可通过文件选择器交付本地视频，文件名后缀不等于编码格式 | 用本地 File / blob URL 交给浏览器原生视频解码；不把录屏上传到处理服务器。读取元数据和实际帧是否成功才是最终判断。 |
| 视频解码 | Apple 推荐静态视频使用 H.264 MP4；Safari 也有 HEVC 能力，但具体容器、编码配置、硬件和系统版本仍影响解码 | 优先 H.264 MP4；MOV / HEVC 交由当前设备尝试。不内置通用转码器，失败时提示转为 H.264 MP4 或重新导出。不能承诺“所有 MOV 都支持”。[Apple 视频说明](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)、[WebKit Safari 17](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) |
| 原帧时间轴 | 容器样本有实际呈现时间戳，VFR 的间隔不必相等；解码顺序与呈现顺序也可能不同 | Mediabunny 读取本地样本 PTS，按实际时间生成导出调度；不能用估计 FPS 代替。WebCodecs 时间为整数微秒，格式编码还需考虑各自延时精度。[Mediabunny 读取说明](https://mediabunny.dev/guide/reading-media-files)、[WebCodecs](https://www.w3.org/TR/webcodecs/#encodedvideochunk) |
| 视频逐帧提取 | Safari 16.4 起提供视频 WebCodecs，HEVC WebCodecs 在 Safari 17.4 才加入 | 按实际配置检测解码能力，通过 CanvasSink 取原帧并核对时间戳。不能从 HTMLVideoElement 可播放推导出 WebCodecs 同样支持。[Safari 17.2 说明](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#webcodecs)、[Safari 17.4 说明](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/#additional-codecs) |
| 兼容取帧回退 | Canvas 可绘制视频当前帧；seek 异步，实际定位取决于浏览器 | 无法逐帧解码时可按源时间轴请求 video seek；明确显示兼容解码提示，不能承诺严格原帧对应。等待 seeked 与可绘制帧，并设超时及取消。[Canvas drawImage](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage)、[seeked](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seeked_event) |
| 内联播放 | iPhone 的 playsinline 避免自动进入全屏；静音视频可符合放宽后的播放条件，play() 仍可能被拒绝 | 视频保持 muted / playsinline；以用户导入、点击操作启动流程，处理播放或解码失败。不能把可播放推断成任何后台情境都能解码。[WebKit 视频策略](https://webkit.org/blog/6784/new-video-policies-for-ios/) |
| GIF | 每个活动色表最多 256 项，透明度为透明索引，帧延时单位是 1/100 秒 | 默认保留原裁剪尺寸及全部选区帧，但颜色与延时受格式约束，不能宣称原视频无损。不同帧可有不同局部色表，不应误写成整部动画只能出现 256 色。[GIF89a 规范](https://www.w3.org/Graphics/GIF/spec-gif89a.txt) |
| APNG | 支持完整 RGBA 和有理数帧延时；Safari 支持 APNG | 可选保真备份，无损保存交给编码器的解码后 8-bit RGBA；不保证微信表情接受，也不等于原 HDR/YUV 视频逐字节无损。[PNG/APNG 规范](https://www.w3.org/TR/png-3/)、[MDN APNG](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types#apng_animated_portable_network_graphics) |
| 文件分享 | Web Share 要求安全上下文、用户激活，文件支持还需实际检测 | **先生成动画文件，再让用户点击分享。** 对最终 File 调用 canShare({files})，点击事件中立即 share({files})。不在长时间编码结束后自动弹分享；不支持时提供下载或打开结果。[share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)、[canShare](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/canShare) |
| 保存到照片 | 网页的文件分享不是原生 PhotoKit 的图库写入授权 | 用户自行在系统菜单选择可用的保存方式。菜单可能随 iOS、来源应用或文件而变化；分享完成不等于已存入照片。网页不能无权限静默写入照片图库。[Apple 原生媒体保存授权](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)、[Web Share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share) |
| 添加到主屏幕 | Safari 支持用户通过分享菜单添加 Web App | 提供 manifest、图标、standalone 展示。由用户手动“添加到主屏幕”；当前系统若显示“作为 Web App 打开”应启用。[Apple iPhone 操作说明](https://support.apple.com/guide/iphone/iphea86e5236/ios) |
| 离线使用 | Service Worker 在 HTTPS / localhost 可缓存应用资源；缓存受配额及回收策略影响 | 缓存应用壳，第一次完整加载后可离线打开。离线不表示录屏、编辑会话或 GIF 被永久保存；清理网站数据或系统回收后需重新联网。[Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)、[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/) |
| 后台处理 | iOS 可以挂起后台网页，动画回调和计时器会暂停或限流 | 处理期间保持前台、避免锁屏；返回后若任务失效，重新导入。Service Worker 不为视频处理提供持续后台执行保证。[WebKit 电量与后台行为](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) |

`canPlayType()` 仅返回浏览器对媒体类型的估计，不能代替实际载入测试；也不要仅按 User-Agent 宣布兼容。[MDN canPlayType](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType)

## 原尺寸与帧时序的边界

默认 GIF 使用原裁剪像素尺寸、源 PTS 调度；只有用户主动选较小尺寸或固定帧率时才缩减。裁剪框以经典四角调整大小、框内拖动位置，最终矩形映射到旋转 / 翻转后的显示像素并取整。当前保护上限是单边 8192 px、单帧 16,777,216 像素、1440 帧、128 MiB 输出文件；超出时失败退出，不自动缩图或抽帧。设备可能在达到这些保护值之前耗尽资源，128 MiB 也不是进程内存上限或微信接收承诺。

WebKit 的 VideoFrame 绘制重载尚未使用源矩形：仅把完整帧绘入目标矩形。这会使直接通过 Mediabunny `CanvasSink.crop` 裁剪的结果变成整屏压缩。项目先让 CanvasSink 生成完整、已旋转 / 翻转的显示画布，再从该 Canvas 读取选区像素；显式缩小也从 Canvas 裁剪缩放。此路径同时检查完整源帧与输出帧尺寸，因此小选区不能绕过完整源帧的 8192 px 单边 / 16,777,216 像素预算。源码核实不等于已在全部 iPhone 版本完成修复验收。[WebKit VideoFrame 绘制](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/canvas/CanvasRenderingContext2DBase.cpp#L1832-L1863)、[Mediabunny 1.62 绘制实现](https://github.com/Vanilagy/mediabunny/blob/v1.62.0/src/sample.ts#L1292-L1408)

GIF 无法逐帧精确表示 1/60 秒或不足 10 ms 的间隔。项目对完整序列统一分配 10 ms 整数倍延时，每个选区帧至少保留 10 ms，不因短头帧、短尾帧或 VFR 短帧拒绝整段，也不抽掉这些帧。可行时，文件总时长取原总时长最接近的 10 ms；若帧数乘以 10 ms 已超过该时长，则延长至能容纳全部帧的最低时长，并显示实际生成文件的时长。协调局部时间边界可能改变节奏，不能称为逐帧时序无损。[GIF89a 延时定义](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)

文件时长与播放器展示时长仍是两件事。60 fps 常写成 10 / 20 ms 交替；当前 WebKit 的 Apple 图像解码路径把小于 11 ms 的帧延时改成 100 ms，可能使结果明显变慢。最低 10 ms 是文件编码策略，不是 Safari 原速播放保证；这项上游源码证据也不能替代某个 iOS / 微信版本的实际播放测试。[WebKit frameDurationAtIndex](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/cg/ImageDecoderCG.cpp#L506-L533)

APNG 的 delay_num / delay_den 各为 uint16，按秒解释；1/30、1/60、1001/30000 等常见间隔可精确表示，一般 VFR 分数仍可能超出字段范围。APNG 的 1/120 秒也可能触发播放器短延时钳制，屏幕刷新和运行负载另会影响展示。因此“文件保存每帧”不等于“所有播放器原速显示”。PNG 无损只覆盖编码输入的 RGBA；浏览器的视频解码、色彩空间转换和 HDR 到 SDR 映射可能已经改变像素。[PNG/APNG fcTL](https://www.w3.org/TR/png-3/#fcTL-chunk)、[WebCodecs 像素转换](https://www.w3.org/TR/webcodecs/#videoframecopytooptions)

Mediabunny 1.62.0 会将支持的简单 edit list 偏移映射到 packet PTS，但多段 edit 或非 1 倍速 edit 只发出警告，不代表完整实现。项目拦截此类警告以停止原帧模式；复杂剪辑和非标准时间轴不在“任意 MOV 都支持”的承诺内。对简单 edit 的有效裁尾区间、负时间预滚、空区间和旋转一致性也必须保守处理，无法确认时不可声称原时间轴精确重建。[固定版本容器解析源码](https://github.com/Vanilagy/mediabunny/blob/v1.62.0/src/isobmff/isobmff-demuxer.ts#L1090-L1134)

界面起止时间的显示舍入不能扩大真实视频范围：例如 32 帧 / 30 fps 视频约长 1.066667 秒，即使用户输入 1.07 秒，实际终点仍限制在该片尾。固定帧率采样仅消除浮点运算制造的零时长额外帧；真实存在的短残帧仍保留并交给所选格式处理。

rVFC 的触发频率受视频帧率与浏览器绘制频率中较低者限制，120 fps 视频在 60 Hz 绘制时可能只有约 60 次回调，且回调时机没有严格同步保证。它可用于预览与就绪协调，不能用于证明所有源帧都已枚举或用回调频率冒充原 FPS。[MDN requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)

## 图像与时间处理的固有限制

以下是根据输入信息和所选算法推导出的边界，不是浏览器兼容性结论：

- 录屏已经把透明表情与评论区背景合成。恢复透明是从背景颜色估计出的蒙版，无法凭空恢复原始 alpha；白色主体、阴影、渐变、背景同色边缘可能误删或留边。
- 智能模式应在边缘背景足够一致时建议透明，否则保留矩形；用户可随时改回矩形。透明模式的结果必须在不同底色预览中检查。
- 运动区域并不必然是表情。评论区滚动、点赞动画、多个表情或视频背景都会制造候选。自动区域是建议，手动画框是必要路径。
- 完整循环检测需要录到足够的重复内容。建议固定画面录下至少两遍，最好三遍，开始与结束不要遮住表情。不足一遍时任何算法都不能恢复缺失动作。
- 相同姿势可能出现在一个循环内部，因此只比较两张相同帧不足以证明周期；还需序列匹配及置信度。重复静止帧合并时必须累加停留时间，否则动画会加速。
- 源视频时间轴与抖音内部播放的原始 GIF 时间轴不是同一个对象。录屏本身可能已经丢帧或变帧率，保留录屏每帧也不能恢复录屏前已丢失的动作。兼容 seek 路径及用户选择的固定帧率采样还可能进一步改变逐帧对应。
- 微信对个人表情的接收、大小限制与分享目标由微信版本和系统决定。本项目导出标准 GIF，不宣称固定大小阈值在所有微信版本通用；应在真实微信中验证动画与透明效果。

## 为什么使用纯前端处理

本项目以本地容器解析、浏览器原生视频解码、Canvas 图像处理和 JavaScript GIF / APNG 编码为基础，避免要求用户安装转码插件。项目只需静态资源，适合 GitHub Pages。[GitHub Pages 定义](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

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
