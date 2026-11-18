// The forge's in-memory store: one process, one store, every surface (git, REST,
// GraphQL, MCP) reading and writing the same objects. No persistence is needed: the
// pod is fresh per trial. Deterministic: no clock, no randomness in stored data.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { FIXED_ISO, SCENARIO_EPOCH_SEC, SERVER_IDENTITY, VIEWER } from './scenario.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  comments: Comment[];
  readonly seq: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  readonly head: string;
  readonly base: string;
  headSha: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly issueByNumber: Map<number, Issue>;
  readonly pulls: Pull[];
  readonly pullByNumber: Map<number, Pull>;
  nextNumber: number;
  readonly createdSeq: number;
}

/** Opaque Relay-style global ids: base64 of `Kind:part:part`, never a bare number. */
export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts.shift();
  if (!kind || parts.length === 0) return null;
  // The encoding must round-trip exactly, or the id is not one of ours.
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  return { kind, parts };
}

const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextGlobalId = 1;
  private repoSeq = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repo the token owns, or null (a foreign owner is always a 404, never a 403). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  getRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, options: { private?: boolean; description?: string } = {}): Repo {
    if (!REPO_NAME_RE.test(name)) throw new ApiError(422, `Invalid repository name ${JSON.stringify(name)}`);
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) throw new ApiError(422, 'Repository already exists');
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextNumber: 1,
      createdSeq: this.repoSeq,
    };
    this.nextRepoId += 1;
    this.repoSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, a full ref, HEAD, or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branchTip = repo.refs.get(`refs/heads/${ref}`);
    if (branchTip !== undefined) return branchTip;
    const tagTip = repo.refs.get(`refs/tags/${ref}`);
    if (tagTip !== undefined) return tagTip;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  commitTree(repo: Repo, commitOid: string): string {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') throw new ApiError(404, 'Not Found');
    return parseCommit(object.data).tree;
  }

  /** Walk a tree by path segments; null when any segment is missing. */
  treeEntryAt(repo: Repo, rootTree: string, segments: readonly string[]): { oid: string; mode: string } | null {
    let treeOid = rootTree;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  blobAtPath(repo: Repo, rootTree: string, path: string): string | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return null;
    const found = this.treeEntryAt(repo, rootTree, segments);
    if (!found || found.mode === '40000') return null;
    return found.oid;
  }

  /** Direct children of a directory path ('' is the root): files and subdirectories. */
  dirEntries(repo: Repo, rootTree: string, dirPath: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
    const segments = dirPath.split('/').filter((segment) => segment !== '');
    let treeOid = rootTree;
    if (segments.length > 0) {
      const found = this.treeEntryAt(repo, rootTree, segments);
      if (!found || found.mode !== '40000') return null;
      treeOid = found.oid;
    }
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: segments.length > 0 ? `${segments.join('/')}/${entry.name}` : entry.name,
      oid: entry.oid,
      mode: entry.mode,
    }));
  }

  /**
   * Set (or delete, with blobOid null) one path in a tree, returning the new root tree
   * oid. Intermediate trees are created as needed; emptied directories are pruned.
   * A null return means "this tree is now empty" (only the root caller turns that
   * into the empty-tree object).
   */
  private setPathInTree(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string | null): string | null {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree((repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)));
    const name = segments[0] as string;
    if (segments.length === 1) {
      const index = entries.findIndex((entry) => entry.name === name);
      if (blobOid === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const index = entries.findIndex((entry) => entry.name === name);
      const child = index >= 0 ? entries[index] : undefined;
      const childTree = this.setPathInTree(repo, child && child.mode === '40000' ? child.oid : null, segments.slice(1), blobOid);
      if (childTree === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '40000', name, oid: childTree };
      } else {
        entries.push({ mode: '40000', name, oid: childTree });
      }
    }
    if (entries.length === 0) return null;
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  setPath(repo: Repo, rootTree: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) throw new ApiError(422, 'Invalid path');
    const result = this.setPathInTree(repo, rootTree, segments, blobOid);
    return result ?? EMPTY_TREE_OID;
  }

  /** Create a commit on `branchRef` (creating the ref when the repo is unborn). */
  commitOnBranch(repo: Repo, branchRef: string, message: string, treeOid: string): string {
    const parent = repo.refs.get(branchRef);
    const commit = buildCommit({
      tree: treeOid,
      parents: parent !== undefined ? [parent] : [],
      message,
      author: SERVER_IDENTITY,
      committer: SERVER_IDENTITY,
      timestamp: SCENARIO_EPOCH_SEC,
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(branchRef, oid);
    return oid;
  }

  /** Commits reachable from `tip`, newest first (tip, then parents, depth-first). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
    const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, commit });
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  // ---------------------------------------------------------------- contents

  putContents(
    repo: Repo,
    options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { contentSha: string; commitSha: string; status: 200 | 201 } {
    const branchRef = options.branch !== undefined ? `refs/heads/${options.branch}` : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(branchRef);
    if (options.branch !== undefined && tip === undefined && repo.refs.size > 0) {
      throw new ApiError(422, `Branch ${options.branch} does not exist`);
    }
    const rootTree = tip !== undefined ? this.commitTree(repo, tip) : null;
    const existing = rootTree === null ? null : this.blobAtPath(repo, rootTree, options.path);
    if (existing !== null) {
      if (options.sha === undefined || options.sha.toLowerCase() !== existing.toLowerCase()) {
        throw new ApiError(409, 'sha does not match the current file');
      }
    }
    const blobOid = this.putObject(repo, 'blob', options.content);
    const newTree = this.setPath(repo, rootTree, options.path, blobOid);
    const commitSha = this.commitOnBranch(repo, branchRef, options.message, newTree);
    return { contentSha: blobOid, commitSha, status: existing !== null ? 200 : 201 };
  }

  deleteContents(
    repo: Repo,
    options: { path: string; message: string; sha?: string; branch?: string },
  ): { commitSha: string } {
    const branchRef = options.branch !== undefined ? `refs/heads/${options.branch}` : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined) throw new ApiError(404, 'Not Found');
    const rootTree = this.commitTree(repo, tip);
    const existing = this.blobAtPath(repo, rootTree, options.path);
    if (existing === null) throw new ApiError(404, 'Not Found');
    if (options.sha !== undefined && options.sha.toLowerCase() !== existing.toLowerCase()) {
      throw new ApiError(409, 'sha does not match the current file');
    }
    const newTree = this.setPath(repo, rootTree, options.path, null);
    const commitSha = this.commitOnBranch(repo, branchRef, options.message, newTree);
    return { commitSha };
  }

  // ---------------------------------------------------------------- labels / issues

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextGlobalId, name, color };
    this.nextGlobalId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels?: readonly string[] }): Issue {
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (!label) throw new ApiError(422, `Label ${name} does not exist`);
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      comments: [],
      seq: repo.nextNumber,
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  addComment(issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextGlobalId, body };
    this.nextGlobalId += 1;
    issue.comments.push(comment);
    return comment;
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number } = {},
  ): Issue[] {
    const state = options.state ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = options.direction ?? 'desc';
    list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
    const page = Math.max(1, options.page ?? 1);
    return list.slice((page - 1) * perPage, page * perPage);
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, input: { head: string; base: string; title: string; body: string }): Pull {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (headTip === undefined) throw new ApiError(422, `Head branch ${input.head} does not exist`);
    if (baseTip === undefined) throw new ApiError(422, `Base branch ${input.base} does not exist`);
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.head === input.head && existing.base === input.base) {
        throw new ApiError(422, 'A pull request already exists for this head and base');
      }
    }
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      head: input.head,
      base: input.base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.nextNumber,
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return pull;
  }

  listPulls(repo: Repo, options: { state?: string; perPage?: number; page?: number } = {}): Pull[] {
    const state = options.state ?? 'open';
    const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
    const page = Math.max(1, options.page ?? 1);
    return [...list].sort((a, b) => b.seq - a.seq).slice((page - 1) * perPage, page * perPage);
  }

  /** One changed path between two trees, with its old/new blob oids. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null, prefix = ''): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
    const baseEntries = baseTree === null ? [] : parseTree(repo.objects.get(baseTree)?.data ?? Buffer.alloc(0));
    const headEntries = headTree === null ? [] : parseTree(repo.objects.get(headTree)?.data ?? Buffer.alloc(0));
    const baseByName = new Map(baseEntries.map((entry) => [entry.name, entry]));
    const headByName = new Map(headEntries.map((entry) => [entry.name, entry]));
    const names = new Set([...baseByName.keys(), ...headByName.keys()]);
    for (const name of [...names].sort()) {
      const base = baseByName.get(name);
      const head = headByName.get(name);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (base === undefined && head !== undefined) {
        if (head.mode === '40000') {
          out.push(...this.diffTrees(repo, null, head.oid, path));
        } else {
          out.push({ path, status: 'added', oldOid: null, newOid: head.oid });
        }
      } else if (base !== undefined && head === undefined) {
        if (base.mode === '40000') {
          out.push(...this.diffTrees(repo, base.oid, null, path));
        } else {
          out.push({ path, status: 'removed', oldOid: base.oid, newOid: null });
        }
      } else if (base !== undefined && head !== undefined) {
        if (base.oid === head.oid) continue;
        if (base.mode === '40000' && head.mode === '40000') {
          out.push(...this.diffTrees(repo, base.oid, head.oid, path));
        } else if (base.mode === '40000' || head.mode === '40000') {
          if (base.mode === '40000') out.push(...this.diffTrees(repo, base.oid, null, path));
          else out.push({ path, status: 'removed', oldOid: base.oid, newOid: null });
          if (head.mode === '40000') out.push(...this.diffTrees(repo, null, head.oid, path));
          else out.push({ path, status: 'added', oldOid: null, newOid: head.oid });
        } else {
          out.push({ path, status: 'modified', oldOid: base.oid, newOid: head.oid });
        }
      }
    }
    return out;
  }

  /** Added/deleted line counts between two blob contents (multiset line intersection). */
  lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const linesOf = (data: Buffer | null): string[] => {
      if (data === null) return [];
      const text = data.toString('utf8');
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const oldLines = linesOf(oldData);
    const newLines = linesOf(newData);
    const counts = new Map<string, number>();
    for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const remaining = counts.get(line) ?? 0;
      if (remaining > 0) {
        counts.set(line, remaining - 1);
        common += 1;
      }
    }
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    const diff = this.diffTrees(repo, baseTree, headTree);
    return diff.map((entry) => {
      const oldData = entry.oldOid === null ? null : repo.objects.get(entry.oldOid)?.data ?? null;
      const newData = entry.newOid === null ? null : repo.objects.get(entry.newOid)?.data ?? null;
      const { additions, deletions } = this.lineCounts(oldData, newData);
      const status = entry.status === 'added' ? 'added' : entry.status === 'removed' ? 'removed' : 'modified';
      return { filename: entry.path, status, additions, deletions, changes: additions + deletions };
    });
  }

  /** True when the PR's diff can apply cleanly onto the default branch tip. */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip === undefined) return false;
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    const defaultTree = this.commitTree(repo, defaultTip);
    for (const entry of this.diffTrees(repo, baseTree, headTree)) {
      const b = entry.oldOid;
      const h = entry.newOid;
      const d = this.blobAtPath(repo, defaultTree, entry.path);
      if (b === h) continue;
      if (b === d) continue;
      if (h === d) continue;
      return false;
    }
    return true;
  }

  mergePull(repo: Repo, pull: Pull): { sha: string } {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is already closed');
    if (!this.pullMergeable(repo, pull)) throw new ApiError(405, 'Merge conflict');
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip === undefined) throw new ApiError(404, 'Not Found');
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    let mergedTree = this.commitTree(repo, defaultTip);
    for (const entry of this.diffTrees(repo, baseTree, headTree)) {
      mergedTree = this.setPath(repo, mergedTree, entry.path, entry.newOid);
    }
    const commitSha = this.commitOnBranch(repo, `refs/heads/${repo.defaultBranch}`, pull.title, mergedTree);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = commitSha;
    return { sha: commitSha };
  }

  // ---------------------------------------------------------------- git helpers

  /** True when `ancestor` is reachable from `oid` (commit parents, tag targets). */
  isAncestorOf(repo: Repo, ancestor: string, oid: string): boolean {
    return isAncestor(ancestor, oid, this.lookup(repo));
  }

  reachableFrom(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }

  emptyTreeOid(): string {
    return EMPTY_TREE_OID;
  }

  zeroOid(): string {
    return ZERO_OID;
  }
}

// ---------------------------------------------------------------- JSON views

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner, id: VIEWER.id, type: 'User' } },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner, id: VIEWER.id, type: 'User' } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}
