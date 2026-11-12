// `agent-broker compose` refuses a project whose resolved config (fake `docker compose config` output here) gives a
// container the broker's own folders or the Docker socket. Nothing here runs Docker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { COMPOSE_COMMAND_NAMES, COMPOSE_COMMANDS, commandProblems } from '../bin/compose-guard.mjs';
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
  await fs.writeFile(path.join(bin, 'docker'), `#!/bin/sh\ncase " $* " in *" config "*) echo "CONFIG $*" >> "${log}"; cat "${cfg}";; *) echo "RAN $*" >> "${log}"; echo "STDIN:$(cat)" >> "${log}"; echo "ran $OWN";; esac\n`, { mode: 0o755 });
  let r = admin(['apply', '--stack', 'demo', '--new-stack', '--project', 'app', '--new-project', '--path', project], `project:APP_SECRET=${OWN}\n`);
  assert.equal(r.status, 0, r.stderr);
  r = admin(['apply', '--group', 'other', '--new-group', '--grant-root', 'OTHER_KEY'], `group:OTHER_KEY=${OTHER}\n`);
  assert.equal(r.status, 0, r.stderr);
});

async function compose(config, args, { input, dotenv } = {}) {
  await fs.writeFile(cfg, JSON.stringify(config));
  await fs.writeFile(log, '');
  if (dotenv === undefined) await fs.rm(path.join(project, '.env'), { force: true });
  else await fs.writeFile(path.join(project, '.env'), dotenv);
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'compose', ...args], { cwd: project, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', input });
  await fs.rm(path.join(project, '.env'), { force: true });
  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  return { ...r, ran: lines.filter((l) => l.startsWith('RAN')), configCalls: lines.filter((l) => l.startsWith('CONFIG')), stdinSeen: lines.filter((l) => l.startsWith('STDIN:')).map((l) => l.slice(6)) };
}
const svc = (extra) => ({ services: { web: { image: 'x', ...extra } } });
const bind = (source) => svc({ volumes: [{ type: 'bind', source, target: '/t' }] });

