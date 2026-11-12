// The sending side of the token copy: this machine's account tokens (stacks the owner marked "shared") are copied to a
// second machine over SSH. The receiving side is `agent-broker-admin receive-from-mac` (one JSON line on stdin).
//
// Files (all in the broker home, 0600, hidden from the CLI sandbox):
//   .ssh/sync_ed25519, .ssh/known_hosts   the broker's own key and the one pinned host key set (never trust on first use)
//   sync/target.json                      { host, user, port }
//   sync/sent.json                        { <stack>: { <KEY>: last number used } }: only goes up, survives unshare and removal
//   sync-outbox/<stack>.<KEY>.json        one entry per stack and key: the message still to deliver (a newer one replaces it)
// A value is never in an argument, an output line or the audit log. Callers save the change locally FIRST; nothing here
// may fail that change, so copyAfterChange() never throws.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_KEYS, DIR, UsageError, audit, fail, listStacks, loadStack, loadStackSecrets, saveStack, writePrivate } from './lib.mjs';

// Tests only (dev root): a stand-in for ssh.
const SSH = process.env.AGENT_BROKER_DEV_ROOT && process.env.AGENT_BROKER_DEV_SSH ? process.env.AGENT_BROKER_DEV_SSH : '/usr/bin/ssh';
const KEYGEN = '/usr/bin/ssh-keygen';

export const KEY_FILE = path.join(DIR.ssh, 'sync_ed25519');
export const KNOWN_HOSTS = path.join(DIR.ssh, 'known_hosts');
const TARGET = path.join(DIR.sync, 'target.json');
const SENT = path.join(DIR.sync, 'sent.json');
const KEY_COMMENT = 'agent-broker';
const SEND_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entryFile = (stack, key) => path.join(DIR.outbox, `${stack}.${key}.json`);

async function readJson(file, dflt) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return dflt;
    throw e;
  }
}
const writeJson = (file, value) => writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);

