// The sending side of the token copy, end to end: two broker homes (a sender and a receiver) in temp folders, and a
// stand-in for `ssh` that pipes its stdin into the receiver's `receive-from-mac` (or fails the way ssh and the receiver
// do). Runs without sudo, a network or a real second machine; a real Mac and a real SSH login are not covered here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BIN = path.resolve(import.meta.dirname, '../bin');
const LAUNCHD = path.resolve(import.meta.dirname, '../launchd/local.agent-broker.sync.plist');
const V1 = 'tok-value-one-ABC123';
const V2 = 'tok-value-two-DEF456';
const V3 = 'tok-value-three-GHI789';
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const hostKey = (fill) => `ssh-ed25519 ${Buffer.concat([u32(11), Buffer.from('ssh-ed25519'), u32(32), Buffer.alloc(32, fill)]).toString('base64')}`;
const HOST_KEY = hostKey(7);
const bases = [];

// Stand-in for ssh. It logs its arguments (one per line, a CALL line before each call), then behaves as `mode` says:
// `pipe` = the receiver's receive-from-mac; `<exit code>|<stderr text>` = fail like that (stdin is read and kept).
const STANDIN = `#!/bin/bash
{ echo CALL; printf '%s\\n' "$@"; } >> "$STANDIN_DIR/calls.log"
mode=$(cat "$STANDIN_DIR/mode" 2>/dev/null || echo pipe)
if [ "$mode" = pipe ]; then
  AGENT_BROKER_DEV_ROOT=$STANDIN_RECEIVER exec "$STANDIN_NODE" "$STANDIN_BIN/agent-broker-admin.mjs" receive-from-mac
fi
IFS='|' read -r code msg <<<"$mode"
cat >> "$STANDIN_DIR/stdin.log"
[ -z "$msg" ] || echo "$msg" >&2
exit "$code"
`;
const DOWN = '255|ssh: connect to host receiver.example port 22: Connection refused';

async function pair() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-sync-'));
  bases.push(base);
  const sdir = path.join(base, 'standin');
  const standin = path.join(base, 'ssh-standin.sh');
  await fs.mkdir(sdir);
  await fs.mkdir(path.join(base, 'sender'));
  await fs.mkdir(path.join(base, 'receiver'));
  await fs.writeFile(standin, STANDIN, { mode: 0o755 });
  const mk = (name, extra = {}) => {
    const root = path.join(base, name);
    const env = { ...process.env, AGENT_BROKER_DEV_ROOT: root, AGENT_BROKER_SKIP_VERIFY: '1', ...extra };
    const run = (script) => (args, input) => spawnSync(process.execPath, [path.join(BIN, script), ...args], { cwd: root, env, input, encoding: 'utf8' });
    const home = path.join(root, 'home');
    return {
      home, admin: run('agent-broker-admin.mjs'), broker: run('agent-broker.mjs'),
      secrets: (stack) => fs.readFile(path.join(home, 'stack-secrets', `${stack}.env`), 'utf8').catch(() => ''),
      outbox: async () => (await fs.readdir(path.join(home, 'sync-outbox')).catch(() => [])).sort(),
      entry: async (stack, key) => JSON.parse(await fs.readFile(path.join(home, 'sync-outbox', `${stack}.${key}.json`), 'utf8')),
      sent: async () => JSON.parse(await fs.readFile(path.join(home, 'sync', 'sent.json'), 'utf8')),
      log: () => fs.readFile(path.join(home, 'log', 'broker.log'), 'utf8').catch(() => ''),
    };
  };
  const send = mk('sender', { AGENT_BROKER_DEV_SSH: standin, STANDIN_DIR: sdir, STANDIN_RECEIVER: path.join(base, 'receiver'), STANDIN_NODE: process.execPath, STANDIN_BIN: BIN });
  const recv = mk('receiver');
  const calls = async () => (await fs.readFile(path.join(sdir, 'calls.log'), 'utf8').catch(() => '')).split('CALL\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean));
  const mode = (m) => fs.writeFile(path.join(sdir, 'mode'), m);
  return { base, send, recv, calls, mode, stdinLog: () => fs.readFile(path.join(sdir, 'stdin.log'), 'utf8').catch(() => '') };
}