test('a clean config starts: named volumes, ordinary binds, GPU reservations and a project-own value pass', async () => {
  const r = await compose({
    services: {
      web: { image: 'x', environment: { APP_SECRET: OWN }, volumes: [{ type: 'bind', source: path.join(project, 'data'), target: '/d' }, { type: 'bind', source: '/srv/media', target: '/m' }, { type: 'bind', source: '/etc/localtime', target: '/etc/localtime' }, { type: 'volume', source: 'pgdata', target: '/p' }], deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1 }] } } } },
    },
    volumes: { pgdata: {}, media: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/srv/media' } } },
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
    ['a volume that mounts a block device', { ...svc({}), volumes: { v: { driver: 'local', driver_opts: { type: 'ext4', device: '/dev/sda1' } } } }, 'volume "v": driver_opts device /dev/sda1'],
    ['a volume with device and no bind (nfs)', { ...svc({}), volumes: { v: { driver: 'local', driver_opts: { type: 'nfs', o: 'addr=x', device: ':/export' } } } }, 'driver_opts device'],
    ['cap_add', svc({ cap_add: ['DAC_READ_SEARCH'] }), 'cap_add DAC_READ_SEARCH'],
    ['security_opt seccomp=unconfined', svc({ security_opt: ['seccomp=unconfined'] }), 'security_opt seccomp=unconfined'],
    ['security_opt apparmor=unconfined next to a harmless one', svc({ security_opt: ['no-new-privileges:true', 'apparmor=unconfined'] }), 'security_opt apparmor=unconfined'],
    ['userns_mode: host', svc({ userns_mode: 'host' }), 'userns_mode: host'],
    ['network_mode: host', svc({ network_mode: 'host' }), 'network_mode: host'],
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

test('only the named commands run; every other one is refused with the list, and nothing starts', async () => {
  for (const command of ['cp', 'export', 'publish', 'attach', 'watch', 'create', 'kill', 'events', 'ls', 'wait', 'pause', 'scale', 'bridge', 'commit', 'volumes', 'nothing']) {
    const r = await compose(svc({}), [command, 'web']);
    assert.equal(r.status, 2, command);
    assert.deepEqual(r.ran, [], command);
    assert.match(r.stderr, new RegExp(`compose ${command} is not offered \\(allowed: ${COMPOSE_COMMAND_NAMES.join(', ')}\\)`), command);
  }
  const audit = await fs.readFile(path.join(home, 'log/broker.log'), 'utf8');
  assert.match(audit, /"service":"compose","command":"\(not offered\)"/);
});

test('X1: the three routes through Compose\'s own file flags are refused (env-from-file, cp through a link, export -o)', async () => {
  await fs.symlink(home, path.join(project, 's')).catch(() => {});
  for (const [args, mention] of [
    [['run', '--rm', '--env-from-file', `${home}/group-secrets/omp.env`, '-v', './:/w', 'web', 'sh', '-c', 'env > /w/out'], '--env-from-file is not offered'],
    [['run', '--rm', `--env-from-file=${home}/group-secrets/omp.env`, 'web'], '--env-from-file is not offered'],
    [['cp', 's/stack-secrets/demo.env', 'web:/x'], 'compose cp is not offered'],
    [['cp', 'web:/plugin', 's/.docker/cli-plugins/docker-compose'], 'compose cp is not offered'],
    [['export', '-o', `${home}/stack-secrets/demo.env`, 'web'], 'compose export is not offered'],
  ]) {
    const r = await compose(svc({}), args);
    assert.equal(r.status, 2, args.join(' '));
    assert.deepEqual(r.ran, [], args.join(' '));
    assert.ok(r.stderr.includes(mention), `${args.join(' ')}: ${r.stderr}`);
  }
});

test('a flag that is not in the table is refused by name; the never-allowed flags in every form', async () => {
  const refuse = async (args, mention) => {
    const r = await compose(svc({}), args);
    assert.equal(r.status, 2, args.join(' '));
    assert.deepEqual(r.ran, [], args.join(' '));
    assert.ok(r.stderr.includes(mention), `${args.join(' ')}: ${r.stderr}`);
  };
  await refuse(['up', '--nope'], 'up --nope is not offered');
  await refuse(['up', '-d', '-Z'], 'up -Z is not offered');
  await refuse(['logs', '--tail'], 'logs --tail needs a value');
  await refuse(['ps', '--quiet=maybe'], 'ps --quiet takes no value');
  for (const [cmd, flag] of [['run', '--env-from-file'], ['up', '--env-from-file'], ['run', '--privileged'], ['exec', '--privileged'], ['run', '--cap-add'], ['exec', '--cap-add'], ['build', '--ssh'], ['build', '--builder'], ['build', '-o'], ['build', '--output'], ['run', '-p'], ['up', '-p'], ['up', '--project-directory'], ['up', '-f'], ['run', '--project-name']]) {
    const r = await compose(svc({}), [cmd, flag, 'x', 'web']);
    assert.equal(r.status, 2, `${cmd} ${flag}`);
    assert.deepEqual(r.ran, [], `${cmd} ${flag}`);
    assert.ok(r.stderr.includes(`${cmd} ${flag} is not offered`), `${cmd} ${flag}: ${r.stderr}`);
    const eq = await compose(svc({}), [cmd, `${flag}=x`, 'web']);
    assert.equal(eq.status, 2, `${cmd} ${flag}=x`);
    assert.deepEqual(eq.ran, [], `${cmd} ${flag}=x`);
  }
  // Before the command: -p, --project-name and --project-directory are not offered (the folder decides the project).
  for (const flag of ['-p', '--project-name', '--project-directory']) {
    const r = await compose(svc({}), [flag, 'x', 'up']);
    assert.equal(r.status, 2, flag);
    assert.match(r.stderr, /is not offered before the command/, flag);
  }
  // After the service, flags belong to the container's own command.
  const inner = await compose(svc({}), ['exec', '-T', 'web', 'psql', '--privileged', '-p', '5432']);
  assert.equal(inner.status, 0, inner.stderr);
});

test('down -v and rm -v (remove volumes) are refused with a line telling the owner to run it', async () => {
  for (const args of [['down', '-v'], ['down', '--volumes'], ['down', '--remove-orphans', '-v'], ['down', '-vt', '5'], ['rm', '-fv', 'web'], ['rm', '--volumes', 'web']]) {
    const r = await compose(svc({}), args);
    assert.equal(r.status, 2, args.join(' '));
    assert.deepEqual(r.ran, [], args.join(' '));
    assert.match(r.stderr, /removes volumes, which can hold live data: run it yourself/, args.join(' '));
  }
});

test('the compose commands the runbooks use still run, with the flags they use', async () => {
  const used = [
    ['--profile', 'mcp', 'up', '-d', 'mcp'],
    ['--profile', 'mcp', 'ps', 'mcp'],
    ['--profile', 'mcp', 'stop', 'mcp'],
    ['--profile', 'mcp', 'rm', '-f', 'mcp'],
    ['--dry-run', 'up', '-d'],
    ['up', '-d'],
    ['up', '-d', '--force-recreate', 'worker'],
    ['up', '-d', '--no-deps', 'worker'],
    ['up', '-d', 'web'],
    ['ps'],
    ['logs', '-f', 'cron', 'app'],
    ['logs', 'worker', '--tail', '50', '--since=10m'],
    ['exec', '-T', 'db', 'pg_dump', '-U', 'user', 'name'],
    ['exec', 'web', 'tool', 'admin', 'user', 'create', '--admin', '--username', 'x', '--random-password'],
    ['exec', '-T', 'web', 'tool', 'admin', 'user', 'must-change-password', '--unset', 'bot'],
    ['run', '--rm', '--no-deps', '-e', 'MAX_CREATE=1', 'worker', 'python3', '-I', '/app/job.py', '--once'],
    ['run', '--rm', '--no-deps', '-T', 'worker', 'python3', '-I', '/app/switch.py'],
    ['run', '--rm', '-e', 'A=1', '-w', '/app', '--user', 'root', '--name', 'one', 'web', 'ls'],
    ['restart', 'worker'],
    ['down'],
    ['pull'],
    ['build', '--no-cache', '--pull'],
    ['start'],
    ['images'],
    ['top'],
    ['port', 'web', '80'],
    ['version'],
  ];
  for (const args of used) {
    const r = await compose(svc({}), args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(r.ran, [`RAN compose ${args.join(' ')}`], args.join(' '));
  }
  for (const args of [['config', '--quiet'], ['--profile', 'mcp', 'config', '--quiet']]) {
    const r = await compose(svc({}), args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.configCalls.length, 1);
  }
  // Read-only and stop commands do not resolve the config; the ones that start something do.
  assert.deepEqual((await compose(svc({}), ['ps'])).configCalls, []);
  assert.equal((await compose(svc({}), ['up', '-d'])).configCalls.length, 1);
});

test('run -v: a source in the broker home or the socket is refused in every flag form pflag accepts; named volumes and project folders pass', async () => {
  const blocked = [
    ['-v', `${home}:/h`], [`-v${home}:/h`], [`-v=${home}:/h`], ['--volume', `${home}/groups:/h:ro`], [`--volume=${home}:/h`],
    ['-Tv', `${home}:/h`], [`-Tv=${home}:/h`], [`-Tv${home}:/h`], ['-T', `-v=${home}:/h`],
    ['-v', '/var/run/docker.sock:/s'], ['-v', '/:/host'], ['-v', '~/x:/h'], ['-Tv', '/:/host'],
  ];
  for (const flags of blocked) {
    const r = await compose(svc({}), ['run', '--rm', ...flags, 'web', 'cat']);
    assert.equal(r.status, 2, flags.join(' '));
    assert.deepEqual(r.ran, [], flags.join(' '));
    assert.match(r.stderr, /run -v .* is /, flags.join(' '));
  }
  for (const flags of [['-v', 'pgdata:/d'], ['-v=pgdata:/d'], ['-v', './data:/w'], ['-v=./data:/w'], ['-Tv', './data:/w'], ['-Tv=./data:/w'], ['--volume', `${project}/x:/w`], ['-v', '/srv/media:/m:ro']]) {
    const r = await compose(svc({}), ['run', '--rm', ...flags, 'web', 'cat']);
    assert.equal(r.status, 0, `${flags.join(' ')}: ${r.stderr}`);
    assert.equal(r.ran.length, 1);
  }
  // After the service name, "-v ..." is the container's own command.
  assert.equal((await compose(svc({}), ['run', '--rm', 'web', 'ls', '-v', `${home}:/h`])).status, 0);
});

test('the commands the broker offers are the commands SKILL.md lists (one table, no drift)', async () => {
  const doc = await fs.readFile(path.join(BIN, '..', '..', 'SKILL.md'), 'utf8');
  assert.ok(doc.includes(`\`${COMPOSE_COMMAND_NAMES.join(', ')}\``), 'SKILL.md must list exactly: ' + COMPOSE_COMMAND_NAMES.join(', '));
  const help = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'help'], { env, encoding: 'utf8' });
  assert.ok(help.stdout.includes(COMPOSE_COMMAND_NAMES.join(', ')), help.stderr);
});