/** A lock folder (stale after `staleMs`). Returns `busy` instead of running fn when it stays taken. */
const BUSY = Symbol('busy');
async function withLock(name, fn, { tries = 100, staleMs = 30000 } = {}) {
  const lock = path.join(DIR.sync, name);
  for (let i = 0; ; i++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const born = (await fs.stat(lock).catch(() => null))?.mtimeMs ?? Date.now();
      if (Date.now() - born > staleMs) await fs.rmdir(lock).catch(() => {});
      else if (i >= tries) return BUSY;
      else await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}
const withOutbox = async (fn) => {
  const r = await withLock('outbox.lock', fn);
  if (r === BUSY) throw new Error('the outbox is busy');
  return r;
};

// ---- Setup ---------------------------------------------------------------------------------------------------------

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const HOST_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ([A-Za-z0-9+/]{20,}={0,2})(?: .*)?$/;

export const loadTarget = () => readJson(TARGET, null);

/** One `<type> <key>` pair from what the owner pasted (a trailing comment is dropped); the key blob must name its own type. */
function parseHostKey(raw) {
  const m = HOST_KEY.exec(String(raw).trim());
  if (!m) fail('--host-key must be one SSH host public key: "<type> <base64 key>" (for example from: ssh-keyscan, or the receiving machine\'s trust-mac output)');
  const blob = Buffer.from(m[2], 'base64');
  const n = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  if (blob.subarray(4, 4 + n).toString('latin1') !== m[1]) fail(`--host-key: the key is not a ${m[1]} key`);
  return `${m[1]} ${m[2]}`;
}

/**
 * sync-setup: the broker's own key pair (kept when there is one; --new-key replaces it), a known_hosts file holding exactly
 * the given host keys, and the target. Opens no connection. Returns the lines to print.
 */
export async function setup({ to, hostKeys, user, port, newKey }) {
  const host = String(to ?? '').toLowerCase();
  if (!(isIP(host) || HOST.test(host))) fail(`--to must be a host name or an IP address: ${String(to ?? '').slice(0, 60)}`);
  const account = user ?? os.userInfo().username;
  if (!USER.test(account)) fail(`invalid --user: ${account.slice(0, 40)}`);
  const portNumber = port === undefined ? 22 : /^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : fail(`invalid --port: ${String(port).slice(0, 10)}`);
  if (!hostKeys?.length) fail("--host-key '<type key>' is required (once per key): the host key is pinned now, never trusted on first use");
  const keys = [...new Set(hostKeys.map(parseHostKey))];

  await fs.mkdir(DIR.ssh, { recursive: true, mode: 0o700 });
  await fs.chmod(DIR.ssh, 0o700);
  const have = await fs.stat(KEY_FILE).then(() => true, () => false);
  const lines = [];
  if (have && !newKey) lines.push(`kept the existing key ${KEY_FILE} (replace it with --new-key; the receiving side must then trust the new one)`);
  else {
    const tmp = path.join(DIR.ssh, `new-key.${process.pid}`);
    await fs.rm(tmp, { force: true });
    await fs.rm(`${tmp}.pub`, { force: true });
    const r = spawnSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', tmp], { encoding: 'utf8' });
    if (r.status !== 0) fail(`ssh-keygen failed: ${(r.stderr || r.error?.message || '').split('\n')[0].slice(0, 200)}`);
    await fs.chmod(tmp, 0o600);
    await fs.rename(`${tmp}.pub`, `${KEY_FILE}.pub`);
    await fs.rename(tmp, KEY_FILE);
    lines.push(have ? `replaced the key ${KEY_FILE}` : `made the key ${KEY_FILE} (mode 0600)`);
  }
  const spec = portNumber === 22 ? host : `[${host}]:${portNumber}`;
  await writePrivate(KNOWN_HOSTS, `${keys.map((k) => `${spec} ${k}`).join('\n')}\n`);
  await writeJson(TARGET, { host, user: account, port: portNumber });

  const pub = (await fs.readFile(`${KEY_FILE}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2);
  const publicLine = `${pub.join(' ')} ${KEY_COMMENT}`;
  await audit({ admin: 'sync-setup', host, user: account, port: portNumber, hostKeys: keys.length, newKey: Boolean(have && newKey) });
  lines.push(
    `target: ${account}@${host} port ${portNumber} (no connection was made)`,
    `pinned ${keys.length} host key${keys.length === 1 ? '' : 's'} for ${spec} in ${KNOWN_HOSTS}`,
    'your public key (give it to the receiving machine):',
    publicLine,
    'on the receiving machine, run:',
    `  agent-broker-admin trust-mac '${publicLine}' --from <this machine's address> --stacks <the stacks it may copy into, a,b>`,
  );
  return lines;
}

// ---- Shared stacks and the outbox ----------------------------------------------------------------------------------

export async function share(name) {
  const stack = await loadStack(name);
  if (stack.followsMac) fail('this stack follows another machine; it cannot be shared onward');
  const keys = Object.keys(await loadStackSecrets(name)).filter((k) => ACCOUNT_KEYS.includes(k));
  await saveStack(name, { ...stack, shared: true });
  await audit({ admin: 'share-stack', stack: name, keys });
  if (keys.length) await queue(name, keys);
  return keys;
}

/** Stops future copies and drops what was still waiting. Returns how many waiting or refused entries were dropped. */
export async function unshare(name) {
  const stack = await loadStack(name);
  if (!stack.shared) fail(`stack ${name} is not shared`);
  const { shared, ...rest } = stack;
  await saveStack(name, rest);
  const dropped = await dropEntries(name);
  await audit({ admin: 'unshare-stack', stack: name, dropped });
  return dropped;
}

export async function dropEntries(name) {
  return withOutbox(async () => {
    let n = 0;
    for (const e of await entries()) {
      if (e.stack !== name) continue;
      await fs.rm(entryFile(e.stack, e.key), { force: true });
      n++;
    }
    return n;
  });
}

async function entries() {
  const out = [];
  for (const f of (await fs.readdir(DIR.outbox).catch(() => [])).filter((n) => n.endsWith('.json')).sort()) {
    const e = await readJson(path.join(DIR.outbox, f), null).catch(() => null);
    if (e && typeof e.stack === 'string' && ACCOUNT_KEYS.includes(e.key) && Number.isSafeInteger(e.seq)) out.push(e);
  }
  return out;
}

/**
 * Queue the current local state of these keys of a shared stack: a new number each, one entry per stack and key (a newer
 * replaces an older one and keeps the time the copy has been waiting since). The value is read from what was saved.
 */
export async function queue(name, keys) {
  return withOutbox(async () => {
    const stack = await loadStack(name);
    const secrets = await loadStackSecrets(name);
    const sent = await readJson(SENT, {});
    for (const key of keys) {
      if (!ACCOUNT_KEYS.includes(key)) continue;
      const old = await readJson(entryFile(name, key), null).catch(() => null);
      // A number that only goes up. The clock seeds it, so a lost sent.json can never send numbers the receiving side already holds;
      // a held-newer answer names the number the other machine holds: step past it.
      const seq = Math.max((sent[name]?.[key] ?? 0) + 1, Math.floor(Date.now() / 1000), Number.isSafeInteger(old?.held) ? old.held + 1 : 0);
      sent[name] = { ...sent[name], [key]: seq };
      const now = new Date().toISOString();
      await writeJson(entryFile(name, key), {
        v: 1, stack: name, key, value: secrets[key] ?? null, seq, accounts: stack.accounts ?? {},
        state: 'waiting', since: old?.state === 'waiting' && old.since ? old.since : now, queued_at: now, tries: 0,
      });
    }
    await writeJson(SENT, sent);
  });
}

/** `--all`: every key of every shared stack again, with fresh numbers (also asks again what was refused). */
export async function queueAll() {
  let n = 0;
  for (const name of await listStacks()) {
    const stack = await loadStack(name);
    if (!stack.shared) continue;
    const keys = Object.keys(await loadStackSecrets(name)).filter((k) => ACCOUNT_KEYS.includes(k));
    if (keys.length) await queue(name, keys);
    n += keys.length;
  }
  return n;
}

// ---- Delivery ------------------------------------------------------------------------------------------------------

/** The ssh argument list: no value in it; strict host key checking against the broker's own file; nothing from the user's config or agent. */
export function sshArgs(target) {
  return [
    '-F', '/dev/null', '-T', '-i', KEY_FILE,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no',
    '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-p', String(target.port), '-l', target.user, '--', target.host,
  ];
}

const clean = (s, value) => {
  let t = String(s ?? '');
  if (value) t = t.split(value).join('[secret]');
  return t.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
};

function ssh(target, line) {
  return new Promise((resolve) => {
    const env = process.env.AGENT_BROKER_DEV_ROOT ? process.env : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }; // no SSH_AUTH_SOCK
    const child = spawn(SSH, sshArgs(target), { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout, stderr, ...r }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ status: null, timedOut: true }); }, SEND_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < 4096) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    child.stdin.on('error', () => {}); // the far side may close early; the exit status tells
    child.on('error', (e) => finish({ status: null, error: e.code ?? e.message }));
    child.on('close', (status, signal) => finish({ status, signal }));
    child.stdin.end(line);
  });
}

