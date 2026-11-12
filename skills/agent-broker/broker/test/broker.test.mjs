// Security and routing invariants of the broker: token values never reach output; the project copy never follows
// links out of the project or carries a stored secret; the agent's folder (not a name it types) picks the project,
// and the project picks its account stack; only allow-listed actions and paths are accepted.
// Runs without sudo: AGENT_BROKER_DEV_ROOT puts the broker's home in a temp folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const dev = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-test-'));
process.env.AGENT_BROKER_DEV_ROOT = dev;
const lib = await import('../bin/lib.mjs');
const BIN = path.resolve(import.meta.dirname, '../bin');
const TOKEN = 'nfp_TESTtokenVALUE0123456789abcdef';

const env = { ...process.env, AGENT_BROKER_DEV_ROOT: dev, AGENT_BROKER_SKIP_VERIFY: '1' };
const broker = (args, cwd = dev) => spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), ...args], { cwd, env, encoding: 'utf8' });
const admin = (args, input) => spawnSync(process.execPath, [path.join(BIN, 'agent-broker-admin.mjs'), ...args], { env, input, encoding: 'utf8' });
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const folder = async (...parts) => {
  const d = path.join(await fs.realpath(dev), 'repos', ...parts);
  await fs.mkdir(d, { recursive: true });
  return d;
};

test.after(() => fs.rm(dev, { recursive: true, force: true }));

test('scrubber removes stored values and token-shaped strings', () => {
  // Token-shaped strings are built at runtime so secret scanners do not flag this file.
  const fake = (prefix, n) => `${prefix}_${'x7'.repeat(n / 2)}`;
  const netlifyToken = fake('nfp', 32);
  const supabaseToken = fake('sbp', 40);
  const scrub = lib.makeScrubber(['plain-secret-value']);
  const out = scrub([
    'stored plain-secret-value here',
    'postgresql://reader.abc:p%40ss@aws-0.pooler.supabase.com:5432/postgres',
    `netlify ${netlifyToken} supabase ${supabaseToken}`,
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlLXZhbHVl',
    'Authorization: Bearer abc.def-123',
  ].join('\n'));
  for (const leaked of ['plain-secret-value', 'p%40ss', netlifyToken, supabaseToken, 'eyJhbGci', 'abc.def-123']) assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
  assert.match(out, /postgresql:\/\/reader\.abc:\[secret\]@aws-0/);
});

test('stream scrubbing catches a token split across chunks', async () => {
  const input = new PassThrough();
  let out = '';
  const done = lib.scrubStream(input, { write: (s) => { out += s; } }, lib.makeScrubber([TOKEN]));
  input.write(`deploying with ${TOKEN.slice(0, 10)}`);
  input.write(`${TOKEN.slice(10)} done\nnext line`);
  input.end();
  await done;
  assert.equal(out, 'deploying with [secret] done\nnext line');
});

test('project copy skips links out of the project, unreadable files, env files and git data, and prunes removed files', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-src-'));
  const outside = path.join(dev, 'outside-secret.txt');
  await fs.writeFile(outside, 'not for the copy');
  await fs.mkdir(path.join(src, 'dist/sub'), { recursive: true });
  await fs.mkdir(path.join(src, '.git'));
  await fs.mkdir(path.join(src, 'data'));
  await fs.writeFile(path.join(src, 'dist/index.html'), '<p>ok</p>');
  await fs.writeFile(path.join(src, 'dist/sub/old.txt'), 'old');
  await fs.writeFile(path.join(src, '.env'), 'X=1');
  await fs.writeFile(path.join(src, '.git/config'), 'git');
  await fs.writeFile(path.join(src, 'data/big.parquet'), 'data');
  await fs.symlink(outside, path.join(src, 'dist/leak.txt'));
  await fs.symlink('../../..', path.join(src, 'dist/up'));
  await fs.symlink('index.html', path.join(src, 'dist/alias.html'));
  await fs.writeFile(path.join(src, 'private.yaml'), 'owner only', { mode: 0o000 });
  await fs.mkdir(path.join(src, 'private-dir'), { mode: 0o000 });
  const dest = path.join(dev, 'work-copy');

  const first = await lib.syncProject(src, dest, [TOKEN]);
  assert.deepEqual(first.skipped.sort(), ['dist/leak.txt', 'dist/up', 'private-dir/', 'private.yaml']);
  assert.equal(await fs.readFile(path.join(dest, 'dist/alias.html'), 'utf8'), '<p>ok</p>');
  for (const gone of ['.env', '.git', 'data', 'dist/leak.txt', 'dist/up', 'private.yaml']) assert.equal(await fs.lstat(path.join(dest, gone)).catch(() => null), null, gone);
  await fs.chmod(path.join(src, 'private-dir'), 0o700);

  await fs.rm(path.join(src, 'dist/sub/old.txt'));
  const second = await lib.syncProject(src, dest, [TOKEN]);
  assert.equal(second.changed, 0);
  assert.equal(await fs.lstat(path.join(dest, 'dist/sub/old.txt')).catch(() => null), null);
  await fs.rm(src, { recursive: true, force: true });
});

test('project copy refuses a file that contains a stored secret', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-src-'));
  await fs.writeFile(path.join(src, 'exfil.txt'), `token=${TOKEN}`);
  await assert.rejects(lib.syncProject(src, path.join(dev, 'work-exfil'), [TOKEN]), /contains a stored secret/);
  await fs.rm(src, { recursive: true, force: true });
});

test('a stack holds the account token once; every project on it uses it; output shows names, never values', async () => {
  const shop = await folder('shop');
  const blog = await folder('blog');
  ok(admin(['apply', '--stack', 'studio', '--new-stack', '--project', 'shop', '--new-project', '--path', shop, '--netlify-site', 'site-shop'],
    `stack:NETLIFY_AUTH_TOKEN=${TOKEN}\nproject:SUPABASE_READ_URL=postgresql://r.x:dbpass-secret@h:5432/postgres\n`));
  ok(admin(['apply', '--stack', 'studio', '--project', 'blog', '--new-project', '--path', blog, '--netlify-site', 'site-blog']));

  assert.equal((await lib.projectSecrets('blog', await lib.loadProject('blog'))).NETLIFY_AUTH_TOKEN, TOKEN);
  assert.deepEqual(Object.keys(await lib.loadSecrets('blog')), []); // the token is not copied into the project
  const stacks = JSON.parse(ok(broker(['stacks'])).stdout);
  assert.deepEqual(stacks[0].projects, ['blog', 'shop']);
  for (const out of [ok(broker(['stacks'])).stdout, ok(broker(['projects'])).stdout, ok(broker(['whoami'], shop)).stdout]) {
    assert.ok(!out.includes(TOKEN) && !out.includes('dbpass-secret'), out);
  }
  assert.ok((await lib.allSecretValues()).includes(TOKEN)); // stack values are scrubbed too

  // Replacing the stack token once changes it for both projects.
  ok(admin(['apply', '--stack', 'studio'], 'stack:NETLIFY_AUTH_TOKEN=nfp_rotated_value_0000000000000000\n'));
  for (const p of ['shop', 'blog']) assert.equal((await lib.projectSecrets(p, await lib.loadProject(p))).NETLIFY_AUTH_TOKEN, 'nfp_rotated_value_0000000000000000');
  // A project-only value is refused as a stack token.
  assert.match(admin(['apply', '--stack', 'studio'], 'stack:SUPABASE_READ_URL=x\n').stderr, /not an account token/);
});

