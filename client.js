return {
  inject: ['slots', 'timer'],
  apply(ctx) {
    const css = `
.gh-panel { display: flex; flex-direction: column; gap: 12px; max-width: 660px; }
.gh-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px; background: var(--dsw-alias-bg-layer-1); }
.gh-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; margin: 0 0 10px; }
.gh-row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
.gh-input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.gh-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 13px; }
.gh-btn:disabled { opacity: 0.5; cursor: default; }
.gh-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.gh-code { font-family: ui-monospace, Consolas, monospace; font-size: 22px; letter-spacing: 5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); padding: 10px 14px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2); }
.gh-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; margin: 4px 0; }
.gh-err { color: var(--dsw-alias-state-error-primary); font-size: 13px; }
.gh-ok { color: var(--dsw-alias-state-success-primary); font-size: 13px; }
.gh-link { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.gh-link:hover { text-decoration: underline; }
.gh-avatar { width: 30px; height: 30px; border-radius: 50%; }
.gh-repo { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
.gh-repo-name { font-weight: 600; font-size: 13px; }
.gh-badge { font-size: 10px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.gh-issue { padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; }
`;
    ctx.effect(() => styles.insert(css));

    const h = React.createElement;

    const GitHubPanel = () => {
      const [snap, setSnap] = React.useState(null);
      const [clientId, setClientId] = React.useState('');
      const [clientSecret, setClientSecret] = React.useState('');
      const [repos, setRepos] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState(null);
      const [issuesRepo, setIssuesRepo] = React.useState(null);
      const [issues, setIssues] = React.useState(null);
      const [issueTitle, setIssueTitle] = React.useState('');
      const [issueBody, setIssueBody] = React.useState('');
      const [repoName, setRepoName] = React.useState('');
      const [repoDesc, setRepoDesc] = React.useState('');
      const [repoPrivate, setRepoPrivate] = React.useState(false);

      const refresh = () => {
        host.call('state').then((s) => setSnap(s)).catch((e) => setMsg({ kind: 'error', text: String((e && e.message) || e) }));
      };

      React.useEffect(() => {
        refresh();
        const d = ctx.timer.interval(refresh, 2000);
        return () => d();
      }, []);

      const loadRepos = () => {
        setBusy('repos');
        host.call('repos').then((list) => setRepos(list)).catch((e) => setMsg({ kind: 'error', text: String((e && e.message) || e) })).then(() => setBusy(''));
      };

      React.useEffect(() => {
        if (snap && snap.phase === 'connected' && repos === null) loadRepos();
      }, [snap]);

      const loadIssues = (repo) => {
        setIssuesRepo(repo);
        setIssues(null);
        setBusy('issues');
        host.call('issues', { repo }).then((list) => setIssues(list)).catch((e) => setMsg({ kind: 'error', text: String((e && e.message) || e) })).then(() => setBusy(''));
      };

      const call = (method, args) => {
        setBusy(method);
        return host.call(method, args || {}).then((res) => { setMsg(null); refresh(); return res; }).catch((e) => { setMsg({ kind: 'error', text: String((e && e.message) || e) }); refresh(); return null; }).then((res) => { setBusy(''); return res; });
      };

      const btn = (label, onClick, opts) => h('button', { className: 'gh-btn' + ((opts && opts.primary) ? ' gh-btn-primary' : ''), onClick, disabled: !!((opts && opts.disabled) || busy !== '') }, label);

      const children = [];
      if (!snap) {
        children.push(h('div', { className: 'gh-card' }, h('p', { className: 'gh-muted' }, '加载中…')));
      } else {
        if (!snap.configured) {
          children.push(h('div', { className: 'gh-card' }, ...[
            h('p', { className: 'gh-title' }, '① 配置 OAuth App（一次性）'),
            h('p', { className: 'gh-muted' }, 'GitHub 的 OAuth 机制要求每个应用注册自己的 Client ID / Secret。创建一次后本插件会安全保存，之后所有登录都不需要再配置 Token。'),
            h('ol', { className: 'gh-muted' }, ...[
              h('li', null, '打开 ', h('a', { className: 'gh-link', href: 'https://github.com/settings/developers', target: '_blank', rel: 'noreferrer' }, 'github.com/settings/developers'), ' → New OAuth App'),
              h('li', null, 'Application name 随意；Homepage URL 填 https://github.com；Authorization callback URL 填 https://example.com（设备码流程不会跳转回调）'),
              h('li', null, '创建后把 Client ID 与 Client Secret 粘贴到下方并保存'),
            ]),
            h('div', { className: 'gh-row' }, h('input', { className: 'gh-input', placeholder: 'Client ID', value: clientId, onChange: (e) => setClientId(e.target.value) })),
            h('div', { className: 'gh-row' }, h('input', { className: 'gh-input', type: 'password', placeholder: 'Client Secret', value: clientSecret, onChange: (e) => setClientSecret(e.target.value) })),
            h('div', { className: 'gh-row' }, btn('保存凭据', () => call('saveConfig', { clientId, clientSecret }), { primary: true })),
          ]));
        }

        const statusChildren = [];
        if (snap.phase === 'connected' && snap.user) {
          statusChildren.push(h('div', { className: 'gh-row' }, ...[
            h('img', { className: 'gh-avatar', src: snap.user.avatarUrl, alt: '' }),
            h('div', null, ...[
              h('div', { className: 'gh-repo-name' }, snap.user.login),
              h('div', { className: 'gh-muted' }, snap.user.name || ''),
            ]),
            h('span', { style: { flex: 1 } }),
            h('span', { className: 'gh-ok' }, '已连接'),
            btn('退出登录', () => call('logout')),
          ]));
        } else if (snap.phase === 'waiting' && snap.pending) {
          statusChildren.push(
            h('p', { className: 'gh-title' }, '② 在浏览器中完成授权'),
            h('div', { className: 'gh-row' }, h('span', { className: 'gh-code' }, snap.pending.userCode)),
            h('p', { className: 'gh-muted' }, '浏览器应已自动打开 GitHub 授权页；如果没有，请点击下方链接，输入上面的代码并点击 Authorize：'),
            h('div', { className: 'gh-row' }, h('a', { className: 'gh-link', href: snap.pending.url, target: '_blank', rel: 'noreferrer' }, snap.pending.url)),
            h('p', { className: 'gh-muted' }, '授权后本页面会自动变为已连接状态…'),
            h('div', { className: 'gh-row' }, btn('取消', () => call('cancelLogin'))),
          );
        } else {
          statusChildren.push(
            h('p', { className: 'gh-title' }, '② 登录 GitHub'),
            h('p', { className: 'gh-muted' }, snap.hasToken ? '正在恢复登录状态…' : (snap.configured ? '使用 OAuth 设备码流程登录：点击后浏览器会打开 GitHub 授权页，无需手动配置 Token。' : '请先完成上方 ① 的 OAuth App 配置。')),
            h('div', { className: 'gh-row' }, btn('使用 GitHub 登录', () => call('login'), { primary: true, disabled: !snap.configured })),
          );
        }
        children.push(h('div', { className: 'gh-card' }, ...statusChildren));

        const errText = snap.error || (msg && msg.text);
        if (errText) children.push(h('div', { className: 'gh-card' }, h('p', { className: 'gh-err' }, errText)));

        if (snap.phase === 'connected') {
          const repoChildren = [
            h('div', { className: 'gh-row' }, ...[
              h('p', { className: 'gh-title', style: { margin: 0 } }, '③ 仓库'),
              h('span', { style: { flex: 1 } }),
              btn('刷新', loadRepos),
            ]),
            h('div', { className: 'gh-row' }, h('input', { className: 'gh-input', placeholder: '新仓库名', value: repoName, onChange: (e) => setRepoName(e.target.value) })),
            h('div', { className: 'gh-row' }, h('input', { className: 'gh-input', placeholder: '描述（可选）', value: repoDesc, onChange: (e) => setRepoDesc(e.target.value) })),
            h('div', { className: 'gh-row' }, ...[
              h('label', { className: 'gh-muted', style: { display: 'flex', alignItems: 'center', gap: 6 } }, h('input', { type: 'checkbox', checked: repoPrivate, onChange: (e) => setRepoPrivate(e.target.checked) }), '私有'),
              h('span', { style: { flex: 1 } }),
              btn('创建仓库', () => { call('createRepo', { name: repoName, description: repoDesc, private: repoPrivate }).then(() => { setRepoName(''); setRepoDesc(''); loadRepos(); }); }),
            ]),
          ];
          if (repos === null) {
            repoChildren.push(h('p', { className: 'gh-muted' }, '正在加载仓库列表…'));
          } else if (repos.length === 0) {
            repoChildren.push(h('p', { className: 'gh-muted' }, '暂无仓库。'));
          } else {
            repos.forEach((r) => {
              repoChildren.push(h('div', { className: 'gh-repo' }, ...[
                h('div', { className: 'gh-row', style: { margin: 0 } }, ...[
                  h('a', { className: 'gh-repo-name gh-link', href: r.htmlUrl, target: '_blank', rel: 'noreferrer' }, r.fullName),
                  h('span', { className: 'gh-badge' }, r.private ? '私有' : '公开'),
                  h('span', { style: { flex: 1 } }),
                  btn(issuesRepo === r.fullName ? '收起' : 'Issues', () => { if (issuesRepo === r.fullName) { setIssuesRepo(null); setIssues(null); } else loadIssues(r.fullName); }),
                ]),
                r.description ? h('div', { className: 'gh-muted' }, r.description) : null,
              ]));
            });
          }
          children.push(h('div', { className: 'gh-card' }, ...repoChildren));

          if (issuesRepo) {
            const issueChildren = [
              h('p', { className: 'gh-title' }, 'Issues · ' + issuesRepo),
              h('div', { className: 'gh-row' }, h('input', { className: 'gh-input', placeholder: 'Issue 标题', value: issueTitle, onChange: (e) => setIssueTitle(e.target.value) })),
              h('div', { className: 'gh-row' }, h('input', { className: 'gh-input', placeholder: 'Issue 内容（可选）', value: issueBody, onChange: (e) => setIssueBody(e.target.value) })),
              h('div', { className: 'gh-row' }, btn('新建 Issue', () => { call('createIssue', { repo: issuesRepo, title: issueTitle, body: issueBody }).then(() => { setIssueTitle(''); setIssueBody(''); loadIssues(issuesRepo); }); }, { primary: true })),
            ];
            if (issues === null) issueChildren.push(h('p', { className: 'gh-muted' }, '加载中…'));
            else if (issues.length === 0) issueChildren.push(h('p', { className: 'gh-muted' }, '暂无 open issue'));
            else issues.forEach((i) => issueChildren.push(h('div', { className: 'gh-issue' }, ...[
              h('a', { className: 'gh-link', href: i.htmlUrl, target: '_blank', rel: 'noreferrer' }, '#' + i.number + ' ' + i.title),
              h('div', { className: 'gh-muted' }, 'by ' + i.user + ' · ' + i.createdAt + ' · ' + i.comments + ' 评论'),
            ])));
            children.push(h('div', { className: 'gh-card' }, ...issueChildren));
          }
        }
      }
      return h('div', { className: 'gh-panel' }, ...children);
    };

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'github',
      order: 25,
      label: 'GitHub'
    }, GitHubPanel));
  }
}
