# Inkpad Web 移植方案

本文件是把 Inkpad 移植为原生网页应用的施工图，写给负责实现的模型。请从头读到尾再动手。

- 参考代码 **A**：`Inkpad-iOS`（Swift，UIKit 画布 + SwiftUI 界面），分析时的提交 `8d15ab6`
- 参考代码 **B**：`Inkpad-gnome`（Python，GTK 4 + cairo），分析时的提交 `34f9652`
- 文中 `B:model.py:812` 表示 B 仓库 `inkpad/model.py` 第 812 行附近；`A:Sync/Sync.swift` 表示 A 仓库 `Inkpad/Sync/Sync.swift`。行号只在上述提交下准确，找不到时按函数名搜索。

- 仓库地址：A `https://github.com/LoveProgramming-cc/Inkpad-iOS.git`，B `https://github.com/LoveProgramming-cc/Inkpad-gnome.git`。动手前先把两者克隆到 `ref/A` 和 `ref/B`（并把 `ref/` 写进 `.gitignore`），检出上面两个提交，之后只读不改。
- 本项目的工作目录是 `Inkpad/Web/`，所有产出都放在这个文件夹里；本文件位于 `docs/PORTING.md`。

---

## 已定事项（版权人 2026-10-11 确认）

| 事项 | 决定 |
| --- | --- |
| 许可证 | **GPL-3.0**。LICENSE 文件直接取自 B；第三方声明照 B 的 `THIRD-PARTY-NOTICES.md` 写，并加上 pdf.js（Apache-2.0）、pdf-lib 与 fontkit（MIT） |
| 可用的参考代码 | A 和 B 的代码都可以直接翻译使用（A 的版权人同意） |
| 部署 | **GitHub Pages**：纯静态、HTTPS、站点位于子路径 `https://<用户>.github.io/<仓库>/`，没有服务器端，不能设置 HTTP 响应头 |
| 导出 PDF 里的文字 | **必须是矢量**，字体由用户选择（§7.5） |
| PWA（可安装、离线缓存） | 属于平台专门优化，**留给最后阶段的高能力模型做**，当前实现者不要做 |
| 当前阶段的重点 | **踏实迁移已有代码**：能直译的直译，不重构、不“顺手优化”、不添加参考代码里没有的功能 |

### 分工

每个里程碑在 §4 标了类型：

- **直译**：参考代码里有等价实现，逐函数翻译，行为以参考代码为准。这是当前实现者的主要工作。
- **重写**：平台不同，无法直译；本文给出了设计。照设计做，遇到设计没说清或行不通的地方，**停下来写明问题，不要自行发明方案**。
- **留给高能力模型**：PWA；最后的输入手感调校和性能走查（R4、§11）。当前实现者做到功能正确即可。
- **需要用户在场**：一切要用真实 Google 账号的步骤（M0 试验 1、M11 的 ③）。用户不在时跳过它们，先做别的。

---

## 0. 实现者必须遵守的规则

1. **B 是主参考，A 是辅参考，两者的代码都可以直接翻译。** B 是上游，A 是对 B 的移植。逻辑、常量、文案以 B 为准。A 在这些地方更适合作为翻译底本：同步的控制流（`Sync.swift`，已经是 `async/await`）、zip（`Zip.swift`）、编辑会话与自动保存（`AppModel.swift` 的 `EditorSession`）、窄屏布局、触摸与手写笔交互、测试用例。两者行为不同时查 §2.3 的差异表，表里没有的按 B。
2. **文件格式和同步协议必须逐字节兼容**（§6）。网页版写出的 `.inkpad` 文件和云端索引，B 和 A 必须能读；反之亦然。这一部分不允许“改进”。
3. **常量不许改。** §10 列出的数值全部照抄。它们是在真机上调出来的手感参数。
4. **不用 UI 框架，不强制构建步骤。** 原生 ES Modules + 原生 DOM + CSS。禁止 React/Vue/Svelte/Tailwind/jQuery 等。只允许 §3.1 列出的第三方库（pdf.js，pdf-lib 及其字体组件 fontkit），且必须懒加载。
   - 因为部署在 GitHub Pages 的子路径下，**所有资源地址一律用相对路径**（`./src/main.js`、`new URL('./x', import.meta.url)`），不得以 `/` 开头。
5. **时间戳一律用“秒”的浮点数**（`Date.now() / 1000`）。文件和索引里的 `mt`、`ts`、`order_mt`、`last`、`checked` 都是秒。写成毫秒会让其它设备的合并结果全部错乱。
6. **不要把整本笔记读进内存。** 一本笔记可能带 200 MB 的 PDF。zip 读写、上传、下载、哈希全部基于 `Blob.slice()` 和流（§7.8）。
7. **白板坐标在 5×10⁷ 量级，绝不能交给 canvas 的变换矩阵去减。** 所有绘制函数接收原点偏移，在 JS（双精度）里先减再画（§7.1，风险 R3）。
8. 每完成一个里程碑（§4），跑它的验收项，再进入下一个。不要跳着做。
9. 遇到本文没覆盖的行为，去读 B 的对应函数并照抄其逻辑；不要自行设计。
10. 源字符串是简体中文，所有界面文字经 `tr()`（§7.12）。

---

## 1. 结论摘要

- B 约 14 800 行 Python，A 约 18 000 行 Swift。两者的**模型、几何、文件格式、合并、同步算法是同一套逻辑的两份实现**，可以近乎逐行翻译成 JS（约占总量 45%）。
- 需要**重新设计**的是与平台绑定的六块：画布渲染与缓存、输入（笔/手指/鼠标）、PDF 渲染与导出、OAuth 登录、本地存储、界面控件。
- 网页版的结构：纯逻辑层 `core/`（可在 Node 里测试）→ 存储层 `platform/vfs`（IndexedDB）→ 文稿库与编辑器 → 同步 → 导入导出。
- 体积预算：首屏自有代码 ≤ 200 KB（gzip），不含懒加载的 pdf.js 和 pdf-lib。
- 最大的三个风险：浏览器里的 Google OAuth（R1）、矢量 PDF 导出与字体嵌入（R2）、白板大坐标的浮点精度（R3）。M0 先用小试验把 R1、R2 和存储验证掉，不通过就先停下来报告。
- 部署在 GitHub Pages 带来一条需要用户知情的风险：同一账号下所有 Pages 站点共用浏览器存储（R16）。

---

## 2. 参考代码库结构分析

### 2.1 B（GNOME）模块

| 文件 | 行数 | 职责 | 依赖 | 网页版去向 |
| --- | --- | --- | --- | --- |
| `geom.py` | 335 | 命中测试、套索/矩形选取、涂抹擦除判定、局部擦除切割、形状识别 | 无 | `core/geom.js`，逐行翻译 |
| `model.py` | 1537 | 四种元素（笔画/形状/文本/图片）及其绘制、页面、13 种纸张、文档与撤销、文件读写、逐项合并、封面、PDF/PNG 导出 | geom, ptext, pdf, cairo | 拆成 `core/items.js` `page.js` `document.js` `cover.js` `pack.js`，导出部分去 `io/` |
| `ptext.py` | 58 | Pango 文本测量与绘制 | Pango | `core/ptext.js`，**重写** |
| `pdf.py` | 145 | poppler：页数、页面尺寸、渲染、查找文字 | poppler | `core/pdfdoc.js`，**重写**（pdf.js） |
| `render.py` | 82 | cairo→GPU 纹理；PDF 背景的后台渲染线程（优先队列，可作废） | cairo, 线程 | 并入 `editor/canvas.js` 的渲染队列 |
| `canvas.py` | 2667 | 画布：布局、滚动缩放、页面缓存、全部输入处理、所有工具、选区、尺子、激光笔、文本编辑 | 以上全部 + GTK | `editor/canvas.js`（视图与缓存）+ `editor/input.js`（输入）+ `editor/tools.js`（工具）。逻辑照抄，GTK 部分**重写** |
| `window.py` | 2203 | 编辑器外壳（标题栏、工具选项条、各弹出面板、选区条、查找条）、自动保存、同步调度、页面操作、导入导出入口、快捷键 | 全部 | `editor/editorview.js` `pageops.js` `sync/scheduler.js` `main.js` |
| `library.py` | 1407 | `Store`（文件夹即目录、废纸篓、收藏、复制、存档 zip）+ `LibraryView`（网格、拖放、多选、移动撤销） | model, GTK | `library/store.js` + `library/libraryview.js` |
| `gdrive.py` | 1125 | OAuth（环回地址 + PKCE）、Drive REST、索引驱动的同步、云端已删除笔记的还原 | model, urllib | `sync/googleauth.js`（**重写**）`drive.js`（**重写**）`sync.js`（逐行翻译） |
| `goodnotes.py` | 976 | Goodnotes 文档读写：protobuf、Apple LZ4、RTF、笔画几何 | model, pdf | `io/goodnotes.js`，逐行翻译；导出依赖 PDF 导出 |
| `dialogs.py` | 309 | 输入框、确认框、页码框、封面选择、纸张样式对话框 | model | `ui/dialog.js` `paperdialog.js` `coverpicker.js` |
| `prefs.py` | 513 | 设置对话框、储存空间管理 | gdrive, migrate | `ui/prefs.js` `ui/storage.js` |
| `sidebar.py` | 174 | 缩略图（两列）、大纲、书签 | model, render | `editor/sidebar.js` |
| `minimap.py` | 136 | 白板小地图 | geom | `editor/minimap.js` |
| `settings.py` | 90 | 偏好项默认值与读写 | 无 | `core/settings.js` |
| `icons.py` | 459 | Lucide 路径数据 + 程序化小图标（粗细、色块、色轮等） | cairo | `core/icons.js`，数据直接用 `A:Resources/icons.json` |
| `i18n.py` `i18n_ja.py` | 1008 | 中→英、中→日词表 | 无 | `core/i18n.js`，词表用 `A:Resources/en.json` `ja.json` 加 `A:L10n.swift` 的补充项 |
| `style.css` | 454 | GTK 样式 | 无 | `css/*.css`，几乎可以逐条翻译（§9） |
| `migrate.py` | 134 | 把文稿库搬到另一个磁盘文件夹 | 无 | **不移植**（平台专属） |

### 2.2 A（iOS）模块

| 文件 | 行数 | 对应 B | 对网页版的用处 |
| --- | --- | --- | --- |
| `Model/Geom.swift` `Items.swift` `Page.swift` `Document.swift` `Cover.swift` | 2202 | geom.py, model.py | 与 B 等价的第二份实现，B 的 Python 惯用法看不懂时对照它 |
| `Model/Zip.swift` | 214 | Python `zipfile` | **自写 zip 的范本**：只支持 stored/deflate，不支持 zip64，支持按原样拷贝条目（`addRaw`） |
| `Model/Goodnotes.swift` | 1035 | goodnotes.py | 对照 |
| `Sync/Sync.swift` | 977 | gdrive.py 同步部分 | **`async/await` 版的同步算法**，翻译 JS 时主要对照它的控制流；`DriveAPI` 协议就是 `drive.js` 的接口 |
| `Sync/Drive.swift` | 356 | gdrive.py REST 部分 | 请求的 URL、字段、multipart 体的写法 |
| `Sync/GoogleAuth.swift` | 142 | gdrive.py `authorize` | PKCE 细节；网页版流程不同（§7.6） |
| `AppModel.swift` | 557 | window.py 的保存与同步调度 | `EditorSession`（自动保存、`absorb`）和同步触发时机，结构比 B 清晰，照它组织 `scheduler.js` |
| `Editor/CanvasView.swift` | 914 | canvas.py 布局与缓存 | 基于 UIScrollView，**网页版不采用这个结构**，只参考“窗口化光栅”的预算算法 |
| `Editor/CanvasTools.swift` | 1310 | canvas.py 工具 | 触摸相关：`accepts()`、`pressure()`（无压感笔的速度笔锋）、`strokeInterrupted()`、预测笔迹 |
| `Editor/CanvasExtras.swift` | 560 | canvas.py 尺子/激光/小地图 | `hovered()`：笔悬停时的十字/圆点标记 |
| `Editor/EditorView.swift` | 1558 | window.py 界面 | **窄屏布局**（`compact` 分支）、各面板的内容与顺序 |
| `Library/LibraryView.swift` `Sheets.swift` `Store.swift` | 2535 | library.py, dialogs.py, prefs.py | 窄屏布局；`Store` 与 B 等价 |
| `UI/Theme.swift` | 344 | style.css | **Adwaita 颜色的十六进制值**（明/暗两套），直接抄进 CSS 变量 |
| `UI/Lucide.swift` | 267 | icons.py | 不需要：网页直接生成 `<svg>` |
| `Editor/PencilPalette.swift` | 369 | 无 | **不移植**（Apple Pencil Pro 捏合工具盘） |
| `Shortcuts.swift` `Platform.swift` `Demo.swift` `InkpadApp.swift` | 251 | 无 | 不移植；`Demo.swift` 可改写成开发用的示例数据 |
| `InkpadTests/*` `tools/compat.py` `tools/goodnotes_compat.py` | 1648 | 无 | **测试用例来源**（§13） |

### 2.3 A 与 B 行为不一致之处及网页版的取舍

| 项目 | B | A | 网页版 |
| --- | --- | --- | --- |
| 压力灵敏度系数 | `pen_sens = sens / 50`（`B:window.py:540`） | `sens / 100`（`A:Tools.swift` `penSens`，针对 Apple Pencil 调小） | 用 B 的 `/50`，做成常量 `PEN_SENS_DIVISOR` |
| 自动保存延迟 | 2.5 s | 1.5 s | 1.5 s（网页随时可能被关掉） |
| 停笔后同步的最短等待 | 6 s | 5 s | 6 s |
| 左右翻页“拉出新页”的距离 | 280 px | 90 px | 触摸 90，鼠标拖动 280 |
| 白板的实现 | 无边界，自由偏移 `_bo`（`B:canvas.py:474`） | 有限“工作区”，随内容增长 | 用 B 的做法 |
| 旧文件（v3 之前）元素 id | 由内容摘要推导（`B:model.py:1337`） | 随机生成 | 尽量按 B；做不到时退回 A 的做法（风险 R11） |
| 笔的压力 | 直接用设备压力，夹在 [0.02, 1] | `force/2 + 速度项`，并识别无压感笔 | 设备压力按 B；检测到压力恒定时用 A 的速度笔锋（§7.2） |
| 同步完成提示 | “上传 %d，下载 %d” | “上传 %d，下载 %d，合并 %d” / “已是最新” | 按 A |
| 文本输入 | 画布上的弹出框 + “完成” | 全屏输入控制器 | 按 B（弹出框里放 `<textarea>`） |
| 记住位置 | `views[id] = [zoom, 页, fx, fy]`，留 300 条 | 同上，另有 `lastPages` | 只用 `views` |
| 定时整库同步（600 s） | 始终 | 仅文稿库界面且在前台 | 按 A，且页面可见时才跑 |
| 回到前台 | 无 | 距上次同步 > 120 s 则同步 | 按 A（`visibilitychange`） |
| 多个打开的笔记本（标签） | 代码里有 `tabs`，实际恒为 1 个 | 无 | 不做标签，一次只开一本 |
| 手指书写时第二根手指落下 | 一律放弃这一笔（`_touch_reset`） | 开始不足 0.3 s 或不足 8 个点才放弃，否则就地结束这一笔 | 按 A |

### 2.4 依赖关系（自底向上）

```
geom  pack  hash  zip  i18n  icons  settings          ← 纯逻辑，无依赖
   │     │     │    │
   └──► items ─► page ─► document(撤销/合并/读写) ◄── ptext, pdfdoc(接口), cover
                              │
                    vfs(IndexedDB) ─► store(文稿库操作)
                              │              │
              ┌───────────────┼──────────────┴────────────┐
              ▼               ▼                           ▼
        sync(同步算法)   canvas ─► input ─► tools     libraryview
        drive, auth        │                              │
              │            └──► editorview, sidebar, minimap
              ▼                         │
          scheduler ◄───────────────────┘
              │
        io: exportpdf(pdf-lib) exportpng goodnotes archive
```

`sync` 只依赖 `document`、`zip`、`hash`、`vfs`，不依赖任何界面，可以和编辑器并行开发。

---

## 3. 网页版目标架构

### 3.1 技术选型

