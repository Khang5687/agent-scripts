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
  ok(admin(['apply', '--stack', 'thedoor', '--new-stack', '--stack-from-project', 'legacy', '--project', 'legacy']));
  assert.deepEqual(Object.keys(await lib.loadSecrets('legacy')), ['SUPABASE_READ_URL']);
  assert.equal((await lib.loadStackSecrets('thedoor')).NETLIFY_AUTH_TOKEN, 'nfp_legacy_value_00000000000000000');
  assert.equal((await lib.loadProject('legacy')).stack, 'thedoor');
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
  assert.match(broker(['attach', '--stack', 'thedoor'], app).stderr, /attach only adds services/);

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
  const r = spawnSync(process.execPath, [path.join(BIN, 'agent-broker.mjs'), 'apify', 'info', 'thedoor/some-actor'],
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
