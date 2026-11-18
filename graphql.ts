// GraphQL at /api/graphql: a small hand-written parser, validator and executor for
// the documents gh and github-mcp-server send (the suite's 18 fixed documents, plus
// introspection and operation batching). No external GraphQL library: the entry is
// stdlib-only. Unknown fields are a 200 with an errors array naming the field;
// an unknown repository is data.repository = null with no errors.

import { ApiError, gid, parseGid, Store, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------- parsing

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

type SelectionNode = FieldNode | { kind: 'fragment'; type: string; selection: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private skip(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos] as string;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos += 1;
      else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  private peek(): string {
    this.skip();
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skip();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at offset ${this.pos}`);
    this.pos += 1;
  }

  private consume(ch: string): boolean {
    this.skip();
    if (this.src[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private name(): string {
    this.skip();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!match) throw new Error(`expected a name at offset ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  parseDocument(): OperationNode {
    this.skip();
    let kind: 'query' | 'mutation' = 'query';
    if (this.peek() === '{') {
      return { kind, selection: this.parseSelectionSet() };
    }
    const word = this.name();
    if (word !== 'query' && word !== 'mutation') throw new Error(`expected query or mutation, got ${word}`);
    kind = word;
    if (/^[A-Za-z_]/.test(this.peek())) this.name(); // operation name
    if (this.peek() === '(') this.skipVariableDefinitions();
    return { kind, selection: this.parseSelectionSet() };
  }

  /** Skip `($x: Type!, $y: [T])`, keeping only the syntax valid. */
  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const c = this.src[this.pos] as string;
      if (c === undefined) throw new Error('unterminated variable definitions');
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      this.pos += 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    this.skip();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skip();
      if (this.src.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + 2] ?? '')) {
        this.pos += 2;
        const type = this.name();
        return { kind: 'fragment', type, selection: this.parseSelectionSet() };
      }
      throw new Error('named fragment spreads are not supported');
    }
    const first = this.name();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.pos += 1;
      alias = first;
      name = this.name();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        const argName = this.name();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : undefined;
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    this.skip();
    const c = this.peek();
    if (c === '$') {
      this.pos += 1;
      return { kind: 'var', name: this.name() };
    }
    if (c === '"') return { kind: 'string', value: this.parseString() };
    if (c === '[') {
      this.expect('[');
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (c === '{') {
      this.expect('{');
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const fieldName = this.name();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
      if (!match) throw new Error(`bad number at offset ${this.pos}`);
      this.pos += match[0].length;
      return match[0].includes('.') || /[eE]/.test(match[0])
        ? { kind: 'float', value: Number(match[0]) }
        : { kind: 'int', value: Number(match[0]) };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.src[this.pos] as string;
      if (c === undefined) throw new Error('unterminated string');
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (c === '\\') {
        const next = this.src[this.pos + 1] as string;
        this.pos += 2;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += next;
        continue;
      }
      out += c;
      this.pos += 1;
    }
  }
}

// ---------------------------------------------------------------- schema model (for validation + introspection)