| 方面 | 选择 | 理由 |
| --- | --- | --- |
| 语言与模块 | 原生 JavaScript ES Modules，文件头 `// @ts-check` + JSDoc 类型 | 不需要构建就能跑；类型检查可选 |
| 构建 | 开发时零构建；发布时可用 esbuild 打包压缩（可选） | 满足“轻量” |
| 界面 | 原生 DOM + 一个 20 行的 `h(tag, props, ...children)` 辅助函数；“状态变了就重建那一小块”的写法（与 B 的 `_rebuild_options` 相同） | 不需要虚拟 DOM |
| 画布 | Canvas 2D。一个铺满视口的主 `<canvas>` + 一个透明的叠加 `<canvas>`；每页一个离屏缓存画布 | 与 B 的模型一一对应（§7.1） |
| 输入 | Pointer Events（`pointerType` 区分笔/手指/鼠标，`pressure`，`getCoalescedEvents`） | 唯一跨浏览器的笔输入接口 |
| 本地存储 | IndexedDB，把每本笔记作为一个 Blob 存放，逻辑路径与 B 的目录结构相同 | Blob 可懒切片；重命名/移动文件夹是一次事务；所有主流浏览器可用（§7.8） |
| zip | 自写（约 250 行），用 `CompressionStream('deflate-raw')` / `DecompressionStream` | 浏览器自带 deflate，无需库 |
| 哈希 | 自写流式 MD5、SHA-256、CRC-32（约 250 行） | WebCrypto 没有 MD5，且 `digest()` 不能流式 |
| PDF 渲染 | **pdf.js**（`pdfjs-dist`），放在 `vendor/`，首次遇到 PDF 页面时才 `import()` | 浏览器没有把 PDF 画到 canvas 的原生接口，这是唯一绕不开的大依赖 |
| PDF 导出 | **pdf-lib** + **@pdf-lib/fontkit**，放在 `vendor/`，点“导出”时才 `import()` | 要把原 PDF 页面以矢量形式嵌入导出文件，并把用户选的字体子集嵌入以输出矢量文字；自己写 PDF 解析器和字体子集器不现实 |
| 部署 | GitHub Pages，从仓库根目录（或 Actions 产物）发布，根目录放空文件 `.nojekyll` | 用户决定。**不要把 Pages 的发布源设成 `/docs`**：那是放本文件的地方 |
| 测试 | `node --test`，测 `core/`、`sync/`、`io/goodnotes.js`；存储用内存版 `vfs` | 纯逻辑层不碰 DOM |

除 pdf.js、pdf-lib、fontkit 外不引入任何第三方代码。它们都从本站 `vendor/` 加载，不走 CDN（应用里保存着 OAuth 密钥，不能执行第三方域名的脚本）。

GitHub Pages 不能设置响应头，所以内容安全策略写在 `index.html` 和 `oauth.html` 的 `<meta http-equiv="Content-Security-Policy">` 里：`script-src 'self'`；`connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com`；`worker-src 'self' blob:`；`img-src 'self' blob: data:`。

### 3.2 目录结构

```
index.html              单页入口
oauth.html              OAuth 回跳页，只做一件事：把 location.search 交回主页面
.nojekyll               空文件，让 GitHub Pages 原样发布
LICENSE                 GPL-3.0（取自 B）
THIRD-PARTY-NOTICES.md  Lucide、pdf.js、pdf-lib、fontkit
README.md
docs/PORTING.md         本文件
（manifest.webmanifest 与 sw.js 属于 PWA，留给后续阶段，现在不建）
css/  tokens.css  base.css  controls.css  editor.css  library.css  dialogs.css
src/
  main.js               启动、文稿库⇄编辑器切换、全局快捷键、提示条
  core/                 纯逻辑，不碰 DOM（ptext 和 pdfdoc 通过注入的接口碰）
    geom.js  pack.js  hash.js  zip.js
    items.js  page.js  document.js  cover.js
    ptext.js  pdfdoc.js  settings.js  i18n.js  icons.js
  platform/
    vfs.js              IndexedDB 文件库 + 内存版（测试用）
    files.js            选文件、保存文件、拖入文件
    image.js            图片解码、缩小、转 PNG、旋转
    clipboard.js
  library/  store.js  libraryview.js  folderart.js
  editor/
    canvas.js           布局、滚动、缩放、缓存、绘制
    input.js            指针状态机：笔/手指/鼠标、防误触、手势
    tools.js            down/move/up、擦除、选区操作、文本、激光笔、尺子
    editorview.js       标题栏、选项条、各面板、选区条、查找条、状态条
    sidebar.js  minimap.js  pageops.js
  ui/
    dom.js  popover.js  dialog.js  toast.js  controls.js
    paperdialog.js  coverpicker.js  prefs.js  storage.js  folderpicker.js
  sync/  googleauth.js  drive.js  sync.js  scheduler.js
  io/    exportpdf.js  exportfont.js  exportpng.js  goodnotes.js  archive.js
  vendor/ pdfjs/  pdf-lib/  fontkit/
tests/   *.test.js  fixtures/
```

### 3.3 运行时结构

- 主线程：界面、画布、同步的控制流（网络是异步的，不占线程）。
- 一个通用 Worker（`platform/worker.js`）：大文件的 MD5/SHA-256、zip 的 deflate、PNG 导出时的批量处理。小于 1 MB 的数据直接在主线程做。
- pdf.js 自带的 Worker：PDF 解析。
- 文档事件沿用 B 的五种（`B:model.py:970` 的注释）：`added`（纯追加）、`dirty`（某页某矩形）、`pages`（结构变化）、`meta`（书签/大纲）、`state`（撤销栈或保存状态变化）。画布、侧栏、小地图、外壳各自订阅。

**同步变异步的边界**：`Document` 的修改接口（`do/undo/redo/add_items/remove_items/replace_items/push_diff`）保持**同步**。只有以下操作是异步的：`load`、`snapshot`（要编码封面 PNG）、`save`、图片解码与旋转、PDF 打开/渲染/查找、所有存储操作、哈希。

### 3.4 存储模型

IndexedDB 数据库 `inkpad`，三个对象仓库：

| 仓库 | 键 | 值 |
| --- | --- | --- |
| `files` | 相对路径，如 `数学/笔记.inkpad`、`.trash/x.inkpad`、`.deleted/20261007-164500 x.inkpad` | `{path, blob, size, mtime(秒), rev(每次写入加一的整数), id(笔记 id，缓存), cover(Blob，缓存)}` |
| `dirs` | 相对路径 | `{path, mtime}` |
| `kv` | 名称 | `settings`、`library`（即 B 的 `.library.json`）、`sync`（即 `.sync.json`）、`google_client`、`google_token`、`input_log`、`export_font`（用户为导出 PDF 选的字体：`{name, blob}`） |

- 路径规则与 B 完全相同：`/` 分隔，根目录为空串，以 `.` 开头的名字对文稿库不可见，`.trash` 是废纸篓，`.deleted` 是“永久删除”后的本机留存。这样 `Store` 和 `sync` 可以逐行翻译。
- B 里的 `file_sign(path) = (mtime_ns, size)` 在网页版是 `rev + '/' + size`。`rev` 来自全库单调计数器，移动/重命名不改变 `rev` 和 `mtime`。
- 目录的 `mtime` 在其直接子项增删改名时更新（文稿库按日期排序要用）。
- `vfs.js` 导出接口：`list(dir)`、`walk(root)`、`stat(path)`、`read(path) → Blob`、`write(path, blob, {expect}) → sign`、`move(from, to)`（文件或整个目录，一次事务）、`remove(path)`、`mkdir`、`rmdir`、`exists`、`kvGet/kvSet`、`onChange(fn)`。再提供一个接口相同的内存实现给测试用。

---

## 4. 模块依赖顺序（里程碑）

每个里程碑列出：类型、要读的参考、产出、验收。

编号是依赖顺序。**建议的实际施工顺序**是把直译且有现成测试的部分提前：M0（试验 2–4）→ M1 → M2 → M4 → M11 的 ①② → M3 → M5 → M6 → M7 → M8 → M9 → M10 → M12 → M11 的 ③④ → M13。这样前五步全是有测试兜底的翻译工作，做完时文件格式和同步算法就已经可信。

### M0 脚手架与四个验证性试验

类型：重写。试验 1 需要真实的 Google 账号和 OAuth 客户端，**必须有用户在场**；用户不在时先做试验 2–4 和 M1 起的直译工作，把试验 1 留着。

产出：目录骨架、`index.html`、一个静态文件服务器脚本、`node --test` 能跑。

四个试验各写一个独立的小页面，**任何一个不通过都先停下报告**：

1. **OAuth + Drive**：按 §7.6 完成一次授权，拿到 `refresh_token`，刷新一次 `access_token`，创建一个文件夹，用可续传上传传一个 5 MB 的 Blob 并读到返回的 `md5Checksum`，再下载回来比对。确认 `oauth2.googleapis.com/token` 可以跨域调用、上传会话的 `Location` 响应头读得到。
2. **pdf.js**：打开一个含中文的 PDF，把第 1 页的一个子区域按 3 倍缩放画到 canvas；`getTextContent()` 取到文字及位置。
3. **pdf-lib**：新建文档，把另一个 PDF 的某页作为矢量嵌入，再在上面画一条圆头曲线和一条“正片叠底、40% 不透明”的粗线；用 fontkit 以子集方式嵌入一个中文 `.ttf` 和一个 `.otf`，各写一行中日英混排的文字。保存后用系统阅读器和浏览器各打开一次：文字应可选中、可搜索、放大不糊，文件大小不应接近整个字体文件的大小。
4. **IndexedDB**：存入一个 200 MB 的 Blob，重新打开页面后读出，对它 `slice()` 末尾 64 KB 并读取，耗时应在毫秒级；内存不应上涨 200 MB。

### M1 纯逻辑基础

类型：**直译**。

参考：`B:geom.py` 全部；`B:model.py:890-943`（`_zig` `pack_points` `unpack_points`）；`A:Model/Zip.swift`。

产出：`core/geom.js` `pack.js` `hash.js` `zip.js`。

验收：
- 用 B 的 Python 代码生成测试向量（若干笔画的 `pack_points` 输出、`is_scribble`/`recognize_shape`/`erase_runs`/`lasso_pick` 的输入输出），存成 `tests/fixtures/*.json`，JS 结果一致（浮点比较容差 1e-9）。
- MD5、SHA-256、CRC-32 对已知向量正确，分块喂入与一次喂入结果相同。
- zip：能读 Python `zipfile` 写的文件（含 §6.1 提到的 zip64 本地头）；自己写的文件 Python `zipfile.ZipFile(...).testzip()` 返回 `None`。对应 `A:InkpadTests/ModelTests.swift` 的 `testZipRoundTrip`。

### M2 文档模型

类型：**直译**。

参考：`B:model.py` 的 `Stroke/Shape/Text/Image`（不含 `draw`）、`Page`、`page_box`、`Document`、`merge`、`stamp`、`snapshot`、`load`、`notebook_id`、`set_notebook_id`。

产出：`core/items.js`（暂不含绘制）`page.js` `document.js`。`ptext.measure` 先用桩函数：`[min(wrap || 1e9, text.length * size * 0.6), size * 1.3]`（与 `A:tools/compat.py` 给 B 打的桩相同，这样互通测试里两边的文本包围盒一致）。

验收（对应 `A:InkpadTests/ModelTests.swift`）：
- `testDocumentRoundTrip`：建文档→存→读，各字段相同。
- `testUndoLeavesTombstones`：删除元素后 `page.gone` 有其 id；撤销后没有。
- `testMergeItemByItem`：两份副本各加各删，合并后符合 §6.3。
- 与 B 互读：B 写的文件 JS 能读；JS 写的文件 `Document.load()`（Python）能读且内容相同。

### M3 渲染

类型：**直译**（cairo 调用与 Canvas 2D 一一对应，见 §5.1），只有 `ptext.js` 是重写（§7.3）。注意每个绘制函数都要带原点偏移（§7.1 的精度规则），这是参考代码里没有的。

参考：`B:model.py` 各 `draw`、`_smooth_path`、`_dash_runs`、`draw_paper`、`_board_paper`、`render_page`、`ink_on`、`render_cover`、`page_surface`。

产出：`core/ptext.js`、`items.js` 的绘制、`page.js` 的纸张与整页渲染、`cover.js`。

验收：做一个对照页面，把 13 种纸张 × 3 种纸色、5 种封面、每种笔（含虚线/点线、不同压力）、荧光笔在浅色与深色纸上、四种形状、文本、便签各画一格，与 B 运行时的截图逐格目视比对。白板纸张在 `(5e7, 5e7)` 附近画出来的点阵必须均匀不抖（验证规则 0.7）。

### M4 存储与文稿库操作

类型：`vfs.js` 重写（§3.4、§7.8）；`store.js` **直译**（把文件系统调用换成 `vfs` 调用）。

参考：`B:library.py:85-502`（`Entry`、`Store`）；`B:settings.py`。

产出：`platform/vfs.js`（IndexedDB 版 + 内存版）、`core/settings.js`、`library/store.js`。

验收：`Store` 的每个方法有单元测试（新建、重命名、移动、移入废纸篓、恢复、永久删除、从 `.deleted` 恢复、复制后 id 不同、收藏随移动更新、搜索）。对应 `A:InkpadTests/SyncTests.swift` 的 `testMovesCanBeUndone`、`testCopyGetsItsOwnID`。

### M5 界面基础件

类型：重写（控件）；样式表是**直译**（§9）。

参考：`B:style.css`；`A:UI/Theme.swift`；`B:icons.py:312-459`；`A:Resources/icons.json`、`en.json`、`ja.json`、`A:L10n.swift`。

产出：`css/tokens.css` 等、`ui/dom.js` `popover.js` `dialog.js` `toast.js` `controls.js`、`core/icons.js` `i18n.js`。

验收：一个组件陈列页，明暗两套主题下显示全部 69 个图标、24 个文件夹图标、色块、粗细图标、开关、滑块、分段按钮、下拉、弹出框（贴边时翻转、放不下时滚动）、对话框、提示条。

### M6 文稿库界面

类型：界面搭建是重写，每个按钮和菜单背后的行为是**直译**。

参考：`B:library.py:572-1407`；`B:dialogs.py`；`A:Library/LibraryView.swift` 的 `compact` 分支。

产出：`library/libraryview.js` `folderart.js`、`ui/paperdialog.js` `coverpicker.js` `folderpicker.js`。

验收：§8.1 的清单逐项可用。

### M7 画布：显示、滚动、缩放、缓存

类型：布局、坐标换算、缩放锚点是**直译**；缓存与逐帧绘制是重写（§7.1）。

参考：`B:canvas.py:331-700`（布局与缩放）、`1466-1665`（缓存）、`1668-1742`（绘制）、`1405-1464`（滚动条）。

产出：`editor/canvas.js`。先做到只读：打开笔记本，上下/左右翻页，滚轮与捏合缩放，白板自由移动，缩放停下 160 ms 后重绘清晰。

验收：一本 200 页的笔记滚动时保持 60 帧；缩放时以指针/双指中点为锚；左右翻页模式下松手后页面居中；`view_memo`/`restore_memo` 能回到上次位置。

### M8 输入与工具

类型：工具逻辑（`_down/_move/_up/_erase`、选区操作）是**直译**；指针事件的接入是重写（§7.2）。

参考：`B:canvas.py:1033-1250`（触摸）、`1929-2045`（笔与鼠标）、`2047-2423`（工具）、`2425-2667`（选区、粘贴、文本）、`701-785`（尺子）、`1806-1867`（激光笔）；`A:Editor/CanvasTools.swift:284-462`；`A:Editor/CanvasExtras.swift:357-418`。

产出：`editor/input.js` `tools.js`。

验收：§8.2 的清单逐项可用；在一台带笔的设备和一台纯触屏设备上各走一遍。

### M9 编辑器外壳

类型：界面搭建是重写；页面操作、自动保存、快捷键是**直译**。

参考：`B:window.py:197-1331`、`1335-1505`（文档状态与保存）、`1991-2047`（快捷键）；`B:sidebar.py` `minimap.py`；`A:AppModel.swift` 的 `EditorSession`；`A:Editor/EditorView.swift:185-350`。

产出：`editor/editorview.js` `sidebar.js` `minimap.js` `pageops.js`、自动保存。

验收：§8.3 清单；写一笔后 1.5 s 内落盘；刷新页面内容还在；撤销/重做按钮状态正确。

