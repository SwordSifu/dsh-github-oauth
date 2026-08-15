// dsh-github-oauth 的 Typert Remote Host 清单（手写，格式同 dsh-opencode-go-quota-card）。
// typert-loader 通过 package.json exports["./typert"] 导入本模块，把 invocations
// 注册进 ctx.typert（strict 模式）；dsh-api-gateway 再把 /api 上的
// "githubOAuth/<method>" 端点分派到 GitHubOAuthService 的同名方法。
// 参数与结果均用 strict + zod 编解码（z.any 直通，客户端负责形状，
// 仅做边界校验；typert-loader 要求所有 codec 必须为 strict + zod v4）。
import { z } from 'zod';

const ANY = { mode: 'strict', typeSymbol: 'dsh-github-oauth#JsonValue', schema: z.any() };
const ARGS = { name: 'args', wire: 'args', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-github-oauth#Args', schema: z.any() } };

const base = { service: 'githubOAuth', namespace: 'githubOAuth', invocation: { kind: 'direct' } };

const METHODS = [
  ['state', []],
  ['saveConfig', [ARGS]],
  ['clearConfig', []],
  ['login', []],
  ['cancelLogin', []],
  ['logout', []],
  ['repos', []],
  ['createRepo', [ARGS]],
  ['deleteRepo', [ARGS]],
  ['issues', [ARGS]],
  ['createIssue', [ARGS]],
  ['getFile', [ARGS]],
  ['writeFile', [ARGS]],
];

export const TYPERT = {
  package: 'dsh-github-oauth',
  face: 'host',
  schemas: [],
  invocations: METHODS.map(([method, parameters]) => ({
    ...base,
    parameters,
    result: ANY,
    id: 'dsh-github-oauth#' + method,
    method,
  })),
  model: { services: [], events: [], objects: [] },
};
