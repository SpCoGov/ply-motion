# PlyMotion

基于 **Tauri 2 + Rust + React + TypeScript + Vite** 的本地国际象棋棋谱分析与动画编辑器。

- 导入 PGN，使用内置 Stockfish WASM 或本机 UCI 引擎分析棋局。
- 可拖动、拆分和恢复的工作区，支持独立镜头预览窗口。
- 编辑时间线片段、对象属性、关键帧、贝塞尔曲线、镜头和音乐卡点。
- 自定义棋子、棋盘、文字、图片及音效，支持撤销和重做。
- 保存 `.plymotion` 工程，通过 FFmpeg 导出 MP4 视频。

## 开发与构建

Windows 需要 Rust MSVC 工具链、Visual Studio C++ Build Tools、WebView2，以及 Node.js 24 和 pnpm 11。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 启动 Tauri 和 Vite，开发地址为 `http://127.0.0.1:4173`。首次缺少 Tauri 命令时执行：

```powershell
cargo install tauri-cli --version "^2" --locked
```

| 命令 | 用途 |
| --- | --- |
| `pnpm frontend:dev` | 浏览器开发预览 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm frontend:build` | 构建前端到 `dist/` |
| `pnpm build` | 构建前端和 `target/release/ply-motion.exe` |
| `cargo tauri build` | 构建桌面安装包 |
| `pnpm icons` | 从 `icon.svg` 生成应用图标 |

单独执行 `cargo build --release` 前先运行 `pnpm frontend:build`。退出开发模式使用 Ctrl+C；重新编译前关闭正在运行的应用，避免 Windows 文件占用。

## 工程与编辑

在「工程」菜单打开、保存或另存为 `.plymotion`，快捷键为 `Ctrl+O`、`Ctrl+S`、`Ctrl+Shift+S`。桌面版的自定义素材保存在同名 `.assets` 目录，复制工程时需一并复制；浏览器预览保存为单文件下载副本。

点击棋子或时间线片段，在属性面板修改坐标、缩放、旋转、透明度及关键帧。支持暂停、拖动时间尺和使用 `,` / `.` 逐帧定位。「面板」菜单可打开镜头、音乐卡点、素材和构图编辑面板。

## MCP 接入

在桌面程序顶部点击「MCP：关」开启本次会话的控制，重启后默认关闭。浏览器预览不提供 MCP 服务。

接入需要支持原生 TypeScript 类型擦除的 Node.js 24.19 或更新版本。在支持 stdio 的 MCP 客户端中添加以下配置，并替换源码路径：

```json
{
  "mcpServers": {
    "plymotion": {
      "command": "node",
      "args": ["D:/ply-motion/scripts/mcp.mjs"]
    }
  }
}
```

`node` 必须能在客户端 PATH 中找到，否则填写完整路径。脚本通过 `127.0.0.1:4174` 的本机 TCP 桥接连接编辑器；该端口不是 HTTP/SSE 地址。一次只能有一个编辑器开启此端口，其他本机进程也能访问开启控制的工程，因此只在需要时开启。桌面安装包当前不包含 Node 或接入脚本。

先调用 `get_project` 获取工程、对象／片段 ID 和 `revision`，再使用 `set_pgn`、`update_animation`、`seek_timeline`、`undo` 或 `redo`。修改操作使用最新 `revision`；用户在界面修改后需重新读取。替换未保存工程还需 `replaceUnsaved: true`。

`update_animation` 的每个顶层字段会整体替换，未传入字段保留；修改某个对象时需合并并传回已有的 `project.edits.objects`。时间以毫秒表示，缓动支持 `"linear"`、`"hold"` 或四个数字的贝塞尔数组。MCP 修改支持轨道锁定和撤销，完成后需在应用中保存；导入新 PGN 会重置原动画、分析和撤销历史。

## 本地素材

```powershell
pnpm assets
```

下载 Neo 棋子 PNG 和默认走子／吃子音效到 Git 忽略的 `web/assets/chesscom/`。未下载时使用随附 GPL 棋子和合成音效。

Chess.com 资源和用户提供的提取 SVG 不属于本项目 Apache-2.0 授权范围，尚未确认开放再分发许可。本地构建会包含当前存在的素材，对外发布前需确认授权或替换。来源和许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 数据与限制

- 分析标准国际象棋 PGN 主线；变例和文本评论不进入编辑器，原始 PGN 保存在工程中。
- 保存工程使用 `.plymotion`，成片导出使用 MP4。
- 着法分类和准确率是基于引擎分析的估计，不是 Chess.com CAPS；引擎限时与搜索波动可能影响结果。
- 内置 WASM Lite 为单线程；本机 UCI 引擎由用户自行准备，保留其所需网络文件。
- 开局位置索引来源为 Lichess CC0 数据，可用 `node scripts/build-openings.mjs` 重建。

## 许可证

本项目原创代码按 **Apache-2.0** 发布，详见 [LICENSE](LICENSE)；第三方代码和素材保留各自许可证，详见 [THIRD_PARTY.md](THIRD_PARTY.md)。

`web/lib/review.ts`、`motifs.ts`、`engine.ts`、`board.ts` 复用了 Barabosik/chess-analyzer 的 GPLv3 代码，仍保留 GPLv3 授权，完整文本见 [LICENSE-GPL-3.0](LICENSE-GPL-3.0)。包含这些代码的完整应用仍须按 GPLv3 的要求分发；将项目原创代码改为 Apache-2.0 不会改变上游代码的授权。参见 [Apache 官方兼容性说明](https://www.apache.org/licenses/GPL-compatibility.html)。