### M10 PDF

类型：重写（§7.4）。

参考：`B:pdf.py`；`B:render.py`；`B:canvas.py:1524-1576`；`B:model.py:721-743`（旋转与查找）。

产出：`core/pdfdoc.js`、画布里的后台渲染队列、导入 PDF、在笔记中查找。

验收：导入 300 页的 PDF 后可流畅滚动（未渲染好的页先显示白底）；页面旋转后笔迹与背景对齐；查找能高亮 PDF 文字和文本框。

### M11 同步

类型：同步算法（①②）是**直译**，只依赖 M1、M2、M4，可以提前做；登录与传输（③）是重写（§7.6、§7.7），需要用户在场；调度（④）是**直译**。

参考：`B:gdrive.py` 全部；`A:Sync/Sync.swift`（控制流）；`A:Sync/Drive.swift`；`B:window.py:128-174, 1605-1785`；`A:AppModel.swift` 的 `sync` 及其后；`B:prefs.py`。

顺序：① `FakeDrive`（照 `A:InkpadTests/SyncTests.swift:6-93`）→ ② `sync.js` + 移植 `SyncTests` 的全部 15 个用例并通过 → ③ `googleauth.js` + `drive.js` 接真云盘 → ④ `scheduler.js` + 云菜单、设置里的同步分组、储存空间管理。

验收：②全部通过；与一台运行 B 的设备共用同一个云端文件夹，互相新建、修改、重命名、移动、删除、同时修改同一本，结果一致且无残缺文件。

### M12 导入导出

类型：`goodnotes.js`、`archive.js`、`exportpng.js` 是**直译**；`exportpdf.js`、`exportfont.js` 是重写（§7.5）。

参考：`B:model.py:1491-1537`；`B:window.py:2049-2136`；`B:goodnotes.py`；`B:library.py` 的 `import_tree` `export_paths` `export_archive` `import_archive`。

产出：`io/exportpng.js` `exportpdf.js` `goodnotes.js` `archive.js`。

验收：`A:InkpadTests/GoodnotesTests.swift` 的用例；导出的 PDF 中笔迹放大不糊、原 PDF 文字可选中；存档 zip 能被 B 导入。

### M13 收尾

窄屏布局、暗色主题走查、多标签页互斥、全部清单回归。PWA（清单与离线缓存）和最后的性能走查（§11）不在当前实现者的范围内。

---

## 5. 平台 API 对应表

### 5.1 图形

| 用途 | B（cairo/GTK） | A（CoreGraphics） | 网页 |
| --- | --- | --- | --- |
| 离屏位图 | `cairo.ImageSurface` | `CGContext` 位图 | `OffscreenCanvas`，不可用时 `document.createElement('canvas')` |
| 路径 | `move_to/line_to/curve_to/arc/close_path` | `CGContext.move/addLine/addCurve` | `ctx.moveTo/lineTo/bezierCurveTo/arc/closePath` |
| 椭圆 | `save; translate; scale; arc; restore` | 同 | `ctx.ellipse()` |
| 线帽线角 | `LINE_CAP_ROUND` `LINE_JOIN_ROUND` | `.round` | `ctx.lineCap = ctx.lineJoin = 'round'` |
| 正片叠底 | `OPERATOR_MULTIPLY` | `.multiply` | `ctx.globalCompositeOperation = 'multiply'` |
| 透明度 | `set_source_rgba` | `setAlpha` | `rgba()` 颜色或 `globalAlpha` |
| 线性渐变 | `cairo.LinearGradient` | `CGGradient` | `ctx.createLinearGradient` |
| 画位图 | `set_source_surface; paint` | `draw(image)` | `ctx.drawImage` |
| 每像素对应的用户单位 | `device_to_user_distance(1, 0)` | 自算 | 不查询矩阵，由调用方把 `perPixel = 1 / (缩放 × DPR)` 作为参数传入 |
| 把页面缓存交给屏幕 | `Gdk.MemoryTexture` 分条上传（`STRIP`） | `CALayer.contents` | 每帧 `drawImage(缓存画布)`；分条逻辑不需要 |
| 设备像素比 | `surface.get_scale()` | `contentScaleFactor` | `window.devicePixelRatio`，变化时重建缓存 |
| PNG 编码 | `surface.write_to_png` | `pngData()` | `canvas.convertToBlob({type:'image/png'})` / `toBlob`（**异步**） |
| PNG 解码 | `ImageSurface.create_from_png` | `UIImage(data:)` | `createImageBitmap(blob)`（**异步**） |
| 任意图片转 PNG、按 EXIF 摆正、限 2000 px | `GdkPixbuf` | `UIImage` | `createImageBitmap(blob, {imageOrientation:'from-image'})` → 画到 canvas → `toBlob` |
| 矢量 PDF 输出 | `cairo.PDFSurface` | `UIGraphicsPDFRenderer` | pdf-lib（§7.5） |
| 自定义光标 | `Gdk.Cursor.new_from_texture` | 无 | `cursor: url(dataURL) 8 8, crosshair` |

### 5.2 文本

| 用途 | B | A | 网页 |
| --- | --- | --- | --- |
| 测量 | Pango `get_size`（`B:ptext.py`） | `NSString.boundingRect` | `ctx.measureText` + 自写折行（§7.3） |
| 绘制 | `pango_cairo_show_layout` | `NSString.draw` | 逐行 `ctx.fillText` |
| 折行方式 | `WRAP_WORD_CHAR` | 系统默认 | 先按词断，词比行宽长时按字符断；中日文字符间可断 |
| 字体 | `Sans` | 系统字体 | `system-ui, sans-serif` |
| 文本输入 | `Gtk.TextView` 放在弹出框里 | `UITextView` | 弹出框里的 `<textarea>` |

### 5.3 输入

| 用途 | B | A | 网页 |
| --- | --- | --- | --- |
| 笔 | `GestureStylus` + 原始事件 | `UITouch.type == .pencil` | `PointerEvent.pointerType === 'pen'` |
| 压力 | `AxisUse.PRESSURE` | `touch.force` | `e.pressure`（0–1） |
| 一帧内被合并的采样 | `gesture.get_backlog()` | `coalescedTouches` | `e.getCoalescedEvents()`，没有就只用 `e` |
| 预测笔迹 | 无 | `predictedTouches` | `e.getPredictedEvents()`，可选 |
| 橡皮端/笔身键 | `DeviceToolType.ERASER`、`BUTTON2/3_MASK` | 双击切换（不移植） | `e.button === 5 \|\| e.buttons & 32` 为橡皮端；`e.buttons & 2` 为笔身键 |
| 手指 | `TOUCH_BEGIN/UPDATE/END/CANCEL` | `UITouch.type == .direct` | `pointerType === 'touch'` 的 `pointerdown/move/up/cancel`，按 `pointerId` 记录 |
| 鼠标 | `GestureDrag` | `.indirectPointer` | `pointerType === 'mouse'` |
| 中键拖动 | `GestureDrag(button=MIDDLE)` | 无 | `e.button === 1` |
| 滚轮/触控板 | `EventControllerScroll` | UIScrollView | `wheel` 事件；`deltaMode === 0` 视为平滑（触控板），否则按“格” |
| 触控板捏合 | `GestureZoom` | UIScrollView | Chrome/Firefox：`wheel` 且 `ctrlKey`；Safari：`gesturestart/gesturechange` |
| 笔悬停 | 光标 | `UIHoverGestureRecognizer` | 无按键的 `pointermove`（`pointerType === 'pen'`） |
| 长按 | 定时器 550 ms | `UILongPressGestureRecognizer` 0.55 s | `setTimeout(550)`，移动超过 10 px 取消 |
| 右键 | `GestureClick(button=SECONDARY)` | 无 | `contextmenu` 事件（始终 `preventDefault`） |
| 键盘 | `EventControllerKey` | `keyboardShortcut` | `keydown`；`Ctrl` 与 `⌘` 等价（`e.ctrlKey \|\| e.metaKey`） |
| 禁止浏览器自己的手势 | — | — | 画布元素 `touch-action: none; user-select: none; -webkit-touch-callout: none` |
| 独占指针 | 手势 `CLAIMED` | — | `el.setPointerCapture(e.pointerId)` |

### 5.4 存储与文件

| 用途 | B | A | 网页 |
| --- | --- | --- | --- |
| 文稿库根 | `~/Documents/Inkpad` | App 文档目录 | IndexedDB `files`/`dirs` 仓库 |
| 原子替换 | 写 `.tmp` 再 `os.replace` | `replaceItemAt` | 一次 IndexedDB `put`（事务本身是原子的） |
| 文件签名 | `(st_mtime_ns, st_size)` | `"mtime/size"` | `rev + '/' + size` |
| 文件锁 | `threading.RLock`（可重入） | `NSRecursiveLock` | `navigator.locks.request('inkpad-file', …)`，**不可重入**（§7.8） |
| 遍历目录 | `os.walk` | `FileManager` | 对键做前缀范围查询 `IDBKeyRange.bound(prefix, prefix + '￿')` |
| 偏好 | `~/.config/inkpad/settings.json` | `UserDefaults` | `kv['settings']` |
| 凭据与令牌 | `google_client.json` `google_token.json`（0600） | 钥匙串 | `kv['google_client']` `kv['google_token']` |
| 选文件 | `Gtk.FileDialog.open` | `fileImporter` | `<input type="file" accept>`；另支持把文件拖进窗口 |
| 选整个文件夹（导入） | `select_folder` | 文件夹选择器 | `<input type="file" webkitdirectory>`；拖入时用 `DataTransferItem.webkitGetAsEntry()` |
| 保存文件 | `Gtk.FileDialog.save` | 分享面板 | 有 `showSaveFilePicker` 就用；否则 `<a download>` + `URL.createObjectURL` |
| 保存一批文件 | 选目录后逐个写 | 分享多个 | 有 `showDirectoryPicker` 就用；否则打成一个 zip 下载 |
| 剪贴板写图片 | `clipboard.set_texture` | `UIPasteboard` | `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])` |
| 剪贴板读图片 | `read_texture_async` | `UIPasteboard` | 监听 `paste` 事件读 `clipboardData.files`；菜单里的“粘贴”用 `navigator.clipboard.read()` |
| 打开外部链接 | `Gio.AppInfo.launch_default_for_uri` | `UIApplication.open` | `window.open(url, '_blank', 'noopener')` |
| 全屏 | `window.fullscreen()` | 无 | `document.documentElement.requestFullscreen()` |

### 5.5 网络、压缩、摘要

| 用途 | B | A | 网页 |
| --- | --- | --- | --- |
| HTTP | `urllib.request` | `URLSession` | `fetch` |
| 上传进度 | 包一层计数的文件对象 | `URLSessionTaskDelegate` | `XMLHttpRequest` 的 `upload.onprogress`（`fetch` 没有上传进度） |
| 下载进度 | 分块 `read` | `task.progress` | `response.body.getReader()` 累计 |
| OAuth 回跳 | 本机一次性 HTTP 服务器 | 同，或自定义 scheme | 本站的 `oauth.html`（§7.6） |
| 随机数 | `secrets.token_urlsafe` | `SecRandomCopyBytes` | `crypto.getRandomValues` |
| UUID | `uuid.uuid4().hex` | `UUID()` | `crypto.randomUUID().replaceAll('-', '')` |
| SHA-256 | `hashlib.sha256` | `CryptoKit.SHA256` | 自写流式实现；小数据可用 `crypto.subtle.digest` |
| MD5 | `hashlib.md5` | `Insecure.MD5` | 自写流式实现 |
| CRC-32 | `zlib.crc32` | `zlib.crc32` | 自写查表实现 |
| deflate | `zipfile` | `Compression` | `CompressionStream('deflate-raw')` / `DecompressionStream('deflate-raw')` |
| base64 | `base64` | `Data.base64…` | 自写 `Uint8Array ⇄ base64`（`btoa` 只能处理字符串，大数组要分块） |
| protobuf/LZ4/RTF（Goodnotes） | 手写 | 手写 | 照 `B:goodnotes.py` 手写 |

### 5.6 线程与计时

| 用途 | B | A | 网页 |
| --- | --- | --- | --- |
| 后台任务 | `threading.Thread` + `GLib.idle_add` | `Task.detached` / `DispatchQueue` | `async` 函数；计算密集的放 Worker |
| 一次性定时 | `GLib.timeout_add` | `Timer` | `setTimeout` |
| 逐帧回调 | `add_tick_callback` | `CADisplayLink` | `requestAnimationFrame` |
| 缓动动画 | `Adw.TimedAnimation`（`EASE_OUT_CUBIC`） | `setContentOffset(animated:)` | `requestAnimationFrame` + `1 - (1 - t)³` |
| 单调时钟 | `GLib.get_monotonic_time()`（微秒） | `timestamp` | `performance.now()`（毫秒）；**注意换算**，B 里的阈值是微秒 |
| 请求重绘 | `queue_draw()` | `setNeedsDisplay` | 置脏标记 + 下一帧 `requestAnimationFrame` 统一画 |
| 前后台切换 | 无 | `scenePhase` | `document.visibilitychange`、`pagehide` |

### 5.7 界面控件

| B（GTK/libadwaita） | 网页 |
| --- | --- |
| `Adw.HeaderBar` | `<header>` + flex |
| `Gtk.Popover` / `Gtk.MenuButton` | `ui/popover.js`：`position: fixed` 的浮层，按锚点矩形定位，贴边翻转，超高滚动，点外面或按 Esc 关闭 |
| `Adw.AlertDialog` / `Adw.Dialog` | `<dialog>` + `showModal()` |
| `Adw.ToastOverlay` | `ui/toast.js`：底部居中的条，可带一个按钮（“撤销”），3 s / 带按钮 5 s |
| `Gtk.ToggleButton` 成组 | 一组 `<button aria-pressed>`，或 `<input type="radio">` |
| `Gtk.Switch` | `<input type="checkbox" role="switch">` + CSS |
| `Gtk.Scale` | `<input type="range">` |
| `Gtk.DropDown` / `Adw.ComboRow` | `<select>` |
| `Gtk.SpinButton` | `<input type="number">` |
| `Gtk.FlowBox` | CSS grid `repeat(auto-fill, 186px)` |
| `Gtk.Stack`（交叉淡入 160 ms） | 两个容器切换 `hidden` + `opacity` 过渡 |
| `Adw.OverlaySplitView`（侧栏 300 px） | 绝对定位的 `<aside>` + `transform` 过渡 |
| `Adw.PreferencesGroup/ActionRow/SwitchRow/EntryRow/ExpanderRow` | 自写的行样式；`ExpanderRow` 用 `<details>` |
| `Gtk.DragSource/DropTarget` | 用指针事件自己实现拖动（HTML5 拖放在触屏上不可用），见 §8.1 |
| `Adw.StatusPage`（空状态） | 居中的标题 + 说明 |
| `Adw.AboutDialog` | 普通对话框 |
| `Adw.StyleManager.set_color_scheme` | `<html data-theme="light\|dark">`，`system` 时不设并用 `prefers-color-scheme` |

---

## 6. 必须逐字节兼容的规格

### 6.1 `.inkpad` 文件（zip）

来源：`B:model.py:1156-1352`。

条目，按写入顺序：

| 条目 | 压缩 | 内容 |
| --- | --- | --- |
| `document.json` | deflate | 页面列表与文档元数据 |
| `pages/<页面 id>.json` | deflate | 该页的元素与已删除元素的 id |
| `id` | stored | 文档 id 的文本（32 位十六进制） |
| `cover.png` | stored | 封面 |
| `pdf/0.pdf`、`pdf/1.pdf`… | **stored** | 嵌入的 PDF，同一份只存一次 |
| `img/0.png`、`img/1.png`… | **stored** | 图片，同一份只存一次 |

`pdf/` 和 `img/` 必须用 stored：同步时要直接按字节范围切出来上传（§7.7）。

zip 读取规则（风险 R10）：
- **大小、CRC、压缩方式一律取自中央目录。** 本地文件头只用来读“文件名长度 + 扩展区长度”以跳到数据起点。原因：B 的 `_fatten` 用 `force_zip64=True` 写入大条目（`B:gdrive.py:528`），其本地头里的大小是 `0xFFFFFFFF` 加 zip64 扩展区，而中央目录里是正常的 32 位值。
- 同名条目以最后一个为准。
- 文件名：通用标志位 `0x800` 置位时按 UTF-8 解码；写入含非 ASCII 的名字时必须置位。
- 不支持超过 4 GB 的文件或条目，遇到时报错。

