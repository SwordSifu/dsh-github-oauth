/**
 * dsh-github-oauth — 常驻（resident）Host 半边。
 *
 * 由临时动态插件（dynamic/host.js）改造而来，业务逻辑不变：
 *   - GitHub OAuth Device Flow 登录（curl.exe 走 subprocess，沙箱内无 fetch）
 *   - 凭据存 `ctx.credentials`（$DSH_HOME/.credentials.yaml），重启自动恢复
 *   - 通过 Typert Remote（service `githubOAuth`）向浏览器设置面板提供 RPC
 *   - 注册 10 个 Agent 工具（github_status / github_login / ... / github_write_file）
 *
 * 常驻包结构（与 dsh-opencode-go-quota-card 相同的 web 插件格式）：
 *   package.json      —— name/main/exports（./client、./typert）+ dsh.client 声明
 *   index.js          —— 本文件（Host 半边）
 *   client.js         —— 浏览器半边（window.__ModuleLoader__.load 惰性 CJS 包）
 *   typert.host.js    —— Typert Remote 严格描述（invocations + zod 结果编解码）
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export const name = 'dsh-github-oauth';
export const inject = ['tools', 'credentials', 'subprocess'];

const REFS = {
  clientId: credentialRef('GITHUB_OAUTH_CLIENT_ID'),
  clientSecret: credentialRef('GITHUB_OAUTH_CLIENT_SECRET'),
  token: credentialRef('GITHUB_OAUTH_ACCESS_TOKEN'),
};

export class GitHubOAuthService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'githubOAuth');
    this.ctx = ctx;
    this.config = config ?? {};
    this.phase = 'idle'; // idle | waiting | connected
    this.user = null;
    this.pending = null;
    this.error = null;
    this.pollDisposer = null;
    this.pollDelay = 5000;
    this.userLoading = false;
    void this.bootstrap();
  }

  // ---------- helpers ----------
  enc(s) {
    const unreserved = /[A-Za-z0-9\-._~]/;
    let out = '';
    const str = String(s);
    const te = new TextEncoder();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (unreserved.test(ch)) { out += ch; continue; }
      const bytes = te.encode(ch);
      for (let j = 0; j < bytes.length; j++) out += '%' + bytes[j].toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }
  // GitHub 不接受把仓库名整体百分号编码（%2F 会 404），owner/repo 要拆开分别编码
  repoPath(fullName) {
    const parts = String(fullName).split('/');
    if (parts.length !== 2) throw new Error('仓库名称必须是 owner/repo 格式');
    return this.enc(parts[0]) + '/' + this.enc(parts[1]);
  }
  async getCred(ref) { const r = await this.ctx.credentials.resolve(ref); return r ? r.value : undefined; }
  setCred(ref, value) { return this.ctx.credentials.set(ref, value); }
  unsetCred(ref) { return this.ctx.credentials.unset(ref); }

  // ---------- HTTP via curl.exe (sandbox blocks fetch; subprocess is the network path) ----------
  curl(args, opts = {}) {
    return new Promise((resolve, reject) => {
      let handle;
      try {
        handle = this.ctx.subprocess.spawn({
          argv: ['curl.exe', '-sS', '--max-time', String(opts.timeoutMs || 30), '-w', '\n__DSH_HTTP__%{http_code}', ...args],
          cwd: '.',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8388608 }, stderr: { maxBytes: 65536 } },
          graceMs: 5000
        });
      } catch (e) { reject(e); return; }
      handle.done.then((outcome) => {
        const out = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.finalize() : { text: '' };
        const raw = out.text || '';
        if (outcome.exitCode !== 0) {
          const err = new Error('网络请求失败 (curl exit ' + outcome.exitCode + '): ' + raw.slice(0, 300));
          err.exitCode = outcome.exitCode;
          reject(err);
          return;
        }
        const idx = raw.lastIndexOf('__DSH_HTTP__');
        if (idx === -1) { resolve({ text: raw, status: 0 }); return; }
        const status = parseInt(raw.slice(idx + '__DSH_HTTP__'.length).trim(), 10) || 0;
        resolve({ text: raw.slice(0, idx), status });
      }, (e) => reject(e));
    });
  }
  parseJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  httpError(status, data, fallback) {
    const msg = (data && typeof data === 'object' && typeof data.message === 'string') ? data.message : fallback;
    const err = new Error(msg);
    err.status = status;
    return err;
  }

  setError(e) { this.error = (e && e.message) ? String(e.message) : String(e); }

  stopPolling() { if (this.pollDisposer) { try { this.pollDisposer(); } catch {} this.pollDisposer = null; } }

  // ---------- GitHub API ----------
  async ghApi(path, opts = {}) {
    const token = (opts.token !== undefined) ? opts.token : await this.getCred(REFS.token);
    const args = [];
    args.push('-H', 'Accept: application/vnd.github+json');
    args.push('-H', 'User-Agent: dsh-github-oauth');
    args.push('-H', 'X-GitHub-Api-Version: 2022-11-28');
    if (token) args.push('-H', 'Authorization: Bearer ' + token);
    const method = opts.method || 'GET';
    if (opts.json !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(opts.json));
    else if (opts.form !== undefined) args.push('-H', 'Content-Type: application/x-www-form-urlencoded', '-d', opts.form);
    if (method !== 'GET') args.push('-X', method);
    args.push('https://api.github.com' + path);
    const { text, status } = await this.curl(args, opts);
    const data = this.parseJson(text);
    if (status >= 400) throw this.httpError(status, data, 'GitHub API HTTP ' + status);
    return data;
  }

  async requireToken() {
    const token = await this.getCred(REFS.token);
    if (!token) throw new Error('尚未登录 GitHub。请先在「设置 → GitHub」面板或调用 github_login 完成 OAuth 登录。');
    return token;
  }

  async refreshUser() {
    this.userLoading = true;
    try {
      const me = await this.ghApi('/user');
      this.user = { login: me.login, name: me.name || me.login, avatarUrl: me.avatar_url, htmlUrl: me.html_url };
      this.phase = 'connected';
      this.error = null;
    } catch (e) {
      if (e.status === 401) { this.phase = 'idle'; this.user = null; this.error = 'GitHub 登录已失效（令牌被撤销或过期），请重新登录。'; }
      else this.setError(e);
    } finally { this.userLoading = false; }
  }
  async bootstrap() {
    const token = await this.getCred(REFS.token);
    if (token) await this.refreshUser();
  }

  // ---------- device flow ----------
  async ghLogin(path, form) {
    const { text, status } = await this.curl([
      '-H', 'Accept: application/json',
      '-H', 'Content-Type: application/x-www-form-urlencoded',
      '-d', form,
      'https://github.com/login' + path
    ]);
    const data = this.parseJson(text);
    if (status >= 400) {
      const msg = (data && (data.error_description || data.error)) || ('HTTP ' + status);
      const err = new Error(String(msg));
      err.status = status;
      err.oauthError = data && data.error;
      throw err;
    }
    return data;
  }

  openBrowser(url) {
    try {
      this.ctx.subprocess.spawn({
        argv: ['cmd.exe', '/c', 'start', '', url],
        cwd: '.',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        graceMs: 10000
      });
    } catch (e) { /* 打不开也没关系，面板会展示链接 */ }
  }

  async startLogin() {
    this.stopPolling();
    this.error = null;
    const clientId = await this.getCred(REFS.clientId);
    if (!clientId) { this.error = '尚未配置 GitHub OAuth App 的 Client ID / Client Secret。'; return { ok: false, error: this.error }; }
    const form = 'client_id=' + this.enc(clientId) + '&scope=' + this.enc('repo delete_repo');
    let data;
    try {
      data = await this.ghLogin('/device/code', form);
    } catch (e) {
      const msg = String((e && e.message) || e);
      this.error = msg;
      return { ok: false, error: msg };
    }
    if (!data || data.error) {
      const msg = String((data && (data.error_description || data.error)) || '设备码请求失败');
      this.error = msg;
      return { ok: false, error: msg };
    }
    this.pending = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      url: data.verification_uri + '?user_code=' + this.enc(data.user_code),
      expiresAt: Date.now() + ((data.expires_in || 900) * 1000)
    };
    this.phase = 'waiting';
    this.pollDelay = Math.max(data.interval || 5, 5) * 1000;
    this.openBrowser(this.pending.url);
    this.schedulePoll();
    return { ok: true, userCode: this.pending.userCode, url: this.pending.url };
  }

  schedulePoll() {
    this.stopPolling();
    this.pollDisposer = this.ctx.setTimeout(async () => {
      await this.pollOnce();
      if (this.phase === 'waiting') this.schedulePoll();
    }, this.pollDelay);
  }

  async pollOnce() {
    try {
      const clientId = await this.getCred(REFS.clientId);
      const clientSecret = await this.getCred(REFS.clientSecret);
      if (!this.pending || !clientId || !clientSecret) { this.stopPolling(); this.phase = 'idle'; return; }
      if (Date.now() > this.pending.expiresAt) { this.stopPolling(); this.pending = null; this.phase = 'idle'; this.error = '设备码已过期，请重新发起登录。'; return; }
      const form = 'client_id=' + this.enc(clientId)
        + '&client_secret=' + this.enc(clientSecret)
        + '&device_code=' + this.enc(this.pending.deviceCode)
        + '&grant_type=' + this.enc('urn:ietf:params:oauth:grant-type:device_code');
      const data = await this.ghLogin('/oauth/access_token', form);
      if (data && data.access_token) {
        this.stopPolling();
        await this.setCred(REFS.token, data.access_token);
        this.pending = null;
        await this.refreshUser();
        return;
      }
      const code = data && data.error;
      if (code === 'authorization_pending') return;
      if (code === 'slow_down') { this.pollDelay = Math.min(this.pollDelay + 5000, 60000); return; }
      this.stopPolling();
      this.pending = null;
      this.phase = 'idle';
      this.error = (data && (data.error_description || data.error)) || '设备码授权失败。';
    } catch (e) {
      if (this.phase !== 'waiting') this.setError(e);
    }
  }

  // ---------- Typert Remote 方法（client.js 通过 remote.githubOAuth 调用） ----------
  async state() {
    const clientId = await this.getCred(REFS.clientId);
    const token = await this.getCred(REFS.token);
    if (!this.user && token && !this.userLoading && this.phase !== 'waiting') { void this.refreshUser(); }
    return {
      phase: this.phase,
      user: this.user,
      pending: this.pending ? { userCode: this.pending.userCode, url: this.pending.url, verificationUri: this.pending.verificationUri } : null,
      error: this.error,
      configured: !!clientId,
      hasToken: !!token
    };
  }

  async saveConfig(args) {
    const a = args || {};
    if (!a.clientId || !a.clientSecret) throw new Error('Client ID 和 Client Secret 不能为空。');
    await this.setCred(REFS.clientId, String(a.clientId));
    await this.setCred(REFS.clientSecret, String(a.clientSecret));
    this.error = null;
    return { ok: true };
  }

  async clearConfig() {
    await this.unsetCred(REFS.clientId);
    await this.unsetCred(REFS.clientSecret);
    return { ok: true };
  }

  async login() {
    try { return await this.startLogin(); }
    catch (e) { this.setError(e); return { ok: false, error: String((e && e.message) || e) }; }
  }

  async cancelLogin() {
    this.stopPolling();
    this.pending = null;
    this.phase = 'idle';
    return { ok: true };
  }

  async logout() {
    this.stopPolling();
    await this.unsetCred(REFS.token);
    this.user = null;
    this.phase = 'idle';
    this.pending = null;
    this.error = null;
    return { ok: true };
  }

  async repos() {
    await this.requireToken();
    const list = await this.ghApi('/user/repos?affiliation=' + this.enc('owner,collaborator') + '&per_page=100&sort=updated');
    return list.map((r) => ({ fullName: r.full_name, name: r.name, private: r.private, description: r.description, htmlUrl: r.html_url, defaultBranch: r.default_branch, pushedAt: r.pushed_at }));
  }

  async createRepo(args) {
    await this.requireToken();
    const a = args || {};
    if (!a.name) throw new Error('仓库名不能为空。');
    const repo = await this.ghApi('/user/repos', { method: 'POST', json: { name: String(a.name), description: a.description ? String(a.description) : undefined, private: !!a.private, auto_init: a.autoInit !== undefined ? !!a.autoInit : true } });
    return { fullName: repo.full_name, htmlUrl: repo.html_url, private: repo.private, defaultBranch: repo.default_branch };
  }

  async deleteRepo(args) {
    await this.requireToken();
    const a = args || {};
    if (!a.fullName) throw new Error('需要 fullName（格式 owner/repo）。');
    if (a.confirm !== a.fullName) throw new Error('删除确认不匹配：请输入完整的 ' + a.fullName + ' 作为 confirm。');
    await this.ghApi('/repos/' + this.repoPath(a.fullName), { method: 'DELETE' });
    return { ok: true, deleted: a.fullName };
  }

  async issues(args) {
    await this.requireToken();
    const a = args || {};
    if (!a.repo) throw new Error('需要 repo（格式 owner/repo）。');
    const state = a.state ? String(a.state) : 'open';
    const list = await this.ghApi('/repos/' + this.repoPath(a.repo) + '/issues?state=' + this.enc(state) + '&per_page=50');
    return list.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, htmlUrl: i.html_url, user: i.user && i.user.login, createdAt: i.created_at, comments: i.comments }));
  }

  async createIssue(args) {
    await this.requireToken();
    const a = args || {};
    if (!a.repo || !a.title) throw new Error('需要 repo 和 title。');
    const issue = await this.ghApi('/repos/' + this.repoPath(a.repo) + '/issues', { method: 'POST', json: { title: String(a.title), body: a.body ? String(a.body) : undefined } });
    return { number: issue.number, title: issue.title, htmlUrl: issue.html_url };
  }

  async getFile(args) {
    await this.requireToken();
    const a = args || {};
    if (!a.repo || !a.path) throw new Error('需要 repo 和 path。');
    const data = await this.ghApi('/repos/' + this.repoPath(a.repo) + '/contents/' + this.enc(a.path));
    if (Array.isArray(data)) return { kind: 'directory', entries: data.map((e) => ({ name: e.name, type: e.type, path: e.path, size: e.size })) };
    return { kind: 'file', name: data.name, path: data.path, sha: data.sha, size: data.size, encoding: data.encoding, content: data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : data.content, htmlUrl: data.html_url };
  }

  async writeFile(args) {
    await this.requireToken();
    const a = args || {};
    if (!a.repo || !a.path || a.content === undefined) throw new Error('需要 repo、path 和 content。');
    let sha;
    try {
      const existing = await this.ghApi('/repos/' + this.repoPath(a.repo) + '/contents/' + this.enc(a.path));
      if (!Array.isArray(existing) && existing.sha) sha = existing.sha;
    } catch (e) { if (e.status !== 404) throw e; }
    const json = { message: a.message ? String(a.message) : 'chore: update ' + a.path, content: Buffer.from(String(a.content), 'utf8').toString('base64') };
    if (sha) json.sha = sha;
    if (a.branch) json.branch = String(a.branch);
    const res = await this.ghApi('/repos/' + this.repoPath(a.repo) + '/contents/' + this.enc(a.path), { method: 'PUT', json });
    return { updated: !!sha, commitSha: res.commit && res.commit.sha, commitHtmlUrl: res.commit && res.commit.html_url, fileHtmlUrl: res.content && res.content.html_url };
  }
}