const TRUST_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'Abc1'.repeat(11).slice(0, 43)}`;

/** A sender that is set up and shares stack `demo`. */
async function ready(extra = {}) {
  const p = await pair();
  assert.equal(p.send.admin(['sync-setup', '--to', '100.64.0.7', '--host-key', HOST_KEY]).status, 0);
  assert.equal(p.send.admin(['apply', '--stack', 'demo', '--new-stack']).status, 0);
  assert.equal(p.send.admin(['share-stack', 'demo']).status, 0);
  // The receiver names the stacks the sender may copy into (a sender key alone must not create any stack there).
  assert.equal(p.recv.admin(['trust-mac', TRUST_KEY, '--from', '100.64.0.7', '--stacks', 'demo,second,plain']).status, 0);
  return { ...p, ...extra };
}
const ok = (r) => { assert.equal(r.status, 0, `${r.stdout}${r.stderr}`); return r; };
const setKey = (p, key, value) => ok(p.send.admin(['set-stack', 'demo', key], `${value}\n`));
const everything = (...rs) => rs.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');

test('a stack the receiver did not allow is refused for good (stack-not-allowed), keeps no value, and creates nothing there', async () => {
  const p = await ready();
  ok(p.recv.admin(['trust-mac', TRUST_KEY, '--from', '100.64.0.7', '--stacks', 'other']));
  const r = setKey(p, 'APIFY_TOKEN', V1);
  assert.match(r.stdout, /refused the copy \(stack-not-allowed\): stack demo is not on the list this machine takes from the sender/);
  const e = await p.send.entry('demo', 'APIFY_TOKEN');
  assert.equal(e.state, 'refused');
  assert.equal(e.code, 'stack-not-allowed');
  assert.equal(e.value, undefined);
  assert.equal(await fs.readdir(path.join(p.recv.home, 'stacks')).then((l) => l.includes('demo.json')), false);
  assert.match(p.send.broker(['health']).stdout, /copy refused by the other machine: demo APIFY_TOKEN \(stack-not-allowed\)/);
  // The owner adds the stack there; the sender asks again.
  ok(p.recv.admin(['trust-mac', TRUST_KEY, '--from', '100.64.0.7', '--stacks', 'other,demo']));
  ok(p.send.admin(['sync-push', '--all']));
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
});

test.after(() => Promise.all(bases.map((b) => fs.rm(b, { recursive: true, force: true }))));

test('sync-setup: own key pair (0600), a known_hosts file with exactly the given keys, the target; no connection', async () => {
  const p = await pair();
  const second = hostKey(9);
  const r = ok(p.send.admin(['sync-setup', '--to', '100.64.0.7', '--host-key', HOST_KEY, '--host-key', `${second} some-comment`, '--port', '2222', '--user', 'broker-peer']));
  const ssh = path.join(p.send.home, '.ssh');
  const mode = async (f) => ((await fs.stat(f)).mode & 0o777).toString(8);
  assert.equal(await mode(path.join(ssh, 'sync_ed25519')), '600');
  assert.equal(await mode(ssh), '700');
  assert.equal(await mode(path.join(ssh, 'known_hosts')), '600');
  assert.equal(await fs.readFile(path.join(ssh, 'known_hosts'), 'utf8'), `[100.64.0.7]:2222 ${HOST_KEY}\n[100.64.0.7]:2222 ${second}\n`);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(p.send.home, 'sync', 'target.json'), 'utf8')), { host: '100.64.0.7', user: 'broker-peer', port: 2222 });
  const pub = (await fs.readFile(path.join(ssh, 'sync_ed25519.pub'), 'utf8')).trim().split(/\s+/);
  assert.ok(r.stdout.split("\n").includes(`ssh-ed25519 ${pub[1]} agent-broker`));
  assert.match(r.stdout, /trust-mac 'ssh-ed25519 \S+ agent-broker' --from/);
  assert.deepEqual(await p.calls(), [], 'sync-setup must not open a connection');

  // The user defaults to the broker user's own name and the port to 22; a second run keeps the key and replaces the pinned keys.
  const before = await fs.readFile(path.join(ssh, 'sync_ed25519'), 'utf8');
  const again = ok(p.send.admin(['sync-setup', '--to', 'peer.example', '--host-key', second]));
  assert.match(again.stdout, /kept the existing key/);
  assert.equal(await fs.readFile(path.join(ssh, 'sync_ed25519'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(ssh, 'known_hosts'), 'utf8'), `peer.example ${second}\n`);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(p.send.home, 'sync', 'target.json'), 'utf8')), { host: 'peer.example', user: os.userInfo().username, port: 22 });
  const fresh = ok(p.send.admin(['sync-setup', '--to', 'peer.example', '--host-key', second, '--new-key']));
  assert.match(fresh.stdout, /replaced the key/);
  assert.notEqual(await fs.readFile(path.join(ssh, 'sync_ed25519'), 'utf8'), before);
  assert.equal(await mode(path.join(ssh, 'sync_ed25519')), '600');
  assert.deepEqual(await p.calls(), []);
});

test('sync-setup refuses a missing, malformed or wrong-type host key and an option-looking target', async () => {
  const p = await pair();
  const bad = [
    [['--to', '100.64.0.7'], /--host-key/],
    [['--to', '100.64.0.7', '--host-key', 'ssh-ed25519 notbase64!'], /host public key/],
    [['--to', '100.64.0.7', '--host-key', `ssh-rsa ${HOST_KEY.split(' ')[1]}`], /not a ssh-rsa key/],
    [['--to', '-oProxyCommand=x', '--host-key', HOST_KEY], /--to must be a host name/],
    [['--to', '100.64.0.7', '--host-key', HOST_KEY, '--port', '70000'], /invalid --port/],
    [['--to', '100.64.0.7', '--host-key', HOST_KEY, '--user', '-oBad'], /invalid --user/],
    [['--host-key', HOST_KEY], /--to/],
  ];
  for (const [args, re] of bad) {
    const r = p.send.admin(['sync-setup', ...args]);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re);
  }
  assert.deepEqual(await fs.readdir(path.join(p.send.home, '.ssh')), [], 'a refused setup leaves no key or pinned host key behind');
});

test('copy end to end: share, set, rotate, unset reach the receiver, which holds a followsMac stack; labels travel too', async () => {
  const p = await ready();
  // Sharing a stack that holds nothing queues nothing; the first key then arrives at once.
  assert.deepEqual(await p.send.outbox(), []);
  const stackFile = path.join(p.send.home, 'stacks', 'demo.json');
  const rec = JSON.parse(await fs.readFile(stackFile, 'utf8'));
  await fs.writeFile(stackFile, JSON.stringify({ ...rec, accounts: { apify: { name: 'Acme', email: 'a@example.com' } } }));
  const first = setKey(p, 'APIFY_TOKEN', V1);
  assert.match(first.stdout, /stack demo: copied to the other machine/);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
  const listed = ok(p.recv.admin(['list'])).stdout.split('\n}\n').filter(Boolean).map((b) => JSON.parse(`${b}\n}`));
  const there = listed.find((s) => s.stack === 'demo');
  assert.equal(there.followsMac, true);
  assert.deepEqual(there.accounts.apify, { name: 'Acme', email: 'a@example.com' });
  assert.deepEqual(await p.send.outbox(), []);

  setKey(p, 'APIFY_TOKEN', V2);
  setKey(p, 'VERCEL_TOKEN', V3);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V2}\nVERCEL_TOKEN=${V3}\n`);
  const gone = ok(p.send.admin(['unset-stack', 'demo', 'APIFY_TOKEN']));
  assert.match(gone.stdout, /stack demo: copied to the other machine/);
  assert.equal(await p.recv.secrets('demo'), `VERCEL_TOKEN=${V3}\n`);
  assert.equal(await p.send.secrets('demo'), `VERCEL_TOKEN=${V3}\n`);
  // The receiver's copy cannot be changed there.
  assert.match(p.recv.admin(['set-stack', 'demo', 'APIFY_TOKEN'], `${V1}\n`).stderr, /follows the Mac/);
});