`document.json`（紧凑 JSON，无多余空格）：

```json
{"format":"inkpad","version":3,
 "pages":[{"id":"16位十六进制","w":595.0,"h":842.0,"paper":"blank","color":[1.0,1.0,1.0],
           "board":true, "pdf":0,"pdf_page":0,"rot":0, "bookmark":true, "outline":"标题", "mt":1760000000.5}],
 "id":"32位十六进制",
 "gone":["已删除页面的 id，排序后取最后 20000 个"],
 "order_mt":1760000000.5,
 "cover":["simple",[0.69,0.61,0.50]]}
```

- 仅在为真/存在时才写的键：`board`、`pdf`+`pdf_page`+`rot`（三者同写）、`bookmark`、`outline`、`mt`、`order_mt`、`cover`。
- `paper` 取值：`blank dots ruled wide grid cornell legal col2 col3 todo weekly staff go`。
- `cover` 的样式取值：`simple label ribbon band grid`。旧文件的 `cover` 可能是裸的 `[r,g,b]`，按 `("simple", 颜色)` 读。
- 白板页：`w = h = 1e8`，`board: true`。
- `format` 不是 `inkpad` 时报错“不是 Inkpad 文档”。

`pages/<id>.json`：`{"items":[…],"gone":["已删除元素的 id，排序后取最后 20000 个"]}`

元素（每个都带 `"id"`，16 位十六进制）：

| 类型 | JSON |
| --- | --- |
| 笔画 | `{"k":"s","t":"fountain\|ball\|brush\|hl\|tape","c":[r,g,b],"w":宽度,"ps":灵敏度,"d":0\|1\|2,"q":"压缩后的点","o":true,"id":…}`；`o` 仅当胶带已掀开时写 |
| 形状 | `{"k":"h","t":"line\|arrow\|rect\|ellipse","c":[r,g,b],"w":宽度,"r":[x0,y0,x1,y1],"id":…}`；`r` 保留两位小数 |
| 文本 | `{"k":"t","x":…,"y":…,"s":"文字","z":字号,"c":[r,g,b],"wr":折行宽度,"bg":[r,g,b],"id":…}`；`x` `y` 两位小数；`bg` 仅便签有 |
| 图片 | `{"k":"i","r":[x,y,w,h],"img":图片序号,"id":…}`；`r` 两位小数 |

颜色分量是 0–1 的浮点数。单位是 PDF 点（1/72 英寸）。

id 的生成：元素与页面 `uuid4().hex` 的前 16 位；文档 `uuid4().hex` 全 32 位。

旧格式兼容（`B:model.py:1331-1338`）：
- 页面没有 `id`：`md5(文档id + "/" + 页序号)` 的十六进制前 16 位。
- 没有 `pages/<id>.json`：元素在 `document.json` 该页的 `items` 里。
- 笔画没有 `q` 而有 `p`：`[x,y,压力,x,y,压力,…]` 的数字列表。
- 元素没有 `id`：见风险 R11。

保存时的优化（`B:model.py:1211-1221`）：页面的 `rev` 未变且页内无图片时，复用上次序列化好的 JSON 字符串。

### 6.2 点的压缩编码 `q`

来源：`B:model.py:890-943`。

```
字节流 = float64LE(x0) + float64LE(y0)
        + 对每个点（包括第一个）：zigzag-varint(Δx) + zigzag-varint(Δy) + 一字节压力
其中 Δ 是相邻两点的“百分之一点”整数坐标之差：c = round(x * 100)，第一个点的 Δ 为 0
压力字节 = clamp(round(p * 255), 0, 255)
q = 标准 base64(字节流)
```

- zigzag：`n >= 0 ? 2n : -2n - 1`；varint：每字节低 7 位，高位表示后续。**用除法和取模实现，不要用 32 位位运算**（白板坐标乘 100 后超过 2³¹）。
- 解码：累加 Δ 后除以 100，压力为 `字节 / 255`；最后把第一个点的坐标替换成头部的精确 `(x0, y0)`。
- 空点列编码为空串。

### 6.3 逐项合并 `merge(mine, theirs)`

来源：`B:model.py:812-873`；先调用双方的 `stamp()`（`B:model.py:1165-1179`）。照抄，要点：

1. 已删除页面集合 = 两边 `gone_pages` 的并集。
2. 页面顺序取 `order_mt` 较大的一方（相等取 `mine`）；另一方独有的页面插在它在那一方的前一页之后，前一页不在结果里就放末尾。
3. 去掉已删除的页面；若一页不剩，保留 `mine` 原来的第一页。
4. 对两边都有的页面：若对方 `mt` 更大，整组页面设置（`w h paper color board pdf pdf_page rot bookmark outline`）取对方的。
5. 元素：`gone` 取并集；结果 = 我方未被删除的元素（保持原顺序）+ 对方有而我方没有且未被删除的元素（追加在后）。
6. 只要有任何变化：清空撤销与重做栈，`rev += 1`。
7. 返回五个计数：加页、删页、加元素、删元素、接受的设置变化数。

`stamp()`：对每页比较当前设置签名与上次记录的签名，变了就把 `mt` 设为现在；页面顺序若相对上次记录发生了重排（忽略增删，只看共同页面的相对顺序）就把 `order_mt` 设为现在。

墓碑规则（`B:model.py:1022-1035`）：一次“元素”操作中被移出且未在同一操作中被放回的元素，其 id 进入 `page.gone`；被放入的元素 id 从 `gone` 中移除。撤销时方向相反。页面同理进出 `gone_pages`。

### 6.4 云端索引与本机同步状态

来源：`B:gdrive.py:51-63, 424-442, 642-1069`。

固定值：

| 名称 | 值 |
| --- | --- |
| 权限范围 | `https://www.googleapis.com/auth/drive.file` |
| 云端根文件夹名 | `Inkpad`（在“我的云端硬盘”顶层），或用户指定的文件夹 id |
| 索引文件名 | `_inkpad_index.json` |
| 索引格式号 | `3`；读到更大的值时报错“云端的笔记是由更新版本的 Inkpad 同步的…” |
| 大对象阈值 | `pdf/` 或 `img/` 下且 ≥ 32 768 字节 |
| 大对象文件名 | `blob-sha256-` + 内容 SHA-256 的十六进制；旧式 `blob-%08x-%d`（CRC-32，大小）只读不写 |
| 上传件内的清单 | `blobs.json`：`{"pdf/0.pdf": "blob-sha256-…", …}` |
| 断点写索引间隔 | 10 s |
| 自动彻底同步间隔 | 6 小时 |
| 单本笔记的最多重试轮数 | 5 |

云端索引：

```json
{"format":3,
 "items":{"<笔记 id>":{"path":"数学/笔记.inkpad","trashed":false,"md5":"…","file":"<Drive 文件 id>","deleted":false,"ts":1760000000.5}},
 "blobs":{"blob-sha256-…":"<Drive 文件 id>"},
 "folders":{"数学":false,"旧文件夹":true},
 "meta":{"favorites":["数学/笔记.inkpad"],"folders":{"数学":{"color":[r,g,b],"icon":"book"}},"ts":1760000000.5}}
```

- 云端所有文件（笔记、大对象、索引）都**平铺**在根文件夹里；笔记在云端的文件名是其路径的最后一段。
- `folders` 的值为 `true` 表示该文件夹已被删除。
- `meta` 整体以 `ts` 较新的一方为准。

本机状态 `kv['sync']`（即 B 的 `.sync.json`，只在本机用，格式可自定，但建议沿用以便对照代码）：

```json
{"folder_set":"","root":"<根文件夹 id>","index":"<索引文件 id>","checked":秒,"last":秒,
 "items":{"<笔记 id>":{"path":…,"trashed":…,"md5":"上次双方一致时云端的 md5",
                       "local":"当时本机文件的代号","stat":"当时本机文件的签名",
                       "blobs":{"pdf/0.pdf":[crc, 大小, "blob-sha256-…"]},"sent":true}},
 "folders":["上次同步时本机存在的文件夹"]}
```

文稿库元数据 `kv['library']`（即 `.library.json`）：`{"favorites":[相对路径], "trashed":{废纸篓里的名字: 原文件夹}, "folders":{相对路径: {"color":[r,g,b], "icon":名字}}, "archived":{".deleted 里的名字": 原文件夹}, "ts":秒}`。每次保存都把 `ts` 设为现在。

### 6.5 凭据 JSON

导入/导出的文件形状（`B:gdrive.py:80-156`）：

```json
{"inkpad_folder":"<文件夹 id 或空串>",
 "installed":{"client_id":"….apps.googleusercontent.com","client_secret":"…",
              "auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}}
```

导入时接受 `installed` 或 `web` 键。手填时校验客户端 ID 以 `.apps.googleusercontent.com` 结尾；客户端 ID 变了要清除已有令牌。`parse_folder`（`B:gdrive.py:129`）接受文件夹 id 或文件夹网址。

### 6.6 存档 zip（文稿库/文件夹/所选项目的导出）

来源：`B:library.py:358-494`。全部 stored；目录写成以 `/` 结尾的空条目；只收 `.inkpad` 文件，跳过 `.` 开头的名字；末尾加 `inkpad-library.json`：`{"app":"Inkpad","folders":{存档内路径: 样式}}`。导入时永不覆盖已有笔记（重名加序号），拒绝含 `.`、`..` 或以 `/` 开头的路径。

---

## 7. 需要重写的部分

### 7.1 画布渲染与缓存

采用 B 的模型（`B:canvas.py` 文件头注释），不采用 A 的 UIScrollView 结构。

**分层**（自下而上）：
1. 主 `<canvas>`：铺满编辑区，尺寸 = CSS 尺寸 × DPR。每帧清空后画：画布底色 → 每个可见页的阴影与底色 → `drawImage(该页缓存)` → 查找高亮 → 滚动条。
2. 叠加 `<canvas>`：同尺寸，透明。画正在写的笔画、形状预览、橡皮圈、套索虚线、被拖动的选区图层、选区框与手柄、激光笔、尺子、“拉出新页”提示、笔悬停标记。
3. DOM 浮层：撤销条、选项条、选区操作条、查找条、状态条、小地图、文本输入弹出框。

**坐标**：沿用 B 的三套——内容坐标（所有页面排好后的整体，像素）、控件坐标（内容坐标减滚动量）、页面坐标（点）。翻译 `_relayout`、`_origin`、`_page_rect`、`_to_page`、`_locate`、`_anchor`、`_place`（`B:canvas.py:403-675`）。滚动量用两个普通变量 `scrollX/scrollY` 加上下限，替代 `Gtk.Adjustment`。

**页面缓存**（`B:canvas.py:1466-1665`）：
- 每页一个缓存项：`{canvas, full:[整页像素宽, 高], ox, oy, pw, ph, sx, sy, bg}`。`full` 按 `_render_zoom × 页面自身比例 × DPR` 算。
- 整页像素数 ≤ `MAX_PIXELS` 时缓存整页；否则只缓存视口周围的窗口（四周各留 40%，对齐到 256 像素）。白板永远用窗口。
- 缩放过程中不重建，直接把旧缓存拉伸着画；缩放停下 160 ms 后把 `_render_zoom` 设为当前值并重建。缩小到 `_render_zoom / 1.5` 以下时立即跟进（否则要缓存的区域过大）。
- `added` 事件：直接把新元素画到缓存上。`dirty` 事件：对该矩形（向外取整到整像素再各扩 2 像素）裁剪后重画纸张/背景和所有与之相交的元素。`pages` 事件：丢掉已不存在页面的缓存并重新布局。
- 离视口超过前后 2 页的缓存释放。**释放时把画布的 `width` 和 `height` 设为 0**（Safari 不这样做不归还内存）。
- B 的 `STRIP`/`_strips`（分条上传纹理）是 GTK 专用的，不移植。

**精度规则（必须遵守）**：`ctx` 的变换矩阵只放“缩放”和“不超过几万的平移”。所有绘制函数签名带原点：`item.draw(ctx, env)`，其中 `env = {ox, oy, perPixel, onDark, printing}`，函数内部对每个坐标先做 `x - env.ox` 再调用 `ctx`。纸张图案同理（`_board_paper` 里的 `fx, fy` 先在 JS 里算好再减）。对普通页面 `ox = oy = 0`；对白板取缓存窗口左上角对应的页面坐标。

**PDF 背景**（`B:canvas.py:1512-1576`、`B:render.py`）：
- PDF 页的缓存项多一个 `bg`（只含 PDF 的位图），擦除时不必重新渲染 PDF。
- 渲染请求进优先队列：可见页优先级 0，预取（视口后一页、前一页、后两页）为 1–3；同优先级后到的先做；开始前检查是否已作废（页面已滚远超过 3 页或已有更新的请求）。同一时间只跑一个渲染任务；被取代的任务调用 pdf.js 的 `renderTask.cancel()`。
- 最近 8 个渲染好的背景按 LRU 保留（`BG_KEEP`）。
- 背景没好之前，该页先显示白底（或拉伸的旧缓存）。

**正在写的笔画**：
- 钢笔/画笔（逐段变宽）和圆珠笔：每来一批新点，只把新增的线段画到叠加画布上，不清除旧的。B 的 `CHUNK`/`chunks` 烘焙机制因此不需要。
- 荧光笔、胶带、虚线/点线：每帧清掉这条笔画的包围盒，整条重画（半透明线段叠画会变深）。
- 抬笔后 `doc.add_items()` 触发 `added`，笔画被画进页面缓存，然后清掉叠加画布上的这一条。
- 荧光笔在叠加层上是普通的 40% 透明（与 B 相同），落到页面上才是正片叠底，抬笔瞬间颜色会略变，这是原版行为。

**远看时的简化**（`B:model.py:156-169`）：`perPixel > 1.5` 且不是导出 PDF 时，笔画不按压力分段，跳过间距小于一个像素的点，线宽不小于 `0.9 × perPixel`。白板纸张图案在间距小于 6 像素时点阵按 2 的幂抽稀、线条不画（`B:model.py:543-552`）。

### 7.2 输入

一个状态机处理三种指针。B 的 `_raw_pen_event`、`_pen_gone`、`_pen_back`、`_nudge`（`B:canvas.py:821-963`）是针对某款 Chromebook 的规避代码，**不移植**。紧随其后的 `log`（输入日志）和 `_drop`（别的手势要求放弃当前操作；笔正在写时不放弃，否则 `_cancel`）要移植。

**笔**（`pointerType === 'pen'`）：
- 任何笔事件：`hasPen = true`，记录 `penSeen = performance.now()`，调用 `_palm()`（`B:canvas.py:1003`）作废当前所有手指并撤销它们刚做的事。
- `pointerdown`：`setPointerCapture`；橡皮端或笔身键按下则本次按橡皮擦处理；调用 `_down(x, y, pressure, erase)`。
- `pointermove`（有按键）：对 `getCoalescedEvents()` 的每个采样调用 `_move`。压力夹在 `[0.02, 1]`；设备不报压力时为 0.5。
- 无压感笔的识别（来自 `A:CanvasTools.swift:319-356`）：一笔的前 12 个采样压力变化都不超过 0.02，则认定这支笔没有压感，此后用速度笔锋：`aim = clamp(0.95 - 速度(px/s) / 1700, 0.16, 0.92)`；`mouseP += (aim - mouseP) × (1 - exp(-dt / 0.045))`；输出 `clamp(0.5 + (mouseP - 0.5) × 2, 0, 1)`。一旦见到压力变化就恢复使用设备压力。
- `pointerup` → `_up`；`pointercancel` → `_cancel`。
- 无按键的 `pointermove`：画悬停标记（`A:CanvasExtras.swift:359-418`：十字、或关闭十字光标时的小圆点/笔尖大小的色点、橡皮的粗十字、文本工具的 I 形）。