/** What an ssh result means: sent | stale (the other side holds this or a newer number) | refused (for good) | retry. */
function classify(r, entry) {
  if (r.error) return { outcome: 'retry', reason: `cannot run ssh (${clean(r.error)})`, connection: true };
  if (r.timedOut) return { outcome: 'retry', reason: 'the connection timed out', connection: true };
  const err = clean(r.stderr.split('\n').find((l) => l.trim()), entry.value);
  switch (r.status) {
    case 0:
      return /^(stored|deleted) /.test(r.stdout) ? { outcome: 'sent' } : { outcome: 'retry', reason: 'the other machine gave an unexpected answer' };
    case 3: {
      // The receiver's own words: "seq N is not higher than H ...": H is the number it holds. The same number means this very copy
      // already arrived (an answer got lost): done. A higher one means this sender's numbers are behind: keep it visible.
      const held = Number(/is not higher than (\d{1,16})\b/.exec(r.stderr)?.[1]);
      return held === entry.seq ? { outcome: 'stale' } : { outcome: 'held-newer', held: Number.isSafeInteger(held) ? held : null };
    }
    case 2: {
      const m = /refused \(([a-z-]{1,30})\): ([^\n]*)/.exec(r.stderr);
      return { outcome: 'refused', code: m?.[1] ?? 'refused', reason: clean(m?.[2] ?? err ?? 'refused', entry.value) };
    }
    case 4: return { outcome: 'retry', reason: 'the other machine is busy' };
    case 255: return { outcome: 'retry', reason: err || 'ssh could not connect', connection: true };
    case null: return { outcome: 'retry', reason: `ssh stopped (${clean(r.signal)})`, connection: true };
    default: return { outcome: 'retry', reason: `the other machine answered with exit ${r.status}${err ? `: ${err}` : ''}` };
  }
}

