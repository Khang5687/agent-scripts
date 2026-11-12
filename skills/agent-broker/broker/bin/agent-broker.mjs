#!/opt/agent-broker/node/bin/node
// agent-broker: the only way agents use Netlify, Vercel, Supabase and Apify accounts on this Mac.
// Runs as _deployer through `sudo -n -u _deployer` (wrapper /usr/local/bin/agent-broker). The folder the agent runs
// in decides the project; the project decides its account stack and the one site / database it may touch. Agents
// never name an account, a site or a database. Output has secrets removed.
// Guide: agent-scripts/skills/agent-broker/SKILL.md
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNetlifySite, createReadOnlyUser, lookup, verifyPins } from './accounts.mjs';
import {
  CA_FILE, DIR, HOME, KEY, LINUX, NAME, SERVICES, UsageError, allSecretValues, assertNoSecret, assertUnclaimed, audit, checkName,
  checkRelative, effectiveStack, fail, gitRoot, listGroups, listProjects, listStacks, loadGroup, loadGroupSecrets, loadProject,
  loadSecrets, loadStack, loadStackSecrets, loadSyncState, makeScrubber, mkdirs, parseArgs, projectSecrets, resolveProject, run,
  saveProject, saveSecrets, sandboxReady,
  stackFromAgentsMd, syncProject,
} from './lib.mjs';
import { deliver, describeDelivery, healthNotes } from './sync.mjs';
import { configProblems, cpProblems, needsCheck, runVolumeProblems } from './compose-guard.mjs';

