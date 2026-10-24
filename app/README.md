# DeskCalendar 月历组件

一个贴在 Windows 桌面上的透明月历，直接读写 Google Calendar 和 Google Tasks。按 Win+D 显示桌面时它仍然可见；平时其他窗口会盖住它。

## 使用

1. 前提：`%USERPROFILE%\.deskcalendar\google-oauth-client.json` 已存在（"桌面应用"类型的 OAuth 客户端）。
2. 在资源管理器中双击 `src-tauri\target\release\DeskCalendar.exe`。不要从 Claude 里启动，否则缓存和设置会被重定向到 Claude 的私有目录。
3. 点"登录 Google"，在浏览器中授权。出现"Google 未验证此应用"时点"继续"。

| 操作 | 方法 |
|---|---|
| 新建任务 | 点某一天的空白处，输入标题和详情（可选），回车或 Ctrl+Enter。任务写入第一个任务清单，截止日期为当天 |
| 快速标记 | 标题末尾加 `!` = 重要，`!!` = 紧急，`!!!` = 重要且紧急（半角、全角都可以）；也可以勾选"重要"/"紧急" |
| 新建日历事件 | 新建时勾选"指定时间"并填写起止时间，会建成主日历中的事件（结束时间早于开始时间视为次日） |
| 查看 / 编辑任务 | 点任务标题，打开详情：可改标题、详情、日期、重要/紧急、完成状态；可删除（需再点一次确认） |
| 完成 / 取消完成 | 点任务前的方框 |
| 查看 / 编辑日程 | 点日程打开详情。自己日历上的日程（自己组织或允许嘉宾修改的）可改标题、全天/定时、起止日期时间、地点、说明，也可删除；重复日程只改这一次。别人组织的会议和只读日历只能查看。没改说明时不会写回，保留 Google 中的富文本格式 |
| 关闭面板 | 点面板外的任意位置，或按 Esc |
| 鼠标穿透 5 秒 | 顶栏的指针图标；期间卡片变淡，可点到组件后面的桌面图标 |
| 翻月 | 顶栏 ‹ › ；"今天"回到本月 |
| 移动 / 调整大小 | 拖动顶栏 / 拖动边缘 |
| 设置 | 顶栏齿轮：外观（跟随系统 / 浅色 / 深色）、背景不透明度、显示已完成的任务、锁定位置和大小、退出登录 |
| 托盘菜单（右键） | 立即刷新、锁定、鼠标穿透、开机自动启动、退出登录、退出 |

显示规则：
- 显示 Google 日历里所有处于勾选状态的日历；
- 显示除"长期规划"外所有清单中有截止日期的任务；
- 任务前的红点表示 `#重要`，橙点表示 `#紧急`（来自备注末尾的标签行）；
- 每 3 分钟自动刷新；窗口获得焦点、网络恢复时也会刷新；离线时显示上次缓存的数据。

## 文件与数据

| 内容 | 位置 |
|---|---|
| OAuth 客户端 | `%USERPROFILE%\.deskcalendar\google-oauth-client.json`（不在仓库中） |
| 刷新令牌 | Windows 凭据管理器 → 普通凭据 → `DeskCalendar` |
| 锁定状态 | `%APPDATA%\com.deskcalendar.app\settings.json` |
| 窗口位置和大小 | 由 window-state 插件保存在同一目录 |
| 数据缓存、不透明度等偏好 | WebView2 的 localStorage（`%LOCALAPPDATA%\com.deskcalendar.app`） |

注意：Google 同意屏幕处于"测试"状态时，登录 7 天后失效，组件会提示重新登录。改为"正式发布"即可避免。

## 开发

```bash
npm install
npm run check                                 # 类型检查 + 单元测试（Vitest）
npm run dev                                   # 只启动界面，浏览器中用演示数据预览
npm run tauri build -- --debug --no-bundle    # 调试版 exe（带控制台窗口）
npm run tauri build -- --no-bundle            # 发布版 exe
```

- `--demo` 启动参数：使用演示数据，不登录 Google。
- `scripts/smoke.ps1 [-Release]`：以演示数据启动组件，检查窗口所有者是否为桌面窗口、按 Win+D 后是否仍可见。运行时会短暂"显示桌面"。
- Rust 单元测试：`cd src-tauri && cargo test`。

代码结构：

| 文件 | 内容 |
|---|---|
| `src-tauri/src/oauth.rs` | OAuth（回环地址 + PKCE）、凭据管理器、访问令牌刷新 |
| `src-tauri/src/desktop.rs` | 贴桌面层：把窗口的所有者设为桌面窗口（见 `../feasibility/README.md`） |
| `src-tauri/src/lib.rs` | 托盘菜单、锁定、鼠标穿透、开机自启、提供给前端的命令 |
| `src/google.ts` | Google REST 客户端（收到 401 时刷新令牌并重试） |
| `src/model.ts` | 统一的条目模型：事件和任务的转换、四象限标签 |
| `src/month.ts` | 月历网格 |
| `src/source.ts` | 数据源（Google / 演示）与本地缓存 |
| `src/main.ts` | 界面 |