/** Record one result, unless a newer entry replaced this one meanwhile. */
async function settle(entry, c) {
  await withOutbox(async () => {
    const file = entryFile(entry.stack, entry.key);
    const now = await readJson(file, null).catch(() => null);
    if (!now || now.seq !== entry.seq) return;
    if (c.outcome === 'sent' || c.outcome === 'stale') await fs.rm(file, { force: true });
    else if (c.outcome === 'held-newer') {
      const { value, accounts, ...rest } = now; // kept as a visible state; the value is not kept
      await writeJson(file, { ...rest, state: 'held-newer', held: c.held, noted_at: new Date().toISOString() });
    }
    else if (c.outcome === 'refused') {
      const { value, accounts, ...rest } = now; // a refused copy keeps no value
      await writeJson(file, { ...rest, state: 'refused', code: c.code, reason: c.reason, refused_at: new Date().toISOString() });
    } else await writeJson(file, { ...now, tries: (now.tries ?? 0) + 1, last_try: new Date().toISOString(), last_error: c.reason });
  });
  await audit({ sync: 'send', stack: entry.stack, key: entry.key, seq: entry.seq, outcome: c.outcome, ...(c.code ? { code: c.code } : {}) });
}

/**
 * Try every waiting entry, oldest first. Stops at the first failed connection (the others would time out the same way).
 * Returns { reason, results: [{ stack, key, outcome, code?, reason? }] }; `reason` says why nothing was tried or why it stopped.
 */
export async function deliver() {
  const waiting = (await entries()).filter((e) => e.state === 'waiting').sort((a, b) => a.since.localeCompare(b.since) || a.seq - b.seq);
  if (!waiting.length) return { reason: null, results: [] };
  const target = await loadTarget();
  if (!target) return { reason: 'no target is set (agent-broker-admin sync-setup)', results: [] };
  if (!(await fs.stat(KEY_FILE).then(() => true, () => false)) || !(await fs.stat(KNOWN_HOSTS).then(() => true, () => false))) {
    return { reason: 'the key or the pinned host key is missing (agent-broker-admin sync-setup)', results: [] };
  }
  const run = await withLock('sending.lock', async () => {
    const out = { reason: null, results: [] };
    for (const entry of waiting) {
      const line = `${JSON.stringify({ v: 1, stack: entry.stack, key: entry.key, value: entry.value, seq: entry.seq, accounts: entry.accounts })}\n`;
      const c = classify(await ssh(target, line), entry);
      await settle(entry, c);
      out.results.push({ stack: entry.stack, key: entry.key, outcome: c.outcome, code: c.code, reason: c.reason });
      if (c.connection) { out.reason = c.reason; break; }
    }
    return out;
  }, { tries: 40, staleMs: 120000 });
  return run === BUSY ? { reason: 'another delivery is running', results: [] } : run;
}

