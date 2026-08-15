# dsh-github-oauth

> DSH（DeepSeek Harness）**常驻插件** v1.0.1：GitHub OAuth 设备码登录 + 仓库 / Issues / 文件操作。
> 安装一次，每次启动 DSH 自动加载；凭据持久化，重启后自动恢复登录。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🤖 For AI Agents — 安装速查（本 README 供 agent 直接执行）

**插件类型**：DSH **web profile 常驻插件**（Cordis 包，Host + Client 双半部 + Typert Remote）。
**重要**：这不是动态插件 —— **不要**用 `cordis_define` / `cordis_run`，也不要改 `cordis.yml`。

| 项 | 值 |
|---|---|
| 目标目录 | `$DSH_HOME/profiles/web`（默认 `C:\Users\<user>\.dsh\profiles\web`，`$DSH_HOME` 为 `DSH_HOME` 环境变量，未设置则为 `~/.dsh`） |
| 安装位置 | `profiles/web/node_modules/dsh-github-oauth/`（整个包，直接放，不需要 pnpm/install） |
| 需要复制的文件 | 仅 4 个：`package.json`、`index.js`、`client.js`、`typert.host.js`（`dynamic/`、`LICENSE`、`.gitignore`、`README.md` 不需要） |
| 注册方式 | 向 `profiles/web/cordis.patch.yml` **末尾追加**（文件可能被 DSH Desktop 维护，追加即可，勿动已有内容） |
| 激活方式 | `cordis.patch.yml` 会被运行中的 DSH 热加载（`watchUserPatches`）；若 30 秒内 `设置 → GitHub` 面板未出现，**重启 DSH Desktop** |
| 依赖解析 | 包内 import 由 `profiles/node_modules` fallback 解析（`healProfilesModuleFallback`），无需安装任何依赖 |
| 运行平台 | **Windows 10 1803+**（Host 沙箱无 `fetch`，网络走 `subprocess` + 内置 `curl.exe`） |

**注册条目（追加到 cordis.patch.yml 末尾）：**

```yaml
- insert:
    - id: github-oauth
      name: 'dsh-github-oauth'
```

**一键安装（PowerShell，整段可复制执行）：**

```powershell
$ErrorActionPreference = 'Stop'
$src = 'https://raw.githubusercontent.com/SwordSifu/dsh-github-oauth/main'
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$web = Join-Path $home 'profiles\web'
$dst = Join-Path $web 'node_modules\dsh-github-oauth'
New-Item -ItemType Directory -Path $dst -Force | Out-Null
foreach ($f in @('package.json', 'index.js', 'client.js', 'typert.host.js')) {
  & curl.exe -sS -L -o (Join-Path $dst $f) ($src + '/' + $f)
  if ($LASTEXITCODE -ne 0) { throw "下载失败: $f" }
}
$patch = Join-Path $web 'cordis.patch.yml'
if (-not (Select-String -Path $patch -Pattern "name: 'dsh-github-oauth'" -Quiet)) {
  $entry = "- insert:`n    - id: github-oauth`n      name: 'dsh-github-oauth'`n"
  Add-Content -Path $patch -Value $entry -Encoding UTF8
}
Write-Output '已安装。验证：'
Push-Location $web
node --input-type=module -e "import('dsh-github-oauth').then(m => console.log('host OK:', m.name)).catch(e => { console.error('FAIL', e.message); process.exit(1) })"
Pop-Location
Write-Output '然后重启 DSH Desktop（或等热加载），设置 → GitHub 面板应出现。'
```

**验证清单（按顺序）：**

1. 模块可导入：在上面的 `profiles/web` 目录执行
   `node --input-type=module -e "import('dsh-github-oauth').then(m => console.log('OK', m.name))"`
2. 设置页出现 **GitHub** 面板（`设置 → GitHub`）
3. Agent 工具可用：`github_status` / `github_login` / `github_logout` / `github_list_repos` / `github_create_repo` / `github_delete_repo` / `github_list_issues` / `github_create_issue` / `github_get_file` / `github_write_file`
4. 首次使用需配置 OAuth App（见下节），然后点「使用 GitHub 登录」

**卸载：** 删除 `profiles/web/node_modules/dsh-github-oauth` 目录 + 移除 cordis.patch.yml 中对应 insert 条目，重启即可。

---

## 功能特性

- 🔐 **OAuth 设备码登录**：点击「使用 GitHub 登录」→ 浏览器自动打开授权页（用户码已预填）→ 点 Authorize 即完成，全程无需粘贴 Token
- 💾 **凭据持久化**：Client ID / Secret 与访问令牌存入 `$DSH_HOME/.credentials.yaml`，重启后自动恢复登录状态
- 🖥️ **设置面板**（`设置 → GitHub`）：凭据配置、一键登录/登出、仓库列表、创建仓库、Issues 浏览与新建
- 🤖 **10 个 Agent 工具**（见上方验证清单）
- 🔒 **安全**：令牌只存在于 Host 端凭据文件，不经过浏览器页面；删除仓库需二次确认（`confirm` 必须等于完整 `owner/repo`）

## 工作原理

采用 GitHub 官方推荐的 **Device Flow（设备码流程）**：

1. Host 端请求 `POST https://github.com/login/device/code` 获取设备码与 8 位用户码
2. 自动打开浏览器（`github.com/login/device`，用户码已预填），用户点击 Authorize
3. Host 端按 `interval` 轮询 `POST /login/oauth/access_token`，成功后持久化访问令牌
4. 之后所有 GitHub API 调用（`api.github.com`）都携带该令牌