test('the folder picks the project: subfolders, deepest folder, worktrees; wrong folder and old syntax are refused', async () => {
  const shop = await folder('shop');
  const sub = await folder('shop', 'src', 'deep');
  assert.equal(JSON.parse(ok(broker(['whoami'], sub)).stdout).project, 'shop');

  // Nested project folder: the deepest registered folder wins.
  const inner = await folder('shop', 'admin-app');
  ok(admin(['apply', '--stack', 'studio', '--project', 'shop-admin', '--new-project', '--path', inner]));
  assert.equal(JSON.parse(ok(broker(['whoami'], inner)).stdout).project, 'shop-admin');
  assert.equal(JSON.parse(ok(broker(['whoami'], sub)).stdout).project, 'shop');

  // A git worktree of a registered repository counts as that project; the copy comes from the worktree.
  await fs.mkdir(path.join(shop, '.git', 'worktrees', 'feat'), { recursive: true });
  const wt = await folder('shop-feat');
  await fs.writeFile(path.join(wt, '.git'), `gitdir: ${path.join(shop, '.git', 'worktrees', 'feat')}\n`);
  const who = JSON.parse(ok(broker(['whoami'], await folder('shop-feat', 'src'))).stdout);
  assert.equal(who.project, 'shop');
  assert.equal(who.folder, wt);

  const outside = broker(['netlify', 'status'], await folder('elsewhere'));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /is not inside a registered project/);
  const old = broker(['netlify', 'deploy', 'blog'], shop);
  assert.match(old.stderr, /the project comes from the folder you run in \(here: shop\)/);
  const other = broker(['netlify', 'status', '--project', 'blog'], shop);
  assert.match(other.stderr, /belongs to project shop/);
});

test('one folder holding two projects asks for --project, and accepts only those two', async () => {
  const mono = await folder('mono');
  ok(admin(['apply', '--stack', 'studio', '--project', 'web', '--new-project', '--path', mono, '--netlify-site', 'site-web']));
  ok(admin(['apply', '--stack', 'studio', '--project', 'api', '--new-project', '--path', mono, '--netlify-site', 'site-api']));
  assert.match(broker(['whoami'], mono).stderr, /holds 2 projects: (api, web|web, api).*--project/s);
  assert.equal(JSON.parse(ok(broker(['whoami', '--project', 'web'], mono)).stdout).project, 'web');
  assert.match(broker(['whoami', '--project', 'shop'], mono).stderr, /holds 2 projects/);
});

test('a project that held its own account token moves it into a new stack', async () => {
  const legacy = await folder('legacy');
  ok(admin(['apply', '--project', 'legacy', '--new-project', '--path', legacy, '--netlify-site', 'site-legacy'],
    'project:NETLIFY_AUTH_TOKEN=nfp_legacy_value_00000000000000000\nproject:SUPABASE_READ_URL=postgresql://a:b@c/d\n'));
  ok(admin(['apply', '--stack', 'acme', '--new-stack', '--stack-from-project', 'legacy', '--project', 'legacy']));
  assert.deepEqual(Object.keys(await lib.loadSecrets('legacy')), ['SUPABASE_READ_URL']);
  assert.equal((await lib.loadStackSecrets('acme')).NETLIFY_AUTH_TOKEN, 'nfp_legacy_value_00000000000000000');
  assert.equal((await lib.loadProject('legacy')).stack, 'acme');
});

test('only allow-listed actions, options and paths inside the project', async () => {
  const shop = await folder('shop');
  const escape = broker(['netlify', 'deploy', '--dir', '../..'], shop);
  assert.equal(escape.status, 2);
  assert.match(escape.stderr, /must be a path inside the project/);
  assert.match(broker(['netlify', 'env:list'], shop).stderr, /has no action "env:list"/);
  assert.match(broker(['netlify', 'deploy', '--debug'], shop).stderr, /unknown option --debug/);
  assert.match(broker(['supabase', 'query', 'select 1'], shop).stderr, /does not use supabase/);
});

