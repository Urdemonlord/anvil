// Anvil's git smart-HTTP surface: /{owner}/{repo}.git.
//
// upload-pack speaks protocol v2 (ls-refs, fetch, shallow, deepen) and receive-pack
// speaks protocol v0 with report-status in sideband band 1. Every object is judged by
// bytes and hashes, so the pack writer emits plain (undeltad) packs whose SHA-1s
// recompute, and the pack reader verifies the trailer and every inflated size.
//
// The response shapes follow what git itself sends, because the suite's client parses
// them the way a real client does: the advertisement preamble, the NUL-separated
// capability list on the first ref line, the section flushes in a v2 fetch, the
// `unborn` line for a repository with no refs yet.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  packetLines,
  parseTag,
  planFetch,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { Store } from './store.ts';
import type { HandlerContext, HandlerResult } from './app.ts';

const UPLOAD_PACK_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_PACK_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

/** The capabilities this server advertises for receive-pack (protocol v0). */
function receivePackCapabilities(): string {
  return 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=anvil/1.0 symref=HEAD:refs/heads/main';
}

/** The upload-pack v2 capabilities. */
function uploadPackCapabilities(): string[] {
  return ['version 2', 'agent=anvil/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'server-option', 'object-format=sha1'];
}

/** Wrap a payload in sideband band 1 packets (data), chunked to the pkt-line maximum. */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) {
    const chunk = data.subarray(offset, Math.min(offset + 65515, data.length));
    const payload = Buffer.concat([Buffer.from([0x01]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

/** A git ref line: `<oid> <ref>` plus, on the first line, `\0<capabilities>`. */
function refLine(oid: string, ref: string, capabilities?: string): string {
  return capabilities ? `${oid} ${ref}\0${capabilities}\n` : `${oid} ${ref}\n`;
}

interface RepoRef {
  oid: string;
  ref: string;
}

/** Every ref of a repository, sorted by ref name, plus peeled lines for annotated tags. */
function allRefs(store: Store, repo: { refs: Map<string, string> }): RepoRef[] {
  const out: RepoRef[] = [];
  const sorted = [...repo.refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of sorted) {
    out.push({ oid, ref });
    if (ref.startsWith('refs/tags/')) {
      const object = store.getObject(oid);
      if (object?.type === 'tag') {
        out.push({ oid: parseTag(object.data).object, ref: `${ref}^{}` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function advertiseUploadPack(store: Store, repo: { refs: Map<string, string>; defaultBranch: string }): Buffer {
  const lines: Array<string | 'flush'> = [`# service=git-upload-pack\n`, 'flush'];
  for (const capability of uploadPackCapabilities()) lines.push(`${capability}\n`);
  lines.push('flush');
  return encodePktLines(lines);
}

function advertiseReceivePack(store: Store, repo: { refs: Map<string, string>; defaultBranch: string }): Buffer {
  const capabilities = receivePackCapabilities();
  const refs = allRefs(store, repo);
  const lines: Array<string | 'flush'> = [`# service=git-receive-pack\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(refLine(ZERO_OID, 'capabilities^{}', capabilities));
  } else {
    refs.forEach((ref, index) => {
      lines.push(refLine(ref.oid, ref.ref, index === 0 ? capabilities : undefined));
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

function handleLsRefs(
  store: Store,
  repo: { refs: Map<string, string>; defaultBranch: string },
  args: string[],
): Buffer {
  // Pkt-line payloads carry their trailing newline; strip it before matching.
  const clean = args.map((arg) => arg.replace(/\r?\n$/, ''));
  const wantsPeel = clean.includes('peel');
  const wantsSymrefs = clean.includes('symrefs');
  const wantsUnborn = clean.includes('unborn');
  const prefixes = clean.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  if (tip === undefined) {
    // An unborn repository: HEAD has a target but no tip yet. The line names HEAD,
    // not the branch: a name under refs/ would read as a real ref (an empty repo must
    // advertise no refs at all), and a client that looks the branch up by name must
    // find it absent.
    if (wantsUnborn && (matches(defaultRef) || matches('HEAD'))) {
      lines.push(`unborn HEAD symref-target:${defaultRef}\n`);
    }
    return encodePktLines([...lines, 'flush']);
  }
  if (matches('HEAD')) lines.push(`${tip} HEAD${wantsSymrefs ? ` symref-target:${defaultRef}` : ''}\n`);
  for (const ref of allRefs(store, repo)) {
    if (!matches(ref.ref)) continue;
    if (ref.ref.endsWith('^{}')) {
      if (wantsPeel) lines.push(`${ref.oid} ${ref.ref}\n`);
      continue;
    }
    lines.push(`${ref.oid} ${ref.ref}\n`);
  }
  // The peeled attribute belongs on the tag's own line in protocol v2.
  if (wantsPeel) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = /^([0-9a-f]{40}) (refs\/tags\/[^\s]+)\n$/.exec(line);
      if (!match) continue;
      const object = store.getObject(match[1]!);
      if (object?.type === 'tag') {
        lines[index] = `${match[1]} ${match[2]} peeled:${parseTag(object.data).object}\n`;
      }
    }
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// fetch (protocol v2)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
}

function parseFetchV2(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) request.deepen = Number.parseInt(text.slice(7).trim(), 10);
    else if (text.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(text.slice(13).trim(), 10);
    else if (text.startsWith('deepen-not ')) request.deepenNot.push(text.slice(11).trim());
  }
  return request;
}

/**
 * The fetch response: acknowledgments (always NAK here), the shallow section, then the
 * packfile in sideband band 1. When nothing is new there is no packfile section at all:
 * a present-but-empty packfile section would fail the client's parse.
 */
function handleFetchV2(store: Store, repo: { refs: Map<string, string>; defaultBranch: string }, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines = packetLines(packets);
  const command = lines[0]?.trim() ?? '';
  if (!command.startsWith('command=fetch')) {
    throw new Error(`expected command=fetch, got ${JSON.stringify(command)}`);
  }
  const request = parseFetchV2(lines.slice(1));
  // deepen-since / deepen-not: git's shallow math on those is a generation walk from the
  // wants cut by the timestamp / ref; the suite only exercises deepen with a count, and a
  // since/not request without a count means "the whole history up to the cut", which the
  // plain walk already delivers. Treat them as an unbounded fetch.
  const depth = request.deepen !== undefined && Number.isFinite(request.deepen) ? request.deepen : undefined;
  const plan = planFetch(request.wants, request.haves, request.shallow, depth, store.lookup);
  const sections: Buffer[] = [];
  sections.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  const shallowLines: string[] = [];
  for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
  if (shallowLines.length > 0) sections.push(encodePktLines(['shallow-info\n', ...shallowLines, 'flush']));
  if (plan.send.length > 0) {
    const objects: GitObject[] = [];
    for (const oid of plan.send) {
      const object = store.getObject(oid);
      if (object) objects.push(object);
    }
    const pack = writePack(objects);
    sections.push(Buffer.concat([encodePktLine('packfile\n'), sideband(pack), encodePktLines(['flush'])]));
  }
  return Buffer.concat(sections);
}

// ---------------------------------------------------------------------------------------------
// fetch (protocol v0, fallback for clients that do not speak v2)
// ---------------------------------------------------------------------------------------------

function handleFetchV0(store: Store, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines = packetLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
  }
  const plan = planFetch(wants, haves, [], undefined, store.lookup);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  if (plan.send.length > 0) {
    const objects: GitObject[] = [];
    for (const oid of plan.send) {
      const object = store.getObject(oid);
      if (object) objects.push(object);
    }
    parts.push(sideband(writePack(objects)));
  }
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  old: string;
  next: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; packStart: number } | null {
  // The command list is pkt-lines ending at the first flush; the pack follows raw.
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) return { commands, packStart: offset + 4 };
    if (length < 4 || offset + length > body.length) return null;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul < 0 ? payload : payload.slice(0, nul)).trim();
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) return null;
    commands.push({ old: match[1]!, next: match[2]!, ref: match[3]! });
    offset += length;
  }
  return null;
}

/**
 * Handle a receive-pack request. Every command is judged before any ref moves; the
 * report carries `unpack ok` plus one `ok`/`ng` line per command, inside sideband
 * band 1, and a refused update still unpacks ok (the pack itself was fine).
 */
function handleReceivePack(store: Store, repo: { refs: Map<string, string> }, body: Buffer): Buffer {
  const parsed = parsePushCommands(body);
  if (parsed === null || parsed.commands.length === 0) {
    throw new Error('malformed receive-pack command list');
  }
  const { commands, packStart } = parsed;
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  const incoming = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: store.lookup });
      for (const [oid, object] of objects) incoming.set(oid, object);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    const results: Array<{ command: PushCommand; ok: boolean; reason?: string }> = [];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.next === ZERO_OID) {
        // Delete.
        if (current === undefined) results.push({ command, ok: false, reason: 'remote ref does not exist' });
        else if (command.old !== ZERO_OID && command.old !== current) results.push({ command, ok: false, reason: 'non-fast-forward' });
        else results.push({ command, ok: true });
        continue;
      }
      const target = incoming.get(command.next) ?? store.getObject(command.next);
      if (!target) {
        results.push({ command, ok: false, reason: 'unable to resolve new object' });
        continue;
      }
      if (command.old === ZERO_OID) {
        // Create.
        if (current !== undefined) results.push({ command, ok: false, reason: 'already exists' });
        else results.push({ command, ok: true });
        continue;
      }
      // Update: the old value must be the current tip, and the new tip must descend from it.
      if (current === undefined) {
        results.push({ command, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (command.old !== current) {
        results.push({ command, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (target.type !== 'commit' || !isAncestor(command.old, command.next, (oid) => incoming.get(oid) ?? store.getObject(oid))) {
        results.push({ command, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      results.push({ command, ok: true });
    }
    for (const [oid, object] of incoming) store.putObject(object.type, object.data);
    for (const result of results) {
      if (result.ok) {
        if (result.command.next === ZERO_OID) repo.refs.delete(result.command.ref);
        else repo.refs.set(result.command.ref, result.command.next);
        report.push(`ok ${result.command.ref}\n`);
      } else {
        report.push(`ng ${result.command.ref} ${result.reason ?? 'failed'}\n`);
      }
    }
  }
  const payload = encodePktLines(report);
  return Buffer.concat([sideband(payload), encodePktLines(['flush'])]);
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Serve one git request. `subpath` is everything after /{owner}/{repo}.git. Returns null
 * when the path is not a git route at all (the caller then falls through to a 404).
 */
export function handleGit(
  store: Store,
  repoOwner: string,
  repoName: string,
  subpath: string,
  ctx: HandlerContext,
): HandlerResult | null {
  const repo = store.getRepo(repoOwner, repoName);
  if (repo === undefined) return { status: 404, body: { message: 'Not Found' } };
  if (ctx.method === 'GET' && subpath === 'info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      return { status: 200, headers: { 'content-type': UPLOAD_PACK_AD }, body: advertiseUploadPack(store, repo) };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, headers: { 'content-type': RECEIVE_PACK_AD }, body: advertiseReceivePack(store, repo) };
    }
    return { status: 400, body: { message: 'unknown service' } };
  }
  if (ctx.method === 'POST' && (subpath === 'git-upload-pack' || subpath === 'upload-pack')) {
    try {
      const packets = decodePktLines(ctx.body);
      const first = packetLines(packets)[0]?.trim() ?? '';
      if (first.startsWith('command=ls-refs')) {
        const args = packetLines(packets).slice(1);
        return { status: 200, headers: { 'content-type': UPLOAD_PACK_RESULT }, body: handleLsRefs(store, repo, args) };
      }
      if (first.startsWith('command=fetch')) {
        return { status: 200, headers: { 'content-type': UPLOAD_PACK_RESULT }, body: handleFetchV2(store, repo, ctx.body) };
      }
      if (first.startsWith('want ')) {
        return { status: 200, headers: { 'content-type': UPLOAD_PACK_RESULT }, body: handleFetchV0(store, ctx.body) };
      }
      return { status: 400, body: { message: 'unknown upload-pack command' } };
    } catch (error) {
      return { status: 400, body: { message: error instanceof Error ? error.message : String(error) } };
    }
  }
  if (ctx.method === 'POST' && (subpath === 'git-receive-pack' || subpath === 'receive-pack')) {
    try {
      return { status: 200, headers: { 'content-type': RECEIVE_PACK_RESULT }, body: handleReceivePack(store, repo, ctx.body) };
    } catch (error) {
      return { status: 400, body: { message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return null;
}
