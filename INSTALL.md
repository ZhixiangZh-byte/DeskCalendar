# DeskCalendar 安装说明

先看自己属于哪种情况：

| 情况 | 需要做什么 |
|---|---|
| 已有安装包 | 只看"**exe安装**"一节：安装、用自己的 Google 账号登录即可 |
| 自己在新电脑上安装自己构建的安装包 | 看"在新电脑上安装" |
| 从源码构建、用自己的 Google Cloud 项目分发 | 看 "构建安装包" |

## exe安装

拿到安装包 `DeskCalendar_x.y.z_x64-setup.exe` 后：

1. 双击安装。如果 Windows 提示"已保护你的电脑"，点"更多信息 → 仍要运行"（安装包没有代码签名）。
2. 打开 DeskCalendar，点"登录 Google"，用**自己的** Google 账号登录。
3. 出现"Google 未验证此应用"时，点"**高级**"→"**转至 DeskCalendar（不安全）**"，然后勾选授权。
4. 右键托盘图标，可以显示其他组件、开机自启等。

**不需要**：创建 Google Cloud 项目、OAuth 客户端，或者执行下文的发布步骤。这些都由提供安装包的人做过了。

说明：
- 每个人登录的是自己的账号，日程和任务只在自己的电脑和 Google 之间传输，提供安装包的人看不到。
- 本应用未经 Google 审核，最多 100 个 Google 账号可以使用。
- 个人 Gmail 账号可以正常使用；单位的 Google Workspace 账号可能被管理员禁止使用未审核的应用，这时请改用个人 Gmail 账号，或者请管理员放行。
- 对提供安装包的人：内嵌 OAuth 客户端的安装包只在课题组等可信范围内传递，**不要公开发布**。如果安装包流传到不该去的地方，可以在 Google Cloud Console 中重置客户端密钥并重新构建，旧安装包随之无法登录。

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

## 构建安装包与发布

需要本机开发环境（Rust、Node.js、VS Build Tools，见 `../CalendarApp/CalendarApp/environment/ENVIRONMENT.md`）。

```powershell
cd app
npm install
# 可选：把 OAuth 客户端嵌入程序（只用于自己分发的安装包，不要公开发布这样的安装包）
$env:DESKCALENDAR_OAUTH_CLIENT = "$env:USERPROFILE\.deskcalendar\google-oauth-client.json"
npm run tauri build
```

- 生成的安装包在 `app\src-tauri\target\release\bundle\nsis\`。
- 使用者要把自己的客户端文件放到 `%USERPROFILE%\.deskcalendar\google-oauth-client.json`。
- 第一次打包时会自动下载 NSIS 打包工具（Tauri 的缓存）。
- 更换图标后，需要先修改一下 `src-tauri/build.rs` 的时间戳，否则 exe 图标不会更新。


1. Google Auth Platform → **Branding（品牌信息）**，填写以下链接后保存：
   - 应用主页：`https://github.com/ZhixiangZh-byte/DeskCalendar`
   - 隐私政策：`https://github.com/ZhixiangZh-byte/DeskCalendar/blob/main/PRIVACY.md`
   - 服务条款：`https://github.com/ZhixiangZh-byte/DeskCalendar/blob/main/TERMS.md`
   - Authorized domains（授权网域）：`github.com`
2. **Audience（目标对象）** → Publishing status 点"**Publish app**"，改为"In production"。

- 不超过 100 个用户时，**不需要**提交 Google 审核。登录时会继续显示"Google 未验证此应用"，按上文"同事安装"第 3 步继续即可。
- 发布后，已登录的电脑需要重新登录一次，之后刷新令牌就不会再按 7 天过期。
- 改为"正式发布"后，其他人不必再被加为测试用户就能登录。
- 隐私政策和服务条款：根目录的 `PRIVACY.md`、`TERMS.md`；网页版在 `docs/`，可以通过 GitHub Pages 发布（见 `docs/README.md`）。
