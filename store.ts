// Anvil's store: one in-memory forge.
//
// The trial runs one process for the whole conformance + benchmark phase, and
// persistence across restarts is not required, so the store is plain Maps. That is also
// the fastest shape for the four timed workloads: every hot path is a Map lookup.
//
// The object store is global and content-addressed (the same bytes hash to the same id
// in every repository), while refs, issues and pull requests live per repository. A
// repository's refs decide what a clone or fetch may see: reachability is computed from
// the graph, never from which repository an object arrived through.
//
// Determinism: nothing here reads a clock or Math.random. Server-made commits (contents
// writes, squash merges) carry one fixed timestamp and the token owner's identity, so
// the same sequence of operations always builds the same objects.
//
// The token owner is the scenario's viewer (wire.ts's fixed seed builds the same users
// in every run): adaiversen. Repositories belong to that login; any other owner reads
// 404, never 403.

import {
  EMPTY_TREE_OID,
  buildCommit,
  buildTreeForFiles,
  collectReachable,
  flattenTree,
  hashObject,
  isObjectId,
  parseCommit,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';

/** The login the bearer token names: the scenario viewer, from wire.ts's fixed seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** The fixed timestamp every server-made commit carries (wire.ts SCENARIO_EPOCH_SEC). */
export const SERVER_COMMIT_EPOCH = 1735689600;
/** merged_at for squash merges: the same epoch, as an ISO string. */
export const SERVER_MERGED_AT = '2025-01-01T00:00:00.000Z';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  /** The REST numeric id, stable across reads. */
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  /** Creation order, for created_at sorting (numbers already order it, this is explicit). */
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  /** The tips the pull request was opened from (the diff and the merge read these). */
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** The numeric database id, stable across reads. */
  id: number;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One shared counter for issues and pull requests, as GitHub numbers them. */
  nextNumber: number;
  /** Creation order, for GET /user/repos. */
  seq: number;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private repoSeq = 0;
  private opSeq = 0;

  /** Store an object if absent; answer its id. */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      id: this.nextRepoId++,
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      seq: this.repoSeq++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Resolve a ref argument: a branch name, a full ref, or a commit id. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) return this.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  }

  /** Every commit reachable from `from`, tip first (depth-first, parents after the child). */
  listCommits(from: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return out;
  }

  /** The branches of a repository: the default branch first, then the rest by name. */
  branchesOf(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => {
      if (a.name === repo.defaultBranch) return -1;
      if (b.name === repo.defaultBranch) return 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }

  /**
   * Commit `changes` (path -> new bytes, or null to delete) on `branch`, building the
   * real git objects: blobs, trees and a commit whose parent is the branch tip (or the
   * default branch tip when the branch is new, or nothing when the repository is empty).
   * The branch is created when it does not exist yet.
   */
  commitFiles(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const files = new Map<string, Buffer>();
    if (parent !== undefined) {
      const parentObject = this.objects.get(parent);
      if (parentObject?.type === 'commit') {
        for (const [path, entry] of flattenTree(parseCommit(parentObject.data).tree, this.lookup)) {
          const blob = this.objects.get(entry.oid);
          if (blob) files.set(path, blob.data);
        }
      }
    }
    for (const [path, data] of changes) {
      if (data === null) files.delete(path);
      else files.set(path, data);
    }
    const built = buildTreeForFiles(files);
    let treeOid = EMPTY_TREE_OID;
    for (const object of built) {
      const oid = this.putObject(object.type, object.data);
      // buildTreeForFiles appends the root tree last, so the last tree oid is the root.
      if (object.type === 'tree') treeOid = oid;
    }
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent === undefined ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: SERVER_COMMIT_EPOCH,
    });
    const commitOid = this.putObject('commit', commitData);
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: this.opSeq++,
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      headSha,
      baseSha,
      seq: this.opSeq++,
    };
    repo.pulls.push(pull);
    return pull;
  }

  // -------------------------------------------------------------------------------------------
  // diffs and merges
  // -------------------------------------------------------------------------------------------

  /** The file-level diff between two trees: path -> status and the two blob ids. */
  diffTrees(
    baseTreeOid: string,
    headTreeOid: string,
  ): Map<string, { status: 'added' | 'modified' | 'removed'; baseOid?: string; headOid?: string }> {
    const base = baseTreeOid === EMPTY_TREE_OID ? new Map() : flattenTree(baseTreeOid, this.lookup);
    const head = headTreeOid === EMPTY_TREE_OID ? new Map() : flattenTree(headTreeOid, this.lookup);
    const out = new Map<string, { status: 'added' | 'modified' | 'removed'; baseOid?: string; headOid?: string }>();
    for (const [path, entry] of head) {
      const old = base.get(path);
      if (old === undefined) out.set(path, { status: 'added', headOid: entry.oid });
      else if (old.oid !== entry.oid) out.set(path, { status: 'modified', baseOid: old.oid, headOid: entry.oid });
    }
    for (const [path, entry] of base) {
      if (!head.has(path)) out.set(path, { status: 'removed', baseOid: entry.oid });
    }
    return out;
  }

  private treeOf(commitOid: string): string {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(object.data).tree;
  }

  /** Line counts for one changed file, by a multiset diff of its lines. */
  private lineCounts(baseOid: string | undefined, headOid: string | undefined): { additions: number; deletions: number } {
    const linesOf = (oid: string | undefined): string[] => {
      if (oid === undefined) return [];
      const object = this.objects.get(oid);
      if (!object) return [];
      const text = object.data.toString('utf8');
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const count = (lines: string[]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
      return map;
    };
    const baseLines = count(linesOf(baseOid));
    const headLines = count(linesOf(headOid));
    let additions = 0;
    let deletions = 0;
    for (const [line, n] of headLines) additions += Math.max(0, n - (baseLines.get(line) ?? 0));
    for (const [line, n] of baseLines) deletions += Math.max(0, n - (headLines.get(line) ?? 0));
    return { additions, deletions };
  }

  /** A pull request's changed files, with GitHub's file shape. */
  prFiles(pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const diff = this.diffTrees(this.treeOf(pull.baseSha), this.treeOf(pull.headSha));
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const [filename, entry] of [...diff].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const counts = this.lineCounts(entry.baseOid, entry.headOid);
      out.push({
        filename,
        status: entry.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return out;
  }

  /**
   * Whether a pull request would conflict if merged now: any file it changes whose base
   * version has moved on the base branch since the pull request was opened.
   */
  prConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (baseTip === undefined) return true;
    const diff = this.diffTrees(this.treeOf(pull.baseSha), this.treeOf(pull.headSha));
    const baseNow = flattenTree(this.treeOf(baseTip), this.lookup);
    const baseThen = flattenTree(this.treeOf(pull.baseSha), this.lookup);
    for (const path of diff.keys()) {
      const now = baseNow.get(path)?.oid;
      const then = baseThen.get(path)?.oid;
      if (now !== then) return true;
    }
    return false;
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN, for the GraphQL mergeable field. */
  mergeableState(repo: Repo, pull: Pull): string {
    if (pull.merged) return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.prConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: apply its diff (baseSha -> headSha) onto the live base
   * tip, commit once with the base tip as parent, and move the base branch. Returns the
   * merge commit id, or null when the pull request conflicts.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.merged || pull.state !== 'open') return null;
    if (this.prConflicts(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`)!;
    const diff = this.diffTrees(this.treeOf(pull.baseSha), this.treeOf(pull.headSha));
    const files = new Map<string, Buffer>();
    for (const [path, entry] of flattenTree(this.treeOf(baseTip), this.lookup)) {
      const blob = this.objects.get(entry.oid);
      if (blob) files.set(path, blob.data);
    }
    for (const [path, entry] of diff) {
      if (entry.status === 'removed') {
        files.delete(path);
      } else if (entry.headOid !== undefined) {
        const blob = this.objects.get(entry.headOid);
        if (blob) files.set(path, blob.data);
      }
    }
    const built = buildTreeForFiles(files);
    let treeOid = EMPTY_TREE_OID;
    for (const object of built) {
      const oid = this.putObject(object.type, object.data);
      if (object.type === 'tree') treeOid = oid;
    }
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: SERVER_COMMIT_EPOCH,
    });
    const mergeSha = this.putObject('commit', commitData);
    repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = SERVER_MERGED_AT;
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON views (shared by the REST, GraphQL and MCP surfaces)
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

export function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${VIEWER_LOGIN}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${VIEWER_LOGIN}:${pull.base.ref}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

// ---------------------------------------------------------------------------------------------
// opaque global ids (GraphQL Relay ids): base64url of a typed path, never a bare number.
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** Reachability from roots, through the store's objects. */
export function reachableFrom(store: Store, roots: Iterable<string>): Set<string> {
  return collectReachable(roots, store.lookup, { allowMissing: true });
}