**手指**（`pointerType === 'touch'`）：翻译 `_touch`、`_touch_reset`、`_grab_touch`、`_touch_update`（`B:canvas.py:1033-1207`）。要点：
- 笔按着，或距上次笔事件不足 `palm_ms`：这根手指记入 `rejected`，直到抬起都忽略。
- 一根手指、且“用手指书写”开着或当前是激光笔：书写。第二根手指落下时，若这一笔开始不足 0.3 s 或不足 8 个点则丢弃（那是捏合的第一根手指，来自 A 的 `strokeInterrupted`），否则就地结束。
- 否则是移动/缩放：8 像素死区；双指间距 > 12 像素时按间距比缩放；手指中点下的页面点保持在中点下（`_place`）。
- 抬起：单指且在移动中松手 → 惯性滑动（`_start_fling`）；左右翻页模式下 → 吸附到整页（`_rest`）；没移动的单指轻点 → 套索工具下点选最上面的图片/形状/文本框，其它工具下掀开/盖回胶带。
- 手指在尺子上：一指移动，两指旋转。
- 套索工具且有选区：手指按在选区内拖动、按在边缘缩放（触摸的判定范围是 22 像素）；拖动中再放一根手指改为拖走副本。
- 套索工具下手指或鼠标按住不动 550 ms：弹出菜单（剪切/拷贝/复制/删除/粘贴）。笔不触发。
- 笔落下时撤销手掌造成的移动：视图回到 350 ms 之前的状态（`_palm` 里的 `seen` 记录，每 40 ms 记一次）。

**鼠标**（`pointerType === 'mouse'`），翻译 `_drag_begin/update/end`（`B:canvas.py:1975-2035`）：
- 左键按在滚动条滑块上：拖动滑块。点滑块以外不跳转。
- “有手写笔时鼠标不书写”开着且已见过笔：鼠标拖动是移动页面，单击是掀开/盖回胶带。
- 否则书写，压力由速度决定：初值 0.45，每次 `p = p × 0.75 + clamp(0.95 - 位移像素 / 45, 0.15, 0.85) × 0.25`。
- 中键拖动：移动页面。
- 滚轮（`_ctrl_scroll`，`B:canvas.py:1329`）：指针在尺子上 → 每格转 1°，按 Shift 转 15°；按 Ctrl → 以指针为锚缩放 `1.1^(-dy)`；左右翻页模式 → `_turn_scroll`（一格/一次滑动翻一页）；白板 → 自由滚动（Shift 交换两轴）；其余 → 普通滚动。
- 右键在选区上：打开选区条的“更多”菜单。

页面级设置：`<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">`；画布容器 `touch-action: none`；监听 Safari 的 `gesturestart` 并 `preventDefault`；对画布 `contextmenu`、`selectstart`、`dragstart` 一律 `preventDefault`。

### 7.3 文字排版

`core/ptext.js` 导出 `measure(text, size, wrap) → [宽, 高]` 和 `show(ctx, x, y, text, size, wrap, env)`。

- 字体串 `${size}px system-ui, sans-serif`，`textBaseline = 'alphabetic'`。
- 行高：取 `measureText('Hg')` 的 `fontBoundingBoxAscent + fontBoundingBoxDescent`，取不到时用 `size × 1.3`。
- 先按 `\n` 分段。`wrap > 0` 时每段按宽度折行：用 `Intl.Segmenter(undefined, {granularity: 'word'})` 切词（不可用时按空格和 CJK 字符边界切），逐词累加；单个词超宽时用 `granularity: 'grapheme'` 逐字切。
- `measure` 的宽是各行最大宽度，高是行数 × 行高。
- 测量用一个全局共享的 1×1 画布上下文。Node 测试时注入桩函数。
- 文本的包围盒规则在 `B:model.py:347-352`：普通文本四周留 2；便签留 `size × 0.7`，且宽度不小于 `wrap`。
- 各平台字体度量不同，同一个文本框在三端的高度会略有差别。这是已有现象，不处理。

### 7.4 PDF 渲染与查找

`core/pdfdoc.js`：

```js
class PdfDoc {
  constructor(blob, key)        // blob：PDF 字节；key：[大小, CRC-32]，来自 zip 中央目录
  async open()                  // 懒加载 pdf.js 并打开文档；重复调用返回同一个 Promise
  async nPages()
  async pageSize(i)             // [宽, 高]，点；用 page.getViewport({scale: 1})，已含页面自带的旋转
  async render(i, ctx, {offsetX, offsetY, scaleX, scaleY, printing})   // 返回可取消的任务
  async find(i, query)          // [[x0, y0, x1, y1], …]，页面左上角为原点
}
```

- **打开文档不需要在加载笔记时进行**：页面尺寸已经存在 `document.json` 里，布局不依赖 PDF。第一次要画 PDF 页时才 `open()`。
- 页面的 `rot`（四分之一圈数）在 `render_pdf_bg` 里叠加（`B:model.py:721-730`）：先平移再旋转，然后调用 `render`。
- pdf.js 的配置：`workerSrc`、`cMapUrl`、`standardFontDataUrl` 都指向 `vendor/pdfjs/` 下的本地路径（缺 cMap 时中日文 PDF 会显示成空白）。
- 查找：`page.getTextContent()` 得到文字片段及其变换矩阵；对每个片段做不区分大小写的子串匹配，命中时按“字符数比例 × 片段宽度”估算命中框。只能命中落在同一片段内的词，比 poppler 弱，可接受。
- 同一份 PDF 判重（`B:model.py:1193-1200, 1294-1306`）：先比 `[大小, CRC]`，相同再比内容。网页版内容比较用 SHA-256（流式计算并缓存在 `PdfDoc` 上），不要把两份 PDF 都读进内存逐字节比。
- 第一版可以把整个 PDF 读成 `ArrayBuffer` 交给 pdf.js。之后改用 pdf.js 的 `PDFDataRangeTransport`，按需 `blob.slice()` 读取，避免大 PDF 常驻内存。

### 7.5 矢量 PDF 导出

`io/exportpdf.js`，懒加载 pdf-lib。对外：`exportPdf(doc, {pages, paper, ink}) → Blob`。逻辑框架照 `B:model.py:1493-1509`：每页大小为 `page_box` 的宽高，超过 14 400 点时整体缩小。

实现一个与 Canvas 2D 子集同名的适配器 `PdfCtx`，让 §M3 的绘制代码**原样复用**：

| Canvas 2D 调用 | PDF 内容流 |
| --- | --- |
| `moveTo/lineTo/bezierCurveTo/closePath/rect` | `m l c h re` |
| `arc/ellipse` | 拆成贝塞尔曲线 |
| `stroke/fill` | `S` / `f` |
| `lineWidth/lineCap/lineJoin` | `w` / `J` / `j` |
| `strokeStyle/fillStyle`（含透明度） | `RG` / `rg` + ExtGState 的 `CA` / `ca` |
| `globalCompositeOperation = 'multiply'` | ExtGState 的 `BM /Multiply` |
| `save/restore/translate/scale/rotate/clip` | `q` / `Q` / `cm` / `W n` |
| `drawImage(图片)` | 图片 XObject（pdf-lib 的 `embedPng`） |
| `fillText` | 文字操作符 + 嵌入的字体子集，见下 |

坐标系：PDF 原点在左下，导出时在页首加一次 `1 0 0 -1 0 高 cm` 翻转。

- **原 PDF 背景**：`pdfDoc.embedPdf(原文件字节, [页码])` 得到嵌入页，按页面的 `rot` 摆放。同一份源 PDF 只 `embedPdf` 一次。嵌入失败（加密或损坏的 PDF）时退回：用 pdf.js 把该页按 2 倍渲染成 JPEG 嵌入，并在导出完成的提示里说明有几页是以图片形式导出的。
- **文字必须是矢量，字体由用户选择**（`io/exportfont.js`）：
  - 选字体的两种途径：① `<input type="file" accept=".ttf,.otf">` 选一个字体文件，所有浏览器可用；② 浏览器支持 `window.queryLocalFonts()` 时（目前只有桌面版 Chromium），列出系统字体供选择，用 `fontData.blob()` 取字节。选中的字体存进 `kv['export_font']`，下次导出直接用。设置里有“导出 PDF 的字体”一行，显示当前字体名，可更换或清除。
  - 还没选字体就导出、且导出范围内有文字时：先弹出选字体的对话框，取消则不导出。导出范围内没有任何文字（没有文本框、便签，也没有“周计划”纸张）时不需要字体。
  - 嵌入：`pdfDoc.registerFontkit(fontkit)`，`pdfDoc.embedFont(字节, {subset: true})`。只接受单一字体的 `.ttf` / `.otf`；`.ttc` 字体集和可变字体先报错“请选择单个 .ttf 或 .otf 字体文件”。
  - 排版：导出时文字**用所选字体的度量重新折行**。`ptext` 的折行算法不变，只把“测量一段文字宽度”的函数换成 `font.widthOfTextAtSize(text, size)`，行高取 `font.heightAtSize(size)`。文本框的包围盒（便签底色块的大小由它决定）也按这套度量现算，保证文字落在底色块里。屏幕上的字体不受影响，因此导出的折行位置可能与屏幕略有不同，这与三端之间已有的差别同类（R13）。
  - 绘制：`PdfCtx.fillText` 输出文字操作符（`BT … Tf … Tj ET`），用 `font.encodeText()` 编码。因为页首做过上下翻转，写字前要再翻回来（文字矩阵 `1 0 0 -1 x y`）。
  - 所选字体缺字时（逐字用 `font.getCharacterSet()` 检查）：导出照常进行，缺的字符画不出来；完成提示里写明“所选字体缺少 N 个字符”并列出前几个，让用户换字体。**不要悄悄退回图片。**
  - 适用范围：文本框、便签、“周计划”纸张上的星期名。封面是 PNG，不涉及。
- 逐段变宽的笔画会产生大量小路径，文件比原版大，属正常。
- Goodnotes 导出（`B:goodnotes.py:860`）需要“只含背景、不含笔画”的 PDF，调用同一个导出函数并临时过滤掉笔画。

### 7.6 Google 登录（OAuth）

B 和 A 用“桌面应用”类型的客户端，回跳到本机环回地址。网页做不到在任意域名下接收环回回跳，所以流程改为：

1. 回跳地址固定为本站的 `oauth.html`：`new URL('oauth.html', location.href).href`（去掉查询串和片段）。
2. 生成 `verifier`（64 字节随机数的 base64url）、`challenge = base64url(SHA-256(verifier))`、`state`（16 字节）。把 `verifier` 和 `state` 存进 `sessionStorage`。
3. 打开授权页（参数与 `B:gdrive.py:208-211` 相同）：`client_id`、`redirect_uri`、`response_type=code`、`scope`、`access_type=offline`、`prompt=consent`、`state`、`code_challenge`、`code_challenge_method=S256`。优先 `window.open` 弹窗；弹窗被拦截时整页跳转。
4. `oauth.html` 的脚本：有 `window.opener` 时用 `BroadcastChannel('inkpad-oauth')` 把 `location.search` 发回并关闭自己；否则把它存进 `sessionStorage` 再跳回 `index.html`，主页面启动时检查并继续。
5. 主页面核对 `state`，向 `token_uri` 发 `POST`（表单编码）：`client_id`、`client_secret`、`code`、`code_verifier`、`grant_type=authorization_code`、`redirect_uri`。响应里必须有 `refresh_token`，否则报“Google 没有返回刷新令牌，请重试”。
6. 存 `{refresh_token, access_token, expires_at: 现在 + expires_in - 60}`。之后每次调用前若已过期就用 `grant_type=refresh_token` 刷新（`B:gdrive.py:259-267`）。
7. 断开：向 `https://oauth2.googleapis.com/revoke` 发令牌（失败不管），删除本地令牌。

用户需要做的配置（写进设置页的说明文字里，并显示可一键复制的两个地址）：
- 正式部署（GitHub Pages）：在与桌面版**同一个 Google Cloud 项目**里新建“Web 应用”类型的 OAuth 客户端。“已获授权的 JavaScript 来源”填 `https://<用户>.github.io`（只有协议和域名，不带仓库路径）；“已获授权的重定向 URI”填 `https://<用户>.github.io/<仓库>/oauth.html`（完整地址，大小写与末尾必须一字不差）。然后在设置里填这个客户端的 ID 和密钥。
- 本机开发（`http://localhost:端口`）：在同一个 Web 客户端里把 `http://localhost:端口` 和 `http://localhost:端口/oauth.html` 也加进去；或者直接用桌面版的“桌面应用”客户端（待验证，见 R1 问题四）。
- 设置页里这两个地址由代码从 `location` 算出来显示，不要写死。

导出凭据 JSON 时：页面来源是环回地址用 `installed` 键，否则用 `web` 键（把 Web 客户端当成桌面客户端导入 B 会登录失败）。

此节有两个未经实测的前提，见风险 R1，M0 试验 1 就是验证它们。

### 7.7 Drive 传输

`sync/drive.js` 实现 `A:Sync/Sync.swift:50-69` 的 `DriveAPI` 接口：`root()`、`find(name, parent)`、`getJSON(id)`、`putJSON(name, value, parent, id)`、`rename(id, name)`、`upload(blob, name, parent, id) → [id, md5]`、`download(id) → Blob`、`children(parent)`、`md5(id)`、`alive(id)`、`trash(id)`，外加 `onBytes(已传, 总数)` 回调。请求细节照 `B:gdrive.py:250-391`。

- 查询串里的文件名要转义 `\` 和 `'`（`A:Sync/Drive.swift` 的 `quoted`；B 没做，是个缺陷）。
- `putJSON`：`multipart/related`，两段都是 JSON，新建用 `POST`，替换用 `PATCH …/files/<id>`，`?uploadType=multipart&fields=id`。
- `upload`：可续传上传。第一步 `fetch` 发起会话（头 `X-Upload-Content-Type: application/zip`、`X-Upload-Content-Length`），从响应头 `Location` 取会话地址；第二步用 `XMLHttpRequest` `PUT` 整个 Blob，监听 `upload.onprogress`。响应 `fields=id,md5Checksum`。
- `download`：`fetch(…?alt=media)`，用 `body.getReader()` 读块并累计进度，最后 `new Blob(块数组)`。
- 错误：非 2xx 时取 `error.message`，抛 `DriveError`，带 `code`（HTTP 状态）。同步逻辑依赖 `code === 404` 和 `403`。
- 进度回调限流到每秒 10 次（`A:AppModel.swift` 的 `Pace`）。

**瘦身与复原（零拷贝）**，对应 `_slim` 和 `_fatten`（`B:gdrive.py:452-544`）：
- `slim(blob, seen, have)`：读中央目录；非大对象的条目用“原样拷贝”（`blob.slice(数据起点, 数据终点)` 作为新 zip 的一部分，不解压不重压）；大对象条目不写入，改记进 `blobs.json`。大对象的名字优先从 `seen` 取（同位置、同 CRC、同大小即认为没变），否则流式算 SHA-256。需要上传的大对象：若条目是 stored，直接就是 `blob.slice(数据起点, 数据终点)`；若是 deflate，先解压。返回 `{slim: Blob, parts: {名字: Blob}, found}`。
- `fatten(slimBlob, haveBlob, seen, fetch)`：没有 `blobs.json` 则原样返回。否则新 zip = slim 里除 `blobs.json` 外的全部条目（原样拷贝）+ 每个大对象（本机旧文件里有就切片拷贝，否则 `fetch` 下载；下载到的 `blob-sha256-` 对象要核对 SHA-256，不符则报错且不使用）。大对象以 stored 写入。
- 两者的产物都是 `new Blob([若干切片和小数组])`，不占内存。
- `stripped(blob)`：zip 里有 `blobs.json` 即为“残缺件”，不得打开、不得上传、不得当作已同步（`B:gdrive.py:547`）。

`sync.js` 的主体 `_sync`（`B:gdrive.py:671-1069`）逐行翻译，控制流对照 `A:Sync/Sync.swift:461` 起的 `run`。其中 `publish`、`checkpoint`、`place`、`local_md5`、`push`、`settle` 六个内部函数和主循环的每个分支都要保留，包括注释里解释的每一种情形。不要简化。

### 7.8 本地存储、锁、多标签页