const HELP = `agent-broker <service> <action> [options]      run inside the project's folder: the folder picks the project

  agent-broker whoami        this folder's project, account stack, site and database
  agent-broker projects      all projects and their folders     agent-broker stacks   all account stacks
  agent-broker result <id>   result of an approved Supabase admin query
  agent-broker run <group>   for a systemd unit's pre-start step only (ExecStartPre=+): fills the unit's RuntimeDirectory
                             with the keys its group grants; refused for any other caller (a guard: any process of this
                             user can join a unit's cgroup, so a caller that does is not told apart)
  agent-broker key <group> <KEY>   for a program's key line (OMP apiKey "!..."): prints that one value to the
                             program the group's program grant names; refused for anything else
  agent-broker health        can the broker serve every key its groups promise? one line, no values; exit 0 = healthy
  agent-broker sync-retry    try the token copies still waiting for the other machine (what the timer runs); no arguments:
                             it can only send what is already queued, to the one pinned target

New project (a folder not registered yet; the user names the stack; stacks come from the owner's wizard):
  agent-broker init --stack S --list                     the stack's sites and databases (free or used by a project)
  agent-broker init --stack S [--name N] [--here]        register this git repo (--here: this exact folder), then
         [--netlify-site ID | --netlify-new NAME]        write the AGENTS.md block (--no-agents-md: skip it)
         [--supabase-ref REF [--no-reader]] [--vercel-project ID] [--apify] [--no-agents-md]
  agent-broker attach [same service options]             add a service the project does not use yet
  agent-broker agents-md [--write]                       the AGENTS.md block (--write: into AGENTS.md / CLAUDE.md)
  A new Supabase project costs money: ask the user to create it on supabase.com, then attach --supabase-ref.
  --netlify-new creates a Netlify site in the stack's account; --supabase-ref creates a read-only database user.

netlify  deploy [--prod] [--message M] [--dir D] [--functions F] [--alias A] [--json] [--timeout S] [--skip-functions-cache]
                                                        \`netlify deploy --no-build\` on the project's pinned site:
                                                        files already built; without --dir, netlify.toml [build]
                                                        publish decides (as with plain netlify); draft unless --prod
         status | deploys | logs [--since 1h] [--function NAME]...
         blobs-list <store> [--prefix P] | blobs-get <store> <key> | blobs-meta <store> <key>
vercel   deploy [--prod]                                deploy .vercel/output built with \`vercel build\`
         settings                                       .vercel/project.json for \`vercel build\` (no environment values)
         deploys | logs <deployment-url-or-id>
supabase query "<SQL>"                                  read-only database user
         migrate [--dry-run] [--include-all]            apply supabase/migrations
         admin-query "<SQL>"                            full rights; waits for the owner's approval
apify    push [--dir D] [--force] [--version V] [--build-tag T]
         pull <actor>                                   actor source as a tar stream on stdout
         info <actor> | builds <actor> | build-log <build-id> | runs <actor> | run-info <run-id> | logs <run-id>
         call <actor> [--input-file F | --input JSON] [--build B] [--memory MB] [--timeout S]
compose  [-f F] [--profile P] [--dry-run] <command> [args]
                                                        Linux: \`docker compose\` in the project's own folder with
                                                        its stored values (e.g. up -d | ps | logs app | exec -T db ...)

--project NAME only chooses between projects that share one folder (a repo root holding two projects).
Commands that print keys, passwords or environment values are not offered.`;

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9~/._-]{0,200}$/;
const ID = /^[A-Za-z0-9._-]{1,200}$/;
const checkId = (v, what) => (ID.test(v ?? '') ? v : fail(`invalid ${what}: ${v ?? '(missing)'}`));
const checkActor = (v) => (ACTOR.test(v ?? '') ? v : fail(`invalid actor: ${v ?? '(missing)'}`));
const none = (rest) => { if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`); };
const json = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

const KEY_FOR = { netlify: 'NETLIFY_AUTH_TOKEN', vercel: 'VERCEL_TOKEN', supabase: 'SUPABASE_ACCESS_TOKEN', apify: 'APIFY_TOKEN' };

/** P = { name, project, root } from resolveProject. */
async function context(P, service, needs) {
  const secrets = await projectSecrets(P.name, P.project);
  const stack = await effectiveStack(P.project);
  if (!P.project[service] && !P.project.adHoc) {
    fail(`project ${P.name} does not use ${service} (owner: wizard -> "Add a project" to add it)`);
  }
  for (const k of needs) {
    if (!secrets[k]) fail(`stack ${stack ?? P.name} has no ${k}: ask the owner to run the wizard`);
  }
  const config = P.project[service] ?? {};
  const values = await allSecretValues();
  return { project: P.project, config, secrets, values, scrub: makeScrubber(values) };
}

async function workCopy(P, ctx) {
  const dest = path.join(DIR.work, P.name);
  const { changed, skipped } = await syncProject(P.root, dest, ctx.values);
  process.stderr.write(`agent-broker: copied ${changed} changed file(s) from ${P.root}${skipped.length ? `; left out ${skipped.length} (links outside the project, or files only you can read): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', ...' : ''}` : ''}\n`);
  return dest;
}

async function scratch() {
  const dir = path.join(DIR.tmp, randomUUID());
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ---- Netlify -----------------------------------------------------------------------------------------------------

async function netlifyApi(ctx, route) {
  const res = await fetch(`https://api.netlify.com/api/v1${route}`, { headers: { Authorization: `Bearer ${ctx.secrets.NETLIFY_AUTH_TOKEN}` } });
  if (!res.ok) fail(`Netlify API ${res.status}: ${ctx.scrub(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function blobStore(ctx, name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: checkName(name, 'store'), siteID: ctx.config.site_id, token: ctx.secrets.NETLIFY_AUTH_TOKEN, consistency: 'strong' });
}

const checkKey = (k) => (k && k.length <= 600 && !/[\0-\x1f]/.test(k) ? k : fail(`invalid blob key: ${k ?? '(missing)'}`));
const netlifyEnv = (ctx) => ({ NETLIFY_AUTH_TOKEN: ctx.secrets.NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID: ctx.config.site_id });

// Options passed on to `netlify deploy` as given. Not offered: --site/--site-name/--team/--auth (the folder picks the
// site and account), --build/--trigger (the build would run with the token present), --prod-if-unlocked (--prod only).
const NETLIFY_DEPLOY_OPTS = {
  prod: 'bool', message: 'string', dir: 'string', functions: 'string', alias: 'string', json: 'bool', timeout: 'string',
  'skip-functions-cache': 'bool',
};

const netlify = {
  async deploy(P, args) {
    const { opts, positional } = parseArgs(args, NETLIFY_DEPLOY_OPTS);
    none(positional);
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const cli = ['deploy', '--no-build', '--site', ctx.config.site_id];
    for (const [k, v] of Object.entries(opts)) {
      // --name=value: a value that starts with "-" stays a value
      cli.push(v === true ? `--${k}` : `--${k}=${k === 'dir' || k === 'functions' ? checkRelative(v, `--${k}`) : v}`);
    }
    return run('netlify', cli, { cwd: await workCopy(P, ctx), env: netlifyEnv(ctx), scrub: ctx.scrub });
  },
  async status(P, args) {
    none(args);
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const s = await netlifyApi(ctx, `/sites/${ctx.config.site_id}`);
    const d = s.published_deploy ?? {};
    json({ name: s.name, url: s.ssl_url ?? s.url, admin_url: s.admin_url, account: s.account_slug,
      published_deploy: { id: d.id, state: d.state, published_at: d.published_at, title: d.title } });
    return 0;
  },
  async deploys(P, args) {
    none(args);
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const list = await netlifyApi(ctx, `/sites/${ctx.config.site_id}/deploys?per_page=10`);
    json(list.map((d) => ({ id: d.id, state: d.state, context: d.context, created_at: d.created_at, title: d.title, url: d.deploy_ssl_url })));
    return 0;
  },
  async logs(P, args) {
    const { opts, positional } = parseArgs(args, { since: 'string', function: 'list' });
    none(positional);
    const since = opts.since ?? '1h';
    if (!/^\d{1,4}[smhd]$/.test(since)) fail('--since must look like 30m, 1h, 2d');
    const fns = (opts.function ?? []).map((f) => checkName(f, 'function'));
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const cli = ['logs', '--source', 'functions', '--since', since, ...(fns.length ? ['--function', ...fns] : [])];
    return run('netlify', cli, { cwd: await scratch(), env: netlifyEnv(ctx), scrub: ctx.scrub });
  },
  async 'blobs-list'(P, args) {
    const { opts, positional: [store, ...rest] } = parseArgs(args, { prefix: 'string' });
    none(rest);
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const { blobs } = await (await blobStore(ctx, store)).list(opts.prefix ? { prefix: opts.prefix } : {});
    for (const b of blobs) process.stdout.write(`${JSON.stringify({ key: b.key, etag: b.etag })}\n`);
    return 0;
  },
  async 'blobs-get'(P, [store, key, ...rest]) {
    none(rest);
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const body = await (await blobStore(ctx, store)).get(checkKey(key), { type: 'arrayBuffer' });
    if (body == null) { process.stderr.write(`agent-broker: no blob ${store}/${key}\n`); return 3; }
    const buf = Buffer.from(body);
    assertNoSecret(buf, ctx.values, `blob ${store}/${key}`);
    await new Promise((resolve, reject) => process.stdout.write(buf, (e) => (e ? reject(e) : resolve())));
    return 0;
  },
  async 'blobs-meta'(P, [store, key, ...rest]) {
    none(rest);
    const ctx = await context(P, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const meta = await (await blobStore(ctx, store)).getMetadata(checkKey(key));
    if (!meta) { process.stderr.write(`agent-broker: no blob ${store}/${key}\n`); return 3; }
    process.stdout.write(`${ctx.scrub(JSON.stringify({ etag: meta.etag, metadata: meta.metadata }))}\n`);
    return 0;
  },
};

// ---- Vercel ------------------------------------------------------------------------------------------------------

const vercelEnv = (ctx) => ({ VERCEL_TOKEN: ctx.secrets.VERCEL_TOKEN, VERCEL_ORG_ID: ctx.config.org_id, VERCEL_PROJECT_ID: ctx.config.project_id });

const vercel = {
  async deploy(P, args) {
    const { opts, positional } = parseArgs(args, { prod: 'bool' });
    none(positional);
    const ctx = await context(P, 'vercel', ['VERCEL_TOKEN']);
    const work = await workCopy(P, ctx);
    if (!(await fs.stat(path.join(work, '.vercel', 'output')).catch(() => null))) fail('.vercel/output does not exist: run `vercel build` first (`agent-broker vercel settings > .vercel/project.json` gives its settings)');
    const cli = ['deploy', '--prebuilt', '--yes'];
    if (opts.prod) cli.push('--prod');
    return run('vercel', cli, { cwd: work, env: vercelEnv(ctx), scrub: ctx.scrub });
  },
  async settings(P, args) {
    none(args);
    const ctx = await context(P, 'vercel', ['VERCEL_TOKEN']);
    const dir = await scratch();
    try {
      const code = await run('vercel', ['pull', '--yes', '--environment', 'production'],
        { cwd: dir, env: vercelEnv(ctx), scrub: ctx.scrub, out: process.stderr });
      if (code) return code;
      process.stdout.write(ctx.scrub(await fs.readFile(path.join(dir, '.vercel', 'project.json'), 'utf8')));
      return 0;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }); // .vercel/.env.*.local holds environment values
    }
  },
  async deploys(P, args) {
    none(args);
    const ctx = await context(P, 'vercel', ['VERCEL_TOKEN']);
    const q = new URLSearchParams({ projectId: ctx.config.project_id, limit: '10', ...(ctx.config.org_id?.startsWith('team_') ? { teamId: ctx.config.org_id } : {}) });
    const res = await fetch(`https://api.vercel.com/v6/deployments?${q}`, { headers: { Authorization: `Bearer ${ctx.secrets.VERCEL_TOKEN}` } });
    if (!res.ok) fail(`Vercel API ${res.status}: ${ctx.scrub(await res.text()).slice(0, 500)}`);
    json((await res.json()).deployments.map((d) => ({ id: d.uid, state: d.state ?? d.readyState, target: d.target, created: new Date(d.created).toISOString(), url: d.url })));
    return 0;
  },
  async logs(P, [deployment, ...rest]) {
    none(rest);
    if (!/^[A-Za-z0-9._:/-]{1,300}$/.test(deployment ?? '')) fail('give a deployment URL or id');
    const ctx = await context(P, 'vercel', ['VERCEL_TOKEN']);
    return run('vercel', ['inspect', deployment, '--logs'], { cwd: await scratch(), env: vercelEnv(ctx), scrub: ctx.scrub });
  },
};