const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'IssueState', author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', merged: 'Boolean',
    files: 'PullRequestFileConnection', headRef: 'Ref', baseRef: 'Ref', author: 'User',
  },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestFileConnection: { nodes: '[PullRequestFile]', edges: '[PullRequestFileEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileEdge: { node: 'PullRequestFile', cursor: 'String' },
  PullRequestFile: { path: 'String', additions: 'Int', deletions: 'Int', changes: 'Int' },
  IssueComment: { id: 'ID', body: 'String', author: 'User' },
  IssueCommentConnection: { nodes: '[IssueComment]', edges: '[IssueCommentEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String' },
  LabelConnection: { nodes: '[Label]', totalCount: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  Node: { id: 'ID' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', description: 'String' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { types: '[__Type]', queryType: '__Type' },
};

const MUTATION_FIELDS: Readonly<Record<string, string>> = {
  createIssue: 'CreateIssuePayload',
  closeIssue: 'CloseIssuePayload',
  createPullRequest: 'CreatePullRequestPayload',
  mergePullRequest: 'MergePullRequestPayload',
  addComment: 'AddCommentPayload',
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

const SCALARS = new Set(['String', 'Int', 'ID', 'Boolean', 'Float']);

function typeFields(type: string): Readonly<Record<string, string>> | null {
  return FIELD_TYPES[type] ?? null;
}

function validateSelections(selections: readonly SelectionNode[], parentType: string, errors: string[]): void {
  for (const selection of selections) {
    if ('kind' in selection && selection.kind === 'fragment') {
      validateSelections(selection.selection, selection.type, errors);
      continue;
    }
    const field = selection as FieldNode;
    if (field.name === '__typename') continue;
    let fields = typeFields(parentType);
    if (parentType === 'Query' && field.name in MUTATION_FIELDS) {
      fields = { ...fields, [field.name]: MUTATION_FIELDS[field.name] as string };
    }
    const childType = fields?.[field.name];
    if (childType === undefined) {
      errors.push(`Cannot query field "${field.name}" on type "${parentType}".`);
      continue;
    }
    if (field.selection !== undefined) {
      const base = childType.replace(/^\[|\]$/g, '');
      if (SCALARS.has(base)) {
        errors.push(`Field "${field.name}" of type "${base}" must not have a selection.`);
      } else {
        validateSelections(field.selection, base, errors);
      }
    }
  }
}

function typeInfo(name: string): Record<string, unknown> | null {
  const fields = FIELD_TYPES[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    fields: fields === undefined ? null : Object.keys(fields).map((field) => ({ __typename: '__Field', name: field, description: null })),
    enumValues: enumValues === undefined ? null : enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
    description: null,
  };
}

// ---------------------------------------------------------------- values

function evalValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'var': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface Envelope {
  __typename: string;
  [key: string]: unknown;
}

function userEnvelope(): Envelope {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoEnvelope(repo: Repo): Envelope {
  return { __typename: 'Repository', repo };
}

function issueEnvelope(repo: Repo, issue: Issue): Envelope {
  return { __typename: 'Issue', repo, issue };
}

function pullEnvelope(repo: Repo, pull: Pull): Envelope {
  return { __typename: 'PullRequest', repo, pull };
}

function pageInfoEnvelope(hasNextPage: boolean, endCursor: string | null, startCursor: string | null = null): Envelope {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor };
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Envelope {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.issues];
  if (states !== null) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = decodeCursor(args.after);
  if (afterSeq !== null) {
    const index = list.findIndex((issue) => issue.seq === afterSeq);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > nodes.length;
  const endCursor = nodes.length > 0 ? encodeCursor((nodes[nodes.length - 1] as Issue).seq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: nodes.map((issue) => issueEnvelope(repo, issue)),
    edges: nodes.map((issue) => ({ __typename: 'IssueEdge', node: issueEnvelope(repo, issue), cursor: encodeCursor(issue.seq) })),
    pageInfo: pageInfoEnvelope(hasNextPage, endCursor),
    totalCount: list.length,
  };
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): Envelope {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  let list = [...repo.pulls];
  list = list.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = decodeCursor(args.after);
  if (afterSeq !== null) {
    const index = list.findIndex((pull) => pull.seq === afterSeq);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > nodes.length;
  const endCursor = nodes.length > 0 ? encodeCursor((nodes[nodes.length - 1] as Pull).seq) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: nodes.map((pull) => pullEnvelope(repo, pull)),
    edges: nodes.map((pull) => ({ __typename: 'PullRequestEdge', node: pullEnvelope(repo, pull), cursor: encodeCursor(pull.seq) })),
    pageInfo: pageInfoEnvelope(hasNextPage, endCursor),
    totalCount: list.length,
  };
}

function resolveNode(store: Store, id: string): Envelope | null {
  const parsed = parseGid(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = store.getRepoById(Number(parsed.parts[0]));
    return repo ? repoEnvelope(repo) : null;
  }
  if (parsed.kind === 'Issue') {
    const repo = store.getRepoById(Number(parsed.parts[0]));
    const issue = repo?.issueByNumber.get(Number(parsed.parts[1]));
    return repo && issue ? issueEnvelope(repo, issue) : null;
  }
  if (parsed.kind === 'PullRequest') {
    const repo = store.getRepoById(Number(parsed.parts[0]));
    const pull = repo?.pullByNumber.get(Number(parsed.parts[1]));
    return repo && pull ? pullEnvelope(repo, pull) : null;
  }
  return null;
}

// ---------------------------------------------------------------- resolvers

type Resolver = (store: Store, parent: Envelope, args: Record<string, unknown>) => unknown;

const RESOLVERS: Readonly<Record<string, Resolver>> = {
  'Query.viewer': () => userEnvelope(),
  'Query.repository': (store, _parent, args) => {
    const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo ? repoEnvelope(repo) : null;
  },
  'Query.node': (store, _parent, args) => resolveNode(store, String(args.id ?? '')),
  'Node.id': (_store, parent) => {
    if (parent.__typename === 'Repository') return gid('Repository', (parent.repo as Repo).id);
    if (parent.__typename === 'Issue') return gid('Issue', (parent.repo as Repo).id, (parent.issue as Issue).number);
    if (parent.__typename === 'PullRequest') return gid('PullRequest', (parent.repo as Repo).id, (parent.pull as Pull).number);
    return null;
  },
  'Query.__type': (_store, _parent, args) => typeInfo(String(args.name ?? '')),
  'Query.__schema': () => ({
    __typename: '__Schema',
    types: Object.keys(FIELD_TYPES).map((name) => typeInfo(name)).filter((entry) => entry !== null),
    queryType: typeInfo('Query'),
  }),
  'Repository.id': (_store, parent) => gid('Repository', (parent.repo as Repo).id),
  'Repository.databaseId': (_store, parent) => (parent.repo as Repo).id,
  'Repository.name': (_store, parent) => (parent.repo as Repo).name,
  'Repository.nameWithOwner': (_store, parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
  'Repository.owner': () => userEnvelope(),
  'Repository.defaultBranchRef': (_store, parent) => ({ __typename: 'Ref', name: (parent.repo as Repo).defaultBranch }),
  'Repository.viewerPermission': () => 'ADMIN',
  'Repository.hasIssuesEnabled': () => true,
  'Repository.issue': (_store, parent, args) => {
    const repo = parent.repo as Repo;
    const issue = repo.issueByNumber.get(Number(args.number));
    return issue ? issueEnvelope(repo, issue) : null;
  },
  'Repository.issues': (store, parent, args) => issuesConnection(store, parent.repo as Repo, args),
  'Repository.pullRequests': (store, parent, args) => pullsConnection(store, parent.repo as Repo, args),
  'Repository.pullRequest': (_store, parent, args) => {
    const repo = parent.repo as Repo;
    const pull = repo.pullByNumber.get(Number(args.number));
    return pull ? pullEnvelope(repo, pull) : null;
  },
  'Issue.id': (_store, parent) => gid('Issue', (parent.repo as Repo).id, (parent.issue as Issue).number),
  'Issue.number': (_store, parent) => (parent.issue as Issue).number,
  'Issue.title': (_store, parent) => (parent.issue as Issue).title,
  'Issue.body': (_store, parent) => (parent.issue as Issue).body,
  'Issue.state': (_store, parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
  'Issue.author': () => userEnvelope(),
  'Issue.labels': (_store, parent) => ({
    __typename: 'LabelConnection',
    nodes: (parent.issue as Issue).labels.map((label) => ({ __typename: 'Label', id: label.id, name: label.name, color: label.color })),
    totalCount: (parent.issue as Issue).labels.length,
  }),
  'Issue.comments': (_store, parent) => {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    return {
      __typename: 'IssueCommentConnection',
      nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: gid('IssueComment', repo.id, issue.number, comment.id), body: comment.body, author: userEnvelope() })),
      edges: issue.comments.map((comment) => ({
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: gid('IssueComment', repo.id, issue.number, comment.id), body: comment.body },
        cursor: encodeCursor(comment.id),
      })),
      pageInfo: pageInfoEnvelope(false, null),
      totalCount: issue.comments.length,
    };
  },
  'PullRequest.id': (_store, parent) => gid('PullRequest', (parent.repo as Repo).id, (parent.pull as Pull).number),
  'PullRequest.number': (_store, parent) => (parent.pull as Pull).number,
  'PullRequest.title': (_store, parent) => (parent.pull as Pull).title,
  'PullRequest.body': (_store, parent) => (parent.pull as Pull).body,
  'PullRequest.state': (_store, parent) => ((parent.pull as Pull).state === 'open' ? 'OPEN' : 'CLOSED'),
  'PullRequest.headRefName': (_store, parent) => (parent.pull as Pull).head,
  'PullRequest.baseRefName': (_store, parent) => (parent.pull as Pull).base,
  'PullRequest.mergeable': (store, parent) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    if (pull.state !== 'open') return 'UNKNOWN';
    return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
  },
  'PullRequest.merged': (_store, parent) => (parent.pull as Pull).merged,
  'PullRequest.files': (store, parent, args) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    const files = store.pullFiles(repo, pull);
    const first = typeof args.first === 'number' ? args.first : files.length;
    const nodes = files.slice(0, first).map((file) => ({
      __typename: 'PullRequestFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return {
      __typename: 'PullRequestFileConnection',
      nodes,
      edges: nodes.map((node) => ({ __typename: 'PullRequestFileEdge', node, cursor: encodeCursor(0) })),
      pageInfo: pageInfoEnvelope(files.length > nodes.length, null),
      totalCount: files.length,
    };
  },
  'PullRequest.headRef': (_store, parent) => ({ __typename: 'Ref', name: (parent.pull as Pull).head }),
  'PullRequest.baseRef': (_store, parent) => ({ __typename: 'Ref', name: (parent.pull as Pull).base }),
  'PullRequest.author': () => userEnvelope(),
};

function resolveField(store: Store, parentType: string, parent: Envelope, field: FieldNode, variables: Readonly<Record<string, unknown>>): unknown {
  const args = evalArgs(field, variables);
  const key = `${parentType}.${field.name}`;
  const resolver = RESOLVERS[key];
  if (resolver) return resolver(store, parent, args);
  // Plain property fallback (PageInfo, Ref, __Type, payload envelopes, User).
  const value = (parent as Record<string, unknown>)[field.name];
  return value === undefined ? null : value;
}

function executeSelections(
  store: Store,
  selections: readonly SelectionNode[],
  parentType: string,
  parent: Envelope | null,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (parent === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if ('kind' in selection && selection.kind === 'fragment') {
      if (parent.__typename !== selection.type) continue;
      const merged = executeSelections(store, selection.selection, selection.type, parent, variables);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    const field = selection as FieldNode;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = parent.__typename;
      continue;
    }
    const value = resolveField(store, parentType, parent, field, variables);
    if (field.selection === undefined || value === null || value === undefined) {
      out[key] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      const itemType = (typeFields(parentType)?.[field.name] ?? '').replace(/^\[|\]$/g, '');
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? executeSelections(store, field.selection as SelectionNode[], itemType, item as Envelope, variables)
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const envelope = value as Envelope;
      const childType = (typeFields(parentType)?.[field.name] ?? envelope.__typename).replace(/^\[|\]$/g, '');
      out[key] = executeSelections(store, field.selection, childType, envelope, variables);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- mutations

function executeMutation(store: Store, field: FieldNode, variables: Readonly<Record<string, unknown>>): unknown {
  const args = evalArgs(field, variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? store.getRepoById(Number(parsed.parts[0])) : null;
      if (repo === null) throw new ApiError(404, 'Repository not found');
      const issue = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { issue: issueEnvelope(repo, issue) };
    }
    case 'closeIssue': {
      const parsed = parseGid(String(input.issueId ?? ''));
      const repo = parsed?.kind === 'Issue' ? store.getRepoById(Number(parsed.parts[0])) : null;
      const issue = repo?.issueByNumber.get(Number(parsed?.parts[1]));
      if (repo === undefined || repo === null || issue === undefined) throw new ApiError(404, 'Issue not found');
      issue.state = 'closed';
      return { issue: issueEnvelope(repo, issue) };
    }
    case 'createPullRequest': {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? store.getRepoById(Number(parsed.parts[0])) : null;
      if (repo === null) throw new ApiError(404, 'Repository not found');
      const pull = store.createPull(repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: '',
      });
      return { pullRequest: pullEnvelope(repo, pull) };
    }
    case 'mergePullRequest': {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const repo = parsed?.kind === 'PullRequest' ? store.getRepoById(Number(parsed.parts[0])) : null;
      const pull = repo?.pullByNumber.get(Number(parsed?.parts[1]));
      if (repo === undefined || repo === null || pull === undefined) throw new ApiError(404, 'Pull request not found');
      store.mergePull(repo, pull);
      return { pullRequest: pullEnvelope(repo, pull) };
    }
    case 'addComment': {
      const parsed = parseGid(String(input.subjectId ?? ''));
      const repo = parsed?.kind === 'Issue' ? store.getRepoById(Number(parsed.parts[0])) : null;
      const issue = repo?.issueByNumber.get(Number(parsed?.parts[1]));
      if (repo === undefined || repo === null || issue === undefined) throw new ApiError(404, 'Issue not found');
      const comment = store.addComment(issue, String(input.body ?? ''));
      return {
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: gid('IssueComment', repo.id, issue.number, comment.id), body: comment.body },
          cursor: encodeCursor(comment.id),
        },
      };
    }
    default:
      throw new ApiError(400, `Unknown mutation ${field.name}`);
  }
}

function executeOperation(store: Store, operation: OperationNode, variables: Readonly<Record<string, unknown>>): { data: unknown; errors?: Array<{ message: string }> } {
  const errors: string[] = [];
  if (operation.kind === 'mutation') {
    // Validate the mutation's fields against the mutation table + payload types.
    for (const selection of operation.selection) {
      if ('kind' in selection && selection.kind === 'fragment') continue;
      const field = selection as FieldNode;
      const payloadType = MUTATION_FIELDS[field.name];
      if (payloadType === undefined) {
        errors.push(`Cannot query field "${field.name}" on type "Mutation".`);
        continue;
      }
      if (field.selection !== undefined) validateSelections(field.selection, payloadType, errors);
    }
  } else {
    validateSelections(operation.selection, 'Query', errors);
  }
  if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };

  try {
    if (operation.kind === 'mutation') {
      const out: Record<string, unknown> = {};
      for (const selection of operation.selection) {
        if ('kind' in selection && selection.kind === 'fragment') continue;
        const field = selection as FieldNode;
        const key = field.alias ?? field.name;
        const payload = executeMutation(store, field, variables) as Envelope;
        const payloadType = MUTATION_FIELDS[field.name] as string;
        out[key] =
          field.selection === undefined
            ? payload
            : executeSelections(store, field.selection, payloadType, { __typename: payloadType, ...payload }, variables);
      }
      return { data: out };
    }
    const data = executeSelections(store, operation.selection, 'Query', { __typename: 'Query' }, variables);
    return { data };
  } catch (err) {
    if (err instanceof ApiError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  json: unknown;
}

/** POST /api/graphql: one operation object, or an array of them (operation batching). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const variablesOf = (entry: Record<string, unknown>): Record<string, unknown> => {
    const variables = entry.variables;
    return variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
  };
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Each operation must be an object with a query string.' }] };
    }
    const query = (entry as Record<string, unknown>).query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    let operation: OperationNode;
    try {
      operation = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    return executeOperation(store, operation, variablesOf(entry as Record<string, unknown>));
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map(runOne) };
  }
  return { status: 200, json: runOne(body) };
}