- **锁**：B 用一把可重入锁 `file_lock` 保护“比较签名→替换文件”。Web Locks 不可重入，所以规定：**只有最外层的公开函数取锁**（`Document.save`、编辑器的自动保存写入、同步里替换本机文件的那几处），内部的 `_write` 等函数不取锁并在名字上加下划线前缀。取锁的函数之间不得互相调用。
- 锁内的 `await` 只允许是存储读写，不允许有网络请求。
- `vfs.write(path, blob, {expect})`：在同一个 IndexedDB 读写事务里读出当前 `rev`，与 `expect` 不符就抛 `Changed`，相符才 `put`。这一步本身是原子的，是跨标签页安全的最后一道保障。
- **多标签页**：用 `navigator.locks.request('inkpad-sync', {ifAvailable: true}, …)` 保证同一时间只有一个标签页在同步；用 `BroadcastChannel('inkpad-library')` 广播“文稿库变了”，其它标签页收到后刷新列表，打开着同一本笔记的标签页走“文件被别人写了”的流程（`absorb`，`B:window.py:1422`）。
- **持久化**：启动时调用 `navigator.storage.persist()`。在“管理储存空间”里显示 `navigator.storage.estimate()` 的用量与配额。
- **关闭页面**：`visibilitychange` 变为 `hidden` 时立即保存并发起一次静默同步；`beforeunload` 时若有未保存的修改则触发浏览器的离开确认。`pagehide` 里发起的 IndexedDB 写入不保证完成，不能依赖它。
- **封面缓存**：`vfs.write` 时若调用方提供了封面 Blob 就存进记录；没有的（同步下载来的文件）在文稿库第一次显示它时从 zip 里取出 `cover.png` 并回填。记录的 `rev` 变化时缓存作废。

### 7.9 自动保存与“文件被别人写了”

照 `A:AppModel.swift` 的 `EditorSession`（比 `B:window.py:1374-1505` 清晰）：

- 文档每次发出 `state`/`pages`/`meta` 且 `modified` 为真：重置 1.5 s 的保存定时器，并通知同步调度器“有编辑”。
- 保存：正在进行操作（`canvas.op` 非空）或上一次保存未完成时推迟。否则：若文件签名与本编辑器记录的不同且没有进行中的操作 → 先 `absorb()`；`snap = await doc.snapshot()`；带 `expect` 写入。
- 写入时发现签名不符（`Changed`）：什么都没写；`refused += 1`；重新排一次保存。连续 3 次后不再带 `expect`，强行写入。
- `absorb()`：重新读文件。编辑器有未保存修改 → `merge(当前文档, 读到的文档)` 并重新排保存；没有 → 直接换成读到的文档，保持视图位置。
- 同步结束后的 `followOpenNotebook`（`A:AppModel.swift`）：正在写就 0.4 s 后再看；文件不在原路径 → 按笔记 id 在库里找（被别的设备改名/移动），找不到说明被别的设备删了 → 关闭编辑器回文稿库并提示“已删除”；签名变了 → `absorb()`。

### 7.10 同步调度

`sync/scheduler.js`，合并 `B:window.py:128-174, 1605-1676` 与 `A:AppModel.swift`：

| 时机 | 范围 | 彻底？ | 静默？ |
| --- | --- | --- | --- |
| 启动后 2 s | 整库 | 是（本次运行的第一次） | 是 |
| 点“立即同步” | 整库 | 是 | 否 |
| 回到文稿库 | 整库 | 否 | 是 |
| 文稿库界面每 600 s（页面可见时） | 整库 | 否 | 是 |
| 页面重新可见且距上次同步 > 120 s | 整库 | 否 | 是 |
| 页面变为不可见 | 整库 | 否 | 是 |
| 打开一本笔记 | 仅这一本 | 否 | 是 |
| 停笔后：`max(6 s, 上次同步完成时刻 + 4 × 上次耗时 − 现在)`，到点时若正在写或正在同步就重排 | 仅这一本 | 否 | 是 |
| 编辑器里每 `sync_every` 秒（5–300，默认 30），前提：页面可见、没有待触发的停笔同步、没有同步在跑 | 仅这一本 | 否 | 是 |

- “否”表示传 `thorough = null`，由 `sync()` 自己决定（没有索引 id 或距上次彻底同步超过 6 小时则彻底；快速同步遇到 404 自动改彻底重跑一次，`B:gdrive.py:660-668`）。
- 同步进行中又有请求：记下来，结束后再跑一次；整库请求压过单本请求，非静默压过静默（`B:window.py:1610-1614`）。
- 同步开始前：若编辑器开着且没有进行中的操作，先保存。
- 同步结束后：重新加载 `library` 元数据；不在编辑器里就刷新文稿库；调用 `followOpenNotebook`。

### 7.11 图片

`platform/image.js`：
- `toPng(blob, limit = 2000) → {png: Blob, w, h}`：解码（按 EXIF 摆正）、最长边超限时等比缩小、编码为 PNG。Goodnotes 导入用 `limit = 2400`。
- 图片元素持有 `{data: Blob, bitmap: ImageBitmap|null}`。加载文档时不等解码；`bitmap` 就绪后对该元素的包围盒发一次 `dirty`。
- 旋转（`B:model.py:427-439`）要重新编码 PNG，是异步的。因此“旋转选区”和“旋转页面”是 `async` 函数：先 `await` 所有图片转好，再同步地执行一次 `doc.do(...)`，保证撤销栈上是一步。
- 同一份图片数据在保存时只写一次：按对象身份去重（`_SaveCtx`，`B:model.py:957`）；加载时按 `[大小, CRC]` 加内容去重。

### 7.12 多语言与图标

- `tr(text)`：语言为 `zh` 返回原文；否则查表，查不到返回原文。`trf(text, ...args)` 处理 `%d` `%s`。
- 词表：`A:Resources/en.json`、`ja.json`，再合并 `A:L10n.swift` 的 `extraEN`、`extraJA`。网页版新增的文案（OAuth 配置说明等）自己补三语。
- 语言选择：设置里的 `language`（`auto/zh/en/ja`）；`auto` 时看 `navigator.language` 前缀。切换语言后整页重建界面（B 是重建窗口）。
- 日期格式串在词表里是 `strftime` 形式（如 `%Y年%-m月%-d日 %H:%M`、`%b %-d, %Y %H:%M`），写一个只支持 `%Y %m %-m %d %-d %H %M %b` 的小函数。
- 图标：`icons.json` 的 `icons[名字] = {els, fill}`，`els` 的每项是路径字符串或 `['rect', x, y, w, h, r]` / `['circle', cx, cy, r]`。生成 `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`；`fill: true` 的图标另加 `fill="currentColor"`。`glyphs` 是 24 个文件夹图标。
- 程序化图标（`B:icons.py:312-459`）：`weight(宽)`、`dot(半径)`、`letter(比例)`、`line_style(0|1|2)`、`swatch(颜色, 是否带小箭头)`、`wheel`（色轮）、文件夹图（`B:library.py:37-82` 的 `folder_texture`）。这些画在 20×20 的坐标系里，同样生成 SVG。

---

## 8. 功能清单

实现时逐项打勾。每项后面是参考位置。

### 8.1 文稿库

- [ ] 左侧栏：品牌字样 “Inkpad”；文稿 / 收藏 / 废纸篓；点已选中的“文稿”回到根目录（`B:library.py:592-606`）
- [ ] 顶栏：搜索框（搜索时遍历全库，`Store.find`）、云按钮（同步中换成转动的图标并变强调色）、设置按钮
- [ ] 路径条（进入子文件夹后显示，每一级可点）、返回上一级按钮、大标题
- [ ] “新建”菜单：笔记本、白板、导入 PDF 或 Goodnotes…、导入整个文件夹…、导入存档（.zip）…、文件夹
- [ ] 排序：日期（新的在前）/ 名称（文件夹在前）；记住选择（`sort`）
- [ ] 网格单元：封面（150×200 内等比）或文件夹图（150×118，颜色 + 图标）、收藏星标、名称（点开菜单）、修改时间
- [ ] 单元菜单（`B:library.py:984-1002`）：重命名；文件夹另有自定义颜色（8 色）、设置图标（24 个 + 无）、导出文件夹…；移动到…；收藏/取消收藏；移到废纸篓。废纸篓里：恢复、永久删除
- [ ] 笔记本单击打开；文件夹**双击**打开，单击只高亮（`_activate`，`B:library.py:1240`）
- [ ] 记住上次所在文件夹（`last_folder`）
- [ ] 拖动移动：把项目拖到文件夹、路径条的任一级、返回按钮上；拖多选中的一个会带上全部（`B:library.py:890-934`）。用指针事件实现：按住移动超过 8 像素开始拖，跟手显示封面缩影，经过可放置目标时高亮
- [ ] 移动可撤销/重做：提示条上的“撤销”、`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`、空白处右键或长按菜单；最多 50 步（`move_items` `_replay`）
- [ ] “移动到…”对话框：可折叠的文件夹树，默认只展开第一层，不预选；不能移进自己（`_pick_folder`，`B:library.py:1110`）
- [ ] 多选模式：全选、计数、批量导出/复制/移动/移到废纸篓；废纸篓里是恢复/永久删除；鼠标可拖出选框（`_band_*`，`B:library.py:1196`）
- [ ] 清空废纸篓（带确认）
- [ ] 空状态文案（`B:library.py:813-819`）
- [ ] 新建笔记本对话框：标题、封面（无 + 5 种样式 × 8 色）、尺寸（A4/A5/A3/B5/Letter）、纸色（3 种）、方向、13 种模板分四组、左侧大预览；记住上次用的模板（`B:dialogs.py:132-309`）
- [ ] 新建白板对话框：标题、纸色、背景（空白/点阵/窄行距/方格）
- [ ] 导入：PDF → 新笔记本；`.goodnotes` → 新笔记本并提示统计；整个文件夹（保留目录结构，带进度，结束后列出失败项，`import_tree`）；存档 zip；把文件拖进窗口等同于导入
- [ ] 导出：单个文件夹 / 所选项目 / 整个文稿库为存档 zip；单本笔记的 `.inkpad` 文件（下载）
- [ ] 云菜单（`_cloud_popover`，`B:window.py:1728`）：未连接时的说明与“连接 Google Drive…”；已连接时的状态行（正在同步 / 上次同步失败：… / 上次同步：时间 / 已连接，尚未同步）、同步中显示当前文件名（固定两行）+ 进度条 + 百分比、“立即同步”、“断开连接”

### 8.2 画布与工具

- [ ] 纸张 13 种 × 纸色 3 种；深色纸上荧光笔不用正片叠底（`ink_on`，`B:model.py:746`）
- [ ] 笔：钢笔 / 圆珠笔 / 画笔；压感；实线 / 虚线 / 点线；稳定器；最小点距 `0.4 / zoom`
- [ ] 长按吸附成规则形状：停住 600 ms 且移动不超过 5 像素 → 识别为直线 / 矩形 / 椭圆；荧光笔和胶带只吸附成直线（`_held`，`B:canvas.py:2205`）
- [ ] 涂抹擦除：抬笔时若笔画像来回涂抹且盖住了内容，记成两步（先加这一笔，再删目标和这一笔）（`_up`，`B:canvas.py:2291-2302`）
- [ ] 荧光笔；胶带（画过遮住内容，手指或鼠标点一下掀开/盖回，掀开后只剩 16% 的痕迹）
- [ ] 橡皮擦：标准（切掉碰到的部分，其余成为更短的笔画）/ 笔画（整条）；三档大小；筛选（笔 / 荧光笔 / 形状）；箭头和“笔画模式”按整体命中；擦完自动回到上一个工具（可选）；清除页面（`_erase`，`B:canvas.py:2382`）
- [ ] 形状：直线 / 箭头 / 矩形 / 椭圆
- [ ] 文本：点击页面出输入框；点已有文本框则编辑；清空即删除；三档字号；折行宽度规则见 §10
- [ ] 便签：四种颜色，折角
- [ ] 套索：自由 / 长方形；筛选（手写 / 图像 / 形状 / 文本框）；很小的套索（屏幕上不足 8 像素）等同点选；点选最上面的图片、形状或文本框（不选笔画）
- [ ] 选区：拖动移动；右下角手柄或按住边缘等比缩放（以对角为原点）；选区条（颜色、剪切、拷贝、复制、删除、更多：向左/向右旋转、移到最前/最后、粘贴、截图到剪贴板、存为图片…）；选区条放在选区上方，放不下就放下方（`_place_selbar`，`B:window.py:401`）
- [ ] 拷贝/粘贴：粘贴落在原位偏移 (14, 14)，或落在长按/指定的位置；应用内剪贴板没有内容时粘贴系统剪贴板里的图片
- [ ] 激光笔：光点（跟随）/ 轨迹（最后一笔后停 1 s，再用 350 ms 淡出）；三种颜色；四层叠画的发光效果（`_draw_laser`，`B:canvas.py:1806`）
- [ ] 插入图片：放在可见区域中央，不超过页面的 60%，随后切到套索并选中它
- [ ] 尺子：手指或鼠标拖动；双指或滚轮旋转；接近 45° 的倍数（1.5° 内）时吸附；笔在边缘 18 像素内起笔则沿边画直线；刻度随缩放，标注厘米与角度（`B:canvas.py:701-785`）
- [ ] 视图：上下滚动 / 左右翻页（每页占一个视口宽，松手居中，拖得够远或够快翻页，放大后在页内移动、需用力拉过边缘才翻页）；首尾页继续拉动可新建一页
- [ ] 缩放：捏合、Ctrl+滚轮、`Ctrl +/−/0`；范围 0.2（白板 0.04）到“最大放大倍数”
- [ ] 自绘滚动条：只显示位置，只有鼠标能拖滑块；左右翻页时横条只表示当前页
- [ ] 白板：无边界；小地图（内容块 + 视口框，点/拖跳转，显示缩放百分比并可点回 100%，“显示全部内容”）
- [ ] 重新打开笔记本回到上次的位置和缩放
- [ ] 笔悬停标记；鼠标光标随工具变化（十字 / 文本 / 橡皮；关闭“显示十字光标”时是小圆点）
- [ ] 防误触：`palm_ms` 内忽略手指；笔落下时撤销手掌造成的移动

### 8.3 编辑器外壳

- [ ] 标题栏（蓝色）：文稿库、标题按钮（重命名… / 更改封面… / 导入 PDF 页面… / 立即保存）、侧栏开关、查找；中间工具组（9 个工具 + 插入图片 + 尺子）；右侧添加页面、导出、更多
- [ ] 再点一次已选中的工具：隐藏/显示选项条
- [ ] 选项条内容按工具变化（`_rebuild_options`，`B:window.py:701-758`）
- [ ] 笔面板：三种笔、线型、笔尖大小（百分比 ↔ 宽度，并显示毫米）、压力灵敏度、稳定性、预览、长按成形开关、涂抹擦除开关、恢复默认（`_pen_popover`）
- [ ] 粗细预设：三档，点已选中的那档弹出滑块调整（笔 0.3–8.0，荧光笔 3–40）
- [ ] 颜色槽：点选；点已选中的弹出调色板（15 色 + 自定义颜色 + 删除此颜色）；最多 9 个，“+” 添加
- [ ] 添加页面面板：在此之前 / 在此之后 / 最后一页；当前模板；更多模板…；图像…；导入 PDF…
- [ ] 页面面板（“更多”）：第 N / M 页、前往…；八个磁贴（书签、大纲、模板、加页、拷贝、复制、左转、右转，有页面剪贴板时加“粘贴”）；缩小 / 适合宽度 / 放大；开关（涂画以擦除、用手指书写、全屏模式）；设置…、关于、清除页面、删除页面。执行动作后面板不关闭并刷新内容（`_page_panel`，`B:window.py:1076-1173`）
- [ ] 页面操作：加页、拷贝/粘贴页面、复制、旋转 90°/180°（内容一起转）、清除、删除（删到最后一页时补一张同样的空白页）、更换模板（PDF 页不可换）
- [ ] 侧栏（300 px）：缩略图两列（当前页高亮、书签角标、每页的操作菜单、末尾“添加页面”）、大纲、书签；缩略图在侧栏可见时才渲染，每 350 ms 最多 12 张
- [ ] 在笔记中查找：查文本框、便签和 PDF 文字；计数 “i / n”；上一个 / 下一个；当前命中居中并用橙色、其余黄色
- [ ] 状态条：“页 / 总页数 · 缩放%”（白板不显示）
- [ ] 撤销/重做（300 步）
- [ ] 导出菜单：矢量 PDF（页面范围如 `1-3,5`；笔迹和背景 / 仅笔迹 / 仅背景）；当前页 PNG；全部页面 PNG（同样可选范围与内容）；Goodnotes（实验性）；`.inkpad` 文件
- [ ] 快捷键（`_key`，`B:window.py:2001`；`Ctrl` 与 `⌘` 等价）：`Z` 撤销、`Shift+Z` / `Y` 重做、`C` 拷贝、`V` 粘贴、`S` 保存、`E` 导出 PDF、`F` 查找、`G` 前往页面、`+ = −` 缩放、`0` 适合宽度；不带修饰键：`← → PageUp PageDown` 翻页（焦点在输入框时不处理）、`Delete` / `Backspace` 删除选区、`Esc` 取消操作并清除选区、`F11` 全屏
- [ ] 提示条与错误对话框