// A fake CLI first in PATH that writes its arguments (one per line) and the token file it tries to read to `log`.
async function fakeCli(name, script) {
  const bin = await folder(`fake-${name}-bin`);
  const log = path.join(dev, `fake-${name}.log`);
  await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${script.replaceAll('$LOG', log)}\n`, { mode: 0o755 });
  const call = (args, cwd) => spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), ...args],
    { cwd, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  return { call, log };
}

test('netlify deploy is plain `netlify deploy --no-build` on the pinned site: no stored folder, options passed on', async () => {
  const shop = await folder('shop');
  const { call, log } = await fakeCli('netlify', 'printf "%s\\n" "$@" > "$LOG"');
  ok(call(['netlify', 'deploy', '--message', 'first try'], shop));
  // No --dir: the CLI reads netlify.toml [build] publish itself, as plain netlify does.
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), ['deploy', '--no-build', '--site', 'site-shop', '--message=first try']);
  ok(call(['netlify', 'deploy', '--dir', 'out', '--prod', '--alias', 'v2', '--message', '--prod'], shop));
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'),
    ['deploy', '--no-build', '--site', 'site-shop', '--dir=out', '--prod', '--alias=v2', '--message=--prod']);
  // The folder picks the site and account; the build never runs with the token present; --prod is the only prod switch.
  for (const flag of ['--site', '--auth', '--build', '--trigger', '--prod-if-unlocked', '--site-name']) {
    assert.match(call(['netlify', 'deploy', flag, 'x'], shop).stderr, new RegExp(`unknown option ${flag}`));
  }
  assert.match(call(['netlify', 'deploy', '--functions', '/etc'], shop).stderr, /must be a path inside the project/);
});

test('CLIs cannot read the broker token files, whatever path the project config points at', async () => {
  const shop = await folder('shop');
  const tokenFile = path.join(dev, 'home', 'stack-secrets', 'studio.env');
  const { call, log } = await fakeCli('netlify', `cat "${tokenFile}" > "$LOG" 2>&1; ls "${path.join(dev, 'home', 'projects')}" >> "$LOG" 2>&1; echo own > own.txt; echo done`);
  const r = ok(call(['netlify', 'deploy'], shop));
  assert.match(r.stdout, /done/);
  const seen = await fs.readFile(log, 'utf8');
  assert.match(seen, /Operation not permitted/);
  assert.ok(!seen.includes('NETLIFY_AUTH_TOKEN') && !seen.includes('shop.json'), seen);
  // Its own working copy stays writable.
  assert.equal(await fs.readFile(path.join(dev, 'home', 'work', 'shop', 'own.txt'), 'utf8'), 'own\n');
});

test('records with a stored build folder lose it on load: whoami shows none', async () => {
  const app = await folder('oldsite');
  ok(admin(['apply', '--stack', 'studio', '--project', 'oldsite', '--new-project', '--path', app, '--netlify-site', 'site-old']));
  const file = path.join(dev, 'home', 'projects', 'oldsite.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, netlify: { ...record.netlify, dir: '.next' }, apify: { dir: 'actor' } }));
  const who = JSON.parse(ok(broker(['whoami'], app)).stdout);
  assert.deepEqual(who.services.netlify, { site_id: 'site-old', token: true });
  assert.deepEqual(who.services.apify, { token: false });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual([saved.netlify, saved.apify], [{ site_id: 'site-old' }, {}]);
});

test('init: an agent registers an unclaimed git repo on an existing stack; claimed folders and pins are refused', async () => {
  ok(admin(['apply', '--stack', 'studio'], `stack:SUPABASE_ACCESS_TOKEN=${['sbp', 'fake', 'value'].join('_')}\n`));
  const repo = await folder('newapp');
  await fs.mkdir(path.join(repo, '.git'));
  const sub = await folder('newapp', 'src');
  assert.match(broker(['init', '--stack', 'nope'], sub).stderr, /unknown stack: nope/);
  assert.match(broker(['init'], sub).stderr, /give the account stack/);

  const made = JSON.parse(ok(broker(['init', '--stack', 'studio', '--netlify-site', 'site-new', '--supabase-ref', 'refnew', '--no-reader'], sub)).stdout);
  assert.equal(made.created, 'newapp');
  assert.equal(made.folder, repo); // the git root, not the subfolder it ran in
  assert.deepEqual(made.services.netlify, { site_id: 'site-new' });
  assert.match(broker(['init', '--stack', 'studio', '--here', '--netlify-dir', 'out'], await folder('dirapp')).stderr, /unknown option --netlify-dir/);
  assert.equal(JSON.parse(ok(broker(['whoami'], sub)).stdout).stack, 'studio');

  assert.match(broker(['init', '--stack', 'studio'], repo).stderr, /already belongs to project newapp/);
  // A folder holding a registered project is refused (it would swallow it).
  assert.match(broker(['init', '--stack', 'studio', '--here'], path.dirname(repo)).stderr, /holds project/);
  // A site or database pinned by another project is refused.
  const other = await folder('otherapp');
  assert.match(broker(['init', '--stack', 'studio', '--here', '--netlify-site', 'site-new'], other).stderr, /already belongs to project newapp/);
  assert.match(broker(['init', '--stack', 'studio', '--here', '--supabase-ref', 'refnew', '--no-reader'], other).stderr, /already belongs to project newapp/);
  // A service the stack has no token for is refused.
  assert.match(broker(['init', '--stack', 'studio', '--here', '--apify'], other).stderr, /stack studio has no apify token/);
  assert.equal(await fs.lstat(path.join(dev, 'home', 'projects', 'otherapp.json')).catch(() => null), null);
});

test('attach adds a missing service only; agents-md gives the block for the folder', async () => {
  const app = await folder('attachapp');
  ok(broker(['init', '--stack', 'studio', '--here'], app));
  assert.equal(JSON.parse(ok(broker(['attach', '--netlify-site', 'site-attach'], app)).stdout).services.netlify.site_id, 'site-attach');
  assert.match(broker(['attach', '--netlify-site', 'site-other'], app).stderr, /already uses netlify/);
  assert.match(broker(['attach', '--stack', 'acme'], app).stderr, /attach only adds services/);

  const md = JSON.parse(ok(broker(['agents-md', '--json'], app)).stdout);
  assert.equal(md.folder, app);
  assert.match(md.block, /uses account stack `studio`/);
  assert.match(md.block, /agent-broker netlify deploy/);
  assert.match(md.block, /agent-broker supabase query/);
});

test('apify commands give the CLI its token in a throwaway auth file that is removed afterwards', async () => {
  // apify-cli reads ~/.apify/auth.json (or the keyring), never APIFY_TOKEN, so the token has to arrive as that file.
  const apifyToken = ['apify', 'api', 'TESTtokenVALUE0123456789abcd'].join('_');
  ok(admin(['apply', '--stack', 'actors', '--new-stack'], `stack:APIFY_TOKEN=${apifyToken}\n`));
  const app = await folder('actorapp');
  ok(broker(['init', '--stack', 'actors', '--here', '--apify'], app));
  const bin = await folder('fake-apify-bin');
  const log = path.join(dev, 'fake-apify.log');
  await fs.writeFile(path.join(bin, 'apify'), `#!/bin/sh\n{ echo "HOME=$HOME"; echo "KEYRING=$APIFY_DISABLE_KEYRING"; cat "$HOME/.apify/auth.json"; } > "${log}"\necho '{"name":"x"}'\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'apify', 'info', 'acme/some-actor'],
    { cwd: app, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"name":"x"/);
  const [homeLine, keyringLine, ...auth] = (await fs.readFile(log, 'utf8')).split('\n');
  const home = homeLine.slice('HOME='.length);
  assert.notEqual(home, lib.HOME);
  assert.equal(keyringLine, 'KEYRING=1');
  assert.equal(JSON.parse(auth.join('\n')).token, apifyToken);
  assert.equal(await fs.lstat(home).catch(() => null), null, 'throwaway HOME left behind');
  assert.ok(!r.stdout.includes(apifyToken) && !r.stderr.includes(apifyToken));
});