test('apply with stack:KEY lines and --stack-from-project copy too; a stack that is not shared sends nothing', async () => {
  const p = await ready();
  const dir = await fs.mkdtemp(path.join(p.base, 'proj-'));
  ok(p.send.admin(['apply', '--stack', 'demo'], `stack:NETLIFY_AUTH_TOKEN=${V1}\n`));
  assert.equal(await p.recv.secrets('demo'), `NETLIFY_AUTH_TOKEN=${V1}\n`);
  ok(p.send.admin(['apply', '--project', 'app', '--new-project', '--path', dir], `project:APIFY_TOKEN=${V2}\n`));
  const moved = ok(p.send.admin(['apply', '--stack', 'demo', '--stack-from-project', 'app']));
  assert.match(moved.stdout, /stack demo: copied to the other machine/);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V2}\nNETLIFY_AUTH_TOKEN=${V1}\n`);

  const before = (await p.calls()).length;
  ok(p.send.admin(['apply', '--stack', 'solo', '--new-stack']));
  const solo = ok(p.send.admin(['set-stack', 'solo', 'APIFY_TOKEN'], `${V3}\n`));
  assert.ok(!/copy|copied/.test(solo.stdout), solo.stdout);
  assert.equal((await p.calls()).length, before, 'an unshared stack sends nothing');
  assert.deepEqual((await p.send.outbox()).filter((f) => f.startsWith('solo.')), []);
  assert.equal(await p.recv.secrets('solo'), '');
});

test('offline: the change is saved, the command succeeds, one entry waits (the newer replaces the older), and a retry delivers it', async () => {
  const p = await ready();
  await p.mode(DOWN);
  const a = ok(p.send.admin(['set-stack', 'demo', 'APIFY_TOKEN'], `${V1}\n`));
  assert.match(a.stdout, /stack demo: saved here; the copy is waiting \(ssh: connect to host receiver\.example port 22: Connection refused\)/);
  assert.equal(await p.send.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
  assert.deepEqual(await p.send.outbox(), ['demo.APIFY_TOKEN.json']);
  const since = (await p.send.entry('demo', 'APIFY_TOKEN')).since;
  await new Promise((r) => setTimeout(r, 15));
  const b = ok(p.send.admin(['set-stack', 'demo', 'APIFY_TOKEN'], `${V2}\n`));
  assert.match(b.stdout, /the copy is waiting/);
  assert.deepEqual(await p.send.outbox(), ['demo.APIFY_TOKEN.json'], 'at most one entry per stack and key');
  const e = await p.send.entry('demo', 'APIFY_TOKEN');
  assert.equal(e.value, V2);
  assert.equal(e.since, since, 'the entry keeps the time the copy has been waiting since');
  assert.equal(await p.recv.secrets('demo'), '');

  // health: a note, not a failure
  const h = p.send.broker(['health']);
  assert.equal(h.status, 0, h.stdout);
  assert.match(h.stdout, new RegExp(`^ok: 0 groups, 0 grants; 1 token copy waiting for the other machine, oldest since ${since}\\n$`));

  // Back online: the timer's no-password command delivers only the newer value.
  await p.mode('pipe');
  const retry = ok(p.send.broker(['sync-retry']));
  assert.match(retry.stdout, /delivered 1 copy/);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V2}\n`);
  assert.deepEqual(await p.send.outbox(), []);
  assert.match(p.send.broker(['health']).stdout, /^ok: 0 groups, 0 grants\n$/);
  assert.equal(ok(p.send.broker(['sync-retry'])).stdout, '', 'nothing waiting: no output');
});

