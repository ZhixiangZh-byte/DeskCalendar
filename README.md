<p align="center"><img src="docs/icon.png" width="96" alt="DeskCalendar icon" /></p>

<h1 align="center">DeskCalendar</h1>

<p align="center">
  Transparent desktop calendar widgets for Windows, powered by your Google Calendar &amp; Google Tasks.<br />
  贴在 Windows 桌面上的透明日历组件，直接读写你的 Google Calendar 和 Google Tasks。
</p>

<p align="center"><a href="#english">English</a> · <a href="#中文">中文</a></p>

---

## English

### Features

- **Five desktop widgets**:
  - **Month**: events and tasks laid out on a month grid.
  - **Day**: all-day items, plus a 24-hour timeline with a "now" line.
  - **Eisenhower matrix**: open tasks sorted into important × urgent quadrants.
  - **Review box**: overdue tasks and tasks completed in the last 30 days.
  - **Long-term plans**: tasks kept in a dedicated Google Tasks list.
- **Stays on the desktop**: widgets remain visible after <kbd>Win</kbd>+<kbd>D</kbd> and sit beneath your normal windows. You can adjust transparency, size and position, lock them in place, and enable click-through.
- **Full editing**:
  - Tasks: create, edit, complete and delete Google Tasks, including details.
  - Events: create and edit events on your own Google calendars (all-day or timed, location, description).
  - Quick marks: end a title with `!` (important), `!!` (urgent) or `!!!` (both).
- **Offline friendly**: changes made offline are queued locally and synced in order when the network returns. Every widget keeps a local cache.
- **Efficient sync**: incremental refresh fetches only what changed, with a periodic full refresh as a safety net.
- **Extras**: light and dark themes, optional Chinese lunar dates and traditional festivals, tray menu, start with Windows.
- **No server**: the app talks directly to Google's APIs. Your data never goes anywhere else.

### Requirements

- Windows 10 / 11 (x64). The only runtime needed is WebView2: it ships with Windows 11, and the installer fetches it if it is missing.
- A Google account.

### Already got an installer? Just install and sign in

If someone who has already set up DeskCalendar gives you their installer, **you do not need a Google Cloud project, an OAuth client, or any of the publishing steps below**.

1. Run the installer. If SmartScreen warns about an unsigned app, choose *More info → Run anyway*.
2. Open DeskCalendar, click **Sign in to Google**, and sign in with **your own** Google account.
3. Google will show "Google hasn't verified this app". Click *Advanced → Go to DeskCalendar (unsafe)*, then grant the permissions.

Your calendar and task data travel only between your computer and Google; the person who built the installer cannot see them.

Things to know:
- The app is unverified, so at most 100 Google accounts can use it.
- Personal Gmail accounts work. Organization (Google Workspace) accounts may be blocked from unverified apps by their administrator.

### Building or distributing it yourself: set up a Google OAuth client (one time)

You only need this section if you build DeskCalendar from source, or want to distribute it under your own Google Cloud project. The repository does not contain any OAuth credentials, so you need your own:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable the **Google Calendar API** and **Google Tasks API** for it.
3. Open **Google Auth Platform** and configure the app:
   - **Branding**: an app name and a support email.
   - **Audience**: "External"; add yourself as a test user, or publish the app (see below).
4. Under **Clients**, create a client of type **Desktop app** and download the JSON file.
5. Save the file as `%USERPROFILE%\.deskcalendar\google-oauth-client.json`.

> While the app is in **Testing** status, Google expires sign-ins after 7 days. For personal use, set the status to **In production** under **Audience**. No verification is needed for up to 100 users; you will see a "Google hasn't verified this app" screen when signing in. Click *Continue*.

### Install

1. Download `DeskCalendar_x.y.z_x64-setup.exe` from Releases, or build it yourself (see below), and run it.
   - It installs for the current user only and needs no administrator rights.
   - Windows SmartScreen may warn about an unsigned app. Choose *More info → Run anyway*.
2. Start DeskCalendar, click **Sign in to Google**, and authorize in the browser.
3. Right-click the tray icon to show more widgets, lock positions, enable click-through, or start with Windows.

More details (in Chinese): [INSTALL.md](INSTALL.md) · [app/README.md](app/README.md)

### Build from source

Prerequisites:
- Node.js 20+
- Rust (stable, MSVC toolchain)
- Visual Studio Build Tools with the "Desktop development with C++" workload

```powershell
cd app
npm install
npm run check          # type check + unit tests
npm run dev            # UI preview in a browser with demo data
npm run tauri build    # release exe + NSIS installer (app/src-tauri/target/release/bundle/nsis/)
```

To embed your OAuth client in a build that **you distribute only to your own computers**, set `DESKCALENDAR_OAUTH_CLIENT` to the path of the JSON file before `npm run tauri build`. Never publish such a build.

### Project layout

| Path | Contents |
|---|---|
| `app/src-tauri/` | Rust backend (Tauri 2): OAuth with loopback and PKCE, the refresh token in Windows Credential Manager, attaching windows to the desktop layer, the tray |
| `app/src/` | TypeScript frontend: Google REST client, data model, the five views, offline queue, lunar calendar |
| `app/test/` | Unit tests (Vitest) |
| `feasibility/` | Early feasibility experiments: Google API checks and the desktop-layer prototype |
| `docs/` | GitHub Pages site (homepage, privacy policy, terms) |

### Privacy

DeskCalendar runs only on your computer and accesses Google Calendar and Google Tasks solely to display and edit your own data. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md).

### License

[MIT](LICENSE)

---

## 中文

### 功能