test('the AGENTS.md block is written once, replaced on rerun, and reaches Claude Code', async () => {
  const { withBlock, writeBlocks } = await import('../bin/write-block.mjs');
  const block = (n) => `<!-- agent-broker:start -->\nblock ${n}\n<!-- agent-broker:end -->`;
  assert.equal(withBlock('# Rules\n', block(1)), `# Rules\n\n${block(1)}\n`);
  assert.equal(withBlock(withBlock('# Rules\n', block(1)), block(2)), `# Rules\n\n${block(2)}\n`);

  const empty = await folder('md-empty');
  writeBlocks(empty, block(1));
  assert.equal(await fs.readFile(path.join(empty, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(await fs.readFile(path.join(empty, 'AGENTS.md'), 'utf8'), /block 1/);

  const both = await folder('md-both');
  await fs.writeFile(path.join(both, 'AGENTS.md'), '# A\n');
  await fs.writeFile(path.join(both, 'CLAUDE.md'), '# C\n');
  assert.deepEqual(writeBlocks(both, block(1)), ['AGENTS.md', 'CLAUDE.md']);
  const imports = await folder('md-imports');
  await fs.writeFile(path.join(imports, 'AGENTS.md'), '# A\n');
  await fs.writeFile(path.join(imports, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.deepEqual(writeBlocks(imports, block(1)), ['AGENTS.md']);
});

test('global stack acts as default fallback when project has no explicit stack and in init', async () => {
  ok(admin(['apply', '--stack', 'global', '--new-stack'], `stack:NETLIFY_AUTH_TOKEN=nfp_global123\nstack:SUPABASE_ACCESS_TOKEN=sbp_global123\n`));
  const stacks = JSON.parse(ok(broker(['stacks'])).stdout);
  const glob = stacks.find((s) => s.stack === 'global');
  assert.ok(glob);
  assert.equal(glob.is_default, true);

  // init in an unclaimed folder without --stack should pick 'global' automatically
  const defapp = await folder('defapp');
  const made = JSON.parse(ok(broker(['init', '--netlify-site', 'site-def', '--here'], defapp)).stdout);
  assert.equal(made.stack, 'global');
  const who = JSON.parse(ok(broker(['whoami'], defapp)).stdout);
  assert.equal(who.stack, 'global');
  assert.equal(who.services.netlify.token, true);

  // A legacy project without explicit stack should fall back to global
  const legapp = await folder('legapp');
  await lib.saveProject('legapp', { paths: [legapp], netlify: { site_id: 'site-leg', dir: 'dist' } });
  const whoLeg = JSON.parse(ok(broker(['whoami'], legapp)).stdout);
  assert.equal(whoLeg.stack, 'global (default fallback)');
  assert.equal(whoLeg.services.netlify.token, true);
});
test('cli-guard blocks account commands but allows bypass via AGENT_BROKER_BYPASS and --global', async () => {
  const guardPath = path.resolve(import.meta.dirname, '../guard/cli-guard');
  const runGuard = (args, extraEnv = {}) => spawnSync('bash', [guardPath, ...args], {
    env: { ...process.env, PATH: '/usr/bin:/bin', ...extraEnv },
    encoding: 'utf8',
  });

  // Mock real netlify command in realBinDir, guard in guardBinDir
  const realBinDir = await folder('realbin');
  const guardBinDir = await folder('guardbin');
  const mockNetlify = path.join(realBinDir, 'netlify');
  await fs.writeFile(mockNetlify, '#!/bin/sh\necho "REAL_NETLIFY: $@"\n', { mode: 0o755 });

  const guardNetlify = path.join(guardBinDir, 'netlify');
  await fs.copyFile(guardPath, guardNetlify);
  await fs.chmod(guardNetlify, 0o755);

  const runMock = (args, extraEnv = {}) => spawnSync(guardNetlify, args, {
    env: { ...process.env, PATH: `${guardBinDir}:${realBinDir}:/usr/bin:/bin`, ...extraEnv },
    encoding: 'utf8',
  });
  // deploy should be blocked without bypass
  const blocked = runMock(['deploy', '--prod']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /needs an account/);
  assert.match(blocked.stderr, /pass --global or set AGENT_BROKER_BYPASS=1/);

  // dev (local safe command) should pass through
  const safe = runMock(['dev']);
  assert.equal(safe.status, 0);
  assert.match(safe.stdout, /REAL_NETLIFY: dev/);

  // bypass with env var
  const byEnv = runMock(['deploy', '--prod'], { AGENT_BROKER_BYPASS: '1' });
  assert.equal(byEnv.status, 0);
  assert.match(byEnv.stdout, /REAL_NETLIFY: deploy --prod/);

  // bypass with --global flag
  const byFlag = runMock(['deploy', '--global', '--prod']);
  assert.equal(byFlag.status, 0);
  assert.match(byFlag.stdout, /REAL_NETLIFY: deploy --prod/);
});

test('agents-md --stack outputs a project-agnostic snippet; unregistered repo with stack in AGENTS.md dynamically resolves', async () => {
  const out = ok(broker(['agents-md', '--stack', 'studio'])).stdout;
  assert.match(out, /This project uses account stack `studio`/);
  assert.match(out, /agent-broker netlify deploy/);
  assert.doesNotMatch(out, /attachapp|saas-1|analytics/); // zero project names or paths

  // New repository with zero pre-registration
  const brandNewRepo = await folder('brand-new-repo');
  await fs.mkdir(path.join(brandNewRepo, '.git'));
  await fs.writeFile(path.join(brandNewRepo, 'AGENTS.md'), out);

  // whoami inside the new repo resolves stack studio automatically
  const who = JSON.parse(ok(broker(['whoami'], brandNewRepo)).stdout);
  assert.equal(who.stack, 'studio');
  assert.equal(who.project, 'brand-new-repo');
  assert.equal(who.folder, brandNewRepo);
});

test('compose: docker compose in the registered folder with its stored values; output scrubbed; stdin passed on', async () => {
  const PW = 'compose-db-password-0123';
  const stack = await folder('homelab', 'stacks', 'firefly');
  ok(admin(['apply', '--stack', 'homelab', '--new-stack', '--project', 'firefly', '--new-project', '--path', stack], `project:POSTGRES_PASSWORD=${PW}\n`));
  const bin = await folder('fake-docker-bin');
  const log = path.join(dev, 'fake-docker.log');
  await fs.writeFile(path.join(bin, 'docker'), `#!/bin/sh\npwd > "${log}"\nprintf "%s\\n" "$@" >> "${log}"\necho "password=$POSTGRES_PASSWORD"\ncat\n`, { mode: 0o755 });
  const compose = (args, cwd, input = '') => spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'compose', ...args],
    { cwd, input, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

  // From a subfolder too: Compose always runs in the registered folder, so the Compose project name never changes.
  const r = ok(compose(['--profile', 'mcp', '-f', 'compose.yaml', 'exec', '-T', 'db', 'psql'], await folder('homelab', 'stacks', 'firefly', 'sub'), 'select 1;\n'));
  assert.equal(r.stdout, 'password=[secret]\nselect 1;\n');
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), [stack, 'compose', '--profile', 'mcp', '-f', 'compose.yaml', 'exec', '-T', 'db', 'psql']);

  // The folder and the broker decide the project folder and name; files stay inside the project. (--env-file never
  // reaches the broker: Node itself reads that flag, wherever it stands.)
  for (const [args, msg] of [
    [['-p', 'other', 'up'], /-p is not offered/],
    [['--project-directory=/', 'up'], /--project-directory is not offered/],
    [['-f', '../immich/compose.yaml', 'up'], /must be a path inside the project/],
    [['--profile', 'mcp'], /give a compose command/],
  ]) assert.match(compose(args, stack).stderr, msg);

  // A git worktree has the same folder name, so the same Compose project: it would replace the live containers.
  const repo = path.dirname(path.dirname(stack));
  await fs.mkdir(path.join(repo, '.git', 'worktrees', 'ticket'), { recursive: true });
  const wt = await folder('homelab-ticket');
  await fs.writeFile(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'ticket')}\n`);
  assert.match(compose(['up', '-d'], await folder('homelab-ticket', 'stacks', 'firefly')).stderr, /not in a worktree of it/);
  assert.match(compose(['ps'], await folder('unregistered')).stderr, /is not inside a registered project/);
});

test('admin import stores .env values as Compose reads them; a $ Compose would expand is refused', async () => {
  const app = await folder('homelab', 'stacks', 'immich');
  ok(admin(['apply', '--stack', 'homelab', '--project', 'immich', '--new-project', '--path', app]));
  ok(admin(['import', 'immich'], 'A="dq \\"x\\" y"\nB=\'sq $HOME\'\nC=plain-value # note\nD=cost$$1\n'));
  assert.deepEqual(await lib.loadSecrets('immich'), { A: 'dq "x" y', B: 'sq $HOME', C: 'plain-value', D: 'cost$1' });
  assert.match(admin(['import', 'immich'], 'E=pa$word\n').stderr, /E: the value has a \$ that Compose expands/);
  assert.equal((await lib.loadSecrets('immich')).E, undefined);
});

// ---- Groups ------------------------------------------------------------------------------------------------------

const GROUP_VALUE = 'demo-group-secret-value-123';
const groupOf = (name) => ok(admin(['list'])).stdout.split(/\n(?=\{)/).map((j) => JSON.parse(j)).find((j) => j.group === name);

test('a group keeps grants and values apart: list shows names only, and every broker output scrubs the value', async () => {
  const r = ok(admin(
    ['apply', '--group', 'demo', '--new-group',
      '--grant-file', 'demo.service:demo-key=DEMO_KEY', '--grant-file', 'demo.service:other-key=DEMO_OTHER', '--optional', 'DEMO_OTHER',
      '--grant-env', 'demo-two.service:DEMO_ENV',
      '--grant-root', 'DEMO_KEY', '--grant-root-write', 'DEMO_OTHER',
      '--grant-omp', 'DEMO_KEY', '--omp-exe', '/opt/demo-omp/'],
    `group:DEMO_KEY=${GROUP_VALUE}\n`,
  ));
  assert.ok(!(r.stdout + r.stderr).includes(GROUP_VALUE));
  const listed = ok(admin(['list']));
  assert.ok(!listed.stdout.includes(GROUP_VALUE));
  const group = groupOf('demo');
  assert.deepEqual(group.keys, ['DEMO_KEY']);
  assert.deepEqual(group.grants, [
    { unit: 'demo.service', files: { 'demo-key': 'DEMO_KEY', 'other-key': 'DEMO_OTHER' }, optional: ['DEMO_OTHER'] },
    { unit: 'demo-two.service', env: ['DEMO_ENV'] },
    { root: true, keys: ['DEMO_KEY'], write: ['DEMO_OTHER'] },
    { omp: true, cgroup: 'paseo.service', exe: '/opt/demo-omp/', keys: ['DEMO_KEY'] },
  ]);
  assert.equal((await fs.stat(path.join(dev, 'home/group-secrets/demo.env'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dev, 'home/groups/demo.json'))).mode & 0o777, 0o600);
  // The scrubber behind every broker output knows the group value.
  const scrub = lib.makeScrubber(await lib.allSecretValues());
  assert.equal(scrub(`leak ${GROUP_VALUE} end`), 'leak [secret] end');
  // set-group / unset-group work like set-stack / unset-stack; the value never comes back.
  assert.ok(!ok(admin(['set-group', 'demo', 'DEMO_OTHER'], 'second-demo-value-456\n')).stdout.includes('second-demo'));
  assert.match(ok(admin(['unset-group', 'demo', 'DEMO_OTHER'])).stdout, /deleted DEMO_OTHER from group demo/);
  assert.match(admin(['unset-group', 'demo', 'DEMO_OTHER']).stderr, /has no DEMO_OTHER/);
});

test('a grant is replaced whole by the unit it names, and removed by --remove-grant', () => {
  ok(admin(['apply', '--group', 'demo', '--grant-file', 'demo.service:new-name=DEMO_KEY']));
  assert.deepEqual(groupOf('demo').grants.find((g) => g.unit === 'demo.service'), { unit: 'demo.service', files: { 'new-name': 'DEMO_KEY' } });
  ok(admin(['apply', '--group', 'demo', '--remove-grant', 'demo-two.service', '--remove-grant', 'root', '--remove-grant', 'omp']));
  assert.deepEqual(groupOf('demo').grants.map((g) => g.unit), ['demo.service']);
  assert.match(admin(['apply', '--group', 'demo', '--remove-grant', 'root']).stderr, /has no grant for root/);
});

test('groups refuse bad unit names, bad key names, bad file names, unknown groups and stray options', () => {
  const refused = (args, input, pattern) => {
    const r = admin(args, input);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, pattern);
  };
  for (const unit of ['demo', 'demo.timer', '../demo.service', 'a/b.service', 'demo service.service', '.service']) {
    refused(['apply', '--group', 'demo', '--grant-file', `${unit}:f=DEMO_KEY`], '', /invalid unit name|expects UNIT/);
  }
  refused(['apply', '--group', 'demo', '--grant-env', 'demo.service:lower_case'], '', /invalid key name/);
  refused(['apply', '--group', 'demo', '--grant-root', 'bad-key'], '', /invalid key name/);
  refused(['apply', '--group', 'demo', '--grant-file', 'demo.service:../etc=DEMO_KEY'], '', /invalid file name/);
  refused(['apply', '--group', 'demo', '--grant-file', 'demo.service:a/b=DEMO_KEY'], '', /invalid file name/);
  refused(['apply', '--group', 'demo', '--grant-file', 'demo.service:f=DEMO_KEY', '--optional', 'DEMO_NOPE'], '', /optional but not named/);
  refused(['apply', '--group', 'demo', '--optional', 'DEMO_KEY'], '', /goes with --grant-file/);
  refused(['apply', '--group', 'demo', '--grant-omp', 'DEMO_KEY'], '', /needs --omp-exe/);
  refused(['apply', '--group', 'demo', '--grant-omp', 'DEMO_KEY', '--omp-exe', '/opt/../etc'], '', /absolute exe folder/);
  refused(['apply', '--group', 'ghost', '--grant-root', 'DEMO_KEY'], '', /unknown group ghost/);
  refused(['apply', '--group', 'demo', '--new-group'], '', /already exists/);
  refused(['apply', '--group', 'Bad Name', '--new-group'], '', /invalid group name/);
  refused(['apply', '--group', 'demo', '--stack', 'studio'], '', /cannot be combined/);
  refused(['apply', '--grant-root', 'DEMO_KEY'], '', /needs --group/);
  refused(['apply'], 'group:DEMO_KEY=x\n', /need --group/);
  refused(['set-group', 'ghost', 'DEMO_KEY'], 'x\n', /unknown group: ghost/);
  refused(['set-group', 'demo', 'lower'], 'x\n', /invalid key name/);
  refused(['set-group', 'demo', 'DEMO_KEY'], 'two\nlines\n', /empty or has line breaks/);
});

test('import-files stores key files with one call, values on stdin and never in argv; loose or odd files are refused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-files-'));
  const argsLog = path.join(dir, 'argv.log');
  const stdinLog = path.join(dir, 'stdin.log');
  const fakeAdmin = path.join(dir, 'admin.sh');
  await fs.writeFile(fakeAdmin, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argsLog}'\ntee -a '${stdinLog}' | '${process.execPath}' '${path.join(BIN, 'agent-broker-admin.mjs')}' "$@"\n`, { mode: 0o700 });
  const wrapper = path.resolve(import.meta.dirname, '../wrappers/agent-broker-admin');
  const files = (...args) => spawnSync('bash', [wrapper, ...args], { env: { ...env, AGENT_BROKER_DEV_ADMIN: fakeAdmin }, encoding: 'utf8' });
  const key = path.join(dir, 'tts-key');
  const second = path.join(dir, 'token');
  await fs.writeFile(key, 'file-value-one-abc\n', { mode: 0o600 });
  await fs.writeFile(second, 'file-value-two-def', { mode: 0o400 });

  const r = files('import-files', 'demo', `DEMO_FILE_ONE=${key}`, `DEMO_FILE_TWO=${second}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes('file-value'));
  assert.match(r.stdout, /imported DEMO_FILE_ONE DEMO_FILE_TWO into group demo/);
  assert.equal(await fs.readFile(argsLog, 'utf8'), 'import-group demo\n');
  assert.equal(await fs.readFile(stdinLog, 'utf8'), 'DEMO_FILE_ONE=file-value-one-abc\nDEMO_FILE_TWO=file-value-two-def\n');
  assert.equal(await fs.readFile(key, 'utf8'), 'file-value-one-abc\n'); // the source file is left alone
  const secretsFile = path.join(dev, 'home/group-secrets/demo.env');
  const stored = await fs.readFile(secretsFile, 'utf8');
  assert.match(stored, /^DEMO_FILE_ONE=file-value-one-abc$/m);
  assert.match(stored, /^DEMO_FILE_TWO=file-value-two-def$/m);
  assert.ok(!ok(admin(['list'])).stdout.includes('file-value'));

  const loose = path.join(dir, 'loose');
  await fs.writeFile(loose, 'loose-value-xyz', { mode: 0o644 });
  const multi = path.join(dir, 'multi');
  await fs.writeFile(multi, 'a\nb\n', { mode: 0o600 });
  const empty = path.join(dir, 'empty');
  await fs.writeFile(empty, '\n', { mode: 0o600 });
  for (const [spec, pattern] of [
    [`DEMO_LOOSE=${loose}`, /readable by others/],
    [`DEMO_MULTI=${multi}`, /more than one line/],
    [`DEMO_EMPTY=${empty}`, /is empty/],
    [`DEMO_GONE=${path.join(dir, 'nope')}`, /no such file/],
    [`lower=${key}`, /expected KEY=file/],
    [key, /expected KEY=file/],
  ]) {
    const bad = files('import-files', 'demo', spec);
    assert.equal(bad.status, 2, spec);
    assert.match(bad.stderr, pattern);
  }
  // One bad file in the list: nothing at all is stored.
  assert.equal(files('import-files', 'demo', `DEMO_LATE=${key}`, `DEMO_LOOSE=${loose}`).status, 2);
  assert.ok(!(await fs.readFile(secretsFile, 'utf8')).includes('DEMO_LATE'));
  assert.match(files('import-files', 'ghost', `DEMO_FILE_ONE=${key}`).stderr, /unknown group: ghost/);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---- run <group> -------------------------------------------------------------------------------------------------

const RUN_FILE_VALUE = 'run-file-value-abc123';
const RUN_OTHER_VALUE = 'run-other-value-def456';
const RUN_ENV_VALUE = 'run env "quoted" \\ back $HOME # hash';
const RUN_VALUES = [RUN_FILE_VALUE, RUN_OTHER_VALUE, RUN_ENV_VALUE];
const cgroupOf = (unit, uid = 1000) => `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}\n`;

/** Runs `agent-broker run <group>` as the broker does (dev root), from the cgroup text given. */
async function brokerRun(group, cgroup, extraEnv = {}) {
  const file = path.join(dev, `cgroup-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(file, cgroup);
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'run', group], {
    cwd: dev, env: { ...env, SUDO_UID: '1000', AGENT_BROKER_DEV_CGROUP_FILE: file, ...extraEnv }, encoding: 'utf8',
  });
  await fs.rm(file);
  return r;
}
const records = (stdout) => { const parts = stdout.split('\0'); parts.pop(); return Array.from({ length: parts.length / 3 }, (_, i) => parts.slice(i * 3, i * 3 + 3)); };