// ---- Supabase ----------------------------------------------------------------------------------------------------

const ROW_LIMIT = 2000;

const supabase = {
  async query(P, args) {
    if (args.length !== 1) fail('give the SQL as one argument: agent-broker supabase query "select ..."');
    const ctx = await context(P, 'supabase', ['SUPABASE_READ_URL']);
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: ctx.secrets.SUPABASE_READ_URL,
      ssl: { ca: await fs.readFile(CA_FILE, 'utf8'), rejectUnauthorized: true },
      connectionTimeoutMillis: 10000,
      query_timeout: 300000,
      application_name: 'agent-broker',
    });
    try {
      await client.connect();
      const results = [].concat(await client.query(args[0]));
      const out = results.map((r) => ({
        command: r.command, rowCount: r.rowCount,
        rows: (r.rows ?? []).slice(0, ROW_LIMIT),
        ...((r.rows?.length ?? 0) > ROW_LIMIT ? { truncated: `first ${ROW_LIMIT} of ${r.rows.length} rows` } : {}),
      }));
      process.stdout.write(`${ctx.scrub(JSON.stringify(out.length === 1 ? out[0] : out, null, 2))}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`agent-broker: ${ctx.scrub(String(e.message ?? e))}\n`);
      return 1;
    } finally {
      await client.end().catch(() => {});
    }
  },
  async migrate(P, args) {
    const { opts, positional } = parseArgs(args, { 'dry-run': 'bool', 'include-all': 'bool' });
    none(positional);
    const ctx = await context(P, 'supabase', ['SUPABASE_ACCESS_TOKEN']);
    const work = await workCopy(P, ctx);
    const env = { SUPABASE_ACCESS_TOKEN: ctx.secrets.SUPABASE_ACCESS_TOKEN };
    const linked = await run('supabase', ['link', '--project-ref', ctx.config.project_ref, '--yes'], { cwd: work, env, scrub: ctx.scrub });
    if (linked) return linked;
    const cli = ['db', 'push', '--linked', '--yes'];
    if (opts['dry-run']) cli.push('--dry-run');
    if (opts['include-all']) cli.push('--include-all');
    return run('supabase', cli, { cwd: work, env, scrub: ctx.scrub });
  },
  async 'admin-query'(P, args) {
    if (args.length !== 1) fail('give the SQL as one argument: agent-broker supabase admin-query "..."');
    await context(P, 'supabase', ['SUPABASE_ACCESS_TOKEN']);
    const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + randomUUID().slice(0, 6);
    await fs.writeFile(path.join(DIR.queue, `${id}.json`), JSON.stringify({ id, project: P.name, sql: args[0], created_at: new Date().toISOString(), status: 'pending' }, null, 2), { mode: 0o600 });
    process.stdout.write(`Waiting for approval: ${id}\nAsk the owner to run in their own Terminal:  agent-broker-admin approve ${id}\nThen read the result with:  agent-broker result ${id}\n`);
    return 0;
  },
};

// ---- Apify -------------------------------------------------------------------------------------------------------

// apify-cli 1.10 reads its token only from ~/.apify/auth.json or the keyring: APIFY_TOKEN in the environment is ignored
// by every account command ("You are not logged in"). Each call gets a throwaway HOME (0700, in the broker's tmp)
// holding auth.json, removed when the CLI exits, so the token never lands in the broker user's real home.
async function apifyRun(ctx, args, cwd, stdout, allow = []) {
  const home = await scratch();
  try {
    await fs.mkdir(path.join(home, '.apify'), { mode: 0o700 });
    await fs.writeFile(path.join(home, '.apify', 'auth.json'), JSON.stringify({ token: ctx.secrets.APIFY_TOKEN, secretsBackend: 'file' }), { mode: 0o600 });
    const env = { HOME: home, APIFY_DISABLE_KEYRING: '1', APIFY_CLI_DISABLE_TELEMETRY: '1' };
    return await run('apify', args, { cwd, env, scrub: ctx.scrub, out: stdout, allow: [home, ...allow] });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const apify = {
  async push(P, args) {
    const { opts, positional } = parseArgs(args, { dir: 'string', force: 'bool', version: 'string', 'build-tag': 'string' });
    none(positional);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    const work = await workCopy(P, ctx);
    const dir = path.join(work, checkRelative(opts.dir ?? '.', '--dir'));
    const cli = ['push'];
    if (opts.force) cli.push('--force');
    if (opts.version) cli.push('--version', checkId(opts.version, 'version'));
    if (opts['build-tag']) cli.push('--build-tag', checkId(opts['build-tag'], 'build tag'));
    return apifyRun(ctx, cli, dir, undefined, [work]);
  },
  async pull(P, [actor, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    const dir = await scratch();
    try {
      const out = path.join(dir, 'actor');
      const code = await apifyRun(ctx, ['pull', checkActor(actor), '--dir', out], dir, process.stderr);
      if (code) return code;
      // stdout carries only the tar (CLI messages went to stderr); the tar is checked for stored secrets first.
      const { execFileSync } = await import('node:child_process');
      const tar = execFileSync('/usr/bin/tar', ['-c', '-C', dir, 'actor'], { maxBuffer: 512 << 20 });
      assertNoSecret(tar, ctx.values, 'actor source');
      process.stdout.write(tar);
      return 0;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  async info(P, [actor, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['actors', 'info', checkActor(actor), '--json'], await scratch());
  },
  async builds(P, [actor, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['builds', 'ls', checkActor(actor), '--json'], await scratch());
  },
  async 'build-log'(P, [build, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['builds', 'log', checkId(build, 'build id')], await scratch());
  },
  async runs(P, [actor, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['runs', 'ls', checkActor(actor), '--json'], await scratch());
  },
  async 'run-info'(P, [runId, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['runs', 'info', checkId(runId, 'run id'), '--json'], await scratch());
  },
  async logs(P, [runId, ...rest]) {
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['runs', 'log', checkId(runId, 'run id')], await scratch());
  },
  async call(P, args) {
    const { opts, positional: [actor, ...rest] } = parseArgs(args, { 'input-file': 'string', input: 'string', build: 'string', memory: 'string', timeout: 'string' });
    none(rest);
    const ctx = await context(P, 'apify', ['APIFY_TOKEN']);
    const dir = await scratch();
    const cli = ['call', checkActor(actor)];
    if (opts['input-file']) {
      const file = path.join(dir, 'input.json');
      const work = await workCopy(P, ctx);
      await fs.copyFile(path.join(work, checkRelative(opts['input-file'], '--input-file')), file);
      cli.push('--input-file', file);
    } else if (opts.input) {
      try { JSON.parse(opts.input); } catch { fail('--input must be a JSON object'); }
      cli.push('--input', opts.input);
    }
    if (opts.build) cli.push('--build', checkId(opts.build, 'build'));
    if (opts.memory) cli.push('--memory', String(Number.parseInt(opts.memory, 10)));
    if (opts.timeout) cli.push('--timeout', String(Number.parseInt(opts.timeout, 10)));
    return apifyRun(ctx, cli, dir);
  },
};

// ---- Docker Compose (Linux broker) -------------------------------------------------------------------------------

// Options accepted before the compose command. Not offered: --env-file, --project-directory, -p / --project-name (the
// folder decides them; the broker gives the values), and anything not listed.
const COMPOSE_OPTS = { '-f': 'file', '--file': 'file', '--profile': 'value', '--progress': 'value', '--ansi': 'value', '--dry-run': 'bool' };

/**
 * `docker compose` in the project's registered folder, with the project's stored values in the environment (Compose
 * reads them before the folder's .env file, which keeps only the non-secret settings). Output is scrubbed; stdin is
 * passed on (`exec -T db psql < dump.sql`). Runs only in the registered folder itself: a git worktree of it has the
 * same Compose project name, so it would replace the live containers.
 */
async function compose(cwd, args) {
  if (!LINUX && !process.env.AGENT_BROKER_DEV_ROOT) fail('compose runs on the Linux broker only (on a Mac, Docker belongs to your own user: use docker compose)');
  const P = await resolveProject(cwd, undefined, undefined, { registeredOnly: true });
  if (!P.project.paths.includes(P.root)) {
    fail(`compose runs only in the project's own folder (${P.project.paths.join(', ')}), not in a worktree of it: it would change the live containers`);
  }
  const opts = [];
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    const kind = COMPOSE_OPTS[flag] ?? fail(`compose option ${flag} is not offered before the command (allowed: ${Object.keys(COMPOSE_OPTS).join(', ')})`);
    if (kind === 'bool') { opts.push(flag); continue; }
    const v = inline ?? args[++i] ?? fail(`${flag} needs a value`);
    opts.push(flag, kind === 'file' ? checkRelative(v, flag) : v);
  }
  if (i >= args.length) fail('give a compose command: agent-broker compose ps | up -d | logs <service> | ...');
  const [command, ...rest] = args.slice(i);
  const secrets = await loadSecrets(P.name);
  const scrub = makeScrubber(await allSecretValues());
  if (needsCheck(command)) {
    const problems = await composeProblems(P, opts, command, rest, secrets);
    if (problems.length) {
      await audit({ service: 'compose', command, project: P.name, refused: problems[0] });
      fail(`compose ${command} refused, nothing was started: ${problems.slice(0, 5).join('; ')}. The broker does not give a container its own folders or the Docker socket.`);
    }
  } else if (command === 'cp') {
    const problems = cpProblems(rest, P.root);
    if (problems.length) fail(`compose cp refused: ${problems.join('; ')}`);
  }
  const code = await run('docker', ['compose', ...opts, command, ...rest],
    { cwd: P.root, env: secrets, scrub, sandbox: false, stdin: 'inherit' });
  await audit({ service: 'compose', command, project: P.name, code });
  return code;
}

