// REST v3 under /api/v3: repositories, contents, branches, commits, labels, issues,
// pull requests. Every reply is JSON with a non-empty X-GitHub-Request-Id; errors
// are JSON {message}; a foreign owner is a 404, never a 403.

import { parseCommit } from './gitcore.ts';
import { FIXED_ISO, VIEWER } from './scenario.ts';
import {
  ApiError,
  commentJson,
  issueJson,
  pullJson,
  repoJson,
  Store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestCtx {
  method: string;
  /** Decoded pathname, e.g. /api/v3/repos/adaiversen/amber-thistle/issues. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when the request carried none. */
  body: unknown;
  /** The request origin (http://host:port) for absolute pagination links. */
  origin: string;
}

export interface RestResult {
  status: number;
  /** null means "no body" (204). */
  json: unknown;
  headers?: Record<string, string>;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

function intQuery(query: URLSearchParams, field: string, fallback: number): number {
  const raw = query.get(field);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** GitHub-style pagination: slice + a Link header with absolute next/prev/first/last. */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, origin: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, intQuery(query, 'per_page', 30)));
  const page = Math.max(1, intQuery(query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const pageItems = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${origin}${basePath}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: pageItems, headers: { link: links.join(', ') } };
}

/** `Name <email> ts +0000` -> {name, email, date}. */
function identityOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: FIXED_ISO };
  const timestamp = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(timestamp * 1000).toISOString() };
}

function commitJson(sha: string, commit: ReturnType<typeof parseCommit>): Record<string, unknown> {
  return {
    sha,
    commit: {
      message: commit.message,
      author: identityOf(commit.author),
      committer: identityOf(commit.committer),
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    html_url: `https://example.invalid/${VIEWER.login}`,
    url: '/api/v3/user',
  };
}

function requireRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === null) throw new ApiError(404, 'Not Found');
  return repo;
}