test('when the config cannot be resolved, nothing starts', async () => {
  await fs.writeFile(cfg, 'not json');
  await fs.writeFile(log, '');
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'compose', 'up'], { cwd: project, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /did not give JSON, so up was not started/);
  assert.ok(!(await fs.readFile(log, 'utf8')).includes('RAN'));
});

test('every command that can start or change containers is checked; read-only ones, stop and exec are not', async () => {
  for (const command of ['up', 'run', 'start', 'restart', 'build']) {
    const r = await compose(bind(home), [command, 'web']);
    assert.equal(r.status, 2, command);
    assert.deepEqual(r.ran, [], command);
  }
  for (const command of ['ps', 'logs', 'down', 'stop', 'exec', 'pull', 'rm', 'images', 'top']) {
    const r = await compose(bind(home), [command, 'web']);
    assert.equal(r.status, 0, `${command}: ${r.stderr}`);
    assert.deepEqual(r.configCalls, [], command);
    assert.equal(r.ran.length, 1);
  }
});

test('--env-file is in no table (Node itself stops it before the broker sees it, so the table is the second wall)', async () => {
  for (const command of COMPOSE_COMMAND_NAMES) {
    for (const flag of ['--env-file', '--env-from-file', '--privileged', '--cap-add', '--ssh', '--builder', '-o', '--output', '-p', '--project-directory', '--project-name', '-f']) {
      if (COMPOSE_COMMANDS[command].flags[flag]) continue; // -f: logs --follow, rm --force, version --format
      assert.deepEqual((await commandProblems(command, [flag, 'x'], { home, cwd: project })).length > 0, true, `${command} ${flag}`);
    }
  }
});