/**
 * Why a compose command that can start or change containers must not run, from the resolved config the real call would
 * use (same files, same environment, every profile: `up web` turns on a profile by itself). The JSON stays in memory:
 * it holds this project's own values, so it is never printed. A stored value that is not this project's, found in it,
 * also refuses (an env_file of broker files has no path left in the resolved output).
 */
async function composeProblems(P, opts, command, rest, secrets) {
  const problems = command === 'run' ? await runVolumeProblems(rest, { home: HOME, cwd: P.root }) : [];
  const chunks = [];
  const code = await run('docker', ['compose', ...opts.filter((o) => o !== '--dry-run'), '--profile', '*', 'config', '--format', 'json'], {
    cwd: P.root, env: secrets, scrub: makeScrubber(await allSecretValues()), outScrub: (s) => s, out: { write: (s) => chunks.push(s) }, sandbox: false,
  });
  if (code !== 0) fail(`compose could not resolve this project's configuration (exit ${code}), so ${command} was not started`);
  let config;
  try {
    config = JSON.parse(chunks.join(''));
  } catch {
    fail(`compose config did not give JSON, so ${command} was not started`);
  }
  const own = new Set(Object.values(secrets));
  const otherValues = (await allSecretValues()).filter((v) => !own.has(v));
  return [...problems, ...(await configProblems(config, { home: HOME, cwd: P.root, otherValues }))];
}

const ACTIONS = { netlify, vercel, supabase, apify };

// ---- Overview commands (no secrets, only names) --------------------------------------------------------------

/** What one project uses: stack, folders, pinned site / database, stored key names. */
async function describe(name, project) {
  const stack = await effectiveStack(project);
  const keys = new Set(Object.keys(await loadSecrets(name)));
  if (stack) for (const k of Object.keys(await loadStackSecrets(stack))) keys.add(k);
  const services = {};
  for (const s of SERVICES) if (project[s]) services[s] = { ...project[s], token: keys.has(KEY_FOR[s]) };
  const stackLabel = project.stack ?? (stack ? 'global (default fallback)' : null);
  return { project: name, stack: stackLabel, folders: project.paths, services, keys: [...keys].sort(), note: project.note };
}

async function whoami(cwd, flags = {}) {
  const P = await resolveProject(cwd, flags.explicit, flags.explicitStack);
  const d = await describe(P.name, P.project);
  const stack = await effectiveStack(P.project);
  const accounts = stack ? (await loadStack(stack)).accounts ?? {} : {};
  json({ ...d, folder: P.root, accounts, use: 'agent-broker <service> <action> from inside this folder; agent-broker help' });
  return 0;
}

async function projectsList() {
  const out = [];
  for (const name of await listProjects()) out.push(await describe(name, await loadProject(name)));
  json(out);
  return 0;
}

async function stacksList() {
  const out = [];
  const projects = await Promise.all((await listProjects()).map(async (n) => [n, await effectiveStack(await loadProject(n))]));
  for (const name of await listStacks()) {
    const s = await loadStack(name);
    out.push({ stack: name, is_default: name === 'global', ...(s.followsMac ? { follows_mac: true } : {}), ...(s.shared ? { shared: true } : {}), accounts: s.accounts ?? {},
      keys: Object.keys(await loadStackSecrets(name)).sort(), projects: projects.filter(([, st]) => st === name).map(([n]) => n), note: s.note });
  }
  json(out);
  return 0;
}

async function result(id) {
  checkId(id, 'request id');
  const req = JSON.parse(await fs.readFile(path.join(DIR.queue, `${id}.json`), 'utf8').catch(() => fail(`no request ${id}`)));
  const values = await allSecretValues();
  process.stdout.write(`${makeScrubber(values)(JSON.stringify({ id, status: req.status, project: req.project, sql: req.sql, output: req.output }, null, 2))}\n`);
  return 0;
}

