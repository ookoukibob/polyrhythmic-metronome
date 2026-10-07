# 高级多节拍/奇数拍节拍器 (Advanced Polyrhythmic Metronome)

这是一个纯前端、跨平台的现代化高级节拍器，专为音乐人、贝斯手、鼓手与作曲者设计。

**统一跨平台架构 (Single Codebase)**：
* **核心代码**：HTML5 + CSS3 + Vanilla JavaScript (与平台完全解耦，三端共享 100% 逻辑代码)
* **音频引擎**：Web Audio API (Look-Ahead 前瞻调度器，sample-accurate 极低延迟，防抖动，离线合成)
* **数据存储**：`localStorage` (纯本地持久化，无后端、无数据库、无网络依赖)
* **三端发布体系**：
  1. **Web 版本**：直接双击 `index.html` 或静态托管运行。
  2. **Windows 桌面版 (`.exe`)**：基于 Electron 打包的独立桌面客户端。
  3. **Android 移动版 (`.apk`)**：基于 Capacitor 打包的原生 Android 工程。

---

## 核心特性实现

1. **标志性用例：59/16 奇数拍节拍器**
   - 启动即默认载入 59/16 复合分组：`3+3+2+5+7+4+6+5+2+3+4+5+3+3+4 = 59`。
   - 细分音符时长公式：`sixteenth duration = (4 / 16) * (60 / BPM) = 60 / BPM / 4`，精确计算每个十六分音符。
   - 分组总和校验：实时校验分组之和是否等于分子，差值醒目警告。

2. **任意拍号支持 (Arbitrary Meters)**
   - 分子支持任意正整数（如 4、7、13、17、41、59、73、137 等，支持至几百上千拍）。
   - 分母支持任意正数（如常见的 4/8/16/32，亦支持 7、5、3 等无理/奇数细分）。
   - 健壮的输入校验：杜绝 0、负数、NaN 等非法数值。

3. **分组系统 (Grouping System)**
   - 自动在各组第一个细分音符触发重音（Accent）。
   - 提供「自动分组 (Auto Group)」、「平均分配 (Even)」、「组首重音」、「一键清空」。
   - 支持新增组、删除组、直接输入数值，以及 **◀/▶ 快速调整分组顺序**。

4. **交互式细分网格 (Subdivision Grid)**
   - 完整显示 1..N 的细分单元格，点击循环切换三种状态：
     - **● 重音 (Accent)**：明亮橙色高亮，增益放大
     - **○ 普音 (Normal)**：清脆青色音
     - **× 静音 (Mute)**：灰色静音，不触发音频事件
   - 包含分组边界标识线，支持横向平滑滚动，并支持播放头自动居中视野跟踪。
   - 提供 Pattern 操作：重置为默认分组、全部普音、随机节奏型。

5. **多层复节奏 (Multi-Layer Polyrhythm)**
   - 支持同时播放多层独立节奏（如 `59/16` vs `7/16` vs `11/16`）。
   - 每层独立拥有：拍号 (分子/分母)、BPM 独立倍率、音色、音量、重音增益、静音及分组。

6. **Web Audio 稳定调度器 (Look-Ahead Scheduling)**
   - 采用 25ms 调度定时器结合 80ms 预调度窗口，在 Web Audio 线程精确触发音频节点。
   - 5 种纯算法合成音色（无需外部音频文件，零体积零加载）：
     - Classic Click (经典下潜正弦波)
     - Wood Block (共鸣滤波木鱼音)
     - Electronic (穿透性电子方波)
     - Soft Click (温和正弦音)
     - Cowbell 🐄 (双失谐金属方波)

7. **Transport 控制与练琴实用工具**
   - ▶ 播放 / ⏸ 暂停 / ■ 停止 / ↻ 重置。
   - 空格键 (Space) 全局播放/暂停快捷键。
   - BPM 控制：20–600（支持数字输入、滑块、+/-1、+/-5 微调）。
   - **Tap Tempo** 测速器。
   - **屏幕常亮保护 (Screen Wake Lock)**：播放期间自动保持设备屏幕常亮，防止手机/电脑休眠中断练习。

8. **预设管理与 URL 分享**
   - 包含 7 种经典/实验性内置预设（59/16、59:7:11、73/32、23/7、17/16 等）。
   - 本地 `localStorage` 自定义预设存取。
   - URL Hash 编码：一键复制完整配置的分享链接。

---

## 平台运行与打包指南

### 1. Web 版本运行

直接使用浏览器打开，完全离线可用：
```bash
# 方式 A：直接双击打开 index.html 即可运行
# 方式 B：如需本地静态服务器调试
npm run serve
```
访问 `http://localhost:3000` 即可。

---

### 2. Windows 桌面版 (`.exe`)

#### 直接运行已打包好的客户端：
已编译生成的 Windows 独立可执行程序位于：
```
release\Polyrhythmic Metronome-win32-x64\Polyrhythmic Metronome.exe
```
直接双击即可运行，绿色免安装。

#### 开发运行与重新打包：
```bash
# 启动桌面开发调试
npm start

# 重新打包 Windows 绿色版 .exe
npm run build:win
```
输出目录为 `release/Polyrhythmic Metronome-win32-x64/`。

---

### 3. Android 移动版 (`.apk`)

项目已完整初始化 Capacitor Android 工程（位于 `android/` 目录），配置了 `AndroidManifest.xml`、WAKE_LOCK 权限和 WebView 同步：

#### 同步最新前端代码至 Android 工程：
```bash
npm run cap:sync
```

#### 在 Android Studio 中打开并构建 APK：
```bash
npm run cap:open
```
在 Android Studio 中点击 **Build > Build Bundle(s) / APK(s) > Build APK(s)**，即可生成 `.apk` 文件。

#### 命令行直接构建 Debug APK（需配置本地 Android SDK）：
```bash
npm run build:android
```
生成的 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

---

## 项目结构

```
advanced-metronome/
├── index.html            # 统一前端入口 (Web / Electron / Capacitor 共享)
├── style.css             # 专业 DAW 暗黑主题样式与移动端适配
├── app.js                # 节拍器全量核心逻辑 (Web Audio、Rhythm、State、UI)
├── package.json          # 构建脚本与多平台配置
├── capacitor.config.json # Capacitor Android 配置文件
├── scripts/
│   └── prepare-cap.js    # 将前端文件同步至 Capacitor www 目录的脚本
├── electron/
│   └── main.js           # Electron 桌面主进程 (纯本地加载 index.html)
├── release/              # Windows .exe 打包产物目录
│   └── Polyrhythmic Metronome-win32-x64/
│       └── Polyrhythmic Metronome.exe
└── android/              # 原生 Android Capacitor 工程
```
