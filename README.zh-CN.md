[English](README.md) · [简体中文](README.zh-CN.md)

# Polyrhythmic Metronome（多层复节奏节拍器）

> A metronome for meters that shouldn't exist.
>
> 59/16？73/32？有何不可。

一个用于练习与作曲的离线节拍器，专门服务于"不该存在"的拍号。
分子分母随便填——7/8、13/16、23/7、59/16 都可以；把小节拆成你自己的分组，
标出重音与静音，再叠上多层互不干扰的节奏。

项目本体就是 HTML + CSS + 原生 JavaScript，跑在 Web Audio API 上。
没有后端、没有框架、没有构建步骤：同样三个文件（`index.html`、
`style.css`、`app.js`）在所有平台上共用，Android 用 Capacitor 封装，
Windows 用 Electron 封装。

## 功能特性

- **任意拍号** — 分子支持 1–1024，分母支持 1–256（正整数）。7/8、11/16、
  59/16、73/32 都只是数字，没有写死的"合法拍号表"。
- **自定义分组（Grouping）** — 按 3+3+2+5+7… 的方式拆分小节，可手动修改
  任意一组、增删组、◀/▶ 调整顺序，并实时校验各组之和与分子是否一致。
  快捷操作：自动分组、平均分配、组首重音、清空。
- **重音 / 普音 / 静音 Pattern** — 点击任意细分单元格在 ● 重音、○ 普音、
  × 静音之间循环。支持重置 Pattern、全部普音、随机生成。
- **多层复节奏** — 同时播放多个拍号（59/16 对 7/16 对 11/16）。每层拥有
  独立的拍号、分组、Pattern 与静音状态。
- **每层独立音色 / 音量 / 倍率** — 5 种纯算法合成音色（Classic Click、
  Wood Block、Electronic、Soft Click、Cowbell），独立音量与重音音量，
  以及 0.1×–8× 的每层 BPM 倍率。
- **Web Audio 前瞻调度** — 25ms 的调度器每 tick 填充 80ms 的前瞻窗口，
  所有音频事件都落在 AudioContext 时钟上，而不是主线程定时器上。
- **Tap Tempo** — 连点 `TAP TEMPO` 即可测速定 BPM。
- **本地预设** — 7 个内置预设（59/16、59:7:11、73/32、23/7、17/16、7/8、
  4/4），以及保存在 `localStorage` 的自定义预设。
- **URL 分享配置** — 当前 BPM 与所有图层（拍号、分组、Pattern、音色、
  音量、倍率、静音）会被编码进 URL fragment，打开链接即可还原同一配置。
- **屏幕常亮（Screen Wake Lock）** — 播放期间保持屏幕不熄灭。
- **离线运行** — 无服务器、无统计上报、无网络请求，本地文件或任意静态
  托管都能跑。

## 截图

暂无截图——移动端布局定稿后会补充到这里。

## 运行方式

### Web

直接用浏览器打开 `index.html`，或起一个静态服务器：

```bash
npm run serve    # http://localhost:3000
```

仅运行不需要安装依赖；`npm install` 只在打包（Android / Windows）时需要。

### Android

环境要求：JDK 21，以及带 platform 35 与 build-tools 的 Android SDK
（Android Studio 会一并装好）。

```bash
npm install
npm run cap:sync                 # 把网页资源复制到 android 工程

cd android
gradlew assembleDebug            # macOS / Linux 用 ./gradlew assembleDebug
```

APK 输出在 `android/app/build/outputs/apk/debug/app-debug.apk`，使用 debug
签名，可直接 `adb install` 安装。

Release 构建（`gradlew assembleRelease`）的签名配置从
`android/keystore.properties` 读取，该文件已 gitignore。请自行创建 keystore
并在其中填写：

```properties
storeFile=../keystore/release.keystore
storePassword=...
keyAlias=...
keyPassword=...
```

applicationId 为 `com.polyrhythm.metronome`。应用只声明了 `WAKE_LOCK`
权限：页面资源由 WebView 本地提供，没有任何网络请求，因此**有意不申请**
`INTERNET` 权限。

修改网页文件后，需要重新执行 `npm run cap:sync` 再构建。

### Windows

```bash
npm install
npm start           # 开发运行 Electron 应用
npm run build:win   # 打包绿色版
```

`build:win` 使用 `electron-packager`，产物为
`release/Polyrhythmic Metronome-win32-x64/Polyrhythmic Metronome.exe`，
免安装，双击即用。

## 分享配置

点击顶部的 **分享配置** 按钮，当前 BPM 与所有图层会被序列化为 JSON，
base64 编码进 URL fragment 并复制到剪贴板。打开该链接即可还原完全相同的
配置。整个过程不经过任何服务器，解码在浏览器本地完成。

## 项目结构

```
polyrhythmic-metronome/
├── index.html            # 入口，Web / Electron / Capacitor 共用
├── style.css             # DAW 风格暗色主题 + 响应式规则
├── app.js                # 状态、节奏模型、Web Audio 调度器、UI
├── package.json          # 脚本与打包元数据
├── capacitor.config.json # Capacitor Android 配置
├── scripts/
│   └── prepare-cap.js    # 把网页资源复制到 www/
├── electron/
│   └── main.js           # Electron 主进程
├── android/              # Capacitor Android 工程（Gradle）
├── assets/               # 图标（svg）
└── LICENSE
```

`www/`、`release/`、`build/`、`dist/` 均为生成目录，已被 gitignore。

## 许可证

Polyrhythmic Metronome 使用 **Polyrhythmic Metronome Source-Available
Non-Commercial License**（源码可见非商业许可证），详见 [LICENSE](LICENSE)。

它**不是** OSI 认可的开源许可证。你可以出于个人、教育、研究及其他非商业
目的查看、运行、学习、修改和分享代码；商业用途需事先取得版权方许可。
Copyright (c) 2026 OokoukiBob。

## 参与贡献

欢迎在
[ookoukibob/polyrhythmic-metronome](https://github.com/ookoukibob/polyrhythmic-metronome)
提交 issue 和 pull request，尤其是缺陷修复与各平台打包问题。请保持改动聚焦；
贡献内容同样遵循上述非商业许可证（见 [LICENSE](LICENSE) 中的贡献条款）。
