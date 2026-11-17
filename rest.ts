// Anvil's REST v3 surface: /api/v3.
//
// The shapes follow GitHub's REST API as the suite expects them: 201 on create with the
// resource, 204 on delete, 422 for a duplicate name or an unknown label, 409 for a
// stale contents sha, 405 for a conflicted merge. Every reply is JSON and carries
// X-GitHub-Request-Id (the server sets it); an unknown route is a JSON 404 and a
// malformed JSON body is a 400.
//
// A repository under any owner other than the token owner reads 404, never 403.
// Contents writes and squash merges build real git objects in the shared store, so a
// commit the REST surface made is the same kind of object a push made, and reads back
// through the git surface with the same SHA-1.

import { flattenTree, parseCommit, parseTree } from './gitcore.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  issueJson,
  pullJson,
  repoJson,
  type Repo,
  type Store,
} from './store.ts';
import type { HandlerContext, HandlerResult } from './app.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(status: number, value: unknown, headers: Record<string, string> = {}): HandlerResult {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: value as Record<string, unknown> };
}

function error(status: number, message: string): HandlerResult {
  return json(status, { message });
}

/** Parse a JSON body; a non-empty body that does not parse is a 400. */
function readBody(ctx: HandlerContext): { ok: true; value: Record<string, unknown> } | { ok: false; result: HandlerResult } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, result: error(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, result: error(400, 'malformed JSON body') };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Slice a list into a page and build the Link header for the next page, if any. */
function paginate<T>(items: readonly T[], ctx: HandlerContext): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(ctx.query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    headers.link = `<http://${ctx.host}${ctx.path}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}

/** A repository the caller may see, or the 404 that hides every other owner's repos. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name) ?? null;
}

function commitJson(store: Store, sha: string): Record<string, unknown> {
  const object = store.getObject(sha);
  if (!object || object.type !== 'commit') return { sha, commit: { message: '' }, parents: [] };
  const commit = parseCommit(object.data);
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: '' };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      // GitHub returns the message without the trailing newline the object carries.
      message: commit.message.replace(/\n+$/, ''),
      author: person(commit.author),
      committer: person(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

/** Serve one REST request. `path` is everything after /api/v3. Null means not a REST route. */
export function handleRest(store: Store, path: string, ctx: HandlerContext): HandlerResult | null {
  const segments = path === '' ? [] : path.split('/').filter((segment) => segment.length > 0);
  const method = ctx.method;

  // GET /api/v3/ — the API root; no auth required, and it names the OAuth scopes.
  if (method === 'GET' && segments.length === 0) {
    return json(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'ada iversen', email: 'adaiversen@example.invalid' });
  }

  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      const name = asString(body.value.name).trim();
      if (name === '') return error(422, 'name is required');
      const description = asString(body.value.description);
      const isPrivate = asBoolean(body.value.private);
      const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      if (repo === null) return error(422, 'name already exists on this account');
      if (typeof body.value.default_branch === 'string' && body.value.default_branch !== '') {
        repo.defaultBranch = body.value.default_branch;
      }
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, headers } = paginate(repos, ctx);
      return json(200, page.map((repo) => repoJson(repo)), headers);
    }
    return null;
  }

  // /repos/{owner}/{name} and everything beneath it.
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    const rest = segments.slice(3);
    const repo = findRepo(store, owner, name);
    if (repo === null) return error(404, 'Not Found');

    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = readBody(ctx);
        if (!body.ok) return body.result;
        if (typeof body.value.description === 'string') repo.description = body.value.description;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return null;
    }

    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        return json(200, store.branchesOf(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
      }
      if (method === 'GET' && rest.length === 2) {
        const branchName = decodeURIComponent(rest[1]!);
        const branch = store.branchesOf(repo).find((entry) => entry.name === branchName);
        if (branch === undefined) return error(404, 'Not Found');
        return json(200, { name: branch.name, commit: { sha: branch.sha } });
      }
      return null;
    }

    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === undefined) return error(404, 'Not Found');
      const commits = store.listCommits(tip).map((sha) => commitJson(store, sha));
      const { page, headers } = paginate(commits, ctx);
      return json(200, page, headers);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = readBody(ctx);
        if (!body.ok) return body.result;
        const ref = asString(body.value.ref);
        const sha = asString(body.value.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return error(422, 'ref and sha are required');
        if (store.getObject(sha) === undefined) return error(422, 'object does not exist');
        if (repo.refs.has(ref)) return error(422, 'reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha } });
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const branchName = decodeURIComponent(rest[3]!);
        const sha = repo.refs.get(`refs/heads/${branchName}`);
        if (sha === undefined) return error(404, 'Not Found');
        return json(200, { ref: `refs/heads/${branchName}`, object: { sha } });
      }
      return null;
    }

    return handleRestResource(store, repo, rest, ctx);
  }
  return null;
}

function handleRestResource(store: Store, repo: Repo, rest: string[], ctx: HandlerContext): HandlerResult | null {
  const method = ctx.method;

  // ---------------------------------------------------------------- contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);

    if (method === 'GET') {
      if (tip === undefined) return error(404, 'Not Found');
      const tipObject = store.getObject(tip);
      if (!tipObject || tipObject.type !== 'commit') return error(404, 'Not Found');
      let treeOid = parseCommit(tipObject.data).tree;
      let prefix = '';
      const segments = filePath === '' ? [] : filePath.split('/');
      for (let index = 0; index < segments.length; index += 1) {
        const name = segments[index]!;
        const entries = parseTree(store.getObject(treeOid)?.data ?? Buffer.alloc(0));
        const entry = entries.find((candidate) => candidate.name === name);
        if (entry === undefined) return error(404, 'Not Found');
        prefix = prefix === '' ? name : `${prefix}/${name}`;
        if (index === segments.length - 1) {
          if (entry.mode === '40000') {
            return json(200, dirListing(store, entry.oid, prefix));
          }
          const blob = store.getObject(entry.oid);
          if (!blob) return error(404, 'Not Found');
          return json(200, {
            type: 'file',
            name,
            path: prefix,
            sha: entry.oid,
            size: blob.data.length,
            encoding: 'base64',
            content: blob.data.toString('base64'),
          });
        }
        if (entry.mode !== '40000') return error(404, 'Not Found');
        treeOid = entry.oid;
      }
      return json(200, dirListing(store, treeOid, ''));
    }

    if (method === 'PUT') {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      const message = asString(body.value.message);
      const contentRaw = asString(body.value.content);
      if (contentRaw === '') return error(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentRaw, 'base64');
      } catch {
        return error(422, 'content is not valid base64');
      }
      const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : repo.defaultBranch;
      const sha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      const branchTip = store.resolveRef(repo, branch);
      const existing = branchTip === undefined ? undefined : flattenTree(parseCommit(store.getObject(branchTip)!.data).tree, store.lookup).get(filePath);
      if (existing !== undefined) {
        if (sha === undefined) return error(409, 'sha is required to update a file');
        if (sha !== existing.oid) return error(409, 'sha does not match the current file');
      } else if (sha !== undefined) {
        return error(404, 'Not Found');
      }
      const commitSha = store.commitFiles(repo, branch, new Map([[filePath, content]]), message === '' ? `Update ${filePath}` : message);
      const blobSha = store.putObject('blob', content);
      const name = filePath.split('/').pop() ?? filePath;
      return json(existing === undefined ? 201 : 200, {
        content: { type: 'file', name, path: filePath, sha: blobSha, size: content.length, encoding: 'base64', content: contentRaw },
        commit: { sha: commitSha, message },
      });
    }

    if (method === 'DELETE') {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      const message = asString(body.value.message);
      const sha = asString(body.value.sha);
      const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : repo.defaultBranch;
      const branchTip = store.resolveRef(repo, branch);
      if (branchTip === undefined) return error(404, 'Not Found');
      const existing = flattenTree(parseCommit(store.getObject(branchTip)!.data).tree, store.lookup).get(filePath);
      if (existing === undefined) return error(404, 'Not Found');
      if (sha !== '' && sha !== existing.oid) return error(409, 'sha does not match the current file');
      const commitSha = store.commitFiles(repo, branch, new Map([[filePath, null]]), message === '' ? `Delete ${filePath}` : message);
      return json(200, { commit: { sha: commitSha, message } });
    }
    return null;
  }

  // ------------------------------------------------------------------ labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST' && rest.length === 1) {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      const name = asString(body.value.name).trim();
      if (name === '') return error(422, 'name is required');
      const color = asString(body.value.color) || '000000';
      const existing = repo.labels.get(name);
      if (existing !== undefined) return json(201, { name: existing.name, color: existing.color });
      repo.labels.set(name, { name, color });
      return json(201, { name, color });
    }
    return null;
  }

  // ------------------------------------------------------------------ issues
  if (rest[0] === 'issues') {
    const number = rest.length >= 2 ? Number.parseInt(rest[1]!, 10) : Number.NaN;
    if (rest.length === 1 && method === 'POST') {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      const title = asString(body.value.title).trim();
      if (title === '') return error(422, 'title is required');
      const labelNames = Array.isArray(body.value.labels) ? body.value.labels : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const labelName of labelNames) {
        if (typeof labelName !== 'string') continue;
        const label = repo.labels.get(labelName);
        if (label === undefined) return error(422, `label ${labelName} does not exist`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, asString(body.value.body), labels);
      return json(201, issueJson(issue));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, headers } = paginate(issues, ctx);
      return json(200, page.map((issue) => issueJson(issue)), headers);
    }
    if (Number.isNaN(number)) return error(404, 'Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return error(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return json(200, issueJson(issue));
    if (rest.length === 2 && method === 'PATCH') {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
      if (typeof body.value.title === 'string') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      return json(200, issueJson(issue));
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
      }
      if (method === 'POST') {
        const body = readBody(ctx);
        if (!body.ok) return body.result;
        const commentBody = asString(body.value.body);
        if (commentBody === '') return error(422, 'body is required');
        const comment = store.createComment(issue, commentBody);
        return json(201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
      }
    }
    return null;
  }

  // -------------------------------------------------------------------- pulls
  if (rest[0] === 'pulls') {
    const number = rest.length >= 2 ? Number.parseInt(rest[1]!, 10) : Number.NaN;
    if (rest.length === 1 && method === 'POST') {
      const body = readBody(ctx);
      if (!body.ok) return body.result;
      const head = asString(body.value.head);
      const base = asString(body.value.base);
      const title = asString(body.value.title).trim();
      if (head === '' || base === '' || title === '') return error(422, 'head, base and title are required');
      const pull = store.createPull(repo, head, base, title, asString(body.value.body));
      if (pull === null) return error(422, 'head or base branch does not exist');
      return json(201, pullJson(pull));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      pulls = [...pulls].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, headers } = paginate(pulls, ctx);
      return json(200, page.map((pull) => pullJson(pull)), headers);
    }
    if (Number.isNaN(number)) return error(404, 'Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return error(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return json(200, pullJson(pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return json(200, store.prFiles(pull));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.merged) return error(405, 'pull request is already merged');
      const mergedSha = store.mergePull(repo, pull);
      if (mergedSha === null) return error(405, 'merge conflict');
      return json(200, { merged: true, sha: mergedSha, message: 'Pull request successfully merged' });
    }
    return null;
  }
  return null;
}

function dirListing(store: Store, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = store.getObject(treeOid);
  if (!object || object.type !== 'tree') return [];
  const entries = parseTree(object.data);
  return entries.map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      return { type: 'dir', name: entry.name, path, sha: entry.oid };
    }
    const blob = store.getObject(entry.oid);
    return { type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 };
  });
}
