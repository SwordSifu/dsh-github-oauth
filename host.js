return {
  inject: ['credentials', 'subprocess', 'timer'],
  apply(ctx) {
    const REFS = { clientId: 'GITHUB_OAUTH_CLIENT_ID', clientSecret: 'GITHUB_OAUTH_CLIENT_SECRET', token: 'GITHUB_OAUTH_ACCESS_TOKEN' };
    const creds = ctx.credentials;
    const timer = ctx.timer;

    // ---------- helpers ----------
    function enc(s) {
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
    function repoPath(fullName) {
      const parts = String(fullName).split('/');
      if (parts.length !== 2) throw new Error('仓库名称必须是 owner/repo 格式');
      return enc(parts[0]) + '/' + enc(parts[1]);
    }
    async function getCred(ref) { const r = await creds.resolve(ref); return r ? r.value : undefined; }
    const setCred = (ref, value) => creds.set(ref, value);
    const unsetCred = (ref) => creds.unset(ref);

    // ---------- HTTP via curl.exe (sandbox blocks fetch; subprocess is the network path) ----------
    const HTTP_MARK = '__DSH_HTTP__';
    function curl(args, opts = {}) {
      return new Promise((resolve, reject) => {
        let handle;
        try {
          handle = ctx.subprocess.spawn({
            argv: ['curl.exe', '-sS', '--max-time', String(opts.timeoutMs || 30), '-w', '\n' + HTTP_MARK + '%{http_code}', ...args],
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
          const idx = raw.lastIndexOf(HTTP_MARK);
          if (idx === -1) { resolve({ text: raw, status: 0 }); return; }
          const status = parseInt(raw.slice(idx + HTTP_MARK.length).trim(), 10) || 0;
          resolve({ text: raw.slice(0, idx), status });
        }, (e) => reject(e));
      });
    }
    function parseJson(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    }
    function httpError(status, data, fallback) {
      const msg = (data && typeof data === 'object' && typeof data.message === 'string') ? data.message : fallback;
      const err = new Error(msg);
      err.status = status;
      return err;
    }

    // ---------- state ----------
    let phase = 'idle'; // idle | waiting | connected
    let user = null;
    let pending = null;
    let error = null;
    let pollDisposer = null;
    let pollDelay = 5000;
    let userLoading = false;
    const setError = (e) => { error = (e && e.message) ? String(e.message) : String(e); };
    function stopPolling() { if (pollDisposer) { pollDisposer(); pollDisposer = null; } }

    // ---------- GitHub API ----------
    async function ghApi(path, opts = {}) {
      const token = (opts.token !== undefined) ? opts.token : await getCred(REFS.token);
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
      const { text, status } = await curl(args, opts);
      const data = parseJson(text);
      if (status >= 400) throw httpError(status, data, 'GitHub API HTTP ' + status);
      return data;
    }
    const gh = (path, opts) => ghApi(path, opts);

    async function requireToken() {
      const token = await getCred(REFS.token);
      if (!token) throw new Error('尚未登录 GitHub。请先在「设置 → GitHub」面板或调用 github_login 完成 OAuth 登录。');
      return token;
    }

    async function refreshUser() {
      userLoading = true;
      try {
        const me = await gh('/user');
        user = { login: me.login, name: me.name || me.login, avatarUrl: me.avatar_url, htmlUrl: me.html_url };
        phase = 'connected';
        error = null;
      } catch (e) {
        if (e.status === 401) { phase = 'idle'; user = null; error = 'GitHub 登录已失效（令牌被撤销或过期），请重新登录。'; }
        else setError(e);
      } finally { userLoading = false; }
    }
    async function bootstrap() {
      const token = await getCred(REFS.token);
      if (token) await refreshUser();
    }

    // ---------- device flow ----------
    async function ghLogin(path, form) {
      const { text, status } = await curl([
        '-H', 'Accept: application/json',
        '-H', 'Content-Type: application/x-www-form-urlencoded',
        '-d', form,
        'https://github.com/login' + path
      ]);
      const data = parseJson(text);
      if (status >= 400) {
        const msg = (data && (data.error_description || data.error)) || ('HTTP ' + status);
        const err = new Error(String(msg));
        err.status = status;
        err.oauthError = data && data.error;
        throw err;
      }
      return data;
    }

    async function openBrowser(url) {
      try {
        ctx.subprocess.spawn({
          argv: ['cmd.exe', '/c', 'start', '', url],
          cwd: '.',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
          graceMs: 10000
        });
      } catch (e) { /* 打不开也没关系，面板会展示链接 */ }
    }

    async function startLogin() {
      stopPolling();
      error = null;
      const clientId = await getCred(REFS.clientId);
      if (!clientId) { error = '尚未配置 GitHub OAuth App 的 Client ID / Client Secret。'; return { ok: false, error }; }
      const form = 'client_id=' + enc(clientId) + '&scope=' + enc('repo delete_repo');
      let data;
      try {
        data = await ghLogin('/device/code', form);
      } catch (e) {
        const msg = String((e && e.message) || e);
        error = msg;
        return { ok: false, error: msg };
      }
      if (!data || data.error) {
        const msg = String((data && (data.error_description || data.error)) || '设备码请求失败');
        error = msg;
        return { ok: false, error: msg };
      }
      pending = {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        url: data.verification_uri + '?user_code=' + enc(data.user_code),
        expiresAt: Date.now() + ((data.expires_in || 900) * 1000)
      };
      phase = 'waiting';
      pollDelay = Math.max(data.interval || 5, 5) * 1000;
      openBrowser(pending.url);
      schedulePoll();
      return { ok: true, userCode: pending.userCode, url: pending.url };
    }

    function schedulePoll() {
      stopPolling();
      pollDisposer = timer.timeout(async () => {
        await pollOnce();
        if (phase === 'waiting') schedulePoll();
      }, pollDelay);
    }

    async function pollOnce() {
      try {
        const clientId = await getCred(REFS.clientId);
        const clientSecret = await getCred(REFS.clientSecret);
        if (!pending || !clientId || !clientSecret) { stopPolling(); phase = 'idle'; return; }
        if (Date.now() > pending.expiresAt) { stopPolling(); pending = null; phase = 'idle'; error = '设备码已过期，请重新发起登录。'; return; }
        const form = 'client_id=' + enc(clientId)
          + '&client_secret=' + enc(clientSecret)
          + '&device_code=' + enc(pending.deviceCode)
          + '&grant_type=' + enc('urn:ietf:params:oauth:grant-type:device_code');
        const data = await ghLogin('/oauth/access_token', form);
        if (data && data.access_token) {
          stopPolling();
          await setCred(REFS.token, data.access_token);
          pending = null;
          await refreshUser();
          return;
        }
        const code = data && data.error;
        if (code === 'authorization_pending') return;
        if (code === 'slow_down') { pollDelay = Math.min(pollDelay + 5000, 60000); return; }
        stopPolling();
        pending = null;
        phase = 'idle';
        error = (data && (data.error_description || data.error)) || '设备码授权失败。';
      } catch (e) {
        if (phase !== 'waiting') setError(e);
      }
    }

    // ---------- RPC ----------
    async function rpcState() {
      const clientId = await getCred(REFS.clientId);
      const token = await getCred(REFS.token);
      if (!user && token && !userLoading && phase !== 'waiting') { void refreshUser(); }
      return {
        phase,
        user,
        pending: pending ? { userCode: pending.userCode, url: pending.url, verificationUri: pending.verificationUri } : null,
        error,
        configured: !!clientId,
        hasToken: !!token
      };
    }

    const rpc = {
      state: rpcState,
      async saveConfig(args) {
        const a = args || {};
        if (!a.clientId || !a.clientSecret) throw new Error('Client ID 和 Client Secret 不能为空。');
        await setCred(REFS.clientId, String(a.clientId));
        await setCred(REFS.clientSecret, String(a.clientSecret));
        error = null;
        return { ok: true };
      },
      async clearConfig() {
        await unsetCred(REFS.clientId);
        await unsetCred(REFS.clientSecret);
        return { ok: true };
      },
      async login() { try { return await startLogin(); } catch (e) { setError(e); return { ok: false, error: String((e && e.message) || e) }; } },
      async cancelLogin() { stopPolling(); pending = null; phase = 'idle'; return { ok: true }; },
      async logout() { stopPolling(); await unsetCred(REFS.token); user = null; phase = 'idle'; pending = null; error = null; return { ok: true }; },
      async repos() {
        await requireToken();
        const list = await gh('/user/repos?affiliation=' + enc('owner,collaborator') + '&per_page=100&sort=updated');
        return list.map((r) => ({ fullName: r.full_name, name: r.name, private: r.private, description: r.description, htmlUrl: r.html_url, defaultBranch: r.default_branch, pushedAt: r.pushed_at }));
      },
      async createRepo(args) {
        await requireToken();
        const a = args || {};
        if (!a.name) throw new Error('仓库名不能为空。');
        const repo = await gh('/user/repos', { method: 'POST', json: { name: String(a.name), description: a.description ? String(a.description) : undefined, private: !!a.private, auto_init: a.autoInit !== undefined ? !!a.autoInit : true } });
        return { fullName: repo.full_name, htmlUrl: repo.html_url, private: repo.private, defaultBranch: repo.default_branch };
      },
      async deleteRepo(args) {
        await requireToken();
        const a = args || {};
        if (!a.fullName) throw new Error('需要 fullName（格式 owner/repo）。');
        if (a.confirm !== a.fullName) throw new Error('删除确认不匹配：请输入完整的 ' + a.fullName + ' 作为 confirm。');
        await gh('/repos/' + repoPath(a.fullName), { method: 'DELETE' });
        return { ok: true, deleted: a.fullName };
      },
      async issues(args) {
        await requireToken();
        const a = args || {};
        if (!a.repo) throw new Error('需要 repo（格式 owner/repo）。');
        const state = a.state ? String(a.state) : 'open';
        const list = await gh('/repos/' + repoPath(a.repo) + '/issues?state=' + enc(state) + '&per_page=50');
        return list.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, htmlUrl: i.html_url, user: i.user && i.user.login, createdAt: i.created_at, comments: i.comments }));
      },
      async createIssue(args) {
        await requireToken();
        const a = args || {};
        if (!a.repo || !a.title) throw new Error('需要 repo 和 title。');
        const issue = await gh('/repos/' + repoPath(a.repo) + '/issues', { method: 'POST', json: { title: String(a.title), body: a.body ? String(a.body) : undefined } });
        return { number: issue.number, title: issue.title, htmlUrl: issue.html_url };
      },
      async getFile(args) {
        await requireToken();
        const a = args || {};
        if (!a.repo || !a.path) throw new Error('需要 repo 和 path。');
        const data = await gh('/repos/' + repoPath(a.repo) + '/contents/' + enc(a.path));
        if (Array.isArray(data)) return { kind: 'directory', entries: data.map((e) => ({ name: e.name, type: e.type, path: e.path, size: e.size })) };
        return { kind: 'file', name: data.name, path: data.path, sha: data.sha, size: data.size, encoding: data.encoding, content: data.encoding === 'base64' ? atob(data.content) : data.content, htmlUrl: data.html_url };
      },
      async writeFile(args) {
        await requireToken();
        const a = args || {};
        if (!a.repo || !a.path || a.content === undefined) throw new Error('需要 repo、path 和 content。');
        let sha;
        try {
          const existing = await gh('/repos/' + repoPath(a.repo) + '/contents/' + enc(a.path));
          if (!Array.isArray(existing) && existing.sha) sha = existing.sha;
        } catch (e) { if (e.status !== 404) throw e; }
        const json = { message: a.message ? String(a.message) : 'chore: update ' + a.path, content: btoa(String(a.content)) };
        if (sha) json.sha = sha;
        if (a.branch) json.branch = String(a.branch);
        const res = await gh('/repos/' + repoPath(a.repo) + '/contents/' + enc(a.path), { method: 'PUT', json });
        return { updated: !!sha, commitSha: res.commit && res.commit.sha, commitHtmlUrl: res.commit && res.commit.html_url, fileHtmlUrl: res.content && res.content.html_url };
      }
    };

    // ---------- model tools ----------
    const toolRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
    const toolDefs = [
      { name: 'github_status', description: '查看当前与 GitHub 的连接状态：是否已配置 OAuth App、是否已登录、当前用户、是否有待处理的登录流程或错误。', parameters: {}, output: { schema: { type: 'json' }, render: toolRender }, execute: async () => rpc.state() },
      { name: 'github_login', description: '通过 GitHub OAuth 设备码流程登录（无需手动配置 Token）。会尝试自动打开浏览器并返回 8 位用户码与授权 URL；用户在该页面输入用户码并授权后，插件自动完成登录并持久化访问令牌。', parameters: {}, output: { schema: { type: 'json' }, render: toolRender }, execute: async () => rpc.login() },
      { name: 'github_logout', description: '注销 GitHub 登录：删除已保存的访问令牌。', parameters: {}, output: { schema: { type: 'json' }, render: toolRender }, execute: async () => rpc.logout() },
      { name: 'github_list_repos', description: '列出当前账号有权访问的仓库（含协作仓库）。', parameters: { affiliation: { type: 'string', description: '过滤：owner / collaborator / organization_member，可逗号组合，默认 owner,collaborator' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.repos(args) },
      { name: 'github_create_repo', description: '在 GitHub 上创建新仓库。', parameters: { name: { type: 'string', required: true, description: '仓库名' }, private: { type: 'boolean', description: '是否私有，默认 false' }, description: { type: 'string', description: '仓库描述' }, autoInit: { type: 'boolean', description: '是否自动创建 README，默认 true' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.createRepo(args) },
      { name: 'github_delete_repo', description: '删除仓库（危险操作）。confirm 必须与 fullName 完全一致才会执行。', parameters: { fullName: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, confirm: { type: 'string', required: true, description: '必须输入与 fullName 相同的值以确认删除' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.deleteRepo(args) },
      { name: 'github_list_issues', description: '列出仓库的 issues（不含 PR）。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, state: { type: 'string', description: 'open / closed / all，默认 open' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.issues(args) },
      { name: 'github_create_issue', description: '在仓库中新建 issue。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, title: { type: 'string', required: true, description: 'issue 标题' }, body: { type: 'string', description: 'issue 正文' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.createIssue(args) },
      { name: 'github_get_file', description: '读取仓库中某个文件或目录的内容。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, path: { type: 'string', required: true, description: '文件路径，如 README.md 或 src/' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.getFile(args) },
      { name: 'github_write_file', description: '创建或更新仓库中的文件（通过 Contents API 直接提交）。', parameters: { repo: { type: 'string', required: true, description: '仓库完整名称 owner/repo' }, path: { type: 'string', required: true, description: '文件路径' }, content: { type: 'string', required: true, description: '文件内容' }, message: { type: 'string', description: '提交信息，默认 chore: update <path>' }, branch: { type: 'string', description: '目标分支，默认默认分支' } }, output: { schema: { type: 'json' }, render: toolRender }, execute: async (args) => rpc.writeFile(args) }
    ];

    ctx.effect(() => {
      const disposers = [];
      for (const name of Object.keys(rpc)) disposers.push(harness.handle(name, rpc[name]));
      for (const def of toolDefs) disposers.push(harness.registerTool(ctx, harness.defineTool(def)));
      bootstrap().catch((e) => setError(e));
      return () => { stopPolling(); for (const d of disposers) { try { d(); } catch (e) {} } };
    });
  }
}
