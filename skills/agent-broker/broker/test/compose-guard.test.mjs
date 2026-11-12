// `agent-broker compose` refuses a project whose resolved config (fake `docker compose config` output here) gives a
// container the broker's own folders or the Docker socket. Nothing here runs Docker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BIN = path.resolve(import.meta.dirname, '../bin');
const dev = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-cguard-')));
const home = path.join(dev, 'home');
const env = { ...process.env, AGENT_BROKER_DEV_ROOT: dev, AGENT_BROKER_SKIP_VERIFY: '1' };
const admin = (args, input) => spawnSync(process.execPath, [path.join(BIN, 'agent-broker-admin.mjs'), ...args], { env, input, encoding: 'utf8' });
const OWN = 'own-project-value-0001';
const OTHER = 'group-value-not-this-projects-77';
const project = path.join(dev, 'repos', 'app');
const bin = path.join(dev, 'fake-bin');
const log = path.join(dev, 'docker.log');
const cfg = path.join(dev, 'config.json');

test.after(() => fs.rm(dev, { recursive: true, force: true }));
test.before(async () => {
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(bin);
  // config -> the JSON in $FAKE_CONFIG (and a log line); anything else -> a log line "RAN <args>".
  await fs.writeFile(path.join(bin, 'docker'), `#!/bin/sh\ncase " $* " in *" config "*) echo "CONFIG $*" >> "${log}"; cat "${cfg}";; *) echo "RAN $*" >> "${log}"; echo "ran $OWN";; esac\n`, { mode: 0o755 });
  let r = admin(['apply', '--stack', 'homelab', '--new-stack', '--project', 'app', '--new-project', '--path', project], `project:APP_SECRET=${OWN}\n`);
  assert.equal(r.status, 0, r.stderr);
  r = admin(['apply', '--group', 'other', '--new-group', '--grant-root', 'OTHER_KEY'], `group:OTHER_KEY=${OTHER}\n`);
  assert.equal(r.status, 0, r.stderr);
});

async function compose(config, args) {
  await fs.writeFile(cfg, JSON.stringify(config));
  await fs.writeFile(log, '');
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'compose', ...args], { cwd: project, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  return { ...r, ran: lines.filter((l) => l.startsWith('RAN')), configCalls: lines.filter((l) => l.startsWith('CONFIG')) };
}
const svc = (extra) => ({ services: { web: { image: 'x', ...extra } } });
const bind = (source) => svc({ volumes: [{ type: 'bind', source, target: '/t' }] });

test('a clean config starts: named volumes, ordinary binds, GPU reservations and a project-own value pass', async () => {
  const r = await compose({
    services: {
      web: { image: 'x', environment: { APP_SECRET: OWN }, volumes: [{ type: 'bind', source: path.join(project, 'data'), target: '/d' }, { type: 'bind', source: '/srv/media', target: '/m' }, { type: 'bind', source: '/etc/localtime', target: '/etc/localtime' }, { type: 'volume', source: 'pgdata', target: '/p' }], deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1 }] } } } },
    },
    volumes: { pgdata: {}, nfs: { driver: 'local', driver_opts: { type: 'nfs', o: 'addr=x', device: ':/export' } } },
  }, ['up', '-d']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.ran.length, 1);
  assert.match(r.ran[0], /^RAN compose up -d$/);
  // The check resolves every profile (`up web` turns its profile on by itself), with the files the real call uses, and never prints the config.
  assert.match(r.configCalls[0], /^CONFIG compose --profile \* config --format json$/);
  assert.ok(!r.stdout.includes('"services"'));
  const withOpts = await compose(svc({}), ['-f', 'compose.yaml', '--profile', 'mcp', '--dry-run', 'up']);
  assert.match(withOpts.configCalls[0], /^CONFIG compose -f compose.yaml --profile mcp --profile \* config --format json$/);
  assert.equal(withOpts.ran[0], 'RAN compose -f compose.yaml --profile mcp --dry-run up');
});

