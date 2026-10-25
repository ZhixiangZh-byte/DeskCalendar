# Privacy Policy · 隐私政策

Effective date / 生效日期：2026-10-25

## English

### Summary

DeskCalendar is a desktop application that runs on your own computer. It connects directly to Google Calendar and Google Tasks using your Google account.

**There is no DeskCalendar server. The developer does not collect, receive, store, sell or share any of your data.**

### Google user data the app accesses

| Scope | Purpose |
|---|---|
| `calendar.calendarlist.readonly` | Read the list of calendars you have selected, to decide which calendars to display. |
| `calendar.events` | Read events to display them. Create, edit or delete events only when you do so in the app. |
| `tasks` | Read tasks to display them. Create, edit, complete or delete tasks only when you do so in the app. |

### How the data is used and stored

- Data is used only to show your calendars and tasks in the widgets and to apply the changes you make.
- So that the widgets work offline, two things are stored locally on your computer (WebView2 local storage): a cache of recently displayed events and tasks, and a queue of changes made while offline.
- The OAuth refresh token is stored in Windows Credential Manager on your computer. Access tokens are kept only in memory.
- The app has no analytics, advertising or tracking. No data is sent anywhere except to Google's APIs.

### Limited Use disclosure

DeskCalendar's use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

### Removing your data

- Choose **Sign out of Google** in the app (settings panel or tray menu). The refresh token is revoked and deleted, and the local caches are cleared.
- You can revoke access at any time at <https://myaccount.google.com/permissions>.
- Uninstalling the app removes the program. Its local data lives in your Windows user profile.

### Changes and contact

Any updates to this policy will be published in this file. For questions, please open an issue at <https://github.com/ZhixiangZh-byte/DeskCalendar/issues>.

## 中文

### 概要

DeskCalendar 是在你自己电脑上运行的桌面程序，使用你的 Google 账号直接连接 Google Calendar 和 Google Tasks。

**DeskCalendar 没有任何服务器，开发者不会收集、接收、保存、出售或分享你的任何数据。**

### 程序访问的 Google 数据

| 权限 | 用途 |
|---|---|
| `calendar.calendarlist.readonly` | 读取你在 Google 日历中勾选的日历列表，以确定要显示哪些日历。 |
| `calendar.events` | 读取日程用于显示；只有在你于程序中操作时，才新建、修改或删除日程。 |
| `tasks` | 读取任务用于显示；只有在你于程序中操作时，才新建、修改、完成或删除任务。 |

### 数据的使用与存储

- 数据只用于在组件中显示你的日程和任务，以及执行你所做的修改。
- 为了离线可用，以下两类数据保存在你的电脑上（WebView2 本地存储）：最近显示过的日程和任务的缓存，以及断网时的修改队列。
- OAuth 刷新令牌保存在本机的 Windows 凭据管理器中；访问令牌只保存在内存里。
- 程序没有统计分析、广告或追踪，除 Google API 外不向任何地方发送数据。

### 有限使用声明

DeskCalendar 对从 Google API 获取的信息的使用及向其他应用的传输，遵守 [Google API 服务用户数据政策](https://developers.google.com/terms/api-services-user-data-policy)，包括其中的"有限使用"（Limited Use）要求。

### 删除你的数据

- 在程序中选择"**退出 Google 登录**"（设置面板或托盘菜单）：会撤销并删除刷新令牌，同时清空本地缓存。
- 也可以随时在 <https://myaccount.google.com/permissions> 撤销授权。
- 卸载程序会删除程序本身；本地数据位于你的 Windows 用户目录中。

### 变更与联系

本政策如有更新，会发布在本文件中。如有问题，请在 <https://github.com/ZhixiangZh-byte/DeskCalendar/issues> 提交 Issue。
