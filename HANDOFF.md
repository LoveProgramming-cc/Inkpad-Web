# 交接说明：Inkpad 网页版

写于 2026-11-02。用户要换设备，之前所有对话记录都会丢失。这份文件交代目标、已经定下的约定、做到了哪里、还剩什么。接手的人（或下一个模型）先读这一份，再读 `README.md` 和 `docs/PORTING.md`。

## 一、目标

Inkpad 是用户本人做的手写笔记软件，原本有两个版本：

| 代号 | 仓库 | 语言 / 平台 |
| --- | --- | --- |
| A | <https://github.com/LoveProgramming-cc/Inkpad-iOS> | Swift，iPad / iPhone |
| B | <https://github.com/LoveProgramming-cc/Inkpad-gnome> | Python + GTK，Linux 桌面 |

这个项目是第三个版本：**原生网页版**。用户提的要求是：

1. **小巧轻量**：不用笨重的框架，性能要合理。现在是原生 ES 模块 + DOM + Canvas 2D，不需要构建步骤。
2. **功能齐全**：复刻 A、B 的全部功能，包括 Google Drive 云同步和各种细节；只为某个平台专门做的部分除外。
3. **界面复刻**：重现原软件的界面。

## 二、已经定下的约定

这些都是用户明确说过的：

- **许可证**：GPL-3.0，用户是版权人。
- **部署**：GitHub Pages。
  - 仓库：<https://github.com/LoveProgramming-cc/Inkpad-Web>，公开。
  - 网址：<https://loveprogramming-cc.github.io/Inkpad-Web/>，从 `main` 分支根目录发布。
- **A 的代码可以直接用**：A 是用户自己写的。
- **导出的 PDF**：文字必须是矢量，字体由用户选择。
- **PWA**：用户最初定为“平台专门优化，最后再做”，后来已明确要求实现，现在已经做了。
- **自动推送**：在这个仓库里，改动完成、测试通过后**直接提交并推送到 `main`，不用先问**。这是用户 2026-10-12 说的“以后请自动推送”。
- **设计偏好**：
  - 界面不要生硬，下拉菜单等不要用系统原生控件（现在已全部自绘）。
  - 外框线要轻。
- **语言**：用户用中文交流。界面文字以中文为源文本，另有英文、日文翻译。

## 三、历史

1. **写移植方案。** 分析 A、B 后写出 `docs/PORTING.md`：模块依赖顺序、平台 API 对应表、需要重写的部分、风险点。原计划由能力较弱的模型照方案实施。
2. **按 M0–M12 里程碑实现全部功能。** 各里程碑的验证方式见 `README.md` 末尾的“实施状态与验证记录”。
3. **用户在 iPad（Chrome）上试用后修的问题：**
   - 用局域网地址 `http://172.20.10.3:8080` 访问时 `crypto.randomUUID` 不存在，新建笔记报错。已改为 `src/core/uuid.js`，PKCE 改用自带的 SHA-256。
   - 界面生硬：加了对话框、弹出菜单、提示条的动效和按压反馈；悬停样式只在有鼠标的设备上生效；下拉菜单全部自绘；边框减淡。
   - 书写时手掌把工具栏文字选中了：整个界面改为不可选中文字，输入框除外。
   - 写“も”时第二笔丢失：画布拒绝了触摸事件的默认行为，免得 iPadOS 的手势识别抢走笔；笔被系统取消时保留已写部分；忽略迟到的 `lostpointercapture`。
   - 笔画粗细乱跳：改用每个采样点自带的时间戳；压感按 A 的公式换算（iPad 报的压力是占最大力度的比例，约乘 4.17 再除以 2）。
   - 设置里的“记录输入日志”原来没有真正写入，已补上。
   - 选择导出字体时文件选择器不弹出：改为在点击的那一刻直接打开。
   - 双击封面打开了两个编辑器（看起来像多出一条笔工具栏）：已加防重入。
   - 左右翻页模式下放大时露出下一页：缩放后视图限制在当前页范围内。
4. **部署与同步。**
   - 建了仓库并开启 Pages。
   - 用户在自己的 Google Cloud 项目里建了“Web 应用”类型的 OAuth 客户端，连接成功，并且能看到其它设备同步上去的笔记。
   - Google 不允许从局域网 IP 登录，只接受 https 或 `localhost`；这类地址下设置页现在会直接说明原因。
   - 导入凭据 JSON 后，客户端 ID、密钥和同步文件夹输入框现在会立即刷新。