- **五个桌面组件**：
  - **月历**：事件和任务按日期排在月历网格中。
  - **日视图**：全天日程，加上带当前时间线的 24 小时时间轴。
  - **四象限**：未完成的任务按重要 × 紧急分组。
  - **回顾箱**：逾期未完成的任务，以及最近 30 天完成的任务。
  - **长期规划**：Google Tasks 中专门的"长期规划"清单。
- **贴在桌面上**：按 <kbd>Win</kbd>+<kbd>D</kbd> 后仍然可见，平时位于其他窗口之下。透明度、大小、位置都可以调整，也可以锁定和设置鼠标穿透。
- **完整编辑**：
  - 任务：新建、编辑、勾选、删除 Google 任务，可以填写详情。
  - 日程：新建、编辑自己日历上的日程（全天或定时、地点、说明）。
  - 快速标记：标题末尾加 `!` 表示重要，`!!` 表示紧急，`!!!` 表示两者都有。
- **离线可用**：断网时的修改保存在本地队列中，联网后按顺序自动同步；每个组件都有本地缓存。
- **省流量**：增量刷新只取有变化的条目，并定期全量刷新以防遗漏。
- **其他**：浅色 / 深色主题，可选显示农历和传统节日，托盘菜单，开机自启。
- **没有服务器**：程序直接连接 Google API，你的数据不会经过任何其他地方。

### 运行要求

- Windows 10 / 11（x64）。需要的运行环境只有 WebView2：Windows 11 自带，缺少时安装程序会自动下载。
- 一个 Google 账号。

### 已有安装包？直接安装、登录即可

如果已经配置好 DeskCalendar 的人把安装包给你，**你不需要 Google Cloud 项目、OAuth 客户端，也不需要下文的发布步骤**：

1. 运行安装包。如果 Windows 提示"已保护你的电脑"（安装包没有代码签名），点"更多信息 → 仍要运行"。
2. 打开 DeskCalendar，点"登录 Google"，用**你自己的** Google 账号登录。
3. Google 会提示"Google 未验证此应用"：点"**高级**"→"**转至 DeskCalendar（不安全）**"，然后勾选授权。

你的日程和任务数据只在你的电脑和 Google 之间传输，提供安装包的人看不到。

需要知道的事：
- 本应用未经 Google 审核，最多 100 个 Google 账号可以使用。
- 个人 Gmail 账号可以正常使用；单位的 Google Workspace 账号可能被管理员禁止使用未审核的应用。

### 自己构建或分发：创建 Google OAuth 客户端（只需一次）

只有从源码自行构建，或要用自己的 Google Cloud 项目分发 DeskCalendar 时，才需要这一节。仓库中不含任何 OAuth 凭据，需要自己创建：

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 中新建一个项目。
2. 为项目启用 **Google Calendar API** 和 **Google Tasks API**。
3. 打开 **Google Auth Platform**，配置应用：
   - **品牌信息**（Branding）：填写应用名称和支持邮箱。
   - **目标对象**（Audience）：选择"外部"；把自己加为测试用户，或者直接发布应用（见下方提示）。
4. 在 **客户端**（Clients）中创建一个**桌面应用**类型的客户端，下载 JSON 文件。
5. 把文件保存为 `%USERPROFILE%\.deskcalendar\google-oauth-client.json`。

> 应用处于**测试**状态时，Google 会让登录每 7 天失效一次。自用时，在**目标对象**中把发布状态改为**正式发布**（In production）即可。不超过 100 个用户时不需要审核，登录时会出现"Google 未验证此应用"，点"继续"即可。

### 安装

1. 从 Releases 下载 `DeskCalendar_x.y.z_x64-setup.exe`，或者自行构建（见下文），然后运行。
   - 只为当前用户安装，不需要管理员权限。
   - Windows 可能提示"已保护你的电脑"（安装包没有代码签名），点"更多信息 → 仍要运行"。
2. 打开 DeskCalendar，点"登录 Google"，在浏览器中授权。
3. 右键托盘图标，可以显示更多组件、锁定位置、设置鼠标穿透和开机自启。

更多说明：[INSTALL.md](INSTALL.md) · [app/README.md](app/README.md)

### 从源码构建

需要的环境：
- Node.js 20+
- Rust（stable，MSVC 工具链）
- Visual Studio Build Tools（"使用 C++ 的桌面开发"工作负载）

```powershell
cd app
npm install
npm run check          # 类型检查 + 单元测试
npm run dev            # 在浏览器中用演示数据预览界面
npm run tauri build    # 发布版 exe + NSIS 安装包（app/src-tauri/target/release/bundle/nsis/）
```

如果要构建**只装在自己电脑上**的安装包，可以在 `npm run tauri build` 之前，把环境变量 `DESKCALENDAR_OAUTH_CLIENT` 设为客户端 JSON 文件的路径，把客户端嵌入程序。这样的安装包请勿公开发布。

### 目录结构

| 路径 | 内容 |
|---|---|
| `app/src-tauri/` | Rust 后台（Tauri 2）：OAuth（回环地址 + PKCE）、在 Windows 凭据管理器中保存刷新令牌、窗口贴桌面层、托盘 |
| `app/src/` | TypeScript 前端：Google REST 客户端、数据模型、五个视图、离线队列、农历 |
| `app/test/` | 单元测试（Vitest） |
| `feasibility/` | 早期可行性验证：Google API 检查、桌面层原型 |
| `docs/` | GitHub Pages 网站（主页、隐私政策、服务条款） |

### 隐私

DeskCalendar 只在你的电脑上运行，访问 Google Calendar 和 Google Tasks 仅用于显示和编辑你自己的数据。详见 [PRIVACY.md](PRIVACY.md) 和 [TERMS.md](TERMS.md)。

### 许可证

[MIT](LICENSE)
