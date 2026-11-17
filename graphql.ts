// Anvil's GraphQL surface: /api/graphql.
//
// The suite's documents are fixed strings, so this is a small, strict parser and
// executor for exactly the GraphQL they use: queries and mutations, variables, input
// objects, enum values, lists, inline fragments, named fragments, batched bodies, and
// the __type introspection shape. It is not a general GraphQL server, and it does not
// pretend to be one.
//
// An unknown field is a 200 with an errors array (the GraphQL way), never a 500: the
// message names the field, as `Cannot query field "x" on type "Y".` Global ids are
// opaque base64url strings, never bare numbers, and they round-trip through node(id:).

import {
  globalId,
  parseGlobalId,
  type Repo,
  type Store,
} from './store.ts';
import type { HandlerContext, HandlerResult } from './app.ts';

// ---------------------------------------------------------------------------------------------
// the document parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export type DefinitionNode = OperationNode | FragmentNode;

export class GraphQLError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@|&='.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped === '\\' ? '\\' : escaped === '"' ? '"' : escaped === '/' ? '/' : escaped;
          end += 2;
          continue;
        }
        value += source[end]!;
        end += 1;
      }
      if (end >= source.length) throw new GraphQLError('unterminated string');
      tokens.push(JSON.stringify(value));
      index = end + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end]!)) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    throw new GraphQLError(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class Parser {
  private readonly tokens: string[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(): string | null {
    return this.tokens[this.position] ?? null;
  }

  next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw new GraphQLError('unexpected end of document');
    this.position += 1;
    return token;
  }

  expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new GraphQLError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(actual)}`);
  }

  isName(token: string | null): boolean {
    return token !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !['query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null'].includes(token);
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek() !== null) definitions.push(this.parseDefinition());
    return definitions;
  }

  parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token === 'fragment') return this.parseFragment();
    if (token === 'query' || token === 'mutation' || token === 'subscription') return this.parseOperation();
    if (token === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    throw new GraphQLError(`unexpected token ${JSON.stringify(token)} at the top level`);
  }

  parseOperation(): OperationNode {
    const operation = this.next() as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.isName(this.peek())) name = this.next();
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expect(')');
    }
    this.skipDirectives();
    return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  parseFragment(): FragmentNode {
    this.expect('fragment');
    const name = this.next();
    this.expect('on');
    const typeCondition = this.next();
    this.skipDirectives();
    return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
  }

  parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      const token = this.peek();
      if (token === 'on') {
        this.next();
        const typeCondition = this.next();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.isName(token)) {
        const name = this.next();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.next();
    let alias = name;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.peek() === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, arguments: args, selectionSet };
  }
}

export function parseDocument(source: string): DefinitionNode[] {
  return new Parser(source).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type RuntimeObject = Record<string, unknown> & { __typename: string };
type Resolver = (source: RuntimeObject, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function userObject(): RuntimeObject {
  return { __typename: 'User', login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid', avatarUrl: '' };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const argument of field.arguments) args[argument.name] = resolveValue(argument.value, ctx.variables);
  return args;
}

/** The fields each type answers. A field missing here is an unknown-field error. */
const FIELD_SETS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name', 'email', 'avatarUrl']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url']),
  Ref: new Set(['name', 'target', 'prefix']),
  Commit: new Set(['oid']),
  Issue: new Set(['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'url', 'comments', 'labels', 'createdAt', 'updatedAt']),
  PullRequest: new Set(['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'url', 'createdAt', 'updatedAt']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  FileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  CommentConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  LabelConnection: new Set(['nodes', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  FileEdge: new Set(['node', 'cursor']),
  CommentEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  Comment: new Set(['id', 'databaseId', 'body', 'author', 'url']),
  Label: new Set(['name', 'color']),
  PullRequestFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description', 'type']),
  __EnumValue: new Set(['name', 'description']),
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'author', 'comments', 'createdAt', 'updatedAt', 'labels', 'repository', 'viewerDidAuthor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'comments', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url', 'createdAt'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Comment: ['id', 'databaseId', 'body', 'author', 'url'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PULL_REQUEST', 'CODE', 'LABEL', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function repositoryObject(repo: Repo): RuntimeObject {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: globalId('repo', repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    owner: userObject(),
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, target: tip === undefined ? null : { __typename: 'Commit', oid: tip }, prefix: 'refs/heads/' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    _repo: repo,
  };
}

function issueObject(repo: Repo, issue: import('./store.ts').Issue): RuntimeObject {
  return {
    __typename: 'Issue',
    id: globalId('issue', repo.owner, repo.name, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userObject(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    _repo: repo,
    _issue: issue,
  };
}

function pullObject(repo: Repo, pull: import('./store.ts').Pull): RuntimeObject {
  return {
    __typename: 'PullRequest',
    id: globalId('pr', repo.owner, repo.name, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: 'UNKNOWN',
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    author: userObject(),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    _repo: repo,
    _pull: pull,
  };
}

function connection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  toNode: (item: T) => RuntimeObject,
  connectionType: string,
  edgeType: string,
): RuntimeObject {
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : -1;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const start = after + 1;
  const slice = items.slice(start, start + first);
  const nodes = slice.map(toNode);
  return {
    __typename: connectionType,
    nodes,
    edges: nodes.map((node, index) => ({ __typename: edgeType, node, cursor: encodeCursor(start + index) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? encodeCursor(start) : null,
      endCursor: nodes.length > 0 ? encodeCursor(start + nodes.length - 1) : null,
    },
    totalCount: items.length,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): RuntimeObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let issues = repo.issues.filter((issue) => {
    if (states === null) return true;
    const wanted = issue.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(wanted);
  });
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'DESC' ? -1 : 1;
  issues = [...issues].sort((a, b) => (a.seq - b.seq) * direction);
  return connection(issues, args, (issue) => issueObject(repo, issue), 'IssueConnection', 'IssueEdge');
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): RuntimeObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = repo.pulls.filter((pull) => {
    if (states === null) return true;
    const wanted = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(wanted);
  });
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'DESC' ? -1 : 1;
  pulls = [...pulls].sort((a, b) => (a.seq - b.seq) * direction);
  return connection(pulls, args, (pull) => pullObject(repo, pull), 'PullRequestConnection', 'PullRequestEdge');
}

const RESOLVERS = new Map<string, Resolver>([
  ['Query.viewer', () => userObject()],
  ['Query.repository', (_source, args, ctx) => {
    const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo === undefined ? null : repositoryObject(repo);
  }],
  ['Query.node', (_source, args, ctx) => {
    const parsed = parseGlobalId(String(args.id ?? ''));
    if (parsed === null) return null;
    if (parsed.kind === 'repo' && parsed.parts.length === 2) {
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      return repo === undefined ? null : repositoryObject(repo);
    }
    if (parsed.kind === 'issue' && parsed.parts.length === 3) {
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[2]));
      return repo !== undefined && issue !== undefined ? issueObject(repo, issue) : null;
    }
    if (parsed.kind === 'pr' && parsed.parts.length === 3) {
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const pull = repo?.pulls.find((candidate) => candidate.number === Number(parsed.parts[2]));
      return repo !== undefined && pull !== undefined ? pullObject(repo, pull) : null;
    }
    return null;
  }],
  ['Query.__type', (_source, args) => {
    const name = String(args.name ?? '');
    const fields = TYPE_FIELDS[name];
    const enumValues = TYPE_ENUM_VALUES[name];
    if (fields === undefined && enumValues === undefined) return null;
    return {
      __typename: '__Type',
      name,
      kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
      fields: fields === undefined ? null : fields.map((field) => ({ __typename: '__Field', name: field, description: null, type: null })),
      enumValues: enumValues === undefined ? null : enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
      description: null,
    };
  }],
  ['Repository.issue', (source, args) => {
    const repo = source._repo as Repo;
    const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
    return issue === undefined ? null : issueObject(repo, issue);
  }],
  ['Repository.issues', (source, args) => issuesConnection(source._repo as Repo, args)],
  ['Repository.pullRequest', (source, args) => {
    const repo = source._repo as Repo;
    const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
    return pull === undefined ? null : pullObject(repo, pull);
  }],
  ['Repository.pullRequests', (source, args) => pullsConnection(source._repo as Repo, args)],
  ['Issue.comments', (source, args) => {
    const repo = source._repo as Repo;
    const issue = source._issue as import('./store.ts').Issue;
    return connection(
      issue.comments,
      args,
      (comment) => ({
        __typename: 'Comment',
        id: globalId('comment', repo.owner, repo.name, issue.number, comment.id),
        databaseId: comment.id,
        body: comment.body,
        author: userObject(),
        url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      }),
      'CommentConnection',
      'CommentEdge',
    );
  }],
  ['Issue.labels', (source) => {
    const issue = source._issue as import('./store.ts').Issue;
    return {
      __typename: 'LabelConnection',
      nodes: issue.labels.map((label) => ({ __typename: 'Label', name: label.name, color: label.color })),
      totalCount: issue.labels.length,
    };
  }],
  ['PullRequest.mergeable', (source, _args, ctx) => {
    const repo = source._repo as Repo;
    const pull = source._pull as import('./store.ts').Pull;
    return ctx.store.mergeableState(repo, pull);
  }],
  ['PullRequest.files', (source, args, ctx) => {
    const repo = source._repo as Repo;
    const pull = source._pull as import('./store.ts').Pull;
    const files = ctx.store.prFiles(pull);
    return connection(
      files,
      args,
      (file) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }),
      'FileConnection',
      'FileEdge',
    );
  }],
  ['Mutation.createIssue', (_source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (parsed === null || parsed.kind !== 'repo' || parsed.parts.length !== 2) {
      ctx.errors.push({ message: 'createIssue: repositoryId is not a repository id' });
      return null;
    }
    const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const title = String(input.title ?? '');
    if (title === '') {
      ctx.errors.push({ message: 'createIssue: title is required' });
      return null;
    }
    const issue = ctx.store.createIssue(repo, title, String(input.body ?? ''), []);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: null };
  }],
  ['Mutation.closeIssue', (_source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    if (parsed === null || parsed.kind !== 'issue' || parsed.parts.length !== 3) {
      ctx.errors.push({ message: 'closeIssue: issueId is not an issue id' });
      return null;
    }
    const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
    const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[2]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: null };
  }],
  ['Mutation.createPullRequest', (_source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (parsed === null || parsed.kind !== 'repo' || parsed.parts.length !== 2) {
      ctx.errors.push({ message: 'createPullRequest: repositoryId is not a repository id' });
      return null;
    }
    const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const pull = ctx.store.createPull(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), String(input.body ?? ''));
    if (pull === null) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: null };
  }],
  ['Mutation.mergePullRequest', (_source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    if (parsed === null || parsed.kind !== 'pr' || parsed.parts.length !== 3) {
      ctx.errors.push({ message: 'mergePullRequest: pullRequestId is not a pull request id' });
      return null;
    }
    const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
    const pull = repo?.pulls.find((candidate) => candidate.number === Number(parsed.parts[2]));
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    if (pull.merged) {
      ctx.errors.push({ message: 'mergePullRequest: pull request is already merged' });
      return null;
    }
    const mergedSha = ctx.store.mergePull(repo, pull);
    if (mergedSha === null) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
      return null;
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: null };
  }],
  ['Mutation.addComment', (_source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    if (parsed === null || parsed.kind !== 'issue' || parsed.parts.length !== 3) {
      ctx.errors.push({ message: 'addComment: subjectId is not an issue id' });
      return null;
    }
    const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
    const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[2]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'addComment: issue not found' });
      return null;
    }
    const comment = ctx.store.createComment(issue, String(input.body ?? ''));
    const node: RuntimeObject = {
      __typename: 'Comment',
      id: globalId('comment', repo.owner, repo.name, issue.number, comment.id),
      databaseId: comment.id,
      body: comment.body,
      author: userObject(),
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: encodeCursor(issue.comments.length - 1) }, clientMutationId: null };
  }],
]);

function completeValue(value: unknown, selections: SelectionNode[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selections, ctx));
  if (typeof value === 'object') {
    const object = value as RuntimeObject;
    const typeName = typeof object.__typename === 'string' ? object.__typename : 'Object';
    return executeSelectionSet(selections, object, typeName, ctx);
  }
  return value;
}

function executeSelectionSet(selections: readonly SelectionNode[], source: RuntimeObject, typeName: string, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(fragment.selectionSet, source, typeName, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(selection.selectionSet, source, typeName, ctx));
      }
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const fields = FIELD_SETS[typeName];
    if (fields === undefined || !fields.has(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[selection.alias] = null;
      continue;
    }
    const args = resolveArgs(selection, ctx);
    const resolver = RESOLVERS.get(`${typeName}.${selection.name}`);
    let value: unknown;
    try {
      value = resolver !== undefined ? resolver(source, args, ctx) : (source[selection.name] ?? null);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[selection.alias] = null;
      continue;
    }
    out[selection.alias] = selection.selectionSet.length > 0 ? completeValue(value, selection.selectionSet, ctx) : value;
  }
  return out;
}

function executeDocument(store: Store, doc: unknown): Record<string, unknown> {
  const body = (doc ?? {}) as Record<string, unknown>;
  if (typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = parseDocument(body.query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  const operation = typeof body.operationName === 'string'
    ? operations.find((candidate) => candidate.name === body.operationName)
    : operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'no operation found in document' }] };
  }
  const variables: Record<string, unknown> = {};
  for (const definition of operation.variableDefinitions) {
    variables[definition.name] = definition.defaultValue === null ? null : resolveValue(definition.defaultValue, {});
  }
  const supplied = (body.variables ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(supplied)) variables[key] = value;
  const ctx: ExecContext = { store, fragments, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selectionSet, { __typename: rootType }, rootType, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Serve one GraphQL request; a JSON array body is a batch, answered in order. */
export function handleGraphql(store: Store, ctx: HandlerContext): HandlerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'malformed JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((doc) => executeDocument(store, doc)) };
  }
  return { status: 200, body: executeDocument(store, parsed) };
}