test('Y1: a compose file from stdin, a remote file or a hidden file list is refused; the check and the real call read the same files', async () => {
  const stdinForms = [
    ['-f -', ['-f', 'compose.yaml', '-f', '-', 'up', '-d']],
    ['--file=-', ['-f', 'compose.yaml', '--file=-', 'up', '-d']],
    ['-f - for ps', ['-f', '-', 'ps']],
    ['a git remote ref', ['-f', 'git@host.example:x/y.git', 'up']],
    ['an oci ref', ['-f', 'oci://registry.example/x:1', 'up']],
    ['an https ref', ['--file', 'https://host.example/c.yaml', 'up']],
    ['an absolute file', ['-f', '/tmp/evil.yaml', 'up']],
  ];
  for (const [what, args] of stdinForms) {
    const r = await compose(svc({}), args, { input: 'services: {}\n' });
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.deepEqual([r.ran, r.configCalls], [[], []], what);
  }
  const envForms = [
    ['COMPOSE_FILE=compose.yaml:- in .env', 'COMPOSE_FILE=compose.yaml:-\n', /COMPOSE_FILE entry "-"/],
    ['a quoted list', 'COMPOSE_FILE="compose.yaml:-"\n', /entry "-"/],
    ['export form', 'export COMPOSE_FILE=compose.yaml:-\n', /entry "-"/],
    ['a custom separator', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=compose.yaml;-\n', /entry "-"/],
    ['a custom separator hiding a colon entry', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=compose.yaml;git@host.example:x/y.git\n', /remote reference/],
    ['a remote ref', 'COMPOSE_FILE=compose.yaml:oci://registry.example/x\n', /COMPOSE_FILE entry/],
    ['a file outside the project', 'COMPOSE_FILE=compose.yaml:../other/c.yaml\n', /not a path inside the project/],
    ['a variable', 'COMPOSE_FILE=${X}\n', /variable/],
    ['COMPOSE_ENV_FILES', 'COMPOSE_ENV_FILES=/x/.env\n', /COMPOSE_ENV_FILES/],
  ];
  for (const [what, dotenv, mention] of envForms) {
    for (const command of ['up', 'ps']) {
      const r = await compose(svc({}), [command], { dotenv });
      assert.equal(r.status, 2, `${what} ${command}: ${r.stderr}`);
      assert.match(r.stderr, mention, what);
      assert.deepEqual([r.ran, r.configCalls], [[], []], what);
    }
  }
  // Ordinary lists still run, and Compose's own default files (no list at all) are left alone.
  for (const dotenv of ['COMPOSE_FILE=compose.yaml:compose.prod.yaml\n', 'COMPOSE_PATH_SEPARATOR=;\nCOMPOSE_FILE=compose.yaml;compose.prod.yaml\n', 'OTHER=1\n', 'COMPOSE_FILE=\n']) {
    const r = await compose(svc({}), ['up', '-d'], { dotenv });
    assert.equal(r.status, 0, `${dotenv}: ${r.stderr}`);
    assert.match(r.ran[0], /^RAN compose up -d$/);
  }
  const plain = await compose(svc({}), ['up', '-d']);
  assert.equal(plain.status, 0);
  assert.equal(plain.ran[0], 'RAN compose up -d'); // no explicit -f where there was none
});

test('Y1: stdin goes only to run and exec; up, build, restart, start and the rest run with it ignored', async () => {
  for (const command of ['up', 'build', 'restart', 'start', 'ps', 'pull']) {
    const r = await compose(svc({}), [command], { input: 'services: {web: {image: evil}}\n' });
    assert.equal(r.status, 0, `${command}: ${r.stderr}`);
    assert.deepEqual(r.stdinSeen, [''], `${command} must not see stdin`);
  }
  for (const args of [['exec', '-T', 'db', 'psql'], ['run', '--rm', '-T', 'web', 'cat']]) {
    const r = await compose(svc({}), args, { input: 'select 1;\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdinSeen, ['select 1;'], `${args[0]} keeps stdin (the runbooks pipe SQL into exec -T)`);
  }
});

test('Y2: every key that makes the client read or write a host path goes through the path check', async () => {
  const cases = [
    ['env_file as a string', svc({ env_file: path.join(home, 'secrets/app.env') }), 'env_file'],
    ['env_file as a list of strings', svc({ env_file: ['/dev/null', path.join(home, 'group-secrets/x.env')] }), 'env_file'],
    ['env_file as a list of objects', svc({ env_file: [{ path: path.join(home, 'x.env'), required: true }] }), 'env_file'],
    ['label_file', svc({ label_file: [path.join(home, 'labels')] }), 'label_file'],
    ['an absolute dockerfile', svc({ build: { context: project, dockerfile: path.join(home, 'Dockerfile') } }), 'build dockerfile'],
    ['a dockerfile that climbs out of the context', svc({ build: { context: path.join(project, 'sub'), dockerfile: path.relative(path.join(project, 'sub'), path.join(home, 'Dockerfile')) } }), 'build dockerfile'],
    ['build ssh as strings', svc({ build: { context: project, ssh: [`default=${path.join(home, 'key')}`] } }), 'build ssh'],
    ['build ssh as objects', svc({ build: { context: project, ssh: [{ id: 'default', path: path.join(home, 'key') }] } }), 'build ssh'],
    ['cache_to type=local dest', svc({ build: { context: project, cache_to: [`type=local,dest=${path.join(home, 'cache')},mode=max`] } }), 'build cache_to'],
    ['cache_from type=local src', svc({ build: { context: project, cache_from: [`type=local,src=${home}`] } }), 'build cache_from'],
  ];
  for (const [what, config, mention] of cases) {
    const r = await compose(config, ['up', '-d']);
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.deepEqual(r.ran, [], what);
    assert.ok(r.stderr.includes(mention), `${what}: ${r.stderr}`);
  }
  const fine = svc({
    env_file: [path.join(project, 'app.env'), { path: path.join(project, 'more.env') }],
    label_file: path.join(project, 'labels'),
    build: { context: project, dockerfile: 'Dockerfile', ssh: ['default'], cache_from: ['type=local,src=cache', 'registry.example/app:cache'], cache_to: ['type=local,dest=cache', 'type=registry,ref=registry.example/app:cache'] },
  });
  const r = await compose(fine, ['up', '-d']);
  assert.equal(r.status, 0, r.stderr);
});

test('Y3 and the container: forms: device_cgroup_rules, a bind that is only named bind, and a join of another container', async () => {
  const cases = [
    ['device_cgroup_rules', svc({ device_cgroup_rules: ['b *:* rwm'] }), 'device_cgroup_rules'],
    ['an option that only contains the text bind', { ...svc({}), volumes: { v: { driver: 'local', driver_opts: { type: 'ext4', device: '/dev/sda1', o: 'usrjquota=bind,jqfmt=vfsv0' } } } }, 'driver_opts device /dev/sda1'],
    ['network_mode: container:', svc({ network_mode: 'container:other' }), 'network_mode container:other'],
    ['pid: container:', svc({ pid: 'container:other' }), 'pid container:other'],
    ['ipc: container:', svc({ ipc: 'container:other' }), 'ipc container:other'],
  ];
  for (const [what, config, mention] of cases) {
    const r = await compose(config, ['up', '-d']);
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.ok(r.stderr.includes(mention), `${what}: ${r.stderr}`);
  }
  for (const o of ['bind', 'rbind', 'ro,bind', 'bind,ro']) {
    const r = await compose({ ...svc({}), volumes: { v: { driver: 'local', driver_opts: { type: 'none', o, device: '/srv/media' } } } }, ['up', '-d']);
    assert.equal(r.status, 0, `${o}: ${r.stderr}`);
  }
  const ok = await compose(svc({ network_mode: 'service:db', pid: 'service:db', device_cgroup_rules: [] }), ['up', '-d']);
  assert.equal(ok.status, 0, ok.stderr);
});

test('N1: a name from the object prototype is not a command', async () => {
  for (const command of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await compose(svc({}), [command]);
    assert.equal(r.status, 2, command);
    assert.match(r.stderr, /is not offered/, command);
    assert.deepEqual(r.ran, [], command);
  }
});