5. **PWA。** 应用清单 `manifest.webmanifest`、图标（取自 A）、离线缓存 `sw.js`、新版本提示、设置里的“应用”一栏，以及桌面 Chrome 安装后可以直接打开 `.pdf`、`.inkpad`、`.goodnotes` 文件。
6. **涂画擦除。**
   - 一度用过网页版自己的一套判定（看转角总量）。2026-11 起改回与 A、B **完全相同**的规则（`B:geom.py` 的 `_scratched` 和 `_straight_passes` 逐行翻译），三端对同一笔的判定一致。
   - 测试 `tests/geom.test.js` 用 A 的 55 个合成样本（`tests/fixtures/scribbles.json`，由 `A:InkpadTests/ScribbleSamples.swift` 转来，答案由 B 的代码给出）。改规则时三端一起改，样本也一起更新。
   - 设置 → 书写里有“宽松的涂抹删除”开关，默认关闭；打开后使用旧规则（`B:geom.py` 的 `_loose`），文案与 A、B 相同。

## 四、现在的状态

- 自动化测试共 87 项，全部通过（`node --test tests/*.test.js`；Node 24 起不能只写目录）。
- 线上版本就是 `main` 的最新提交 `faa2706`。
- 用户已在 iPad 上实际使用。Google 同步已连接，能读到其它设备的笔记。

## 五、还没做或没验证的事

1. **iPad 上“添加到主屏幕”之后的行为**：独立窗口里的 Google 登录是否正常、存储是否与浏览器分开，都没有在真机上验证。更新提示和“用 Inkpad 打开文件”只写了代码，没有实际触发过。
2. **涂画判定**：与 A、B 相同，只用合成笔画验证过。阈值在 `src/core/geom.js` 的 `MIN_REVERSALS`、`SPREAD_FREE`、`SPREAD_STEP`、`DENSE_RATIO`、`STRAIGHT_PASSES`，改动要与 A、B 同步。
3. **笔的手感**：压感和笔速的新换算（`src/editor/input.js` 的 `_penPressure`）改完后，用户还没有给出反馈。
4. **轻量的证据**：用户问过“如何证明足够轻量、达到原生水准”。我只给了加载数据（首屏 54 个请求、约 411 KB 未压缩、第二次打开全部来自缓存），没有书写延迟和帧率的实测。我提议过在编辑器里加一个延迟/帧率调试面板，用户还没回应。
5. **`README.md` 里的旧清单**：末尾的“还没有做”清单有部分已经过时。其中第 1 条 R1 的主要前提已由用户实测成立：Web 客户端能看到其它设备的文件，令牌接口可以跨域。其余条目（`.otf` 字体、跨浏览器、窄屏走查、多标签页互斥、Goodnotes 导出）仍未验证。

## 六、在新设备上接着干

```bash
git clone https://github.com/LoveProgramming-cc/Inkpad-Web.git
cd Inkpad-Web
```

```bash
git clone https://github.com/LoveProgramming-cc/Inkpad-iOS.git ref/A
```

```bash
git clone https://github.com/LoveProgramming-cc/Inkpad-gnome.git ref/B
```

- `ref/` 不入库，`.gitignore` 已忽略它。其中 `tests/interop.test.js` 要调用 B 的 Python 同步代码和 A 的 `tools/compat.py`，所以需要 `ref/` 和 `python3`。
- 本地运行：`node tools/serve.mjs 8080`，然后打开 `http://localhost:8080/`。任何静态文件服务器都可以，node 不是必需的。
- 不能双击 `index.html` 直接打开：ES 模块不能从 `file://` 加载。

**每次改完代码后的固定步骤：**

1. `node tools/build_sw.mjs`：重写离线缓存的文件清单和版本号。漏了这一步，用户拿不到新版本，测试也会失败。
2. `node --test tests/*.test.js`
3. 提交并推送到 `main`，提交信息末尾带上合著者署名。
4. 用 `curl` 确认线上 `sw.js` 里的版本号已经更新。Pages 一般一两分钟生效。

**测试用的字体**：浏览器测试页 `tests/browser/pdf.html` 要用 `tests/browser/_font.ttf`。这个文件没有入库，在新设备上自己放一个 `.ttf` 并改成这个名字即可。

## 七、代码地图

| 目录 | 内容 |
| --- | --- |
| `src/core/` | 文件格式、文档模型、几何（含涂画判定）、渲染、文字排版 |
| `src/platform/` | IndexedDB 文件库、文件选择、图片、PWA |
| `src/library/` | 文稿库 |
| `src/editor/` | 画布、输入状态机（`input.js`）、工具、编辑器界面 |
| `src/io/` | PDF 矢量导出、导入、Goodnotes |
| `src/sync/` | 同步算法、Google 登录、Drive 接口、同步调度 |
| `src/ui/` | 对话框、弹出菜单、控件、设置（`prefs.js`） |
| `src/data/` | 图标、翻译（`en.json`、`ja.json` 取自 A；`web.json` 是网页版新增的文字） |
| `src/vendor/` | pdf.js、pdf-lib、fontkit |

新增界面文字时，要在 `src/data/web.json` 里补英文和日文，然后运行 `python3 tools/missing_strings.py` 检查有没有漏。
