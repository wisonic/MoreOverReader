# Moreover Reader — 在 VS Code 终端里伪装成 AI 会话摸鱼读书

> 本项目（扩展代码、文档）全部由 AI（Claude）生成。

和 [Read On Bush](https://marketplace.visualstudio.com/items?itemName=moyuderen.readOnBush) 同款的**真终端**阅读（VS Code Pseudoterminal，零依赖），但伪装内容是"AI 编码会话"：终端里常驻一段逼真的假工作记录（需求分析、彩色 diff、测试通过），小说正文夹在中间，按 `d` 随时显隐，**失焦自动隐藏**（隐藏时替换成等行数的伪装待办，屏幕零抖动）——同事扫一眼，看到的是你在让 AI 改订单分页 bug。

## 效果

```
● I'll keep the terminal rendering state local and reuse the shared renderer.

⏺ 我先看了订单列表和接口封装，问题集中在分页状态没有和筛选条件一起重置。方案如下：
  1. 把 pageParam 统一交给 useInfiniteQuery 管理
  2. 筛选条件变化时清空本地 selection / scroll anchor
  3. 补 loading、空状态、失败重试和边界单测

Notes: API 返回 nextCursor=null 时应停止请求，避免重复拉最后一页

  东二道街上有一家火磨[2]，那火磨的院子很大，用红色的好砖砌起来的大烟筒是非常高
  的，听说那火磨里边进去不得，那里边的消信可多了，是碰不得的。一碰就会把人用火
  烧死，不然为什么叫火磨呢？…

✏️  Updated src/api/orders.ts
     @@ -24,7 +24,12 @@
   -  const res = await fetch('/api/orders')
   +  const params = new URLSearchParams({ page, size: '20', status })
   +  const res = await fetch('/api/orders?' + params.toString())
   +  if (!res.ok) throw new Error('订单加载失败')
● npm test -- --runInBand orders  ✓ 18 passed (2.4s)

  ⎿  q hide · Q quit · d toggle · n/p step · j jump · e notes · i image · a auto
* Sautéed for 8m 6s · 6/12 · 第一章 · 33%        new task? /clear to save 308.4k tokens

›
[opus-4.8[1m]] █████░░░░░░░░░░░ 33% | 💰 $16.17 | ⏱ 8m 6s
```

## 使用

1. 命令面板（`Cmd/Ctrl+Shift+P`）→ **Moreover: Open Book** 选 `.epub` / `.txt`（或活动栏书本图标 → 书架 → ＋）
2. 弹出名为 `claude` 的终端，假工作流 + 小说正文同时显示
3. **点击终端获得焦点**，按键操作：

| 键 | 功能 |
|---|---|
| `d` | 显示/隐藏正文（隐藏时换成等行数伪装待办，屏幕不跳动） |
| `n` / `↓` / `空格` / `回车` | 下一行 |
| `p` / `↑` | 上一行 |
| `j` | 打开**目录**并跳转（QuickPick，当前章有标记） |
| `l` / `→`，`h` / `←` | 下一章 / 上一章 |
| `e` | 显示/关闭当前窗口内所有 `[n]` 标记的注解（按标记号/EPUB noteref 精确匹配，不自动关） |
| `i` | 打开/关闭最近插图预览（3 秒自动关，再按 `i` 立即关） |
| `I`（大写） | 插图预览，不自动关 |
| `a` | 自动滚动开/关（3 秒一行） |
| `q` | 隐藏正文 |
| `Q`（大写） | 退出阅读 |

## 隐蔽性设计

- **失焦自动隐藏**（四重触发）：切到其他终端、切到编辑器、光标进入编辑器、VS Code 窗口失焦——正文立即换成伪装待办
- **隐藏零抖动**：隐藏时显示等行数的暗灰"待办事项"（12 条轮换），整屏高度不变
- **翻页只动正文**：`n/p` 翻行时上下伪装内容字节级不变，只有正文窗口和进度条在动；翻章/跳转时伪装内容轮换（像切换了新任务）
- 终端标签名就叫 `claude`（可改 `extension.js` 里 `createTerminal({ name: … })`）
- 插图预览窗标题叫 `Preview`，像在看设计稿

## 书架与进度

- 活动栏书本图标 → 书架；右上角 `+` 添加图书
- 每本书**按项目记住读到哪一行**，点书名即续读
- **右键 → 移除**删除图书（带确认弹窗，防误删）

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `moreoverReader.lines` | `3` | 同时显示的正文行数（1–50，越小越隐蔽） |
| `moreoverReader.columns` | `82` | 正文折行的终端列宽（中文按 2 列计；段落预折行、内容零省略、`[n]` 标记不切断） |

## 打包安装

```bash
npm install
npx vsce package --allow-missing-repository
# 扩展面板 → ⋯ → 从 VSIX 安装 → moreover-reader-x.y.z.vsix
```

## 技术说明

- **真终端**（`vscode.window.createTerminal({ pty })` + Pseudoterminal），`handleInput` 直接收到每个按键——无需 keybindings、无需 node-pty，**零运行时依赖**
- **EPUB 解析零依赖**：手工解析 ZIP 中央目录 + zlib inflate；spine 阅读顺序、插图提取（data URI）、注解提取（含 Calibre 中文书常见结构、EPUB noteref 引用）
- TXT 自动识别 UTF-8 / GBK
- 全部渲染逻辑（ANSI 帧、伪装文案、折行）为纯函数，可无头测试

## 已知限制

- 插图经独立 Webview 预览窗显示（终端本身无法渲染图片）
- 复杂排版的 EPUB（多栏/严格分页）会退化为纯文本流

## License

MIT
