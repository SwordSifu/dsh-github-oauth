# dsh-github-oauth

> DSH（DeepSeek Harness）动态 Cordis 插件：**GitHub OAuth 设备码流程登录 + 仓库操作**。
> 浏览器一键授权，**无需手动配置任何 Token**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 功能特性

- 🔐 **OAuth 设备码登录**：点击「使用 GitHub 登录」→ 浏览器自动打开授权页（用户码已预填）→ 点 Authorize 即完成，全程无需粘贴 Token
- 💾 **凭据持久化**：Client ID / Secret 与访问令牌存入 `$DSH_HOME/.credentials.yaml`，重启后自动恢复登录状态
- 🖥️ **设置面板**（`设置 → GitHub`）：凭据配置、一键登录/登出、仓库列表、创建仓库、Issues 浏览与新建
- 🤖 **10 个 Agent 工具**：`github_status` / `github_login` / `github_logout` / `github_list_repos` / `github_create_repo` / `github_delete_repo` / `github_list_issues` / `github_create_issue` / `github_get_file` / `github_write_file`
- 🔒 **安全**：令牌只存在于 Host 端凭据文件，不经过浏览器页面；删除仓库需二次确认（`confirm` 必须等于完整 `owner/repo`）

## 工作原理

采用 GitHub 官方推荐的 **Device Flow（设备码流程）**：

1. 插件请求 `POST https://github.com/login/device/code` 获取设备码与 8 位用户码
2. 自动打开浏览器（`github.com/login/device`，用户码已预填），用户点击 Authorize
3. 插件按 `interval` 轮询 `POST /login/oauth/access_token`，成功后持久化访问令牌
4. 之后所有 GitHub API 调用（`api.github.com`）都携带该令牌

> 不需要回调端口、不依赖本地 Web 服务器，因此对端口/代理环境非常健壮。

## 安装与使用（在 DSH 中）

这是一个动态 Cordis 插件（Host + Client 双半部），在 DSH 会话中通过 `cordis_define` / `cordis_run` 激活：

1. 用 `cordis_define`（plugin idPrefix 任意，如 `ghhub`）粘贴 [host.js](./host.js) 与 [client.js](./client.js) 的完整内容作为 `code.host` / `code.client`；
2. `cordis_run` 激活后，左侧设置栏出现 **GitHub** 面板；
3. 一次性配置 OAuth App 凭据（见下），然后点「使用 GitHub 登录」。

> 注意：动态插件的运行不跨进程重启；DSH 重启后需要重新 `cordis_run` 一次（凭据与登录状态会自动恢复）。

## 一次性配置 OAuth App（约 1 分钟）

GitHub 的 OAuth 机制要求每个应用注册自己的 Client ID / Secret（应用凭据，不是用户 Token）：

1. 打开 [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**
2. Application name 随意；Homepage URL 填 `https://github.com`；Authorization callback URL 填 `https://example.com`（设备码流程不会跳转）
3. **勾选 Enable Device Flow**（新创建的 App 默认关闭，不开启会报 `device_flow_disabled`）
4. 把 Client ID / Client Secret 填入 `设置 → GitHub` 面板保存

## 权限范围

申请 scope：`repo` + `delete_repo`

| 能力 | 说明 |
|---|---|
| 读写公开/私有仓库 | 代码、文件（Contents API 直接提交）、分支、提交、Release |
| Issues | 查看、创建、评论 |
| 删除仓库 | 需显式 confirm 完整 `owner/repo` |
| 写入 `.github/workflows/` | ❌ 需要额外 `workflow` scope |
| 修改账号资料 / SSH keys | ❌ 需要 `user` scope |

令牌可在 GitHub → Settings → Applications → Authorized OAuth Apps 随时撤销。

## 环境要求

- **DSH**（DeepSeek Harness），Host 端提供 `credentials` / `subprocess` / `timer` 服务
- **Windows**：Host 端沙箱禁止 `fetch`，网络层通过 `subprocess` 调用系统自带 **`curl.exe`**（Windows 10 1803+ 内置）

## FAQ

**Q：登录时报 `device_flow_disabled`？**
A：OAuth App 未开启 Device Flow，去 App 设置页勾选 **Enable Device Flow**。

**Q：报错 "fetch is not available in the dynamic package sandbox"？**
A：DSH 动态插件沙箱禁止直接 `fetch`，网络必须走 `subprocess` + `curl.exe`（本插件已内置该方案）。

**Q：能读取私有仓库吗？**
A：能。`repo` scope 覆盖私有仓库的读写。

## 许可证

[MIT](./LICENSE) © 2026 SwordSifu
