[English](README.md) · [简体中文](README.zh-CN.md)

# Polyrhythmic Metronome

> A metronome for meters that shouldn't exist.
>
> 59/16? 73/32? Why not.

An offline metronome for practicing and composing in arbitrary time signatures.
Type any meter you like — 7/8, 13/16, 23/7, 59/16 — split the bar into your own
groups, mark accents and mutes, then stack several independent layers on top of
each other.

The app is plain HTML + CSS + vanilla JavaScript running on the Web Audio API.
There is no backend, no framework and no build step: the same three files
(`index.html`, `style.css`, `app.js`) ship on every platform, wrapped with
Capacitor for Android and Electron for Windows.

## Features

- **Arbitrary meters** — numerator accepts 1–1024, denominator 1–256. Meters
  such as 7/8, 11/16, 59/16 and 73/32 are all just numbers; nothing is
  hard-coded to a list of "allowed" signatures.
- **Custom grouping** — split the bar into groups (3+3+2+5+7…), edit any group
  by hand, add, delete or reorder them, and get a live sum check against the
  numerator. Quick actions: auto-group, even split, accent on group starts,
  clear.
- **Accent / Normal / Mute pattern** — click any subdivision cell to cycle
  through ● accent, ○ normal and × muted. Reset to the group defaults, set
  everything to normal, or generate a random pattern.
- **Polyrhythmic layers** — run several meters at once (59/16 against 7/16
  against 11/16). Each layer keeps its own meter, grouping, pattern and mute
  state.
- **Per-layer sound, volume and multiplier** — 5 synthesized tones (Classic
  Click, Wood Block, Electronic, Soft Click, Cowbell), independent level and
  accent level, plus a BPM multiplier from 0.1× to 8× for that layer.
- **Web Audio look-ahead scheduling** — a 25 ms scheduler tick fills an 80 ms
  look-ahead window, so every hit is placed on the audio clock instead of the
  main thread timer.
- **Tap tempo** — hit `TAP TEMPO` a few times to set the BPM.
- **Local presets** — 7 factory presets (59/16, 59:7:11, 73/32, 23/7, 17/16,
  7/8, 4/4) plus your own saved presets, stored in `localStorage`.
- **Shareable configuration** — the whole state (BPM and every layer) is
  encoded into the URL fragment, so a link reproduces the exact setup.
- **Screen Wake Lock** — the screen stays on while the metronome is playing.
- **Offline** — no server, no analytics, no network calls. Works from a local
  file or any static host.

## Running it

### Web

Open `index.html` directly in a browser, or serve the folder:

```bash
npm run serve    # http://localhost:3000
```

No dependencies are needed just to run it; `npm install` is only required for
packaging (Android / Windows).

### Android

Requirements: JDK 21 and an Android SDK with platform 35 and build-tools
(Android Studio installs both).

```bash
npm install
npm run cap:sync                 # copy web assets into android/app/src/main/assets/public

cd android
gradlew assembleDebug            # ./gradlew assembleDebug on macOS/Linux
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`, signed
with the debug key, ready to install with `adb install`.

For a release build (`gradlew assembleRelease`) Gradle reads the signing
config from `android/keystore.properties`, which is intentionally gitignored.
Create your own keystore and point the file at it:

```properties
storeFile=../keystore/release.keystore
storePassword=...
keyAlias=...
keyPassword=...
```

The application id is `com.polyrhythm.metronome`. The app declares only the
`WAKE_LOCK` permission: it serves its own assets from the WebView and makes no
network requests, so `INTERNET` is deliberately not requested.

To update the app after changing the web files, re-run `npm run cap:sync`
before building.

### Windows

```bash
npm install
npm start           # run the Electron app for development
npm run build:win   # package a portable build
```

`build:win` uses `electron-packager` and writes
`release/Polyrhythmic Metronome-win32-x64/Polyrhythmic Metronome.exe`, which
runs without installation.

## Sharing a configuration

Press **分享配置** in the header. The current BPM and all layers (meter, grouping,
pattern, sound, volumes, multiplier, mute) are serialized to JSON, base64-encoded
into the URL fragment and copied to the clipboard. Opening that URL restores the
same setup. Nothing is sent anywhere — decoding happens in the browser.

## Project layout

```
polyrhythmic-metronome/
├── index.html            # entry point, shared by web / Electron / Capacitor
├── style.css             # DAW-style dark theme + responsive rules
├── app.js                # state, rhythm model, Web Audio scheduler, UI
├── package.json          # scripts and packaging metadata
├── capacitor.config.json # Capacitor Android configuration
├── scripts/
│   └── prepare-cap.js    # copies the web assets into www/
├── electron/
│   └── main.js           # Electron main process
├── android/              # Capacitor Android project (Gradle)
├── assets/               # icon (svg)
└── LICENSE
```

`www/`, `release/`, `build/` and `dist/` are generated and gitignored.

## License

Polyrhythmic Metronome is released under the
**Polyrhythmic Metronome Source-Available Non-Commercial License** — see
[LICENSE](LICENSE).

It is *not* an OSI-approved open source license. You may view, run, study,
modify and share the code for personal, educational, research and other
non-commercial purposes. Commercial use requires permission from the copyright
holder. Copyright (c) 2026 OokoukiBob.

## Contributing

Issues and pull requests are welcome at
[ookoukibob/polyrhythmic-metronome](https://github.com/ookoukibob/polyrhythmic-metronome),
especially for bug fixes and platform packaging problems. Please keep changes
focused, and note that contributions are accepted under the same non-commercial
license (see the contribution section of [LICENSE](LICENSE)).