test('refused, with the service and the path named and nothing started: the broker home, inside it, above it, the Docker socket', async () => {
  await fs.symlink(home, path.join(project, 'link-to-home'));
  const cases = [
    ['the broker home', bind(home), home],
    ['inside the broker home', bind(path.join(home, 'group-secrets/omp.env')), 'group-secrets/omp.env'],
    ['a folder that holds the broker home', bind(path.dirname(home)), path.dirname(home)],
    ['the root folder', bind('/'), '/'],
    ['a symlink that points into the broker home', bind(path.join(project, 'link-to-home')), 'link-to-home'],
    ['a /home-style ancestor with ..', bind(`${home}/../home`), 'home'],
    ['the Docker socket', bind('/var/run/docker.sock'), 'docker.sock'],
    ['the Docker socket, other path', bind('/run/docker.sock'), 'docker.sock'],
    ['a named volume that binds the broker home', { ...svc({}), volumes: { v: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: home } } } }, 'volume "v"'],
    ['a secret file in the broker home', { ...svc({}), secrets: { s: { file: path.join(home, 'secrets/app.env') } } }, 'secret "s"'],
    ['a build context', svc({ build: { context: home } }), 'build context'],
    ['privileged', svc({ privileged: true }), 'privileged: true'],
    ['pid: host', svc({ pid: 'host' }), 'pid: host'],
    ['a host device', svc({ devices: [{ source: '/dev/sda', target: '/dev/sda' }] }), '/dev/sda'],
    ['a stored value that is not the project\'s (env_file of broker files)', svc({ environment: { LEAK: `x${OTHER}y` } }), 'not this project'],
  ];
  for (const [what, config, mention] of cases) {
    const r = await compose(config, ['up', '-d']);
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.deepEqual(r.ran, [], what);
    assert.match(r.stderr, /compose up refused, nothing was started/, what);
    assert.ok(r.stderr.includes(mention), `${what}: ${r.stderr}`);
    if (!/stored value/.test(what)) assert.match(r.stderr, /service "web"|volume|secret/, what);
    for (const v of [OWN, OTHER]) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), `${what}: a value in the output`);
  }
  // A refusal is in the audit log (reason, no value).
  const audit = await fs.readFile(path.join(home, 'log/broker.log'), 'utf8');
  assert.match(audit, /"service":"compose","command":"up","project":"app","refused":"service \\"web\\"/);
  assert.ok(!audit.includes(OTHER));
});

test('every command that can start or change containers is checked; read-only ones and exec are not', async () => {
  for (const command of ['up', 'run', 'create', 'start', 'restart', 'build']) {
    const r = await compose(bind(home), [command, 'web']);
    assert.equal(r.status, 2, command);
    assert.deepEqual(r.ran, [], command);
  }
  for (const command of ['ps', 'logs', 'down', 'stop', 'exec']) {
    const r = await compose(bind(home), [command, 'web']);
    assert.equal(r.status, 0, `${command}: ${r.stderr}`);
    assert.deepEqual(r.configCalls, [], command);
    assert.equal(r.ran.length, 1);
  }
});

test('run -v: a source in the broker home or the socket is refused in every flag form; named volumes and project folders pass', async () => {
  for (const flags of [['-v', `${home}:/h`], [`-v${home}:/h`], ['--volume', `${home}/groups:/h:ro`], [`--volume=${home}:/h`], ['-v', '/var/run/docker.sock:/s'], ['-v', '/:/host'], ['-v', '~/x:/h']]) {
    const r = await compose(svc({}), ['run', '--rm', ...flags, 'web', 'cat']);
    assert.equal(r.status, 2, flags.join(' '));
    assert.deepEqual(r.ran, [], flags.join(' '));
    assert.match(r.stderr, /-v .* is /, flags.join(' '));
  }
  for (const flags of [['-v', 'pgdata:/d'], ['-v', './data:/w'], ['--volume', `${project}/x:/w`], ['-v', '/srv/media:/m:ro']]) {
    const r = await compose(svc({}), ['run', '--rm', ...flags, 'web', 'cat']);
    assert.equal(r.status, 0, `${flags.join(' ')}: ${r.stderr}`);
    assert.equal(r.ran.length, 1);
  }
});

test('cp: a host path must stay inside the project folder', async () => {
  for (const args of [['cp', 'web:/etc/passwd', '/tmp/out'], ['cp', `${home}/groups/x.json`, 'web:/x'], ['cp', 'web:/x', '../out']]) {
    const r = await compose(svc({}), args);
    assert.equal(r.status, 2, args.join(' '));
    assert.deepEqual(r.ran, []);
  }
  const ok = await compose(svc({}), ['cp', 'web:/x', 'out/x']);
  assert.equal(ok.status, 0, ok.stderr);
});

test('when the config cannot be resolved, nothing starts', async () => {
  await fs.writeFile(cfg, 'not json');
  await fs.writeFile(log, '');
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'compose', 'up'], { cwd: project, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /did not give JSON, so up was not started/);
  assert.ok(!(await fs.readFile(log, 'utf8')).includes('RAN'));
});
