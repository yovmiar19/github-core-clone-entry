// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP, modern era (server/discover,
// revision 2026-07-28) with the legacy initialize handshake as a fallback. The tools
// act on the same store as REST, so a repository or issue created over MCP is the
// same object over REST, with stable ids.

import { ApiError, issueJson, pullJson, repoJson, Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, { type: string; description: string }>>,
  required: readonly string[],
): McpTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required: [...required], additionalProperties: false },
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const num = (description: string): { type: string; description: string } => ({ type: 'number', description });

/** The tools list: a frozen constant, so two tools/list calls answer byte-identically. */
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  tool('create_repo', 'Create a repository owned by the authenticated user.', {
    name: str('The repository name.'),
    description: str('A short description of the repository.'),
    private: bool('Whether the repository is private.'),
  }, ['name']),
  tool('get_repo', 'Get one repository by owner and name.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
  }, ['owner', 'repo']),
  tool('list_repos', 'List the authenticated user\'s repositories.', {}, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
    title: str('The issue title.'),
    body: str('The issue body.'),
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by number.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
    number: num('The issue number.'),
  }, ['owner', 'repo', 'number']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
    state: str('Filter by state: open, closed or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
    title: str('The pull request title.'),
    body: str('The pull request body.'),
    head: str('The head branch name.'),
    base: str('The base branch name.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('get_pull_request', 'Get one pull request by number.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
    pull_number: num('The pull request number.'),
  }, ['owner', 'repo', 'pull_number']),
  tool('merge_pull_request', 'Squash-merge a pull request into its base branch.', {
    owner: str('The repository owner login.'),
    repo: str('The repository name.'),
    pull_number: num('The pull request number.'),
  }, ['owner', 'repo', 'pull_number']),
]);

const TOOL_NAMES = new Set(MCP_TOOLS.map((entry) => entry.name));

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredArg(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value === '') throw new ApiError(-32602, `Missing required argument: ${field}`);
  return value;
}

function optionalArg(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === 'string' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, field: string): number {
  const value = args[field];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new ApiError(-32602, `Missing required argument: ${field}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredArg(args, 'name');
      const repo = store.createRepo(repoName, {
        description: optionalArg(args, 'description'),
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'list_repos': {
      return toolResult({ repositories: store.listRepos().map(repoJson) });
    }
    case 'create_issue': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      const issue = store.createIssue(repo, {
        title: requiredArg(args, 'title'),
        body: optionalArg(args, 'body') ?? '',
      });
      return toolResult(issueJson(repo, issue));
    }
    case 'get_issue': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      const issue = repo.issueByNumber.get(numberArg(args, 'number'));
      if (issue === undefined) return toolError('Issue not found');
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      const state = optionalArg(args, 'state') ?? 'all';
      const issues = store.listIssues(repo, { state, perPage: 100, page: 1 });
      return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      const pull = store.createPull(repo, {
        head: requiredArg(args, 'head'),
        base: requiredArg(args, 'base'),
        title: requiredArg(args, 'title'),
        body: optionalArg(args, 'body') ?? '',
      });
      return toolResult(pullJson(repo, pull));
    }
    case 'get_pull_request': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      const pull = repo.pullByNumber.get(numberArg(args, 'pull_number'));
      if (pull === undefined) return toolError('Pull request not found');
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(requiredArg(args, 'owner'), requiredArg(args, 'repo'));
      if (repo === null) return toolError('Repository not found');
      const pull = repo.pullByNumber.get(numberArg(args, 'pull_number'));
      if (pull === undefined) return toolError('Pull request not found');
      const result = store.mergePull(repo, pull);
      return toolResult({ merged: true, sha: result.sha, number: pull.number, pull_number: pull.number });
    }
    default:
      throw new ApiError(-32602, `Unknown tool: ${name}`);
  }
}

export interface McpResult {
  status: number;
  json: unknown;
}

/** POST /mcp with a parsed JSON-RPC body (already authenticated by the router). */
export function handleMcp(store: Store, body: unknown): McpResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 200, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = request.method;
  // A request without an id is a notification: answer 202 with no body.
  if (id === null || id === undefined) {
    return { status: 202, json: null };
  }
  const result = (value: unknown): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });
  if (typeof method !== 'string') return error(-32600, 'Invalid Request: method must be a string');
  const params = (request.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return result({
        protocolVersion: MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: MCP_TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') return error(-32602, 'Invalid params: name is required');
      if (!TOOL_NAMES.has(name)) return error(-32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Invalid params: arguments must be an object');
      try {
        return result(callTool(store, name, args));
      } catch (err) {
        if (err instanceof ApiError && err.status === -32602) return error(-32602, err.message);
        if (err instanceof ApiError) return result(toolError(err.message));
        return result(toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}