// ---------- Agent 工具 ----------
const toolRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

const TOOL_DEFS = [
  { name: 'github_status', description: '查看当前与 GitHub 的连接状态：是否已配置 OAuth App、是否已登录、当前用户、是否有待处理的登录流程或错误。', parameters: {}, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.state() },
  { name: 'github_login', description: '通过 GitHub OAuth 设备码流程登录（无需手动配置 Token）。会尝试自动打开浏览器并返回 8 位用户码与授权 URL；用户在该页面输入用户码并授权后，插件自动完成登录并持久化访问令牌。', parameters: {}, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.login() },
  { name: 'github_logout', description: '注销 GitHub 登录：删除已保存的访问令牌。', parameters: {}, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.logout() },
  { name: 'github_list_repos', description: '列出当前账号有权访问的仓库（含协作仓库）。', parameters: { affiliation: { type: 'string', description: '过滤：owner / collaborator / organization_member，可逗号组合，默认 owner,collaborator' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.repos(args) },
  { name: 'github_create_repo', description: '在 GitHub 上创建新仓库。', parameters: { name: { type: 'string', required: true, description: '仓库名' }, private: { type: 'boolean', description: '是否私有，默认 false' }, description: { type: 'string', description: '仓库描述' }, autoInit: { type: 'boolean', description: '是否自动创建 README，默认 true' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.createRepo(args) },
  { name: 'github_delete_repo', description: '删除仓库（危险操作）。confirm 必须与 fullName 完全一致才会执行。', parameters: { fullName: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, confirm: { type: 'string', required: true, description: '必须输入与 fullName 相同的值以确认删除' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.deleteRepo(args) },
  { name: 'github_list_issues', description: '列出仓库的 issues（不含 PR）。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, state: { type: 'string', description: 'open / closed / all，默认 open' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.issues(args) },
  { name: 'github_create_issue', description: '在仓库中新建 issue。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, title: { type: 'string', required: true, description: 'issue 标题' }, body: { type: 'string', description: 'issue 正文' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.createIssue(args) },
  { name: 'github_get_file', description: '读取仓库中某个文件或目录的内容。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, path: { type: 'string', required: true, description: '文件路径，如 README.md 或 src/' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.getFile(args) },
  { name: 'github_write_file', description: '创建或更新仓库中的文件（通过 Contents API 直接提交）。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, path: { type: 'string', required: true, description: '文件路径' }, content: { type: 'string', required: true, description: '文件内容' }, message: { type: 'string', description: '提交信息，默认 chore: update <path>' }, branch: { type: 'string', description: '目标分支，默认默认分支' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args, exec, svc) => svc.writeFile(args) },
];

export function apply(ctx, config) {
  const service = new GitHubOAuthService(ctx, config);

  ctx.effect(() => () => { service.stopPolling(); }, 'dsh-github-oauth.lifecycle');

  for (const def of TOOL_DEFS) {
    const execute = def.execute;
    ctx.effect(() => ctx.tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: def.output,
      execute: async (args, exec) => execute(args, exec, service),
    })), 'dsh-github-oauth.tool.' + def.name);
  }
}