// ---- New projects: init / attach (no owner approval: only unclaimed folders, the stack's own sites/databases) ---

const SETUP_OPTS = {
  stack: 'string', name: 'string', here: 'bool', list: 'bool', 'netlify-site': 'string', 'netlify-new': 'string',
  'netlify-team': 'string', 'supabase-ref': 'string', 'no-reader': 'bool', 'vercel-project': 'string', apify: 'bool',
  'no-agents-md': 'bool', // read by the wrapper: init then leaves AGENTS.md alone
};
const skipVerify = () => Boolean(process.env.AGENT_BROKER_DEV_ROOT) && process.env.AGENT_BROKER_SKIP_VERIFY === '1'; // tests only
const idArg = (v, what) => (/^[A-Za-z0-9_-]{1,100}$/.test(v ?? '') ? v : fail(`invalid ${what}: ${v ?? '(missing)'}`));

/** Which project already pins this site / database, if any (each is owned by one project only). */
async function pinOwner(service, field, value, except) {
  for (const name of await listProjects()) {
    if (name !== except && (await loadProject(name))[service]?.[field] === value) return name;
  }
  return null;
}

/**
 * Adds the requested services to `project` (pinned site / database checked against the stack's accounts and against
 * every other project). Returns project-only values to store (the read-only database URL). Creates a Netlify site
 * or a database user only after every check passed.
 */
async function addServices(project, name, opts, tokens, stackName) {
  const values = {};
  const wants = { netlify: opts['netlify-site'] || opts['netlify-new'], supabase: opts['supabase-ref'], vercel: opts['vercel-project'], apify: opts.apify };
  if (opts['netlify-site'] && opts['netlify-new']) fail('give --netlify-site or --netlify-new, not both');
  for (const [s, want] of Object.entries(wants)) {
    if (!want) continue;
    if (project[s]) fail(`project ${name} already uses ${s}; changing it is the owner's job (wizard: Move a project)`);
    if (!tokens[KEY_FOR[s]]) fail(`stack ${stackName} has no ${s} token: the owner adds it with the wizard (Replace a token)`);
  }
  if (wants.netlify) {
    const site = opts['netlify-site'] && idArg(opts['netlify-site'], 'Netlify site id');
    if (site && await pinOwner('netlify', 'site_id', site, name)) fail(`Netlify site ${site} already belongs to project ${await pinOwner('netlify', 'site_id', site, name)}`);
    project.netlify = { site_id: site };
  }
  if (wants.supabase) {
    const ref = idArg(opts['supabase-ref'], 'Supabase project ref');
    const owner = await pinOwner('supabase', 'project_ref', ref, name);
    if (owner) fail(`Supabase project ${ref} already belongs to project ${owner}`);
    project.supabase = { project_ref: ref };
  }
  if (wants.vercel) {
    const id = idArg(opts['vercel-project'], 'Vercel project id');
    const owner = await pinOwner('vercel', 'project_id', id, name);
    if (owner) fail(`Vercel project ${id} already belongs to project ${owner}`);
    let org = null;
    if (!skipVerify()) {
      const found = (await lookup({ VERCEL_TOKEN: tokens.VERCEL_TOKEN })).vercel;
      org = found?.projects?.find((p) => p.id === id || p.name === id)?.org_id;
      if (!org) fail(`Vercel project ${id} is not in stack ${stackName}'s Vercel account`);
    }
    project.vercel = { org_id: org ?? 'team_test', project_id: id };
  }
  if (wants.apify) project.apify = {};

  if (!skipVerify()) {
    const check = { ...project, netlify: project.netlify?.site_id ? project.netlify : undefined };
    const { names } = await verifyPins(check, tokens).catch((e) => fail(e.message));
    for (const [s, n] of Object.entries(names)) project[s] = { ...project[s], ...n };
  }
  if (wants.netlify && !project.netlify.site_id) {
    if (skipVerify()) fail('--netlify-new needs the real Netlify API');
    const stack = await loadStack(stackName);
    const team = opts['netlify-team'] ?? stack.accounts?.netlify?.teams?.[0]
      ?? (await lookup({ NETLIFY_AUTH_TOKEN: tokens.NETLIFY_AUTH_TOKEN })).netlify?.account?.teams?.[0];
    if (!team) fail(`could not find a Netlify team for stack ${stackName}; give --netlify-team`);
    const site = await createNetlifySite(tokens.NETLIFY_AUTH_TOKEN, team, opts['netlify-new']).catch((e) => fail(`creating the Netlify site: ${e.message}`));
    project.netlify = { ...project.netlify, site_id: site.id, site_name: site.name, site_url: site.url };
    process.stderr.write(`agent-broker: created Netlify site ${site.name} (${site.url}) in team ${team}\n`);
  }
  if (wants.supabase && !opts['no-reader'] && !skipVerify()) {
    values.SUPABASE_READ_URL = await createReadOnlyUser(tokens.SUPABASE_ACCESS_TOKEN, project.supabase.project_ref)
      .catch((e) => fail(`creating the read-only database user: ${e.message}. Retry with --no-reader and ask the owner.`));
    process.stderr.write('agent-broker: created the read-only database user agent_reader (agent-broker supabase query)\n');
  }
  return values;
}

async function init(cwd, args) {
  const { opts, positional } = parseArgs(args, SETUP_OPTS);
  none(positional);
  const availableStacks = await listStacks();
  const defaultStack = availableStacks.includes('global') ? 'global' : null;
  const chosenStack = opts.stack ?? defaultStack;
  if (!chosenStack) fail('give the account stack: agent-broker init --stack <name> (ask the user which one; list: agent-broker stacks)');
  const stackName = checkName(chosenStack, 'stack');
  await loadStack(stackName);
  const tokens = await loadStackSecrets(stackName);
  if (opts.list) {
    const found = await lookup(tokens);
    const used = {};
    for (const n of await listProjects()) {
      const p = await loadProject(n);
      if (p.netlify) used[`netlify:${p.netlify.site_id}`] = n;
      if (p.supabase) used[`supabase:${p.supabase.project_ref}`] = n;
      if (p.vercel) used[`vercel:${p.vercel.project_id}`] = n;
    }
    json({
      stack: stackName,
      netlify: found.netlify?.sites?.map((s) => ({ ...s, used_by: used[`netlify:${s.id}`] ?? null })) ?? found.netlify?.error ?? null,
      supabase: found.supabase?.projects?.map((p) => ({ ...p, used_by: used[`supabase:${p.ref}`] ?? null })) ?? found.supabase?.error ?? null,
      vercel: found.vercel?.projects?.map((p) => ({ ...p, used_by: used[`vercel:${p.id}`] ?? null })) ?? found.vercel?.error ?? null,
    });
    return 0;
  }
  const here = await fs.realpath(cwd);
  const folder = opts.here ? here : (await gitRoot(here)) ?? here;
  await assertUnclaimed(folder);
  const name = checkName(opts.name ?? path.basename(folder).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, ''));
  if ((await listProjects()).includes(name)) fail(`a project named ${name} exists already: add --name <other>`);
  const project = { stack: stackName, paths: [folder] };
  const values = await addServices(project, name, opts, tokens, stackName);
  await saveProject(name, project);
  await saveSecrets(name, values);
  await audit({ init: name, stack: stackName, folder, services: SERVICES.filter((s) => project[s]) });
  json({ created: name, stack: stackName, folder, services: Object.fromEntries(SERVICES.filter((s) => project[s]).map((s) => [s, project[s]])) });
  return 0;
}

