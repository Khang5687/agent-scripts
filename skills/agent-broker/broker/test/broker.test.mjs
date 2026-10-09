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
  ok(admin(['apply', '--stack', 'studio', '--new-stack', '--project', 'shop', '--new-project', '--path', shop, '--netlify-site', 'site-shop', '--netlify-dir', 'dist'],
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
  ok(admin(['apply', '--stack', 'studio', '--project', 'web', '--new-project', '--path', mono, '--netlify-site', 'site-web', '--netlify-dir', 'apps/web/dist']));
  ok(admin(['apply', '--stack', 'studio', '--project', 'api', '--new-project', '--path', mono, '--netlify-site', 'site-api', '--netlify-dir', 'apps/api/dist']));
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
  assert.equal(made.services.netlify.dir, 'dist');
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
  assert.match(md.block, /broker project `attachapp` on account stack `studio`/);
  assert.match(md.block, /agent-broker netlify deploy/);
  assert.doesNotMatch(md.block, /supabase query/);
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
