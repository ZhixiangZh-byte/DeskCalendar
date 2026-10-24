# DeskCalendar 安装说明

## 在新电脑上安装

1. 把安装包 `DeskCalendar_1.0.0_x64-setup.exe`（约 4 MB）复制到新电脑上，双击运行。
   - 安装包位置：`app\src-tauri\target\release\bundle\nsis\`。
   - 如果 Windows 提示"Windows 已保护你的电脑"，点"更多信息 → 仍要运行"。这是因为安装包没有购买代码签名证书，不是病毒提示。
   - 只为当前用户安装，不需要管理员权限，程序装在 `%LOCALAPPDATA%\Programs\DeskCalendar`。
   - 需要的运行环境只有 WebView2。Windows 11 自带；旧系统缺少时，安装程序会自动联网下载安装。
2. 安装完成后从开始菜单或桌面快捷方式打开 DeskCalendar，点"登录 Google"，在浏览器中授权。出现"Google 未验证此应用"时，点"继续"。
   - 自己构建的安装包已内嵌 OAuth 客户端，新电脑**不需要**再复制 `google-oauth-client.json`。
   - 如果新电脑的 `%USERPROFILE%\.deskcalendar\google-oauth-client.json` 存在，会优先使用这个文件。
3. 右键托盘图标：
   - "显示组件"：打开日视图、四象限、回顾箱、长期规划；
   - "开机自动启动"：勾选后开机自动运行。
4. 每台电脑的组件位置、大小、外观设置各自保存；任务和日程通过 Google 自动同步。

卸载：在"设置 → 应用 → 已安装的应用"中卸载 DeskCalendar。登录凭据保存在 Windows 凭据管理器中（普通凭据 → `DeskCalendar`），卸载后如需清除，可在那里手动删除。

## 让登录不再每 7 天失效

Google Auth Platform → **Audience（目标对象）** → Publishing status 点"**Publish app**"，改为"In production"。

- 自用（不超过 100 个用户）时，**不需要**提交审核，也不需要填写主页和隐私政策链接。登录时会继续显示"Google 未验证此应用"，点"继续"即可。
- 发布后，每台电脑需要重新登录一次，之后刷新令牌就不会再按 7 天过期。

## 自己构建安装包

需要本机开发环境（Rust、Node.js、VS Build Tools，见 `../CalendarApp/CalendarApp/environment/ENVIRONMENT.md`）。

```powershell
cd app
npm install
# 可选：把 OAuth 客户端嵌入程序（只用于自己分发的安装包，不要公开发布这样的安装包）
$env:DESKCALENDAR_OAUTH_CLIENT = "$env:USERPROFILE\.deskcalendar\google-oauth-client.json"
npm run tauri build
```

- 生成的安装包在 `app\src-tauri\target\release\bundle\nsis\`。
- 不设 `DESKCALENDAR_OAUTH_CLIENT` 时不会内嵌客户端，使用者要把自己的客户端文件放到 `%USERPROFILE%\.deskcalendar\google-oauth-client.json`。在 GitHub 上公开发布的安装包应这样构建。
- 第一次打包时会自动下载 NSIS 打包工具（Tauri 的缓存）。
- 更换图标后，需要先修改一下 `src-tauri/build.rs` 的时间戳，否则 exe 图标不会更新（见 `app/README.md`）。

## 开源发布前的检查

- OAuth 客户端文件、刷新令牌都不在仓库中（已在 `.gitignore` 中排除，历史提交中也没有）。
- git 提交记录中包含作者邮箱。如果不想公开，推送到 GitHub 前可以改用 GitHub 提供的 noreply 邮箱重写历史，或者新建一个只包含当前代码的仓库。
- 建议添加开源许可证（如 MIT）。
- `docs/` 中有主页、隐私政策、服务条款的草稿，可通过 GitHub Pages 发布（见 `docs/README.md`）。