test('sync-retry with nothing waiting or no target does nothing; a waiting copy without a target says so and calls nothing', async () => {
  const p = await pair();
  ok(p.recv.admin(['trust-mac', TRUST_KEY, '--from', '100.64.0.7', '--stacks', 'demo']));
  assert.equal(ok(p.send.broker(['sync-retry'])).stdout, '');
  ok(p.send.admin(['apply', '--stack', 'demo', '--new-stack']));
  ok(p.send.admin(['share-stack', 'demo']));
  const r = setKey(p, 'APIFY_TOKEN', V1);
  assert.match(r.stdout, /saved here; the copy is waiting \(no target is set/);
  assert.match(ok(p.send.broker(['sync-retry'])).stdout, /waiting copies stay queued \(no target is set/);
  assert.deepEqual(await p.calls(), []);
  // Setting the target afterwards is enough: the queued copy goes out.
  ok(p.send.admin(['sync-setup', '--to', '100.64.0.7', '--host-key', HOST_KEY]));
  assert.match(ok(p.send.admin(['sync-push'])).stdout, /delivered 1 copy/);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
});

test('a stale answer (3) for this very number clears the entry; busy (4), an internal error (1), a login failure (255) and an unexpected answer keep it', async () => {
  const p = await ready();
  // An answer got lost: the copy arrived, the sender still holds it and sends the same number again.
  await p.mode(DOWN);
  setKey(p, 'APIFY_TOKEN', V1);
  const entryFile = path.join(p.send.home, 'sync-outbox', 'demo.APIFY_TOKEN.json');
  const copy = await fs.readFile(entryFile, 'utf8');
  await p.mode('pipe');
  ok(p.send.admin(['sync-push']));
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
  await fs.writeFile(entryFile, copy);
  assert.match(ok(p.send.admin(['sync-push'])).stdout, /delivered 1 copy/);
  assert.deepEqual(await p.send.outbox(), []);
  assert.equal(p.send.broker(['health']).stdout.includes('holds a newer number'), false);

  for (const [mode, reason] of [
    ['4|agent-broker-admin: refused (busy): another copy is being stored; try again', /busy/],
    ['1|agent-broker-admin: internal error: disk full', /exit 1: agent-broker-admin: internal error: disk full/],
    ['255|ssh: Permission denied (publickey).', /Permission denied/],
    ['0|', /unexpected answer/],
  ]) {
    await p.mode(mode);
    const r = setKey(p, 'APIFY_TOKEN', V2);
    assert.match(r.stdout, reason, mode);
    assert.equal((await p.send.entry('demo', 'APIFY_TOKEN')).state, 'waiting', mode);
  }
  await p.mode('pipe');
  ok(p.send.admin(['sync-push']));
  assert.deepEqual(await p.send.outbox(), []);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V2}\n`);
});

test('a refusal (2) is kept as refused with its code and reason and no value, reported once, not retried, health names it; a newer change asks again', async () => {
  const p = await ready();
  await p.mode(`2|agent-broker-admin: refused (bad-stack): invalid stack name ${V1}`);
  const first = setKey(p, 'APIFY_TOKEN', V1);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /the other machine refused the copy \(bad-stack\): invalid stack name \[secret\]/);
  const raw = await fs.readFile(path.join(p.send.home, 'sync-outbox', 'demo.APIFY_TOKEN.json'), 'utf8');
  const e = JSON.parse(raw);
  assert.equal(e.state, 'refused');
  assert.equal(e.code, 'bad-stack');
  assert.ok(!raw.includes(V1), 'a refused entry keeps no value');
  assert.equal(await p.send.secrets('demo'), `APIFY_TOKEN=${V1}\n`);

  const n = (await p.calls()).length;
  assert.equal(ok(p.send.admin(['sync-push'])).stdout, 'nothing waiting\n');
  assert.equal(ok(p.send.broker(['sync-retry'])).stdout, '');
  assert.equal((await p.calls()).length, n, 'a refused copy is not retried');
  const h = p.send.broker(['health']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^ok: 0 groups, 0 grants; copy refused by the other machine: demo APIFY_TOKEN \(bad-stack\)\n$/);

  // A newer change replaces the refused entry and tries again; so does --all.
  await p.mode('pipe');
  assert.match(setKey(p, 'APIFY_TOKEN', V2).stdout, /copied to the other machine/);
  assert.deepEqual(await p.send.outbox(), []);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V2}\n`);
});