/** Plain words for a deliver() result. No value. */
export function describeDelivery(r) {
  const n = (o) => r.results.filter((x) => x.outcome === o);
  const lines = [];
  const sent = n('sent').length + n('stale').length;
  if (sent) lines.push(`delivered ${sent} cop${sent === 1 ? 'y' : 'ies'}`);
  for (const x of n('refused')) lines.push(`REFUSED by the other machine: ${x.stack} ${x.key} (${x.code}): ${x.reason}. It is kept as refused and not retried; fix the cause, then run: agent-broker-admin sync-push --all`);
  for (const x of n('held-newer')) lines.push(`the other machine holds a newer number for ${x.stack} ${x.key}: check it there, then run: agent-broker-admin sync-push --all`);
  const retry = n('retry');
  if (retry.length || r.reason) lines.push(`${retry.length ? `${retry.length} waiting` : 'waiting copies stay queued'}${r.reason ? ` (${r.reason})` : retry[0]?.reason ? ` (${retry[0].reason})` : ''}`);
  return lines;
}

/**
 * After a local change to account keys of `name`: queue, try at once, and say plainly what happened. Returns null for a
 * stack that is not shared. NEVER throws: the change is already saved.
 */
export async function copyAfterChange(name, keys) {
  try {
    if (!(await loadStack(name)).shared) return null;
    await queue(name, keys);
    const r = await deliver();
    const mine = new Map(r.results.filter((x) => keys.includes(x.key) && x.stack === name).map((x) => [x.key, x]));
    const refused = keys.map((k) => mine.get(k)).find((x) => x?.outcome === 'refused');
    if (refused) return `saved here; the other machine refused the copy (${refused.code}): ${refused.reason}. It is kept as refused; see: agent-broker health`;
    const behind = keys.map((k) => mine.get(k)).find((x) => x?.outcome === 'held-newer');
    if (behind) return `saved here; the other machine holds a newer number for ${behind.key} than this copy has: check it there, then run: agent-broker-admin sync-push --all (see: agent-broker health)`;
    const open = keys.filter((k) => !['sent', 'stale'].includes(mine.get(k)?.outcome));
    if (!open.length) return keys.every((k) => mine.get(k)?.outcome === 'stale') ? 'the other machine already holds this or a newer copy' : 'copied to the other machine';
    return `saved here; the copy is waiting (${mine.get(open[0])?.reason ?? r.reason ?? 'not delivered yet'}); it is retried every 10 minutes and by: agent-broker-admin sync-push`;
  } catch (e) {
    const reason = e instanceof UsageError ? e.message : e?.message ?? String(e);
    return `saved here; the copy could not be queued (${clean(reason)}); run: agent-broker-admin sync-push --all`;
  }
}

// ---- Health ----------------------------------------------------------------------------------------------------------

/** Notes for `agent-broker health`: waiting copies (how many, oldest since) and refused ones (code, stack and key). No value. */
export async function healthNotes() {
  const all = await entries().catch(() => []);
  const waiting = all.filter((e) => e.state === 'waiting');
  const refused = all.filter((e) => e.state === 'refused');
  const notes = [];
  if (waiting.length) notes.push(`${waiting.length} token cop${waiting.length === 1 ? 'y' : 'ies'} waiting for the other machine, oldest since ${waiting.map((e) => e.since).sort()[0]}`);
  for (const e of refused) notes.push(`copy refused by the other machine: ${e.stack} ${e.key} (${clean(e.code)})`);
  for (const e of all.filter((x) => x.state === 'held-newer')) notes.push(`the other machine holds a newer number for ${e.stack} ${e.key}${e.held ? ` (${e.held}, ours ${e.seq})` : ''}: check it, then run: agent-broker-admin sync-push --all`);
  return notes;
}
