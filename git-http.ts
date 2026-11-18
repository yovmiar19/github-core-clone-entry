// Git smart HTTP: upload-pack v2 (+ v0 fallback) and receive-pack v0, served from the
// store's object graph. Wire formats follow the suite's git-client.ts exactly:
// v2 advertisements, ls-refs with server-side ref-prefix filtering and peeled tags,
// fetch with NAK/ACK + shallow-info + sideband packfile sections, and receive-pack
// with per-ref report-status in sideband band 1.

import {
  collectReachable,
  decodePktLines,
  decodePktLinesPrefix,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './gitcore.ts';
import { ApiError, Store, type Repo } from './store.ts';

export const GIT_AGENT = 'github-core-clone/1.0';

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack agent=${GIT_AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs symref=HEAD:refs/heads/main agent=${GIT_AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** A repo's refs sorted by name (HEAD handled separately). */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled commit of an annotated tag ref, or null. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    return parseTag(object.data).object;
  } catch {
    return null;
  }
}

/** v0 ref advertisement: service preamble, flush, HEAD + refs (caps on the HEAD line). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush', `${headOid} HEAD\0${caps}\n`];
  for (const ref of sortedRefs(repo)) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peeledOf(repo, ref.oid);
    if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${GIT_AGENT}\n`,
    'ls-refs=unborn peel symrefs ref-prefix\n',
    'fetch=shallow thin-pack ofs-delta\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request body into its arguments. */
function parseLsRefsArgs(packets: readonly GitPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (!line.startsWith('command=ls-refs') && !line.startsWith('agent=') && !line.startsWith('object-format=')) {
        throw new ApiError(400, `unexpected ls-refs line ${JSON.stringify(line)}`);
      }
      continue;
    }
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line !== '') throw new ApiError(400, `unexpected ls-refs argument ${JSON.stringify(line)}`);
  }
  return args;
}