test('the receiver\'s own refusal text is kept: a stack made there is refused for good (local-stack)', async () => {
  const p = await ready();
  ok(p.recv.admin(['apply', '--stack', 'demo', '--new-stack']));
  const r = setKey(p, 'APIFY_TOKEN', V1);
  assert.match(r.stdout, /refused the copy \(local-stack\): this stack was made here; it does not follow the Mac/);
  assert.equal((await p.send.entry('demo', 'APIFY_TOKEN')).state, 'refused');
});

test('sync-push --all queues every key of every shared stack again with higher numbers and resends them', async () => {
  const p = await ready();
  ok(p.send.admin(['apply', '--stack', 'second', '--new-stack']));
  ok(p.send.admin(['share-stack', 'second']));
  setKey(p, 'APIFY_TOKEN', V1);
  setKey(p, 'VERCEL_TOKEN', V2);
  ok(p.send.admin(['set-stack', 'second', 'NETLIFY_AUTH_TOKEN'], `${V3}\n`));
  const seqs = async () => JSON.parse(await fs.readFile(path.join(p.recv.home, 'sync', 'seq.json'), 'utf8'));
  const before = await seqs();
  // The receiver lost its copy of everything; --all puts it back, and nothing is changed on the sender.
  for (const s of ['demo', 'second']) await fs.writeFile(path.join(p.recv.home, 'stack-secrets', `${s}.env`), '');
  const calls = (await p.calls()).length;
  const r = ok(p.send.admin(['sync-push', '--all']));
  assert.match(r.stdout, /queued 3 keys again/);
  assert.match(r.stdout, /delivered 3 copies/);
  assert.equal((await p.calls()).length - calls, 3);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\nVERCEL_TOKEN=${V2}\n`);
  assert.equal(await p.recv.secrets('second'), `NETLIFY_AUTH_TOKEN=${V3}\n`);
  const after = await seqs();
  for (const [s, k] of [['demo', 'APIFY_TOKEN'], ['demo', 'VERCEL_TOKEN'], ['second', 'NETLIFY_AUTH_TOKEN']]) assert.ok(after[s][k].seq > before[s][k].seq, `${s} ${k}`);
});

test('the numbers only go up, across an unshare and a re-share; unsharing stops copies, drops the waiting ones and says what the other side keeps', async () => {
  const p = await ready();
  setKey(p, 'APIFY_TOKEN', V1);
  const n1 = (await p.send.sent()).demo.APIFY_TOKEN;
  setKey(p, 'APIFY_TOKEN', V2);
  const n2 = (await p.send.sent()).demo.APIFY_TOKEN;
  assert.ok(n2 > n1);

  await p.mode(DOWN);
  setKey(p, 'APIFY_TOKEN', V3);
  assert.deepEqual(await p.send.outbox(), ['demo.APIFY_TOKEN.json']);
  const un = ok(p.send.admin(['unshare-stack', 'demo']));
  assert.match(un.stdout, /no longer shared/);
  assert.match(un.stdout, /1 waiting or refused copy was dropped/);
  assert.match(un.stdout, /keeps what it already has until the owner drops it there/);
  assert.deepEqual(await p.send.outbox(), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(p.send.home, 'stacks', 'demo.json'), 'utf8')).shared, undefined);
  await p.mode('pipe');
  const calls = (await p.calls()).length;
  setKey(p, 'APIFY_TOKEN', V1);
  assert.equal((await p.calls()).length, calls, 'an unshared stack sends nothing');
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V2}\n`, 'the receiver keeps what it had');
  assert.match(p.send.admin(['unshare-stack', 'demo']).stderr, /not shared/);

  ok(p.send.admin(['share-stack', 'demo']));
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
  assert.ok((await p.send.sent()).demo.APIFY_TOKEN > n2, 'the counter survived the unshare');

  // Removing a shared stack drops what waits for it.
  await p.mode(DOWN);
  setKey(p, 'VERCEL_TOKEN', V3);
  const rm = ok(p.send.admin(['remove-stack', 'demo']));
  assert.match(rm.stdout, /it was shared: .*waiting copies dropped/);
  assert.deepEqual(await p.send.outbox(), []);
});