### 8.4 设置与储存空间

- [ ] 外观（跟随系统 / 浅色 / 深色；页面本身始终保持纸张颜色）、语言
- [ ] 书写：涂画以擦除、长按绘制规则形状、用手指书写、显示十字光标、有手写笔时鼠标不书写、翻页方向、显示滚动条、最大放大倍数（600% / 1000% / 2000% / 4000%）
- [ ] Google Drive：说明、客户端 ID、客户端密钥、保存凭据、从 JSON 导入、导出为 JSON、当前同步文件夹（可在浏览器打开）、“如何把笔记放到云端硬盘的其它位置”（折叠，内含文件夹 ID 输入框；更改时弹确认）、打开的笔记本多久同步一次（5 秒–5 分钟）、状态、连接/断开、立即同步
- [ ] 存储：用量与配额、导出整个文稿库…、导入存档（.zip）…、管理储存空间…
- [ ] 导出：导出 PDF 的字体（显示当前字体名；选择字体文件… / 从系统字体中选择…（浏览器支持时）/ 清除）——网页版新增，见 §7.5
- [ ] 工具栏：除“笔”外每个工具一个开关（含插入图片、尺子）
- [ ] 高级：防误触时间（0–1000 ms，步长 10）、记录输入日志（存在 `kv['input_log']`，提供“下载日志”和“清空”）
- [ ] 管理储存空间：本机已删除的笔记（大小合计、逐项恢复到原文件夹、清理缓存并确认）；云端保留的已删除笔记（读取云端目录 → 勾选 → 下载所选）（`B:prefs.py:40-190`，`cloud_deleted` `cloud_restore`）

### 8.5 明确不移植（平台专属）

| 项目 | 来源 | 原因 |
| --- | --- | --- |
| 更改文稿库位置、打开文稿库文件夹、凭据保存位置的显示 | `B:migrate.py`、`B:prefs.py` | 网页没有可见的文件系统 |
| 全屏丢笔画的规避、“轻推”合成器 | `B:canvas.py:821-963` | 针对特定硬件 |
| 安装脚本、桌面入口、命令行打开文件 | `B:install.sh` 等 | 桌面专属 |
| Apple Pencil 双击切换橡皮擦、Pencil Pro 捏合工具盘 | `A:PencilPalette.swift` 等 | 浏览器收不到这些事件 |
| 主屏幕图标快捷操作、最近打开列表 | `A:Shortcuts.swift` | iOS 专属 |
| 系统编辑菜单、分享面板、后台任务、钥匙串 | A | 有对应的网页做法，见 §5 |
| 续签与安装工具 | `A:tools/*.sh` | iOS 专属 |

---

## 9. 界面复刻规格

设计来源是 `B:style.css`；颜色的具体数值取自 `A:UI/Theme.swift`。

### 9.1 颜色变量（`css/tokens.css`）

| 变量 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--header` | `#37629f` | 同 | 编辑器标题栏 |
| `--header-ink` | `#2b5290` | 同 | 标题栏上被选中按钮（白底）的图标色 |
| `--accent` | `#3584e4` | 同 | 强调色（选中框、主按钮） |
| `--accent-text` | `#0461be` | `#81d0ff` | 强调色文字 |
| `--danger` | `#c30000` | `#ff938c` | 危险操作 |
| `--star-on` | `#e8563f` | 同 | 已收藏 |
| `--mark` | `#e5484d` | 同 | 书签角标 |
| `--view-bg` | `#ffffff` | `#1d1d20` | 文稿库背景 |
| `--window-bg` | `#fafafb` | `#222226` | 对话框背景 |
| `--sidebar-bg` | `#ebebed` | `#2e2e32` | 侧栏 |
| `--popover-bg` | `#ffffff` | `#36363a` | 弹出框、浮动条 |
| `--card-bg` | `#ffffff` | `#3f3f44` | 选中的大按钮 |
| `--canvas-bg` | `#e1e1e2` | `#1f1f22` | 画布底色 |
| 选区/套索/小地图视口 | `rgb(54, 133, 227)` | 同 | 即 B 的 `_ACCENT (0.21, 0.52, 0.89)` |
| 页面阴影 | `0 2px 10px rgba(0,0,0,.16)` | 同 | |
| 查找高亮 | 其余 `rgba(255,217,26,.35)`，当前 `rgba(255,128,0,.5)` | 同 | |

GTK CSS 到网页 CSS 的换写：`alpha(X, a)` → `color-mix(in srgb, X calc(a*100%), transparent)`；`alpha(currentColor, a)` 同理；`@accent_bg_color` → `var(--accent)`；`shade(c, 0.9)` 已预先算好。

### 9.2 编辑器

- 标题栏高 46 px，底部 1 px `rgba(0,0,0,.18)`。按钮圆角 10，悬停白 13%，按下白 22%，禁用时白 45%。
- 工具组：背景白 10%，圆角 13，内边距 3，按钮间距 3；工具按钮 38×34；选中：白底、`--header-ink`、阴影 `0 1px 3px rgba(0,0,0,.25)`。
- 标题按钮：字重 600，字号 1.04em，最多 22 个字符后省略；右侧小箭头。分隔线：白 28%，上下各留 12。
- 浮动条（`.pill`）：`--popover-bg`，圆角 18，内边距 `5px 7px`，阴影 `0 6px 20px rgba(0,0,0,.10), 0 1px 3px rgba(0,0,0,.12), 0 0 0 1px rgba(0,0,0,.05)`；按钮 36×36 圆角 12，选中 `currentColor` 11%；色块按钮 34×34 圆形；下拉按钮底色强调色 16%；分隔线 `currentColor` 14%。
- 位置：撤销条左上（左、上各 10）；选项条顶部居中（上 10）；查找条右上（上 62，右 12）；状态条左下（外边距 14，圆角 999，内边距 `5px 14px`，等宽数字）；小地图左下（14），216×150，圆角 16。
- 侧栏宽 300；缩略图宽 124、最高 200；选中缩略图：`0 0 0 2px var(--accent), 0 2px 8px` 强调色 30%。
- 选区框：虚线 `[5, 4]`、线宽 1.5，向外扩 4 px；右下角手柄：半径 6 的白圆、2 px 强调色描边。
- 弹出框圆角 16；面板内边距 `12px 14px`、元素间距 8、标题字重加粗；大选择按钮（`.choice`）圆角 12，选中 `--card-bg` 加细边与阴影；磁贴（`.tile`）圆角 12、底色 `currentColor` 5%；菜单行内边距 `8px 12px`、圆角 9。
- 弹出框里的滑块手柄至少 24×24，滚动条滑块至少宽 10、高 48（给手指用）。

### 9.3 文稿库

- 左栏宽 250，内边距 `10px 14px`，背景 `linear-gradient(170deg, 掺 5% 强调色的侧栏色, 侧栏色 60%)`，右边线 `currentColor` 7%。品牌字 1.7em / 700 / 字距 −0.6，外边距 `22px 12px 26px`。导航行圆角 999，内边距 `11px 18px`，字号 1.12em，选中 `currentColor` 10% + 字重 600。
- 顶栏高 52；搜索框宽 220、圆角 999。
- 大标题 2.5em / 800 / 字距 −0.8。“新建”按钮圆角 999、内边距 `7px 18px`、字重 600、强调色底。
- 网格：左右外边距 26，列距 22，行距 26；单元宽 186、圆角 16、内边距 `14px 4px 10px`；悬停 `currentColor` 4%；选中强调色 18% 底 + 2 px 强调色 75% 内描边；可放置目标：强调色 28% 底 + 2 px 强调色内描边。
- 封面：白底、圆角 5、阴影 `0 0 0 1px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.10), 0 8px 20px rgba(0,0,0,.14)`。文件夹图：`drop-shadow(0 4px 8px rgba(0,0,0,.14))`。
- 星标：圆形小按钮，未收藏 `currentColor` 38%，已收藏 `--star-on`。

### 9.4 对话框尺寸

纸张样式 660×600（带标题栏的新建版 820×600，左栏 250）；设置 620×680；管理储存空间 600×640；模板预览格 96×128，大预览 150×200；封面选项 36×48。

### 9.5 窄屏（视口宽 < 700 px），来自 A 的 `compact` 分支

- 编辑器标题栏变两行：第二行（高 44）是可横向滚动的工具组；标题按钮最宽 130；侧栏宽 250。
- 文稿库：左栏隐藏，顶栏左端换成“文稿 / 收藏 / 废纸篓”下拉；搜索框占满剩余宽度；大标题 26 px；网格左右外边距 10，两列。
- 纸张对话框：左栏内容挪到上方，纵向排列。
- 笔面板：两栏改为上下（B 在窗口宽 < 760 时也这样做）。
- 默认开启“用手指书写”的条件：设备没有笔且是触屏（`matchMedia('(pointer: coarse)')` 为真且从未见过 `pointerType === 'pen'`），仅在首次运行时设置。

---

## 10. 常量表

全部照抄。括号里是来源。

**布局与缩放**（`B:canvas.py:23-31`）：`TOP 64`，`GAP 14`，`SIDE 24`，`BOTTOM 48`；`MAX_PIXELS 12 000 000`；`MIN_ZOOM 0.2`；`BOARD_MIN_ZOOM 0.04`；`max_zoom` 默认 6.0（下限 2.0）；初始缩放 = 适合宽度（左右翻页时同时适合高度），上限 1.35，白板为 1.0；缩放定稿延迟 160 ms；`BG_KEEP 8`；窗口化缓存四周余量 40%，对齐 256；翻页动画 280 ms、三次缓出。

**书写**：最小点距 `0.4 / zoom`；稳定器 `k = 1 − 0.9 × stab`；长按成形 600 ms，移动阈值 5 px（平方 25）；长按菜单 550 ms，移动阈值 10 px；笔压力夹在 `[0.02, 1]`，无压力时 0.5；鼠标压力见 §7.2；`PEN_SENS_DIVISOR 50`。

**笔画宽度**（`B:model.py:119-124`）：钢笔 `w × max(0.15, 1 + sens × 1.2 × (p − 0.5))`；画笔 `w × max(0.12, 1.4 + sens × 2.2 × (p − 0.5))`；其余 `w`。包围盒外扩 `w_at(1.0) / 2 + 1`。

**线型**（`B:model.py:172`）：虚线 实 `max(3w, 2.5)` 空 `max(2.6w, 3.0)`；点线 实 0 空 `max(2.4w, 2.5)`。

**透明度**：荧光笔 0.4；掀开的胶带 0.16；深色纸判定 `0.299r + 0.587g + 0.114b < 0.45` 且无 PDF 背景。

**形状**：箭头头长 `max(8, 4w)`，两翼与轴线夹角 ±2.6 弧度（从箭头尖端起算）；形状小于 2 点不创建。

**形状识别**（`B:geom.py:299-333`）：点数 ≥ 6，长度 ≥ 8；弦长 > 0.88 × 长度 → 直线；弦长 > 0.25 × 长度 → 不识别；短边 < 4 → 不识别；矩形误差 < 0.07 且小于椭圆误差 → 矩形；椭圆误差 < 0.16 → 椭圆。

**涂抹判定**（`B:geom.py:96-150`）：点数 ≥ 10；主轴跨度 ≥ 5；长度 ≥ 2.5 × 跨度；滞回 `max(0.15 × 跨度, 1.5)`；折返 ≥ 3 次。目标：覆盖率 ≥ 0.35，或 ≥ 0.08 且交叉 ≥ 4 次。

**橡皮**：半径 `[4, 9, 18]`（页面点）；整笔命中检测步长 `r × 0.7`；局部擦除重采样步长 `max(0.4r, 0.3)`；切割半径 `r + 笔画宽度 / 2`。

**文本**：字号 `[12, 18, 28]`；折行宽度：白板 400，否则 `max(60, 页宽 − x − 12)`；便签：字号 13，文字色 `(0.16, 0.15, 0.12)`，折行 170，折角 `min(0.9 × size, 宽/4, 高/4)`，折角色为底色 × 0.86。

**选区**：抓取范围 7 px（触摸 22）；手柄命中 13 px；触摸拖动起始死区 8 px；移动判定 `|s − 1| > 0.001` 或位移 × zoom > 1；复制与粘贴偏移 (14, 14)；点选半径 `10 / zoom`；胶带点击半径 `2 / zoom`；选区截图外扩 6，倍率 2（剪贴板）/ 3（存文件）。

**触摸**：死区 8 px；捏合起效间距 12 px；手掌回退窗口 350 ms，视图记录间隔 40 ms；惯性：起始速度 ≥ 250 px/s（取最后 90 ms 的轨迹，松手前 60 ms 内仍在移动），衰减 `exp(−4 dt)`，低于 30 px/s 停止；翻页：位移 > 0.18 × 视口宽 或 速度 > 400 px/s；放大后越过边缘 > `max(110, 0.22 × 视口宽)` 才翻页，越界阻尼 0.4；拉出新页 280 px（触摸 90）。

**滚轮**：缩放 `1.1^(−dy)`；键盘缩放 1.2；非平滑滚轮每格 60 px（白板 48）；左右翻页：触控板累计 ≥ 24 翻一页、静止 180 ms 后才算下一次；滚轮累计 ≥ 0.99 格且距上次翻页 ≥ 220 ms。

**尺子**（`B:canvas.py:38-39, 706-744`）：半宽 46 px；吸附距离 18 px；半长 `max(260, 0.42 × max(宽, 高))`；45° 吸附容差 1.5°；主体色 `rgba(230, 235, 242, .66)`，刻度色 `rgba(56, 64, 82, .9)`。

**激光笔**：停留 1000 ms，淡出 350 ms；轨迹四层：宽 13（色 16%）、7（45%）、3.6（100%）、1.3（白 90%）；光点四层半径 15（14%）、10（30%）、6（100%）、2.4（白 90%）。

**滚动条**：滑块最短 40，轨道 = 视口 − 16，粗 5（拖动时 8），色 `rgba(140, 140, 148, .75)`。

**工具预设**（`B:window.py:23-39`，`B:settings.py:13-58`）：
- 笔的三档宽度：钢笔 `[0.9, 1.6, 2.8]`，圆珠笔 `[0.7, 1.2, 2.0]`，画笔 `[1.4, 2.4, 3.8]`；默认第 2 档，`sens 50`，`stab 0`，`dash 0`
- 笔颜色槽 6 个，默认第 5 个（黑）；荧光笔颜色槽 5 个，宽度 `[8, 14, 22]`
- 胶带宽 `[10, 16, 26]`、5 色；便签 4 色；激光 3 色
- 调色板 15 色；笔尖滑块 `宽度 = 0.3 + 百分比 × 0.047`，毫米 = 宽度 × 0.3528
- 其余默认值全部见 `B:settings.py` 的 `DEFAULTS`，键名照用

**纸张与封面**：尺寸 A4 595×842、A5 420×595、A3 842×1191、B5 499×709、Letter 612×792；纸色 白 `(1, 1, 1)`、黄 `(0.976, 0.965, 0.902)`、深 `(0.13, 0.13, 0.15)`；封面 8 色、文件夹 8 色见 `B:model.py:34` 与 `B:library.py:32`；封面渲染 225×300；无封面设计时取第一页，最长边 300 px（白板为 300×400 居中）。

**导出**：PDF 页面边长上限 14 400 点；PNG 倍率 3，最长边上限 12 000 px；图片导入上限 2000 px（Goodnotes 2400）；Goodnotes `FALLBACK_SCALE 6/11`，`PEN_WIDTH 1.42`。

**其它**：撤销 300 步；墓碑上限 20 000；视图记忆 300 本；文稿库移动撤销 50 步；提示条 3 s（带按钮 5 s）；侧栏缩略图 350 ms 一批、每批 12 张；小地图网格 64×44，350 ms 节流；白板空内容时的默认区域 800×600，内容区外扩 80、最小 400×300。

---

## 11. 性能要点