test('run: a granted unit gets exactly its keys as NUL records; any other caller is refused with nothing on stdout', async () => {
  ok(admin(['apply', '--group', 'runner', '--new-group',
    '--grant-file', 'demo.service:file-key=RUN_FILE', '--grant-file', 'demo.service:other-key=RUN_OTHER', '--grant-env', 'demo.service:RUN_ENV',
    '--grant-file', 'tiny.service:tiny=RUN_FILE'],
  `group:RUN_FILE=${RUN_FILE_VALUE}\ngroup:RUN_OTHER=${RUN_OTHER_VALUE}\ngroup:RUN_ENV=${RUN_ENV_VALUE}\ngroup:RUN_UNGRANTED=ungranted-value-789\n`));
  const r = await brokerRun('runner', cgroupOf('demo.service'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(records(r.stdout), [['file', 'file-key', RUN_FILE_VALUE], ['file', 'other-key', RUN_OTHER_VALUE], ['env', 'RUN_ENV', RUN_ENV_VALUE]]);
  assert.ok(!r.stdout.includes('ungranted-value'));
  assert.deepEqual(records((await brokerRun('runner', cgroupOf('tiny.service'))).stdout), [['file', 'tiny', RUN_FILE_VALUE]]);
  // The audit line names the keys, never a value.
  const log = await fs.readFile(path.join(dev, 'home/log/broker.log'), 'utf8');
  assert.match(log, /"run":"runner","unit":"demo.service","keys":\["RUN_FILE","RUN_OTHER","RUN_ENV"\]/);
  for (const v of RUN_VALUES) assert.ok(!log.includes(v));

  for (const [what, cgroup, extra] of [
    ['unit without a grant', cgroupOf('other.service')],
    ['paseo.service', cgroupOf('paseo.service')],
    ['another user\'s slice', cgroupOf('demo.service', 1001)],
    ['a sub-cgroup of the unit', `${cgroupOf('demo.service').trim()}/sub\n`],
    ['outside app.slice', '0::/user.slice/user-1000.slice/user@1000.service/session.slice/demo.service\n'],
    ['a system service', '0::/system.slice/demo.service\n'],
    ['no cgroup line', 'garbage\n'],
    ['no SUDO_UID', cgroupOf('demo.service'), { SUDO_UID: '' }],
  ]) {
    const bad = await brokerRun('runner', cgroup, extra);
    assert.equal(bad.status, 2, what);
    assert.equal(bad.stdout, '', what);
    for (const v of RUN_VALUES) assert.ok(!bad.stderr.includes(v), what);
  }
  assert.match((await brokerRun('runner', cgroupOf('paseo.service'))).stderr, /no grant for paseo\.service in group runner/);
  assert.match((await brokerRun('ghost', cgroupOf('demo.service'))).stderr, /unknown group: ghost/);
});

test('run: an optional key without a value starts with a warning; a required one stops with its name and prints nothing', async () => {
  ok(admin(['apply', '--group', 'opt', '--new-group', '--grant-file', 'opt.service:needed=RUN_FILE', '--grant-file', 'opt.service:maybe=RUN_MAYBE', '--optional', 'RUN_MAYBE'], `group:RUN_FILE=${RUN_FILE_VALUE}\n`));
  const r = await brokerRun('opt', cgroupOf('opt.service'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(records(r.stdout), [['file', 'needed', RUN_FILE_VALUE]]);
  assert.match(r.stderr, /warning: optional RUN_MAYBE has no value in group opt/);
  ok(admin(['apply', '--group', 'opt', '--grant-file', 'opt.service:needed=RUN_FILE', '--grant-file', 'opt.service:also=RUN_ALSO']));
  const bad = await brokerRun('opt', cgroupOf('opt.service'));
  assert.equal(bad.status, 3);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /no value for RUN_ALSO \(needed by opt\.service\)/);
});

test('run wrapper: writes files 0600 and an env file into the 0700 runtime folder, checks the folder, reports failures as status files, leaks no value', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-run-'));
  const root = path.join(base, 'run-user');
  await fs.mkdir(root, { mode: 0o700 });
  const statusLog = path.join(base, 'status.log');
  const argvLog = path.join(base, 'argv.log');
  const cgroupFile = path.join(base, 'cgroup');
  const fakeBroker = path.join(base, 'broker.sh');
  const fakeWriter = path.join(base, 'writer.sh');
  await fs.writeFile(fakeBroker, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${process.execPath}' '${path.join(BIN, 'agent-broker.mjs')}' "$@"\n`, { mode: 0o700 });
  await fs.writeFile(fakeWriter, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${statusLog}'\n`, { mode: 0o700 });
  const wrapper = path.resolve(import.meta.dirname, '../wrappers/agent-broker');
  const runIn = (unit, group, dir, extra = {}) => {
    spawnSync('bash', ['-c', `printf '%s' "$1" > "$2"`, 'x', cgroupOf(unit), cgroupFile]);
    const e = {
      ...env, SUDO_UID: '1000', AGENT_BROKER_DEV_BROKER: fakeBroker, AGENT_BROKER_DEV_RUN_ROOT: root, AGENT_BROKER_DEV_CGROUP_FILE: cgroupFile,
      AGENT_BROKER_STATUS_WRITER: fakeWriter, AGENT_BROKER_STATUS_DIR: path.join(base, 'status'), ...extra,
    };
    if (dir === undefined) delete e.RUNTIME_DIRECTORY; else e.RUNTIME_DIRECTORY = dir;
    return spawnSync('bash', [wrapper, 'run', group], { env: e, encoding: 'utf8', cwd: dev });
  };
  const folderWith = async (name, mode) => { const d = path.join(root, name); await fs.mkdir(d, { mode }); await fs.chmod(d, mode); return d; };
  const status = async () => fs.readFile(statusLog, 'utf8').catch(() => '');
  const noLeak = (text, what) => { for (const v of RUN_VALUES) assert.ok(!text.includes(v), `${what} leaked a value`); };

  // Success.
  const dir = await folderWith('demo-keys', 0o700);
  const r = runIn('demo.service', 'runner', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(await fs.readFile(path.join(dir, 'file-key'), 'utf8'), RUN_FILE_VALUE);
  assert.equal(await fs.readFile(path.join(dir, 'other-key'), 'utf8'), RUN_OTHER_VALUE);
  assert.equal(await fs.readFile(path.join(dir, 'env'), 'utf8'), 'RUN_ENV="run env \\"quoted\\" \\\\ back $HOME # hash"\n');
  for (const f of ['file-key', 'other-key', 'env']) assert.equal((await fs.stat(path.join(dir, f))).mode & 0o777, 0o600, f);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['env', 'file-key', 'other-key']); // temporary files are gone
  assert.match(await status(), /--job agent-broker-run-demo-service --result ok .*--dir /);
  assert.equal(await fs.readFile(argvLog, 'utf8'), 'run runner\n'); // the broker is asked by group name only
  noLeak(await status(), 'status');
  noLeak(await fs.readFile(argvLog, 'utf8'), 'argv');

  // A rerun replaces the env file instead of appending to it.
  assert.equal(runIn('demo.service', 'runner', dir).status, 0);
  assert.equal((await fs.readFile(path.join(dir, 'env'), 'utf8')).split('\n').length, 2);

  // The runtime folder is checked before anything is asked or written.
  const loose = await folderWith('loose-keys', 0o755);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-outside-'));
  await fs.chmod(outside, 0o700);
  const link = path.join(root, 'link-keys');
  await fs.symlink(dir, link);
  const cases = [
    ['unset', undefined, /RUNTIME_DIRECTORY is not set/],
    ['missing', path.join(root, 'nope'), /not a real folder/],
    ['outside the run root', outside, /is not under /],
    ['dotdot', `${root}/demo-keys/../demo-keys`, /\. or \.\. part/],
    ['two folders', `${dir}:${dir}`, /more than one folder/],
    ['a link', link, /not a real folder/],
    ['mode 0755', loose, /mode 0700: set RuntimeDirectoryMode=0700/],
  ];
  for (const [what, d, pattern] of cases) {
    await fs.writeFile(statusLog, '');
    await fs.writeFile(argvLog, '');
    const bad = runIn('demo.service', 'runner', d);
    assert.equal(bad.status, 1, what);
    assert.match(bad.stderr, pattern, what);
    assert.match(await status(), /--job agent-broker-run-demo-service --result fail .*broker broken, so demo\.service cannot start: /, what);
    assert.equal(await fs.readFile(argvLog, 'utf8'), '', `${what}: the broker must not be called`);
  }
  assert.deepEqual(await fs.readdir(loose), []);

  // Broker refusals come through as the reason; nothing is written.
  const d2 = await folderWith('other-keys', 0o700);
  await fs.writeFile(statusLog, '');
  const refused = runIn('other.service', 'runner', d2);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no grant for other\.service in group runner/);
  assert.match(await status(), /--result fail --category host --service agent-broker --summary broker broken, so other\.service cannot start: no grant for other\.service in group runner/);
  assert.deepEqual(await fs.readdir(d2), []);

  // A required key without a value: non-zero, a fail status file, no key file written.
  const d3 = await folderWith('opt-keys', 0o700);
  await fs.writeFile(statusLog, '');
  const missing = runIn('opt.service', 'opt', d3);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no value for RUN_ALSO/);
  assert.match(await status(), /--job agent-broker-run-opt-service --result fail .*no value for RUN_ALSO/);
  assert.deepEqual(await fs.readdir(d3), []);
  noLeak(missing.stdout + missing.stderr + (await status()), 'a failed run');

  // No status writer configured: the run still works and says nothing about it.
  const d4 = await folderWith('quiet-keys', 0o700);
  const quiet = runIn('demo.service', 'runner', d4, { AGENT_BROKER_STATUS_WRITER: '' });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, '');
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

// ---- key <group> <KEY> -------------------------------------------------------------------------------------------

const KEY_VALUE = 'key-value-abc123-xyz';
const PROGRAM = '/opt/demo-omp/demo-omp';
const MARKER = 'cmdline-marker-arg-should-not-be-logged';

/** A fake /proc with the broker as pid 900; `chain` = [[name, argv...]] from the broker's parent upward (pid 899, 898, ...). */
async function fakeProc(chain, { loopBack = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-broker-proc-'));
  const put = async (pid, ppid, name, argv) => {
    await fs.mkdir(path.join(root, String(pid)));
    await fs.writeFile(path.join(root, String(pid), 'stat'), `${pid} (${name}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 12345 1000000 100 18446744073709551615\n`);
    await fs.writeFile(path.join(root, String(pid), 'cmdline'), argv.length ? `${argv.join('\0')}\0` : '');
  };
  await put(900, 899, 'node', ['node', 'agent-broker.mjs', 'key']);
  for (const [i, [name, ...argv]] of chain.entries()) {
    const pid = 899 - i;
    await put(pid, i === chain.length - 1 ? (loopBack ? 899 : 1) : pid - 1, name, argv);
  }
  return root;
}

async function brokerKey(proc, group, key, { unit = 'paseo.service', cgroup } = {}) {
  const file = path.join(dev, `cgroup-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(file, cgroup ?? cgroupOf(unit));
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'key', group, key], {
    cwd: dev, encoding: 'utf8', timeout: 20000,
    env: { ...env, SUDO_UID: '1000', AGENT_BROKER_DEV_CGROUP_FILE: file, AGENT_BROKER_DEV_PROC: proc, AGENT_BROKER_DEV_PID: '900' },
  });
  await fs.rm(file);
  return r;
}

test('key: the value goes only to a caller in the granted cgroup with the granted program above it', async () => {
  ok(admin(['apply', '--group', 'keyed', '--new-group', '--grant-omp', 'KEY_A', '--grant-omp', 'KEY_B', '--omp-exe', '/opt/demo-omp/'], `group:KEY_A=${KEY_VALUE}\ngroup:KEY_C=ungranted-value-000\n`));
  const dirs = [];
  const proc = async (...a) => { const d = await fakeProc(...a); dirs.push(d); return d; };
  const sudo = ['sudo', '/usr/bin/sudo', '-n', '-u', 'broker-user', '/opt/agent-broker/bin/agent-broker.mjs', 'key', 'keyed', 'KEY_A'];
  const good = await proc([sudo, ['bash', '/bin/bash', '-c', 'x'], ['demo-omp', PROGRAM, MARKER], ['systemd', '/usr/lib/systemd/systemd', '--user']]);

  const r = await brokerKey(good, 'keyed', 'KEY_A');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${KEY_VALUE}\n`);
  assert.equal(r.stderr, '');

  // The audit line has the pid chain (pid + program name), the key name and the result: no value, no command line.
  const log = (await fs.readFile(path.join(dev, 'home/log/broker.log'), 'utf8')).trim().split('\n').at(-1);
  assert.match(log, /"key":"keyed","name":"KEY_A","result":"ok","chain":\[\{"pid":899,"name":"sudo"\},\{"pid":898,"name":"bash"\},\{"pid":897,"name":"demo-omp"\}/);
  for (const leaked of [KEY_VALUE, MARKER, '/bin/bash -c']) assert.ok(!log.includes(leaked), `audit holds ${leaked}`);

  // The program only counts through argv[0] under the granted folder.
  const refusedCases = [
    ['no granted program in the chain', [sudo, ['bash', '/bin/bash'], ['systemd', '/usr/lib/systemd/systemd']]],
    ['a look-alike folder', [sudo, ['x', '/opt/demo-omp-evil/x']]],
    ['a relative path', [sudo, ['x', 'demo-omp/x']]],
    ['the folder itself without a file', [sudo, ['x', '/opt/demo-omp']]],
    ['a .. part', [sudo, ['x', '/opt/demo-omp/../evil/x']]],
    ['the program named only in a later argument', [sudo, ['bash', '/bin/bash', PROGRAM]]],
    ['an empty command line', [sudo, ['kthread']]],
  ];
  for (const [what, chain] of refusedCases) {
    const bad = await brokerKey(await proc(chain), 'keyed', 'KEY_A');
    assert.equal(bad.status, 2, what);
    assert.equal(bad.stdout, '', what);
    assert.match(bad.stderr, /no process above the caller was started from \/opt\/demo-omp\//, what);
  }

  // Key checks: not granted, granted without a stored value (exit 3), and a stored value that is not granted stays private.
  const notGranted = await brokerKey(good, 'keyed', 'KEY_C');
  assert.equal(notGranted.status, 2);
  assert.equal(notGranted.stdout, '');
  assert.match(notGranted.stderr, /KEY_C is not granted in group keyed/);
  const noValue = await brokerKey(good, 'keyed', 'KEY_B');
  assert.equal(noValue.status, 3);
  assert.equal(noValue.stdout, '');
  assert.match(noValue.stderr, /has no value for KEY_B/);
  assert.equal((await brokerKey(good, 'keyed', 'lower')).status, 2);
  assert.match((await brokerKey(good, 'ghost', 'KEY_A')).stderr, /unknown group: ghost/);
  ok(admin(['apply', '--group', 'noprog', '--new-group', '--grant-root', 'KEY_A'], `group:KEY_A=${KEY_VALUE}\n`));
  assert.match((await brokerKey(good, 'noprog', 'KEY_A')).stderr, /no program grant in group noprog/);

  // Caller cgroup: another unit, another user's slice and a deeper path below the granted unit are all refused.
  for (const [what, opts] of [
    ['another unit', { unit: 'demo.service' }],
    ['another user', { cgroup: cgroupOf('paseo.service', 1001) }],
    ['a deeper path', { cgroup: `${cgroupOf('paseo.service').trim()}/sub\n` }],
    ['a system service', { cgroup: '0::/system.slice/paseo.service\n' }],
  ]) {
    const bad = await brokerKey(good, 'keyed', 'KEY_A', opts);
    assert.equal(bad.status, 2, what);
    assert.equal(bad.stdout, '', what);
  }
  const log2 = await fs.readFile(path.join(dev, 'home/log/broker.log'), 'utf8');
  assert.match(log2, /"name":"KEY_A","result":"bad-caller"/);
  assert.match(log2, /"name":"KEY_A","result":"no-program"/);
  assert.match(log2, /"name":"KEY_C","result":"not-granted"/);
  assert.match(log2, /"name":"KEY_B","result":"no-value"/);
  assert.ok(!log2.includes(KEY_VALUE));
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

test('key: the process walk stops at a parent loop and at 32 ancestors, and reads a program name holding ")" and spaces', async () => {
  ok(admin(['apply', '--group', 'walk', '--new-group', '--grant-omp', 'KEY_A', '--omp-exe', '/opt/demo-omp/'], `group:KEY_A=${KEY_VALUE}\n`));
  const shell = ['sh', '/bin/sh'];
  const dirs = [];
  const proc = async (...a) => { const d = await fakeProc(...a); dirs.push(d); return d; };

  // A loop (the last ancestor points back at pid 899) ends the walk without hanging: no program in it, so refused.
  const loop = await brokerKey(await proc([shell, shell, shell], { loopBack: true }), 'walk', 'KEY_A');
  assert.equal(loop.status, 2);
  assert.equal(loop.signal, null);

  // The program at the 32nd ancestor still counts; at the 33rd it is out of reach.
  const deep = (n) => [...Array.from({ length: n - 1 }, () => shell), ['demo-omp', PROGRAM]];
  assert.equal((await brokerKey(await proc(deep(32)), 'walk', 'KEY_A')).status, 0);
  const tooDeep = await brokerKey(await proc(deep(33)), 'walk', 'KEY_A');
  assert.equal(tooDeep.status, 2);
  assert.equal(tooDeep.stdout, '');
  // A long loop-free chain without the program also ends.
  assert.equal((await brokerKey(await proc(Array.from({ length: 60 }, () => shell)), 'walk', 'KEY_A')).status, 2);

  // A name with ")" and spaces in the middle of the chain does not break the parent lookup.
  const odd = await brokerKey(await proc([['we ird) (name ) x', '/usr/bin/odd'], ['demo-omp', PROGRAM]]), 'walk', 'KEY_A');
  assert.equal(odd.status, 0, odd.stderr);
  const logged = (await fs.readFile(path.join(dev, 'home/log/broker.log'), 'utf8')).trim().split('\n').at(-1);
  assert.match(logged, /"name":"we ird\) \(name \) x"/);
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

test('key wrapper: stdout is the value and nothing else, and the broker\'s exit code comes through', async () => {
  ok(admin(['apply', '--group', 'wrapped', '--new-group', '--grant-omp', 'KEY_A', '--grant-omp', 'KEY_B', '--omp-exe', '/opt/demo-omp/'], `group:KEY_A=${KEY_VALUE}\n`));
  const proc = await fakeProc([['demo-omp', PROGRAM]]);
  const cgroupFile = path.join(proc, 'cgroup');
  await fs.writeFile(cgroupFile, cgroupOf('paseo.service'));
  const fakeBroker = path.join(proc, 'broker.sh');
  await fs.writeFile(fakeBroker, `#!/bin/bash\nexec '${process.execPath}' '${path.join(BIN, 'agent-broker.mjs')}' "$@"\n`, { mode: 0o700 });
  const wrapper = path.resolve(import.meta.dirname, '../wrappers/agent-broker');
  const viaWrapper = (key) => spawnSync('bash', [wrapper, 'key', 'wrapped', key], {
    cwd: dev, encoding: 'utf8',
    env: { ...env, SUDO_UID: '1000', AGENT_BROKER_DEV_BROKER: fakeBroker, AGENT_BROKER_DEV_CGROUP_FILE: cgroupFile, AGENT_BROKER_DEV_PROC: proc, AGENT_BROKER_DEV_PID: '900' },
  });
  const good = viaWrapper('KEY_A');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, `${KEY_VALUE}\n`);
  assert.equal(good.stderr, '');
  assert.equal(viaWrapper('KEY_B').status, 3);
  assert.equal(viaWrapper('KEY_Z').status, 2);
  await fs.rm(proc, { recursive: true, force: true });
});