test('a stack that follows another machine cannot be shared onward', async () => {
  const p = await ready();
  setKey(p, 'APIFY_TOKEN', V1);
  const r = p.recv.admin(['share-stack', 'demo']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /follows another machine/);
  assert.equal(JSON.parse(await fs.readFile(path.join(p.recv.home, 'stacks', 'demo.json'), 'utf8')).shared, undefined);
  assert.match(p.send.admin(['share-stack', 'nope']).stderr, /unknown stack/);
});

test('list and agent-broker stacks show the shared mark', async () => {
  const p = await ready();
  ok(p.send.admin(['apply', '--stack', 'plain', '--new-stack']));
  const listed = ok(p.send.admin(['list'])).stdout.split('\n}\n').filter(Boolean).map((b) => JSON.parse(`${b}\n}`));
  assert.equal(listed.find((s) => s.stack === 'demo').shared, true);
  assert.equal(listed.find((s) => s.stack === 'plain').shared, undefined);
  const stacks = JSON.parse(ok(p.send.broker(['stacks'])).stdout);
  assert.equal(stacks.find((s) => s.stack === 'demo').shared, true);
  assert.equal(stacks.find((s) => s.stack === 'plain').shared, undefined);
});

test('ssh gets the message on stdin only: no value in the argument list, strict options, the broker\'s own key and host file; no value in any output, log or health', async () => {
  const p = await ready();
  const outputs = [];
  outputs.push(setKey(p, 'APIFY_TOKEN', V1));
  await p.mode(`255|ssh: Host key verification failed. ${V2}`);
  outputs.push(setKey(p, 'APIFY_TOKEN', V2));
  outputs.push(p.send.broker(['health']), p.send.broker(['stacks']), p.send.admin(['list']), p.send.admin(['sync-push']), p.send.admin(['sync-push', '--all']), p.send.admin(['log', '200']));
  await p.mode('pipe');
  outputs.push(p.send.broker(['sync-retry']));
  const all = await p.calls();
  assert.ok(all.length >= 3);
  const ssh = path.join(p.send.home, '.ssh');
  for (const args of all) {
    for (const a of args) for (const v of [V1, V2, V3]) assert.ok(!a.includes(v), `a value is in an argument: ${a}`);
    const opts = args.join('\n');
    for (const o of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'ForwardAgent=no', 'ClearAllForwardings=yes',
      'PasswordAuthentication=no', 'GlobalKnownHostsFile=/dev/null', 'ConnectTimeout=10', `UserKnownHostsFile=${path.join(ssh, 'known_hosts')}`]) {
      assert.ok(args.includes(o), `missing ${o}`);
    }
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', path.join(ssh, 'sync_ed25519')]);
    assert.ok(args.includes('-T'), 'no terminal');
    assert.ok(opts.includes('-F\n/dev/null'), 'no user config');
    assert.deepEqual(args.slice(-6), ['-p', '22', '-l', os.userInfo().username, '--', '100.64.0.7']);
  }
  // The same list, parsed by the real ssh (-G prints the settings and connects to nothing).
  if (await fs.stat('/usr/bin/ssh').catch(() => null)) {
    const g = spawnSync('/usr/bin/ssh', ['-G', ...all[0]], { encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    for (const line of ['stricthostkeychecking true', 'batchmode yes', 'identitiesonly yes', 'forwardagent no', 'connecttimeout 10', `userknownhostsfile ${path.join(ssh, 'known_hosts')}`, 'passwordauthentication no']) {
      assert.ok(g.stdout.split('\n').includes(line), `ssh -G: missing "${line}"`);
    }
  }
  for (const [what, text] of [['output', everything(...outputs)], ['sender log', await p.send.log()], ['receiver log', await p.recv.log()]]) {
    for (const v of [V1, V2, V3]) assert.ok(!text.includes(v), `${what} holds a value`);
  }
  assert.match(await p.send.log(), /"sync":"send","stack":"demo","key":"APIFY_TOKEN","seq":\d+,"outcome":"sent"/);
});

test('the message ssh receives is one JSON line: v, stack, key, value, seq, accounts', async () => {
  const p = await ready();
  await p.mode('0|');
  setKey(p, 'APIFY_TOKEN', V1);
  const lines = (await p.stdinLog()).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const msg = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(msg).sort(), ['accounts', 'key', 'seq', 'stack', 'v', 'value']);
  assert.equal(msg.v, 1);
  assert.equal(msg.stack, 'demo');
  assert.equal(msg.key, 'APIFY_TOKEN');
  assert.equal(msg.value, V1);
  assert.ok(Number.isSafeInteger(msg.seq) && msg.seq > 0);
});