| 场景 | 要求 | 做法 |
| --- | --- | --- |
| 首屏 | 自有代码 ≤ 200 KB gzip；冷启动到文稿库可操作 < 1 s | pdf.js、pdf-lib、Goodnotes 模块、设置对话框按需 `import()` |
| 书写 | 落笔到出墨不丢帧 | 叠加画布用 `getContext('2d', {desynchronized: true})`；只画新增线段；`pointermove` 里不做 DOM 操作、不分配大对象 |
| 滚动/缩放 | 60 帧 | 每帧只做 `drawImage`；缩放期间不重建缓存；所有重绘合并到一次 `requestAnimationFrame` |
| 擦除 | 跟手 | 只重画受影响的矩形；先用包围盒筛选元素 |
| 大页面/高倍缩放 | 不爆内存 | `MAX_PIXELS` 窗口化；总缓存像素设上限（桌面约 4800 万、移动约 2400 万），超出时释放最远的页 |
| 大 PDF 笔记 | 打开时间与 PDF 大小无关 | 只读 zip 中央目录和 JSON 条目；PDF 懒打开；背景渲染走队列并可作废 |
| 保存 | 写一笔不重写整本 | 未变页面复用已序列化的 JSON；PDF/图片条目从旧文件按字节范围原样拷贝（`blob.slice`） |
| 同步 | 没变化时只发一个请求 | 快速同步完全信任索引与本机记录；未写过的笔记不打开、不算摘要（`B:gdrive.py:768-823`） |
| 文稿库 | 上千本笔记流畅 | 封面懒加载（进入视口才取），按 `path + rev` 缓存 `ObjectURL`，离开时 `revokeObjectURL` |
| 侧栏 | 不拖慢书写 | 仅可见时渲染，350 ms 一批 |
| 哈希/压缩 | 不卡界面 | 超过 1 MB 的放 Worker |

---

## 12. 风险点

按严重程度排序。每条给出对策和验证方法。

**R1 浏览器里的 Google OAuth（高）**
- 问题一：B 的说明要求各设备用同一组客户端 ID 和密钥。本方案假设“同一个 Cloud 项目下的不同客户端 ID 对 `drive.file` 创建的文件互相可见”，从而让公网部署的网页版用一个新的“Web 应用”客户端。这个假设未实测。
- 问题二：假设 `oauth2.googleapis.com/token` 允许跨域请求，且可续传上传的 `Location` 响应头可读。未实测。
- 问题三：客户端密钥存在浏览器里。它本来就是用户自己的密钥，但任何跨站脚本都能读走它和刷新令牌。
- 问题四：“桌面应用”客户端的环回回跳是否接受带路径的地址（`http://127.0.0.1:端口/oauth.html`）未实测。不接受时把回跳地址改为站点根路径，由 `index.html` 自己识别 `?code=`。
- 对策：M0 试验 1 验证前两点和第四点（公网与环回两种部署各做一次）。问题一不成立时：GitHub Pages 上的网页版将看不到桌面版和 iOS 版创建的文件，只能在网页版之间同步；此时停下来报告，由用户决定是否改同步方案，不要自行处理。问题二不成立时：改用 Google Identity Services 的令牌模式（只有 1 小时的访问令牌，过期后需用户点一下重新授权），GitHub Pages 没有服务器端，不能做令牌转发。问题三：严格的 `Content-Security-Policy`（`script-src 'self'`，`connect-src` 只放行 Google 的三个域名），不加载任何第三方脚本。
- 另：OAuth 同意屏幕处于“测试”状态时刷新令牌 7 天失效，在设置说明里保留 A 的 README 中那句提示。

**R2 矢量 PDF 导出（高）**
- 问题一：依赖 pdf-lib 嵌入原 PDF 页面；加密或结构异常的 PDF 可能嵌入失败。Goodnotes 导出依赖它。对策：§7.5 的退路（该页以图片嵌入并提示）。
- 问题二：矢量文字依赖用户选的字体。pdf-lib 的子集嵌入对部分字体（尤其是某些 CFF 轮廓的 `.otf`）可能产生错字或空白；字体集（`.ttc`）和可变字体不支持；中日文字体若不做子集会让导出文件增大十几 MB。对策：M0 试验 3 用 `.ttf` 和 `.otf` 各验证一次；子集结果有问题的字体，改用 `subset: false` 再试并在提示里说明文件会变大；缺字按 §7.5 明确提示。
- 问题三：字体文件有各自的授权条款，嵌入 PDF 是否被允许由用户负责；在选字体的对话框里写一句提示。

**R3 白板大坐标的浮点精度（高）**
- 问题：白板内容在 5×10⁷ 附近，浏览器的 2D 变换矩阵内部是单精度，直接 `translate(-5e7 × 缩放)` 会让笔画抖动、错位。B 和 A 的图形库是双精度，所以参考代码里没有这个处理。
- 对策：§0 规则 7 与 §7.1 的精度规则。验证：M3 的白板对照页。

**R4 输入的跨浏览器差异（高）**
- 问题：笔按下时手掌产生的触摸事件、iPad Safari 的系统手势与文字选择气泡、Windows 上笔长按触发右键、`getCoalescedEvents` 与 `getPredictedEvents` 并非处处可用、触控板捏合在各浏览器事件不同。
- 对策：§7.2 列出的页面级设置；所有可选接口都先检测；保留“输入日志”功能用于排查。验证：至少在 Chrome（Windows 或 ChromeOS 带笔设备）、iPad Safari（Apple Pencil）、Android Chrome、桌面 Firefox 上各走一遍 §8.2。

**R5 大笔记的内存（中高）**
- 问题：任何一处对整本笔记调用 `arrayBuffer()` 都会在手机上崩溃。
- 对策：§0 规则 6；zip 读写、瘦身、复原、哈希、上传全部基于切片与流。验证：用含 200 MB PDF 的笔记走一遍打开、写一笔、保存、同步，观察内存。

**R6 浏览器清除本地数据（中高）**
- 问题：Safari 对 7 天未访问的网站可能清空存储；无痕模式下存储是临时的；配额不足时写入失败。
- 对策：启动时申请持久化；未连接同步时在文稿库显示一次性提示，建议连接同步或定期导出存档；写入失败时弹出明确的错误而不是静默丢失。（安装为 PWA 可免于清除，属于后续阶段。）

**R7 异步化带来的竞态（中高）**
- 问题：B 的同步在线程里顺序执行，靠一把锁与编辑器互斥。JS 里每个 `await` 都是别人插队的机会。
- 对策：§7.8 的锁纪律；“比较签名并替换”必须在同一个 IndexedDB 事务里完成。验证：移植 `SyncTests` 的 `testOverlappingSyncsLoseNothing`、`testSaveAfterTheFileChanged`、`testSyncOfOneNotebook`、`testSkippedNotebookIsLeftAlone`。

**R8 时间单位与时钟（中）**
- 问题：`mt`、`ts` 用毫秒会破坏与其它设备的合并；`performance.now()` 是毫秒而 B 的阈值是微秒。
- 对策：§0 规则 5；封装 `now()`（秒）和 `mono()`（毫秒）两个函数，全项目只用它们。

**R9 画布内存上限（中）**
- 问题：iOS Safari 单个画布约 1670 万像素上限，画布总内存也有限；超出时画布静默变空白。
- 对策：`MAX_PIXELS` 已低于单画布上限；总缓存设上限；释放时把宽高置 0；创建画布后检查 `getContext` 是否成功，失败时降低缓存倍率重试。

**R10 zip 兼容（中）**
- 见 §6.1 的读取规则。验证：M1 用 B 实际同步下载过的文件（经 `_fatten` 写出，含 zip64 本地头）做测试样本。

**R11 旧文件的元素 id（低）**
- 问题：v3 之前的文件元素没有 id，B 用 `md5(页面id/序号/json.dumps(元素, sort_keys=True))` 推导。要与 B 得到相同的 id，需要复现 Python 的 JSON 格式（键排序、`", "` 与 `": "` 分隔、浮点写法如 `1.0`、非 ASCII 转义为 `\uXXXX`）。
- 对策：实现一个 `pyJsonDumps`，覆盖上述规则；写不准时退回随机 id（A 的做法）。影响仅限于“两台设备各自打开同一个旧文件并分别修改后再合并”这种少见情形。

**R12 pdf.js 体积与行为（中）**
- 问题：主库加 Worker 约 1.5 MB（未压缩更大），外加 cMap 与标准字体；页面自带旋转、`UserUnit`；渲染大页占主线程。
- 对策：懒加载；页面尺寸一律取 `getViewport({scale: 1})`；渲染走队列，一次一个，可取消。

**R13 文字度量不一致（低）**
- 同一文本框在三端的高度略有差别，可能影响套索命中和便签外观。已有现象，不处理。

**R14 关闭页面时丢失最后一笔（中）**
- 对策：自动保存 1.5 s；`visibilitychange` 立即保存；`beforeunload` 提示。

**R15 剪贴板与文件对话框的浏览器差异（低）**
- 写图片到剪贴板需要用户手势且部分浏览器不支持：失败时改为下载该图片并提示。`showSaveFilePicker`、`showDirectoryPicker` 仅部分浏览器有：按 §5.4 退回下载。

**R16 `github.io` 的来源是整个账号共用的（中高）**
- 问题：浏览器按“协议 + 域名”隔离存储，不看路径。`https://<用户>.github.io/` 下的**所有仓库页面共用同一个 IndexedDB**，其中任何一个页面的脚本都能读到 Inkpad 存的笔记、OAuth 客户端密钥和刷新令牌。内容安全策略只管本页面，管不了同域的别的页面。
- 对策（三选一，由用户决定，见 §15）：给这个站点绑定一个专用的自定义域名；或用一个只放 Inkpad 的 GitHub 账号/组织来发布；或接受这一点并保证该账号下其它 Pages 站点都是自己可信的代码。
- 实现上：数据库名用 `inkpad`，不要假设同域下没有别的应用；不使用 `localStorage` 存任何凭据。

**R17 GitHub Pages 的其它限制（低）**
- 不能设置响应头：内容安全策略用 `<meta>`（§3.1）；拿不到跨源隔离（`SharedArrayBuffer` 不可用），本方案不依赖它。
- 默认会经过 Jekyll 处理并丢掉以下划线开头的文件：根目录放 `.nojekyll`。
- 站点在子路径下：所有地址用相对路径（§0 规则 4）；OAuth 回跳地址含仓库名，仓库改名后要去 Google 控制台同步修改。
- 单个文件上限 100 MB、站点建议不超过 1 GB：`vendor/` 里的 pdf.js（含 cMap 和标准字体）在几十 MB 以内，没有问题。

---

## 13. 测试计划

1. **纯逻辑单元测试**（`node --test`）：`geom`、`pack`、`hash`、`zip`、`document`（撤销、墓碑、合并、往返）、`store`（内存版 `vfs`）、`goodnotes`。
2. **测试向量来自 B**：写一个 Python 脚本 `tests/make_fixtures.py`，按 `A:tools/compat.py` 的办法把 cairo、gi、ptext、pdf 换成桩，然后调用 B 的 `model.py`、`geom.py` 生成输入输出对，存成 JSON。JS 测试读这些 JSON 比对。
3. **同步测试**：把 `A:InkpadTests/SyncTests.swift` 的 `FakeDrive` 和 15 个用例翻译成 JS，全部通过：`testTwoDevices`、`testArchiveAndCloudRestore`、`testFileGoneFromDriveIsSentAgain`、`testCheckpoint`、`testChangingTheFolder`、`testMovesCanBeUndone`、`testCopyGetsItsOwnID`、`testOverlappingSyncsLoseNothing`、`testSaveAfterTheFileChanged`、`testSyncOfOneNotebook`、`testLargePartsAreUploadedOnce`、`testOrderPaperAndPDFsSurviveAMerge`、`testNotebookWithoutItsPicturesIsMended`、`testQuickSyncIsOneRequest`、`testSkippedNotebookIsLeftAlone`。
4. **与 B 的互通测试**：照 `A:InkpadTests/CompatTests.swift` + `A:tools/compat.py`，用一个“目录版云盘”（一个文件夹里放 `<id>` 文件和名字表），让 B 的 `gdrive.sync()` 和 JS 的 `sync()`（在 Node 里跑，用内存 `vfs`）轮流同步，核对两边笔记内容一致。
5. **Goodnotes**：照 `A:InkpadTests/GoodnotesTests.swift` 与 `A:tools/goodnotes_compat.py`。
6. **渲染对照**：M3 的对照页，人工比对。
7. **界面走查**：§8 的清单，在 R4 列出的四类设备上各一遍；明暗主题、三种语言、宽窄两种布局各一遍。

---

## 14. 给实现者的易错点汇总

- Python 的 `id(obj)` 用于按对象身份比较（撤销、选区、隐藏集合）。JS 里直接用对象引用和 `Set`/`Map`，不要引入额外的 id。
- Python 的元组颜色 `(r, g, b)` 在 JS 里是数组；比较颜色要逐分量比，不能用 `===`。
- Python 的 `round()` 是“四舍六入五成双”，JS 的 `Math.round` 是“五入”。只影响 `.5` 的边界，文件能互读，不必模拟。
- Python 的 `sorted(set)[-20000:]` 是按字符串排序后取末尾。照做。
- `Document._swap`（`B:model.py:1065`）插入时下标要 `min(index, 长度)`，且先按下标排序。
- `replace_items` 要按原元素在页内的顺序排好再生成操作（`B:model.py:1105`）。
- `push_diff` 用于擦除：操作期间直接改 `page.items`，结束时与操作前的列表比对生成一步撤销。
- `doc.touch()`（书签、大纲、掀胶带、改封面）不进撤销栈，但要让 `rev` 加一并发 `meta` 和 `state`。掀胶带还要 `page.rev += 1`。
- `emit` 里：`pages` 事件或第一页的 `added`/`dirty` 要让封面缓存失效（`B:model.py:1003`）。
- 合并后必须清空撤销栈，因为栈里的操作引用的元素可能已被替换。
- 同步里“内容代号”有两种：真正的 MD5，和 `'written ' + 签名`。后者表示“写过，但没算摘要”。两者只在本机记录里比较，照 `local_md5`（`B:gdrive.py:813`）的三种情形处理。
- 同步里上传完成后必须核对云端返回的 `md5Checksum` 与本地瘦身件的 MD5，不符就抛错且不写索引（`B:gdrive.py:832-841`）。
- 下载新笔记要先在一旁拼完整（下载 → 复原）再放进文稿库，中途失败不得留下残缺文件（`B:gdrive.py:971-976`）。
- `settle` 里与编辑器互斥的那一段（`with file_lock`）对应网页版的取锁区，区内不得有网络请求：下载和复原在取锁之前完成。
- 冲突副本的名字是原名加 `tr('（云端副本）')`，并给它一个新的笔记 id。
- 复制笔记、导入他人的 `.inkpad`、发现两个文件 id 相同时，都要 `set_notebook_id` 换新 id。
- 文稿库里所有“取不重名的名字”都是“名字 2”“名字 3”的规则（`Store.unique`）。
- 永久删除不是真删：移到 `.deleted/` 并加 `YYYYMMDD-HHMMSS ` 前缀，直到用户“清理缓存”。
- 废纸篓里的东西不上传；别的设备废纸篓里的东西不下载（`B:gdrive.py:949-966`）。

---

## 15. 决策记录与仍待决定的事项

已决定的事项见文件开头的“已定事项”。下面是仍然开放的，实现到相关部分之前向用户确认；未确认时按“默认”执行。

| 事项 | 选项 | 默认 |
| --- | --- | --- |
| `github.io` 共用来源的处理（R16） | 专用自定义域名 / 专用 GitHub 账号或组织 / 接受现状 | 接受现状，并在 README 里写明 |
| OAuth 的前提不成立时（R1 问题一、二） | 由用户决定 | 停下报告，不自行处理 |
| 屏幕上的文字是否也改用“导出 PDF 的字体” | 是（所见即所得）/ 否（屏幕保持系统字体） | 否 |
| GPL 的“或任何更新版本”一句 | 保留（与 B 相同）/ 只写 3.0 | 与 B 的 LICENSE 和 README 保持一致 |
| 最低浏览器版本 | — | 约为 Chrome/Edge 103、Firefox 113、Safari 16.4（受 `CompressionStream('deflate-raw')` 和离屏画布限制；以 M0 的实测为准） |