async function attach(cwd, args) {
  const { explicit, explicitStack, rest } = takeFlags(args);
  const { opts, positional } = parseArgs(rest, SETUP_OPTS);
  none(positional);
  if (explicitStack || opts.stack || opts.name || opts.here || opts.list) fail('attach only adds services (stack, name and folder are fixed; the owner changes them with the wizard)');
  const P = await resolveProject(cwd, explicit);
  const stack = await effectiveStack(P.project);
  if (!stack) fail(`project ${P.name} has no stack yet: ask the owner (wizard: Set up / update)`);
  const values = await addServices(P.project, P.name, opts, await loadStackSecrets(stack), stack);
  await saveProject(P.name, P.project);
  await saveSecrets(P.name, { ...(await loadSecrets(P.name)), ...values });
  await audit({ attach: P.name, services: Object.keys(opts) });
  json(await describe(P.name, P.project));
  return 0;
}

// Shared by both blocks; the wizard (scripts/wizard.sh, "AGENTS.md text") carries the same lines.
const NETLIFY_DEPLOY_LINE = 'Deploy: build, then `agent-broker netlify deploy --message "..."` (draft; the folder comes from netlify.toml `publish`, or add `--dir <folder>`). `--prod` only when the owner asks.';
const APIFY_LINE = 'Apify: `agent-broker apify push [--dir <actor folder>]`, `runs <actor>`, `logs <run-id>`.';
const COMPOSE_LINE = 'Docker Compose: `agent-broker compose <command>` in the stack folder instead of `docker compose`; the broker adds the stored secrets (the folder\'s `.env` keeps only non-secret settings).';

/** Generic, project-agnostic block for a stack. Drop into AGENTS.md / CLAUDE.md of any repo using this stack. */
async function stackAgentsBlock(stackName) {
  await loadStack(stackName);
  const secrets = await loadStackSecrets(stackName);
  const lines = [
    '<!-- agent-broker:start -->',
    '## Accounts & deployment (agent broker)',
    '',
    `This project uses account stack \`${stackName}\`.`,
    'Use `agent-broker` from inside this repository. The stack picks your account.',
    'Never name an account, site id or project ref; never read tokens or `.env` secrets.',
    'The plain `netlify`/`supabase`/`apify`/`vercel` commands do local work only.',
    '',
    '- Check stack info: `agent-broker whoami`. All actions: `agent-broker help`.',
  ];
  if (secrets.NETLIFY_AUTH_TOKEN) {
    lines.push(`- ${NETLIFY_DEPLOY_LINE}`);
  }
  if (secrets.VERCEL_TOKEN) {
    lines.push('- Deploy: `agent-broker vercel settings > .vercel/project.json`, `vercel build`, `agent-broker vercel deploy`.');
  }
  if (secrets.SUPABASE_ACCESS_TOKEN || secrets.SUPABASE_READ_URL) {
    lines.push('- Database: `agent-broker supabase query "select ..."` (read-only). Changes: `agent-broker supabase migrate --dry-run`, then without; anything else: `agent-broker supabase admin-query "..."` (the owner approves).');
  }
  if (secrets.APIFY_TOKEN) {
    lines.push(`- ${APIFY_LINE}`);
  }
  if (LINUX) lines.push(`- ${COMPOSE_LINE}`);
  lines.push('- Needs a site or database not attached yet: `agent-broker attach ...` (see `agent-broker help`).');
  lines.push('- A missing token: stop and ask the owner to run the agent-broker wizard.');
  lines.push('<!-- agent-broker:end -->');
  return lines.join('\n');
}

