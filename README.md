# Inkpad Web

Handwritten notes, whiteboards and PDF annotation in the browser, written for a pen and a touch
screen. Plain JavaScript modules, DOM and Canvas 2D; no framework and no build step.

- Pressure-sensitive pens, highlighter, shapes, text, sticky notes, tape, ruler, laser pointer
- Notebooks with pages (scrolling down or turning sideways) and endless whiteboards
- Lasso selection: move, resize, copy, recolour, rotate
- PDF import and annotation; export to **vector** PDF (text stays text, in a font you choose) and PNG
- Import of Goodnotes documents (`.goodnotes`)
- A library with folders, favourites, trash, drag and drop; archives (`.zip`)
- Optional sync with your own Google Drive, compatible with the desktop (GNOME) and iOS apps
- Interface in Chinese, English and Japanese

It is a port of two existing apps of the same product, [Inkpad-gnome](https://github.com/LoveProgramming-cc/Inkpad-gnome)
(Python, GTK 4) and [Inkpad-iOS](https://github.com/LoveProgramming-cc/Inkpad-iOS) (Swift). The `.inkpad`
file format and the Google Drive sync protocol are byte-compatible with them. `docs/PORTING.md` is the
plan the port followed.

## Running

Any static file server will do; nothing is built.

```sh
node tools/serve.mjs 8080      # then open http://localhost:8080/
node --test tests/             # the tests
```

Notebooks are kept in the browser (IndexedDB). Use cloud sync, or **Settings › Storage › Export**, to keep
a copy: clearing a site's data deletes them.

## Google Drive sync

Sync uses an OAuth client that you create yourself in the Google Cloud console, in the **same project** as
the desktop and iOS apps, of type **"Web application"**, with the Drive API enabled. Settings › Google Drive
sync shows the two addresses to enter (the origin, and `…/oauth.html`). The app asks only for the
`drive.file` scope, so it can see nothing in your Drive but the files that the Inkpad apps made. No
credentials are part of this repository; yours stay in your browser's storage.

## Deploying on GitHub Pages

Publish the repository root (not `/docs`). The `.nojekyll` file is needed; every path in the app is relative,
so it works under `https://<user>.github.io/<repo>/`.

One thing to know: browsers keep site data per origin, and every project page of a GitHub account shares the
origin `https://<user>.github.io`. Script on any other page of that account could read Inkpad's notebooks,
OAuth secret and tokens. Use a custom domain, or a GitHub account that has only this site, if that matters.

## Licence

GPL-3.0-or-later; see `LICENSE`. Third-party code is listed in `THIRD-PARTY-NOTICES.md`.

---

## 实施状态与验证记录（给后续维护者）

按 `docs/PORTING.md` 的里程碑，当前做到的和验证过的：

| 里程碑 | 状态 | 怎么验证的 |
| --- | --- | --- |
| M1 geom / pack / hash / zip | 完成 | 与 B 的 Python 输出逐字节/逐值比对（`tests/make_fixtures.py` 生成向量）；zip 与 Python `zipfile` 互读，含 zip64 本地头 |
| M2 文档模型 | 完成 | 移植 A 的 `ModelTests`；JS 与 B 双向互读 `.inkpad`；`merge` 结果与 B 一致 |
| M3 渲染 | 完成 | 浏览器对照页 `tests/browser/gallery.html`：13 种纸张×3 色、5 种封面、各种笔、白板 5×10⁷ 处不抖 |
| M4 存储与文稿库 | 完成 | IndexedDB 后端在真实浏览器里通过全部用例，200 MB Blob 读写与切片（`tests/browser/vfs.html`）|
| M5 界面基础件 | 完成 | `tests/browser/components.html`：69 图标、24 文件夹图标、控件、弹出框翻转/滚动、对话框、提示条，明/暗两套主题 |
| M6 文稿库界面 | 完成 | 浏览器里：封面、文件夹图、拖动移动与撤销、收藏；窄屏样式已写，未逐项走查 |
| M7–M9 画布、输入、编辑器 | 主要功能完成 | 浏览器里用合成的指针事件验证：笔压感、长按成形、橡皮、套索移动、便签、缩放、滚动、自动保存落盘；**没有在真实笔/触屏设备上试过**（R4）|
| M10 PDF | 完成 | 30 页 PDF 导入与滚动（后台渲染队列、LRU 8）；`tests/browser/pdf.html` |
| M11 同步 | 算法与 A 的 15 个用例全部通过；与 B 自己的 `gdrive.sync()` 通过目录云盘互通；**Google 登录与 Drive 传输没有用真实账号试过** | `tests/sync.test.js`、`tests/interop.test.js` |
| M12 导入导出 | 矢量 PDF（23 MB 字体子集后 20 KB，文字可选可搜）、PNG、`.inkpad`、存档 zip、Goodnotes 读写（与 B 互读）完成 | `tests/browser/pdf.html`、`tests/goodnotes.test.js` |
| M13 收尾 | 未做 | 见下 |

### 还没有做、需要真实环境的事

1. **R1 的两个前提还没有验证**（需要用户在场，用真实 Google 账号）：① 同一 Cloud 项目里新建的“Web 应用”客户端能否看到桌面/iOS 客户端创建的文件；② `oauth2.googleapis.com/token` 是否允许跨域，可续传上传的 `Location` 响应头是否读得到。第一个不成立就只能在网页版之间同步（见 PORTING.md R1）。
2. `.otf`（CFF 轮廓）字体的子集嵌入没有测过，只测了 `.ttf`；`.ttc` 和可变字体会被拒绝。
3. 真实笔/触屏/触控板的手感（R4）、各浏览器兼容性、性能走查（§11）、窄屏逐项走查、多标签页互斥的实测。
4. PWA（可安装、离线缓存）按约定留给后续阶段，没有做。
5. `Goodnotes` 导出是实验性的（与 B 一样，没有 Goodnotes 应用可验证）。
6. 旧版（v3 之前）文件里没有 id 的元素用随机 id（R11），没有复现 B 的内容摘要 id。