export function handleRest(store: Store, ctx: RestCtx): RestResult {
  const { method, path, query } = ctx;
  const segments = path.split('/').filter((segment) => segment !== '');
  // segments[0] is 'api', segments[1] is 'v3'.

  // GET /api/v3/ — the API root.
  if ((method === 'GET' && segments.length === 2) || (method === 'GET' && segments.length === 3 && segments[2] === '')) {
    return {
      status: 200,
      json: {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'meta') {
    return { status: 200, json: { installed_version: '1.0.0' } };
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'user') {
    return { status: 200, json: viewerJson() };
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos();
      const { page, headers } = paginate(repos, query, '/api/v3/user/repos', ctx.origin);
      return { status: 200, json: page.map(repoJson), headers };
    }
    if (method === 'POST') {
      const body = bodyObject(ctx.body);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') throw new ApiError(422, 'name is required');
      const repo = store.createRepo(name, {
        private: booleanField(body, 'private'),
        description: stringField(body, 'description'),
      });
      return { status: 201, json: repoJson(repo) };
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3] as string);
    const name = decodeURIComponent(segments[4] as string);
    const repo = requireRepo(store, owner, name);
    const rest = segments.slice(5);

    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, json: repoJson(repo) };
      if (method === 'PATCH') {
        const body = bodyObject(ctx.body);
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        return { status: 200, json: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, json: null };
      }
    }

    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      return { status: 200, json: branches };
    }

    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha');
      const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, ref);
      if (tip === undefined || tip === null) throw new ApiError(404, 'Not Found');
      const commits = store.listCommits(repo, tip);
      const { page } = paginate(commits, query, ctx.path, ctx.origin);
      return { status: 200, json: page.map((entry) => commitJson(entry.sha, entry.commit)) };
    }

    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const body = bodyObject(ctx.body);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/')) throw new ApiError(422, 'ref must start with refs/');
      if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) throw new ApiError(422, 'sha must be a 40-hex object id');
      if (!repo.objects.has(sha.toLowerCase())) throw new ApiError(422, 'sha does not exist');
      if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
      repo.refs.set(ref, sha.toLowerCase());
      return { status: 201, json: { ref, object: { sha: sha.toLowerCase(), type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha.toLowerCase()}` } } };
    }

    if (rest.length >= 1 && rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'GET') {
        const ref = query.get('ref');
        const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, ref);
        if (tip === undefined || tip === null) throw new ApiError(404, 'Not Found');
        const rootTree = store.commitTree(repo, tip);
        const found = store.treeEntryAt(repo, rootTree, contentPath.split('/').filter((s) => s !== ''));
        if (contentPath === '') {
          const entries = store.dirEntries(repo, rootTree, '') ?? [];
          return { status: 200, json: entries.map((entry) => dirEntryJson(repo, rootTree, entry)) };
        }
        if (found === null) throw new ApiError(404, 'Not Found');
        if (found.mode === '40000') {
          const entries = store.dirEntries(repo, rootTree, contentPath) ?? [];
          return { status: 200, json: entries.map((entry) => dirEntryJson(repo, rootTree, entry)) };
        }
        const blob = repo.objects.get(found.oid);
        if (!blob) throw new ApiError(404, 'Not Found');
        return {
          status: 200,
          json: {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: found.oid,
            size: blob.data.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
          },
        };
      }
      if (method === 'PUT') {
        const body = bodyObject(ctx.body);
        const message = stringField(body, 'message');
        const content = stringField(body, 'content');
        if (message === undefined) throw new ApiError(422, 'message is required');
        if (content === undefined) throw new ApiError(422, 'content is required');
        const result = store.putContents(repo, {
          path: contentPath,
          content: Buffer.from(content, 'base64'),
          message,
          branch: stringField(body, 'branch'),
          sha: stringField(body, 'sha'),
        });
        return {
          status: result.status,
          json: {
            content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: result.contentSha, size: Buffer.byteLength(Buffer.from(content, 'base64')), encoding: 'base64' },
            commit: { sha: result.commitSha, message },
          },
        };
      }
      if (method === 'DELETE') {
        const body = bodyObject(ctx.body);
        const message = stringField(body, 'message') ?? '';
        const result = store.deleteContents(repo, {
          path: contentPath,
          message,
          sha: stringField(body, 'sha'),
          branch: stringField(body, 'branch'),
        });
        return { status: 200, json: { commit: { sha: result.commitSha } } };
      }
    }

    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const body = bodyObject(ctx.body);
        const name = stringField(body, 'name');
        if (name === undefined || name === '') throw new ApiError(422, 'name is required');
        const label = store.createLabel(repo, name, stringField(body, 'color') ?? 'ededed');
        return { status: 201, json: { id: label.id, name: label.name, color: label.color } };
      }
      if (method === 'GET') {
        return { status: 200, json: [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color })) };
      }
    }

    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        const issues = store.listIssues(repo, {
          state: query.get('state') ?? undefined,
          sort: query.get('sort') ?? undefined,
          direction: query.get('direction') ?? undefined,
          perPage: intQuery(query, 'per_page', 30),
          page: intQuery(query, 'page', 1),
        });
        return { status: 200, json: issues.map((issue) => issueJson(repo, issue)) };
      }
      if (method === 'POST') {
        const body = bodyObject(ctx.body);
        const title = stringField(body, 'title');
        if (title === undefined || title === '') throw new ApiError(422, 'title is required');
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : undefined;
        const issue = store.createIssue(repo, { title, body: stringField(body, 'body') ?? '', labels });
        return { status: 201, json: issueJson(repo, issue) };
      }
    }

    if (rest.length === 2 && rest[0] === 'issues') {
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issueByNumber.get(number);
      if (issue === undefined) throw new ApiError(404, 'Not Found');
      if (method === 'GET') return { status: 200, json: issueJson(repo, issue) };
      if (method === 'PATCH') {
        const body = bodyObject(ctx.body);
        const state = stringField(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(body, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = stringField(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        return { status: 200, json: issueJson(repo, issue) };
      }
    }

    if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issueByNumber.get(number);
      if (issue === undefined) throw new ApiError(404, 'Not Found');
      if (method === 'GET') {
        return { status: 200, json: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
      }
      if (method === 'POST') {
        const body = bodyObject(ctx.body);
        const text = stringField(body, 'body');
        if (text === undefined || text === '') throw new ApiError(422, 'body is required');
        const comment = store.addComment(issue, text);
        return { status: 201, json: commentJson(repo, issue, comment) };
      }
    }

    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        const pulls = store.listPulls(repo, {
          state: query.get('state') ?? undefined,
          perPage: intQuery(query, 'per_page', 30),
          page: intQuery(query, 'page', 1),
        });
        return { status: 200, json: pulls.map((pull) => pullJson(repo, pull)) };
      }
      if (method === 'POST') {
        const body = bodyObject(ctx.body);
        const head = stringField(body, 'head');
        const base = stringField(body, 'base');
        const title = stringField(body, 'title');
        if (head === undefined || head === '') throw new ApiError(422, 'head is required');
        if (base === undefined || base === '') throw new ApiError(422, 'base is required');
        if (title === undefined || title === '') throw new ApiError(422, 'title is required');
        const pull = store.createPull(repo, { head, base, title, body: stringField(body, 'body') ?? '' });
        return { status: 201, json: pullJson(repo, pull) };
      }
    }

    if (rest.length === 2 && rest[0] === 'pulls') {
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pullByNumber.get(number);
      if (pull === undefined) throw new ApiError(404, 'Not Found');
      if (method === 'GET') return { status: 200, json: pullJson(repo, pull) };
    }

    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'files' && method === 'GET') {
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pullByNumber.get(number);
      if (pull === undefined) throw new ApiError(404, 'Not Found');
      return { status: 200, json: store.pullFiles(repo, pull) };
    }

    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'merge' && method === 'PUT') {
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pullByNumber.get(number);
      if (pull === undefined) throw new ApiError(404, 'Not Found');
      const result = store.mergePull(repo, pull);
      return { status: 200, json: { merged: true, sha: result.sha, message: 'Pull request successfully merged' } };
    }
  }

  throw new ApiError(404, 'Not Found');
}

function dirEntryJson(
  repo: Repo,
  rootTree: string,
  entry: { name: string; path: string; oid: string; mode: string },
): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  let size = 0;
  if (!isDir) {
    const blob = repo.objects.get(entry.oid);
    size = blob ? blob.data.length : 0;
  }
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: entry.path,
    sha: entry.oid,
    size,
  };
}