/** Project-specific fallback block (legacy). */
function agentsBlock(name, project, stack) {
  const label = { netlify: (c) => c.site_name ?? c.site_id, supabase: (c) => c.name ?? c.project_ref, vercel: (c) => c.name ?? c.project_id, apify: () => 'actors' };
  const uses = SERVICES.filter((s) => project[s]).map((s) => `${s} ${label[s](project[s])}`).join(', ');
  const lines = [
    '<!-- agent-broker:start -->',
    '## Accounts (agent broker)',
    '',
    `This folder is broker project \`${name}\`${stack ? ` on account stack \`${stack}\`` : ''}${uses ? ` (${uses})` : ''}.`,
    'Use `agent-broker` from inside this folder: the folder picks the account. Never name an account, site id or',
    'project ref; never read tokens or `.env` secrets. The plain `netlify`/`supabase`/`apify`/`vercel` commands do local',
    'work only.',
    '',
    '- Check: `agent-broker whoami`. All actions: `agent-broker help`.',
  ];
  if (project.netlify) lines.push(`- ${NETLIFY_DEPLOY_LINE}`);
  if (project.vercel) lines.push('- Deploy: `agent-broker vercel settings > .vercel/project.json`, `vercel build`, `agent-broker vercel deploy`.');
  if (project.supabase) lines.push('- Database: `agent-broker supabase query "select ..."` (read-only). Changes: `agent-broker supabase migrate --dry-run`, then without; anything else: `agent-broker supabase admin-query "..."` (the owner approves).');
  if (project.apify) lines.push(`- ${APIFY_LINE}`);
  lines.push('- Needs a site or database it does not have yet: `agent-broker attach ...` (see `agent-broker help`).');
  if (LINUX) lines.push(`- ${COMPOSE_LINE}`);
  lines.push('- A missing token: stop and ask the owner to run the agent-broker wizard.');
  lines.push('<!-- agent-broker:end -->');
  return lines.join('\n');
}

async function agentsMd(cwd, args) {
  const { explicit, explicitStack, rest } = takeFlags(args);
  const { opts, positional } = parseArgs(rest, { json: 'bool', stack: 'string' });
  none(positional);
  const stack = opts.stack ?? explicitStack;
  if (stack) {
    checkName(stack, 'stack');
    const block = await stackAgentsBlock(stack);
    if (opts.json) json({ stack, block });
    else process.stdout.write(`${block}\n`);
    return 0;
  }
  const P = await resolveProject(cwd, explicit, explicitStack);
  const effective = await effectiveStack(P.project);
  const block = effective ? await stackAgentsBlock(effective) : agentsBlock(P.name, P.project, null);
  if (opts.json) json({ project: P.name, folder: P.root, block });
  else process.stdout.write(`${block}\n`);
  return 0;
}

// ---- Main --------------------------------------------------------------------------------------------------------

/** Takes --project NAME / --project=NAME out of the arguments. */
/** Takes --project and --stack out of the arguments. */
function takeFlags(args) {
  let explicit;
  let explicitStack;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') explicit = args[++i] ?? fail('--project needs a value');
    else if (args[i].startsWith('--project=')) explicit = args[i].slice('--project='.length);
    else if (args[i] === '--stack') explicitStack = args[++i] ?? fail('--stack needs a value');
    else if (args[i].startsWith('--stack=')) explicitStack = args[i].slice('--stack='.length);
    else rest.push(args[i]);
  }
  if (explicit !== undefined) checkName(explicit);
  if (explicitStack !== undefined) checkName(explicitStack, 'stack');
  return { explicit, explicitStack, rest };
}

/**
 * The systemd user unit the caller runs in, from the caller's own cgroup (sudo keeps it: no pam_systemd in the sudo
 * stack). Accepts only .../user@<SUDO_UID>.service/app.slice/<unit>: the unit sits directly under that user's app slice.
 * Tests only (dev root): the cgroup file can be replaced with AGENT_BROKER_DEV_CGROUP_FILE.
 */
async function callerUnit() {
  const uid = process.env.SUDO_UID ?? '';
  if (!/^[0-9]{1,10}$/.test(uid)) fail('run works only through the sudo wrapper (no SUDO_UID)');
  const file = process.env.AGENT_BROKER_DEV_ROOT && process.env.AGENT_BROKER_DEV_CGROUP_FILE ? process.env.AGENT_BROKER_DEV_CGROUP_FILE : '/proc/self/cgroup';
  const text = await fs.readFile(file, 'utf8').catch(() => fail('cannot read the caller\'s cgroup'));
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  const parts = line ? line.slice(3).split('/').filter(Boolean) : [];
  const n = parts.length;
  if (n < 3 || parts[n - 3] !== `user@${uid}.service` || parts[n - 2] !== 'app.slice') fail('the caller is not a systemd user unit of this user (expected .../user@UID.service/app.slice/<unit>)');
  return parts[n - 1];
}

/**
 * agent-broker run <group>: the keys the caller's unit may have, as NUL-separated records on stdout and nothing else:
 *   file\0<name>\0<value>\0     env\0<KEY>\0<value>\0
 * The one output the broker never scrubs (it IS the secret). Read by the wrapper's `run`, which writes them into the
 * unit's private runtime folder. Exit 2: no grant; 3: a required key has no stored value (nothing is printed then).
 */
async function runGroup(name) {
  checkName(name ?? '', 'group');
  const unit = await callerUnit();
  const grant = (await loadGroup(name)).grants.find((g) => g.unit === unit);
  if (!grant) fail(`no grant for ${unit} in group ${name}`);
  const secrets = await loadGroupSecrets(name);
  const optional = new Set(grant.optional ?? []);
  const records = [];
  const keys = [];
  const missing = [];
  const skipped = [];
  const take = (kind, label, key) => {
    if (key in secrets) { records.push(kind, label, secrets[key]); keys.push(key); } else (optional.has(key) ? skipped : missing).push(key);
  };
  for (const [file, key] of Object.entries(grant.files ?? {})) take('file', file, key);
  for (const key of grant.env ?? []) take('env', key, key);
  if (missing.length) {
    await audit({ run: name, unit, error: 'missing', missing });
    process.stderr.write(`agent-broker: group ${name} has no value for ${missing.join(', ')} (needed by ${unit})\n`);
    return 3;
  }
  for (const key of skipped) process.stderr.write(`agent-broker: warning: optional ${key} has no value in group ${name}; ${unit} starts without it\n`);
  await audit({ run: name, unit, keys, skipped });
  process.stdout.write(records.length ? `${records.join('\0')}\0` : '');
  return 0;
}

// Process tree for `key`: /proc, or under the dev root a fake one (AGENT_BROKER_DEV_PROC, own pid AGENT_BROKER_DEV_PID).
const procRoot = () => (process.env.AGENT_BROKER_DEV_ROOT && process.env.AGENT_BROKER_DEV_PROC) || '/proc';
const ownPid = () => (process.env.AGENT_BROKER_DEV_ROOT && process.env.AGENT_BROKER_DEV_PID ? Number(process.env.AGENT_BROKER_DEV_PID) : process.pid);
const MAX_ANCESTORS = 32;

/** { name, ppid } from /proc/<pid>/stat. The name sits between the first "(" and the LAST ")": it may hold spaces and brackets. */
function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const ppid = Number(text.slice(close + 1).trim().split(' ')[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? { name: text.slice(open + 1, close), ppid } : null;
}

/** The caller's ancestors, nearest first: [{ pid, name, arg0 }]. Ends at pid 1, a loop, an unreadable entry, or MAX_ANCESTORS. */
async function ancestors() {
  const root = procRoot();
  const out = [];
  const seen = new Set([ownPid()]);
  let pid = ownPid();
  while (out.length < MAX_ANCESTORS) {
    const self = parseStat(await fs.readFile(`${root}/${pid}/stat`, 'utf8').catch(() => ''));
    if (!self || self.ppid <= 1 || seen.has(self.ppid)) break;
    pid = self.ppid;
    seen.add(pid);
    const parent = parseStat(await fs.readFile(`${root}/${pid}/stat`, 'utf8').catch(() => ''));
    if (!parent) break;
    const cmdline = await fs.readFile(`${root}/${pid}/cmdline`, 'utf8').catch(() => '');
    out.push({ pid, name: parent.name, arg0: cmdline.split('\0')[0] });
  }
  return out;
}

/**
 * agent-broker key <group> <KEY>: one raw value on stdout (+ newline), for a program's `!command` key line (OMP).
 * All must hold: the caller's cgroup is the grant's (directly under the user's app.slice); an ancestor process was
 * started from the grant's program folder; the key is granted and stored. Exit 2 refused, 3 granted but no stored value.
 * The program check reads argv[0] from /proc/<pid>/cmdline (the broker user cannot read another user's /proc/<pid>/exe).
 * An ancestor passes when its argv[0] is an absolute path under the grant's folder, or a bare name (no "/") the grant
 * lists in `names` (the real OMP here starts as bare `omp`). A caller can fake argv[0], so this is a guard against the
 * wrong program, not a wall. Audit: pid + program name, never command lines or values.
 */
async function keyValue(group, key) {
  checkName(group ?? '', 'group');
  if (!KEY.test(key ?? '')) fail(`invalid key name: ${key ?? '(missing)'}`);
  let chain = [];
  let result = 'error';
  try {
    const unit = await callerUnit().catch((e) => { result = 'bad-caller'; throw e; });
    const grant = (await loadGroup(group)).grants.find((g) => g.omp);
    if (!grant) { result = 'no-grant'; fail(`no program grant in group ${group}`); }
    if (unit !== grant.cgroup) { result = 'bad-caller'; fail(`the caller is ${unit}, not ${grant.cgroup}`); }
    chain = await ancestors();
    const prefix = grant.exe.endsWith('/') ? grant.exe : `${grant.exe}/`;
    const names = grant.names ?? [];
    const fromProgram = (a) => (a.startsWith(prefix) && !a.split('/').some((p) => p === '..' || p === '.')) || (!a.includes('/') && names.includes(a));
    if (!chain.some((a) => fromProgram(a.arg0))) { result = 'no-program'; fail(`no process above the caller was started from ${grant.exe}${names.length ? ` or as ${names.join('/')}` : ''}`); }
    if (!grant.keys.includes(key)) { result = 'not-granted'; fail(`${key} is not granted in group ${group}`); }
    const value = (await loadGroupSecrets(group))[key];
    if (value === undefined) {
      result = 'no-value';
      process.stderr.write(`agent-broker: group ${group} has no value for ${key}\n`);
      return 3;
    }
    result = 'ok';
    process.stdout.write(`${value}\n`);
    return 0;
  } finally {
    await audit({ key: group, name: key, result, chain: chain.map(({ pid, name }) => ({ pid, name })) });
  }
}

/**
 * agent-broker health: can the broker serve what its groups promise? Exactly one line on stdout, no value in it; exit 0
 * healthy, 1 broken. Checks per group: the record parses and its grants are valid; every required key a grant names has
 * a stored value (an optional one is only a note); a program grant's folder exists; the values file can be read.
 * Broken line: `broker broken (<causes>), so <units / programs> cannot get keys`. The wrapper writes the status file
 * (the broker user cannot write the status folder).
 * NOT CHECKED HERE yet, each is its own later step: the age of the Mac copy of the account tokens, that the cloud-CLI
 * sandbox starts, and a scan of the audit log for refused calls.
 */
async function health() {
  const causes = [];
  const stops = new Set();
  const notes = [];
  const macNotes = [];
  let groups = 0;
  let grants = 0;
  for (const name of await listGroups()) {
    groups++;
    let group;
    let secrets;
    let unreadable = null;
    try {
      group = await loadGroup(name);
    } catch {
      unreadable = `cannot read group ${name}`;
    }
    if (!unreadable) {
      try { secrets = await loadGroupSecrets(name); } catch { unreadable = `cannot read the values of group ${name}`; }
    }
    if (unreadable) {
      causes.push(unreadable);
      // Name what the broken record would have served, as far as the file still tells.
      const raw = await fs.readFile(path.join(DIR.groups, `${name}.json`), 'utf8').then(JSON.parse).catch(() => null);
      const units = (Array.isArray(raw?.grants) ? raw.grants : []).map((g) => g?.unit).filter((u) => typeof u === 'string');
      if (units.length) for (const u of units) stops.add(u); else stops.add(`everything in group ${name}`);
      continue;
    }
    for (const g of group.grants) {
      grants++;
      const label = g.unit ?? (g.root ? 'root setup scripts' : `programs from ${g.exe}${g.names?.length ? ` (also named ${g.names.join(', ')})` : ''}`);
      const optional = new Set(g.optional ?? []);
      const needed = g.unit ? [...Object.values(g.files ?? {}), ...(g.env ?? [])] : (g.keys ?? []);
      for (const key of new Set(needed)) {
        if (key in secrets) continue;
        if (optional.has(key)) { notes.push(`${name}.${key}`); continue; }
        causes.push(`group ${name} has no value for ${key}`);
        stops.add(label);
      }
      if (g.omp && !(await fs.stat(g.exe).then((s) => s.isDirectory(), () => false))) {
        causes.push(`program folder ${g.exe} is missing or not readable by the broker`);
        stops.add(label);
      }
    }
  }
  // Stacks that follow the Mac: when the last copy arrived. A note only: this side cannot know what the Mac still has queued.
  const sync = await loadSyncState().catch(() => ({}));
  for (const name of await listStacks()) {
    if (!(await loadStack(name).catch(() => null))?.followsMac) continue;
    const last = Object.values(sync[name] ?? {}).map((e) => e?.at).filter(Boolean).sort().at(-1);
    macNotes.push(`stack ${name}: last copy from the Mac ${last ?? 'never'}`);
  }
  macNotes.push(...(await healthNotes()));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const line = causes.length
    ? `broker broken (${causes.join('; ')}), so ${[...stops].join(', ')} cannot get keys`
    : `ok: ${plural(groups, 'group')}, ${plural(grants, 'grant')}${notes.length ? `; optional without a value: ${notes.join(', ')}` : ''}${macNotes.length ? `; ${macNotes.join('; ')}` : ''}`;
  process.stdout.write(`${line.replace(/[\r\n]+/g, ' ')}\n`);
  return causes.length ? 1 : 0;
}

async function main(argv) {
  const cwd = process.cwd(); // the caller's folder (sudo keeps it): it decides the project
  await mkdirs();
  process.chdir(DIR.tmp);
  const [service, action, ...args] = argv;
  if (!service || service === 'help' || service === '--help') { process.stdout.write(`${HELP}\n`); return 0; }
  if (service === 'projects') return projectsList();
  if (service === 'stacks') return stacksList();
  if (service === 'result') return result(action);
  if (service === 'run') return runGroup(action);
  if (service === 'key') return keyValue(action, args[0]);
  if (service === 'health') return health();
  if (service === 'sync-retry') {
    for (const line of describeDelivery(await deliver())) console.log(line);
    return 0;
  }
  const after = [action, ...args].filter((a) => a !== undefined);
  if (service === 'whoami') return whoami(cwd, takeFlags(after));
  if (service === 'init') return init(cwd, after);
  if (service === 'attach') return attach(cwd, after);
  if (service === 'agents-md') return agentsMd(cwd, after);
  if (service === 'compose') return compose(cwd, after);
  // (cloud actions run their CLI in the sandbox on both systems; on Linux that is bwrap, checked before any token is loaded)
  const actions = ACTIONS[service] ?? fail(`unknown service: ${service} (netlify, vercel, supabase, apify, compose). See: agent-broker help`);
  const fn = Object.hasOwn(actions, action ?? '') ? actions[action] : fail(`${service} has no action "${action ?? ''}". Allowed: ${Object.keys(actions).join(', ')}`);
  sandboxReady();
  const { explicit, explicitStack, rest } = takeFlags(args);
  const P = await resolveProject(cwd, explicit, explicitStack);
  // Old form `agent-broker netlify deploy <project>` (blob store names may look like project names: not checked).
  if (!action.startsWith('blobs-') && NAME.test(rest[0] ?? '') && (await listProjects()).includes(rest[0])) {
    fail(`unexpected argument "${rest[0]}": the project comes from the folder you run in (here: ${P.name}). `
      + 'Site ids, project refs and account names are never passed. See: agent-broker whoami');
  }
  const code = await fn(P, rest);
  await audit({ service, action, project: P.name, code });
  return code;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  async (e) => {
    const msg = e instanceof UsageError ? e.message : `internal error: ${e?.message ?? e}`;
    const values = await allSecretValues().catch(() => []);
    process.stderr.write(`agent-broker: ${makeScrubber(values)(msg)}\n`);
    await audit({ argv: process.argv.slice(2, 4), error: makeScrubber(values)(msg).slice(0, 300) });
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