> 不需要回调端口、不依赖本地 Web 服务器；沙箱内没有 `fetch`，网络层通过 `subprocess` 调用系统自带 `curl.exe`。

## 文件结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边（ESM）：OAuth 流程、GitHub API、Typert Remote 服务 `githubOAuth`、10 个 Agent 工具 |
| `client.js` | 浏览器半边：设置页 GitHub 面板（`window.__ModuleLoader__` 惰性 CJS 包） |
| `typert.host.js` | Typert Remote 严格描述（13 个 invocation，参数与结果均为 strict + zod 编解码） |
| `package.json` | `main` / `exports`（`./client`、`./typert`）/ `dsh.client` 声明 |
| `dynamic/` | 旧动态插件版（`cordis_define` / `cordis_run`，重启失效），仅供参考 |

> **v1.0.1 修复记录**：
> - typert-loader 启动时校验所有 codec 必须为 strict + zod v4，早期版本参数编解码误用 `src-json` 会导致重启后 profile 启动失败 → 已改为 strict + `z.any()` 直通；
> - `github_write_file` / `github_get_file` 对中文等非 ASCII 内容改用 UTF-8 base64（原 `btoa`/`atob` 对非 Latin-1 字符会抛 `Invalid character` 或产生乱码）。

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

## 故障排查（FAQ）

**Q：关闭 DSH 后无法启动（profile 启动失败）？**
A：v1.0.0 的 `typert.host.js` 参数编解码用了 `src-json`，而 typert-loader 启动校验要求 strict + zod v4，导致重启失败。已修复（v1.0.1）。若你已装过旧版：删除 `web/node_modules/dsh-github-oauth` 与 `cordis.patch.yml` 中的条目即可恢复，再按上方步骤重装。

**Q：登录时报 `device_flow_disabled`？**
A：OAuth App 未开启 Device Flow，去 App 设置页勾选 **Enable Device Flow**。

**Q：报错 "fetch is not available in the dynamic package sandbox"？**
A：那是旧动态插件的问题；常驻版没有该限制，网络统一走 `subprocess` + `curl.exe`。

**Q：`github_write_file` 写中文内容报 `Invalid character`？**
A：v1.0.0 的 `btoa` 编码不支持非 Latin-1 字符；v1.0.1 已改为 UTF-8 base64，更新后重启生效。

**Q：能读取私有仓库吗？**
A：能。`repo` scope 覆盖私有仓库的读写。

## 许可证

[MIT](./LICENSE) © 2026 SwordSifu
