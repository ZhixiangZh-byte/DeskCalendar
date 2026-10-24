# DeskCalendar — Windows 桌面日历组件（基于 Google Calendar / Google Tasks）

> 2026-10-24 立项。取代同级目录 `..\CalendarApp\CalendarApp`（自建同步方案）。旧项目暂存不动，其中 `packages/core/src/views.ts` 的视图逻辑可参考。
> 本机环境（Tauri 2 / Rust / Node）见 `..\CalendarApp\CalendarApp\environment\ENVIRONMENT.md`。

## 思路
多平台同步交给 Google：手机端直接使用 Google Calendar / Google Tasks 官方 App 和小组件；本项目只做 Windows 桌面组件，通过 API 直接读写 Google 的数据。不自建服务器。

## 已定决策（2026-10-24 与用户确认）
| 项 | 决策 |
|---|---|
| 可勾选的计划 | Google Tasks。桌面组件里点击新建时，默认建一个精确到天的任务 |
| 有具体时间的计划 | Google Calendar 事件 |
| 长期规划 | Google Tasks 中单独建一个"长期规划"清单，不设日期 |
| 四象限标记 | 写在任务备注末尾的标签：`#重要`、`#紧急` |
| 回顾箱 | 派生：已完成的任务 + 已逾期未完成的任务 |
| Microsoft / Teams | 暂不实现，只保留数据源接口。学校账号不支持把 ICS 发布给校外邮箱；等用户联系 IT 后，视情况补 Graph API 或 ICS |
| 技术栈 | Tauri 2：Rust 后台负责 OAuth、API 调用和缓存；每个组件是一个独立的透明窗口 |

## Google API 已知限制
- Tasks API 的截止时间只保留日期（时间部分会被丢弃）；没有优先级字段，也没有自定义字段。
- OAuth 同意屏幕处于"测试"状态时，刷新令牌 7 天过期；正式使用前要改为"正式发布"（自用不必审核，登录时会提示"未经验证"）。

## 密钥与本机配置
- OAuth 客户端文件：`%USERPROFILE%\.deskcalendar\google-oauth-client.json`（在仓库外，不提交）。
- 刷新令牌存放在 Windows 凭据管理器中，不写入文件、仓库或日志。
- 从 Claude 桌面应用内启动的进程写 AppData 时会被重定向（见用户记忆 / 环境文档），所以涉及真实使用的测试，请用户自己从资源管理器或终端启动。

## 当前状态
- **可行性验证已完成（2026-10-24），结论：可行**。详见 `feasibility/README.md`。
  - `feasibility/google`：Google API 验证 16/16 通过。用户在自己的终端中运行，报告写入 `report.json`（不提交）。
  - `feasibility/desktop-layer`：桌面层原型。采用 `owned` 模式：普通顶层窗口，所有者设为 Progman，失去焦点后退到底层。按 Win+D 后可见，交互全部正常。挂成子窗口的方案收不到输入，**不要使用**。
- **第二阶段：月历组件 `app/`（2026-10-24 完成第一版，等待用户用真实账号测试）**。使用说明和代码结构见 `app/README.md`。
  - 分工：Rust 负责 OAuth 和凭据管理器、贴桌面层、托盘和设置；TypeScript 负责调用 Google API 和界面。访问令牌通过命令交给前端，刷新令牌只留在 Rust 侧。
  - 已验证：21 项前端单元测试、2 项 Rust 单元测试；在浏览器中用演示数据实测了新建任务、勾选完成、设置面板；exe 冒烟测试确认窗口所有者为 Progman，按 Win+D 后可见。
  - 尚未验证：真实账号的登录和数据读写（需用户本人操作）。
  - 暂未实现：编辑或删除任务、新建日历事件、离线修改队列（离线时只能查看）、按 syncToken 增量刷新（目前每次重新拉取当前月份）。
- 测试注意：`Shell.ToggleDesktop()` 在其他程序抢占前台时不可靠，自动化测试请用模拟 Win+D 按键。PowerShell 向 .NET 的 string 参数传 `$null` 时会变成空字符串，需要用 `[NullString]::Value`。

## 工作约定
- 与用户交流用中文。
- 安装新软件前先列出组件、来源和体积，等用户确认；UAC 由用户本人点击。
- 不改动本机与本项目无关的其他开发环境。
