// Anvil's MCP surface: /mcp.
//
// The suite's client speaks the modern era (2026-07-28) through server/discover and
// falls back to the legacy initialize handshake. Both answer the same tools. The
// tools are the forge itself: the six required ones (create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request) plus get_issue,
// all reading and writing the same store the REST surface uses, so an object created
// over MCP is the same object over REST, with the same numeric id.
//
// JSON-RPC discipline: an unknown tool or method is -32602/-32601, never an HTTP 500;
// a body that is not JSON is HTTP 400 with -32700; a notification (no id) gets no
// response; a missing required argument is an isError result. tools/list is a
// constant, so it is byte-identical across calls.

import { VIEWER_LOGIN, issueJson, pullJson, repoJson, type Store } from './store.ts';
import type { HandlerContext, HandlerResult } from './app.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the token owner. Returns the repository, including its full_name and numeric id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name. Returns the repository, including its numeric id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository. Returns the issue, including its number and numeric id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue of a repository by its number. Returns the issue, including its numeric id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch. Returns the pull request, including its number and numeric id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request. Returns merged true and the merge commit sha.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The first defined value among a semantic argument's accepted property names. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = String(arg(args, 'owner') ?? '');
  const repoName = String(arg(args, 'repo', 'repository', 'repository_name') ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(arg(args, 'name', 'repo_name') ?? '');
      if (repoNameArg === '') return errorResult('create_repo: name is required');
      const description = String(arg(args, 'description') ?? '');
      const isPrivate = arg(args, 'private') === true;
      const repo = store.createRepo(VIEWER_LOGIN, repoNameArg, description, isPrivate);
      if (repo === null) return errorResult(`create_repo: repository ${repoNameArg} already exists`);
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`get_repo: repository ${owner}/${repoName} not found`);
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`create_issue: repository ${owner}/${repoName} not found`);
      const title = String(arg(args, 'title') ?? '');
      if (title === '') return errorResult('create_issue: title is required');
      const issue = store.createIssue(repo, title, String(arg(args, 'body') ?? ''), []);
      return textResult(issueJson(issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`list_issues: repository ${owner}/${repoName} not found`);
      const state = String(arg(args, 'state') ?? 'open');
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(issue));
      return textResult({ issues });
    }
    case 'get_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`get_issue: repository ${owner}/${repoName} not found`);
      const number = Number(arg(args, 'issue_number', 'issueNumber', 'number'));
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return errorResult(`get_issue: issue ${number} not found`);
      return textResult(issueJson(issue));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`create_pull_request: repository ${owner}/${repoName} not found`);
      const title = String(arg(args, 'title') ?? '');
      const head = String(arg(args, 'head', 'head_ref', 'head_branch') ?? '');
      const base = String(arg(args, 'base', 'base_ref', 'base_branch') ?? '');
      if (title === '' || head === '' || base === '') return errorResult('create_pull_request: title, head and base are required');
      const pull = store.createPull(repo, head, base, title, String(arg(args, 'body') ?? ''));
      if (pull === null) return errorResult('create_pull_request: head or base branch does not exist');
      return textResult(pullJson(pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`merge_pull_request: repository ${owner}/${repoName} not found`);
      const number = Number(arg(args, 'pull_number', 'pullNumber', 'number', 'pr_number'));
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return errorResult(`merge_pull_request: pull request ${number} not found`);
      if (pull.merged) return errorResult(`merge_pull_request: pull request ${number} is already merged`);
      const mergedSha = store.mergePull(repo, pull);
      if (mergedSha === null) return errorResult(`merge_pull_request: pull request ${number} conflicts with the base branch`);
      return textResult({ merged: true, sha: mergedSha, message: 'Pull request successfully merged' });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Serve one MCP request. Notifications (no id) get no response body. */
export function handleMcp(store: Store, ctx: HandlerContext): HandlerResult {
  if (ctx.method === 'DELETE') return { status: 204, body: '' };
  if (ctx.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  let request: unknown;
  try {
    request = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: request body is not JSON') };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const rpc = request as Record<string, unknown>;
  // A notification carries no id and expects no response.
  if (rpc.id === undefined) return { status: 202, body: '' };
  const id = rpc.id;
  const method = String(rpc.method ?? '');
  const params = (rpc.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: 'anvil', version: '1.0.0' },
        }),
      };
    case 'initialize': {
      const requested = String((params.protocolVersion as string | undefined) ?? '');
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: 'anvil', version: '1.0.0' },
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) return { status: 200, body: rpcError(id, -32602, `unknown tool: ${name}`) };
      const result = callTool(store, name, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
  }
}