/** The v2 ls-refs answer: HEAD (with symref-target when asked) plus matching refs. */
function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.prefixes.length === 0) {
    if (headOid === undefined) {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else {
      lines.push(`${headOid} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Parse a v2 fetch request body. */
function parseFetchArgs(packets: readonly GitPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (!line.startsWith('command=fetch') && !line.startsWith('agent=') && !line.startsWith('object-format=')) {
        throw new ApiError(400, `unexpected fetch line ${JSON.stringify(line)}`);
      }
      continue;
    }
    if (line.startsWith('want ')) args.wants.push(line.slice(5));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
    else if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line.startsWith('filter ') || line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // Accepted and ignored: plain packs are always sent, no filtering is applied.
    } else if (line !== '') {
      throw new ApiError(400, `unexpected fetch argument ${JSON.stringify(line)}`);
    }
  }
  return args;
}

/** Parse a v0 fetch request body: wants section, flush, then haves + done. */
function parseV0FetchArgs(packets: readonly GitPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        args.wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
      else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
        // Accepted and ignored.
      }
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5));
    } else if (line === 'done') {
      args.done = true;
    }
  }
  return args;
}

/** Commit generation (wants at 1) of every commit within `depth` of the wants. */
function commitsWithinDepth(
  repo: Repo,
  wants: readonly string[],
  depth: number,
): { commits: Set<string>; generation: Map<string, number> } {
  const commits = new Set<string>();
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const resolveCommit = (oid: string): string | null => {
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      try {
        const target = parseTag(object.data).object;
        return repo.objects.get(target)?.type === 'commit' ? target : null;
      } catch {
        return null;
      }
    }
    return null;
  };
  for (const want of wants) {
    const commit = resolveCommit(want);
    if (commit !== null) queue.push({ oid: commit, gen: 1 });
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (generation.has(oid)) continue;
    generation.set(oid, gen);
    commits.add(oid);
    if (gen >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  return { commits, generation };
}

/** A tree's whole contents (trees + blobs), never following commit parents. */
function addTreeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/** The objects a fetch sends, plus the shallow-info lines, per the fetch rules. */
function computeFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wants = [...new Set(args.wants)].filter((oid) => isObjectId(oid) && repo.objects.has(oid));
  const haves = [...new Set(args.haves)].filter((oid) => isObjectId(oid));

  // Acknowledgments: ACK every have that is a want or an ancestor of a want, then ready.
  const acks: string[] = [];
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (wants.some((want) => isAncestor(have, want, lookup))) acks.push(have);
  }
  const nak = acks.length === 0;

  let delivered = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== null && Number.isFinite(args.depth) && args.depth > 0) {
    const depth = Math.trunc(args.depth);
    const { commits: depthCommits, generation } = commitsWithinDepth(repo, wants, depth);
    // Delivered commits are the in-depth commits the client does not already hold;
    // each carries its own tree closure, never its parents (the depth cut).
    const deliveredCommits = new Set<string>();
    for (const commit of depthCommits) {
      if (haves.includes(commit)) continue;
      deliveredCommits.add(commit);
    }
    for (const commit of deliveredCommits) {
      delivered.add(commit);
      const object = repo.objects.get(commit);
      if (object && object.type === 'commit') addTreeClosure(repo, parseCommit(object.data).tree, delivered);
    }
    // Tag objects the wants name are delivered whole, even at depth.
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object && object.type === 'tag') delivered.add(want);
    }
    // Shallow-info: the boundary is the commits at exactly `depth` that have parents.
    for (const [oid, gen] of generation) {
      if (gen !== depth) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
    // Previous shallow boundaries inside the fetched region become unshallow; the
    // rest stay shallow.
    for (const boundary of args.shallow) {
      if (depthCommits.has(boundary)) unshallow.push(boundary);
      else if (!shallow.includes(boundary)) shallow.push(boundary);
    }
  } else {
    const wantClosure = collectReachable(wants, lookup, { allowMissing: true });
    const haveClosure = collectReachable(haves, lookup, { allowMissing: true });
    delivered = new Set<string>();
    for (const oid of wantClosure) if (!haveClosure.has(oid)) delivered.add(oid);
  }

  const objects: GitObject[] = [];
  for (const oid of [...delivered].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow, acks, nak };
}

/** Split pack bytes into sideband band-1 pkt-lines (32 KiB data chunks). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

/** The v2 fetch answer: acknowledgments, shallow-info, packfile sections. */
function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow, acks, nak } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (nak) parts.push(pktLine('NAK\n'));
  else {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktDelim());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (objects.length > 0) {
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK/ACK lines, shallow lines, then the sideband pack. */
function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow, acks, nak } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    const pack = writePack(objects);
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse a receive-pack body: command pkt-lines up to the flush, then the raw pack. */
function parsePushBody(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer | null } {
  const { packets, consumed } = decodePktLinesPrefix(body, { stopAtFlush: true });
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).replace(/\n$/, '').split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    line = line.replace(/\n$/, '');
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length !== 3) throw new ApiError(400, `bad push command line ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new ApiError(400, 'push command has a bad object id');
    if (!ref.startsWith('refs/')) throw new ApiError(400, `push command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new ApiError(400, 'push needs at least one command');
  const pack = consumed < body.length ? body.subarray(consumed) : null;
  return { commands, capabilities, pack };
}

/** Apply one push: unpack the pack, then decide each ref update. */
function applyPush(
  store: Store,
  repo: Repo,
  commands: readonly PushCommand[],
  pack: Buffer | null,
): { unpackOk: boolean; unpackDetail: string; refs: Array<{ ref: string; ok: boolean; reason: string }> } {
  if (pack !== null && pack.length > 0) {
    let read;
    try {
      read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
    } catch (err) {
      return {
        unpackOk: false,
        unpackDetail: err instanceof Error ? err.message : 'unpack failed',
        refs: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
      };
    }
    const checksum = verifyPackChecksum(pack);
    if (!checksum.ok) {
      return {
        unpackOk: false,
        unpackDetail: 'pack checksum mismatch',
        refs: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
      };
    }
    for (const [oid, object] of read.objects) {
      const recomputed = hashObject(object.type, object.data);
      if (recomputed !== oid) {
        return {
          unpackOk: false,
          unpackDetail: `object ${oid} does not recompute`,
          refs: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
        };
      }
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.ref.startsWith('refs/tags/')) {
      // Tags move when the client names the current value (no ancestry rule).
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    if (!isAncestor(command.oldOid, command.newOid, lookup)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs: results };
}

/** The report-status stream, pkt-lined, optionally inside sideband band 1. */
function pushReportResponse(
  result: { unpackOk: boolean; unpackDetail: string; refs: Array<{ ref: string; ok: boolean; reason: string }> },
  sideband: boolean,
): Buffer {
  const lines: string[] = [`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`];
  for (const ref of result.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  const inner = encodePktLines(lines);
  if (!sideband) return Buffer.concat([inner, pktFlush()]);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), inner]))];
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- routing

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/;

export function gitRoute(path: string): { owner: string; repo: string; suffix: string } | null {
  const match = GIT_PATH.exec(path);
  if (!match) return null;
  return { owner: match[1] as string, repo: match[2] as string, suffix: match[3] as string };
}

/** GET /{owner}/{repo}.git/info/refs?service=... — the advertisement, or 404. */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string | null, gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  throw new ApiError(400, `unknown service ${JSON.stringify(service)}`);
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs or fetch, v2 or v0. */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  if (body.length === 0) throw new ApiError(400, 'empty upload-pack request');
  const packets = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const commandLine = first ? first.payload.toString('utf8') : '';
  if (gitProtocol === 'version=2' || commandLine.startsWith('command=')) {
    if (commandLine.startsWith('command=ls-refs')) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, parseLsRefsArgs(packets)) };
    }
    if (commandLine.startsWith('command=fetch')) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(repo, parseFetchArgs(packets)) };
    }
    throw new ApiError(400, `unknown upload-pack command ${JSON.stringify(commandLine.slice(0, 40))}`);
  }
  // v0 fetch.
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(repo, parseV0FetchArgs(packets)) };
}

/** POST /{owner}/{repo}.git/git-receive-pack — the push exchange. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const { commands, capabilities, pack } = parsePushBody(body);
  const result = applyPush(store, repo, commands, pack);
  const sideband = capabilities.includes('side-band-64k');
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: pushReportResponse(result, sideband) };
}
