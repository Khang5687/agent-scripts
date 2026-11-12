// The root grant's two commands: `get` (root-run setup scripts read granted keys) and the write guard on `set-group`
// for a root caller. sudo sets SUDO_UID to the uid of whoever ran sudo; here the test sets it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BIN = path.resolve(import.meta.dirname, '../bin');
const dev = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-root-'));
const READ = 'read-value-ABC123';
const OTHER = 'other-value-DEF456';
const WRITTEN = 'written-value-GHI789';
const env = (uid) => ({ ...process.env, AGENT_BROKER_DEV_ROOT: dev, AGENT_BROKER_SKIP_VERIFY: '1', ...(uid === undefined ? {} : { SUDO_UID: uid }) });
const admin = (uid, args, input) => spawnSync(process.execPath, [path.join(BIN, 'agent-broker-admin.mjs'), ...args], { cwd: dev, env: env(uid), input, encoding: 'utf8' });
const OWNER = '1000';
const ROOT = '0';

test.after(() => fs.rm(dev, { recursive: true, force: true }));

test.before(() => {
  const r = admin(OWNER, ['apply', '--group', 'setup', '--new-group', '--grant-root', 'READ_KEY', '--grant-root', 'EMPTY_KEY', '--grant-root-write', 'WRITE_KEY']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(admin(OWNER, ['set-group', 'setup', 'READ_KEY'], `${READ}\n`).status, 0);
  assert.equal(admin(OWNER, ['set-group', 'setup', 'OTHER_KEY'], `${OTHER}\n`).status, 0);
});

test('get: root reads a granted key; stdout is exactly the value and a newline', () => {
  const r = admin(ROOT, ['get', 'setup', 'READ_KEY']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${READ}\n`);
  assert.equal(r.stderr, '');
});

test('get: refused (exit 2, nothing on stdout) for a key outside the root grant\'s keys, a non-root caller, no sudo at all, a missing grant or group', () => {
  const cases = [
    [ROOT, ['get', 'setup', 'OTHER_KEY'], /not in the root grant's keys/], // stored, but not granted
    [ROOT, ['get', 'setup', 'WRITE_KEY'], /not in the root grant's keys/], // a write key is not a read key
    [OWNER, ['get', 'setup', 'READ_KEY'], /only for setup scripts run by root/],
    ['1', ['get', 'setup', 'READ_KEY'], /only for setup scripts run by root/],
    ['00', ['get', 'setup', 'READ_KEY'], /only for setup scripts run by root/],
    [undefined, ['get', 'setup', 'READ_KEY'], /only for setup scripts run by root/],
    [ROOT, ['get', 'nogroup', 'READ_KEY'], /unknown group/],
    [ROOT, ['get', 'setup', 'bad key'], /invalid key name/],
  ];
  for (const [uid, args, re] of cases) {
    const r = admin(uid, args);
    assert.equal(r.status, 2, `${uid} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${uid} ${args.join(' ')}`);
    assert.match(r.stderr, re);
    for (const v of [READ, OTHER, WRITTEN]) assert.ok(!r.stderr.includes(v));
  }
  const noGrant = admin(OWNER, ['apply', '--group', 'plain', '--new-group', '--grant-env', 'demo.service:PLAIN_KEY']);
  assert.equal(noGrant.status, 0, noGrant.stderr);
  const r = admin(ROOT, ['get', 'plain', 'PLAIN_KEY']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no root grant/);
});

test('get: a granted key with no stored value exits 3 and prints nothing on stdout', () => {
  const r = admin(ROOT, ['get', 'setup', 'EMPTY_KEY']);
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /has no value for EMPTY_KEY/);
});

test('root writes a key in the write list; any other key is refused and stays unchanged', () => {
  const w = admin(ROOT, ['set-group', 'setup', 'WRITE_KEY'], `${WRITTEN}\n`);
  assert.equal(w.status, 0, w.stderr);
  assert.ok(!`${w.stdout}${w.stderr}`.includes(WRITTEN));
  for (const key of ['READ_KEY', 'OTHER_KEY', 'NEW_KEY']) {
    const r = admin(ROOT, ['set-group', 'setup', key], 'overwrite-attempt-XYZ\n');
    assert.equal(r.status, 2, key);
    assert.match(r.stderr, /not in the root grant's write list/);
    assert.ok(!r.stderr.includes('overwrite-attempt-XYZ'));
  }
  assert.equal(admin(ROOT, ['get', 'setup', 'READ_KEY']).stdout, `${READ}\n`);
  // A group without a root grant has no write list: root stores nothing there.
  const r = admin(ROOT, ['set-group', 'plain', 'PLAIN_KEY'], 'x-value\n');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not in the root grant's write list/);
  // import-group goes through the same guard.
  assert.equal(admin(ROOT, ['import-group', 'setup'], 'OTHER_KEY=sneaky-value\n').status, 2);
});

test('a non-root set-group still stores any key (the owner\'s password-backed path); the stored write key is readable only if granted', () => {
  for (const uid of [OWNER, undefined]) {
    const r = admin(uid, ['set-group', 'setup', 'ANY_KEY'], 'any-value\n');
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(admin(OWNER, ['set-group', 'setup', 'READ_KEY'], `${READ}\n`).status, 0);
  // WRITE_KEY holds a value root stored, but `get` serves only the `keys` list.
  assert.equal(admin(ROOT, ['get', 'setup', 'WRITE_KEY']).status, 2);
});

test('the audit log has group, key name and result for each call, and no value', async () => {
  const log = await fs.readFile(path.join(dev, 'home', 'log', 'broker.log'), 'utf8');
  assert.match(log, /"admin":"get","group":"setup","key":"READ_KEY","result":"ok"/);
  assert.match(log, /"admin":"get","group":"setup","key":"OTHER_KEY","result":"not-granted"/);
  assert.match(log, /"admin":"get","group":"setup","key":"READ_KEY","result":"not-root"/);
  assert.match(log, /"admin":"get","group":"setup","key":"EMPTY_KEY","result":"no-value"/);
  assert.match(log, /"admin":"set-group","group":"setup","key":"OTHER_KEY","result":"root-not-in-write-list"/);
  for (const v of [READ, OTHER, WRITTEN, 'overwrite-attempt-XYZ', 'sneaky-value', 'any-value']) assert.ok(!log.includes(v), `the log holds ${v}`);
});
