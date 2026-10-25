# DeskCalendar 网站（GitHub Pages）

Google Auth Platform 的"品牌信息"（Branding）中可以填写应用主页、隐私政策、服务条款三个链接。最简单的做法是直接使用仓库中的页面：主页填 <https://github.com/ZhixiangZh-byte/DeskCalendar>，隐私政策填 <https://github.com/ZhixiangZh-byte/DeskCalendar/blob/main/PRIVACY.md>，服务条款填 <https://github.com/ZhixiangZh-byte/DeskCalendar/blob/main/TERMS.md>。本目录是同样内容的网页版，可以用 GitHub Pages 免费发布，不需要购买域名。

| 文件 | 用途 | 发布后的地址（示例） |
|---|---|---|
| `index.html` | 应用主页 | `https://zhixiangzh-byte.github.io/DeskCalendar/` |
| `privacy.html` | 隐私政策（含 Google 要求的 Limited Use 声明） | `https://zhixiangzh-byte.github.io/DeskCalendar/privacy.html` |
| `terms.html` | 服务条款 | `https://zhixiangzh-byte.github.io/DeskCalendar/terms.html` |

## 发布步骤

1. 仓库地址和联系方式（GitHub Issues）已经填好，不需要再修改。
2. 推送到 GitHub 后，打开仓库 Settings → Pages → Build and deployment，选择 Deploy from a branch → `main` 分支 → `/docs` 目录。
3. 几分钟后即可访问上表中的地址，把它们填到 Google Auth Platform → Branding。

## 需要知道的事

- **自用不需要这些页面。** 不超过 100 个用户、也不申请 Google 审核时，这三个链接都可以不填；把发布状态改为 "In production" 即可避免 7 天登录失效。
- **只有申请 Google 审核时才必须填写**（审核后，其他人登录时不再看到"未经验证的应用"）。本应用使用的日历和任务权限属于"敏感权限"，审核还要求：
  - 主页和隐私政策位于**已验证归属的域名**下：需要在 Google Search Console 中验证，并加入 Authorized domains；
  - 主页说明应用的用途，隐私政策说明如何使用 Google 用户数据；
  - 提交一段演示授权流程的视频。
- 关于 `github.io`：它在公共后缀列表中，所以 `<用户名>.github.io` 一般可以作为独立的域名在 Search Console 中验证（在站点根目录放 Google 提供的验证文件）。如果审核时 Google 不接受，再考虑购买一个便宜的域名，绑定到 GitHub Pages 即可。