test('the LaunchDaemon file is well-formed XML and runs sync-retry as the broker user every 10 minutes and at load', { skip: spawnSync('xmllint', ['--version']).error && 'xmllint not installed' }, async () => {
  assert.equal(spawnSync('xmllint', ['--noout', '--nonet', LAUNCHD], { encoding: 'utf8' }).status, 0);
  const text = await fs.readFile(LAUNCHD, 'utf8');
  assert.match(text, /<key>UserName<\/key>\s*<string>_deployer<\/string>/);
  assert.match(text, /<string>\/opt\/agent-broker\/bin\/agent-broker\.mjs<\/string>\s*<string>sync-retry<\/string>/);
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('X4: a stale answer for a number the other machine holds NEWER is kept and shown by health, not dropped; sync-push --all steps past it', async () => {
  const p = await ready();
  const held = Math.floor(Date.now() / 1000) + 80000; // what a stolen sender key could have planted
  await fs.mkdir(path.join(p.recv.home, 'sync'), { recursive: true });
  await fs.writeFile(path.join(p.recv.home, 'sync', 'seq.json'), JSON.stringify({ demo: { APIFY_TOKEN: { seq: held, at: new Date().toISOString() } } }));
  const r = setKey(p, 'APIFY_TOKEN', V1);
  assert.match(r.stdout, /the other machine holds a newer number for APIFY_TOKEN/);
  assert.doesNotMatch(r.stdout, /already holds this or a newer copy/);
  const raw = await fs.readFile(path.join(p.send.home, 'sync-outbox', 'demo.APIFY_TOKEN.json'), 'utf8');
  const e = JSON.parse(raw);
  assert.equal(e.state, 'held-newer');
  assert.equal(e.held, held);
  assert.ok(!raw.includes(V1), 'the entry keeps no value');
  assert.equal(await p.recv.secrets('demo'), '');
  const h = p.send.broker(['health']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /the other machine holds a newer number for demo APIFY_TOKEN \(\d+, ours \d+\): check it, then run: agent-broker-admin sync-push --all/);
  // Not retried by itself.
  const n = (await p.calls()).length;
  assert.equal(ok(p.send.admin(['sync-push'])).stdout, 'nothing waiting\n');
  assert.equal((await p.calls()).length, n);
  // --all asks again with a number past the one the other machine holds.
  assert.match(ok(p.send.admin(['sync-push', '--all'])).stdout, /delivered 1 copy/);
  assert.equal(await p.recv.secrets('demo'), `APIFY_TOKEN=${V1}\n`);
  assert.deepEqual(await p.send.outbox(), []);
  assert.ok((await p.send.sent()).demo.APIFY_TOKEN > held);
  assert.equal(p.send.broker(['health']).stdout.includes('holds a newer number'), false);
});
