#!/opt/agent-broker/node/bin/node
// agent-broker: the only way agents use Netlify, Vercel, Supabase and Apify accounts on this Mac.
// Runs as _deployer through `sudo -n -u _deployer` (wrapper /usr/local/bin/agent-broker). Agents name a project; the
// broker picks that project's account, runs a fixed action and returns output with secrets removed.
// Guide: agent-scripts/skills/agent-broker/SKILL.md
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CA_FILE, DIR, UsageError, allSecretValues, assertNoSecret, audit, checkName, checkRelative, fail, listProjects,
  loadProject, loadSecrets, makeScrubber, mkdirs, parseArgs, run, syncProject,
} from './lib.mjs';

const HELP = `agent-broker <service> <action> <project> [options]

  agent-broker projects                 projects, their services and stored key names (never values)
  agent-broker result <id>              result of an approved Supabase admin query

netlify  deploy <p> [--prod] [--message M] [--dir D]   deploy files that are already built (no build step)
         status <p> | deploys <p>                      site and recent deploys
         logs <p> [--since 1h] [--function NAME]...    function logs
         blobs-list <p> <store> [--prefix P]           Netlify Blobs: keys
         blobs-get <p> <store> <key>                   Netlify Blobs: value bytes to stdout
         blobs-meta <p> <store> <key>                  Netlify Blobs: metadata
vercel   deploy <p> [--prod]                           deploy .vercel/output built with \`vercel build\`
         settings <p>                                  print .vercel/project.json (no environment values)
         deploys <p> | logs <p> <deployment-url-or-id>
supabase query <p> "<SQL>"                             read-only database user
         migrate <p> [--dry-run] [--include-all]       apply supabase/migrations
         admin-query <p> "<SQL>"                       full rights; waits for the owner's approval
apify    push <p> [--dir D] [--force] [--version V] [--build-tag T]
         pull <p> <actor>                              actor source as a tar stream on stdout
         info <p> <actor> | builds <p> <actor> | build-log <p> <build-id>
         runs <p> <actor> | run-info <p> <run-id> | logs <p> <run-id>
         call <p> <actor> [--input-file F | --input JSON] [--build B] [--memory MB] [--timeout S]

Commands that print keys, passwords or environment values are not offered.`;

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9~/._-]{0,200}$/;
const ID = /^[A-Za-z0-9._-]{1,200}$/;
const checkId = (v, what) => (ID.test(v ?? '') ? v : fail(`invalid ${what}: ${v ?? '(missing)'}`));
const checkActor = (v) => (ACTOR.test(v ?? '') ? v : fail(`invalid actor: ${v ?? '(missing)'}`));
const json = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

async function context(projectName, service, needs) {
  const project = await loadProject(projectName);
  const config = project[service];
  if (!config) fail(`project ${projectName} has no ${service} account (owner: agent-broker-admin project ${projectName} ...)`);
  const secrets = await loadSecrets(projectName);
  for (const k of needs) if (!secrets[k]) fail(`project ${projectName} has no ${k} stored (owner: agent-broker-admin set ${projectName} ${k})`);
  const values = await allSecretValues();
  return { project, config, secrets, values, scrub: makeScrubber(values) };
}

async function workCopy(name, ctx) {
  if (!ctx.project.path) fail(`project ${name} has no folder (owner: agent-broker-admin project ${name} --path DIR)`);
  const dest = path.join(DIR.work, name);
  const { changed, skipped } = await syncProject(ctx.project.path, dest, ctx.values);
  process.stderr.write(`agent-broker: copied ${changed} changed file(s) from ${ctx.project.path}${skipped.length ? `; left out ${skipped.length} (links outside the project, or files only you can read): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', ...' : ''}` : ''}\n`);
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

const netlify = {
  async deploy(name, args) {
    const { opts, positional } = parseArgs(args, { prod: 'bool', message: 'string', dir: 'string' });
    if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const dir = checkRelative(opts.dir ?? ctx.config.dir, '--dir');
    const work = await workCopy(name, ctx);
    if (!(await fs.stat(path.join(work, dir)).catch(() => null))?.isDirectory()) fail(`${dir} does not exist: build the project first`);
    const cli = ['deploy', '--no-build', '--dir', dir, '--site', ctx.config.site_id];
    if (opts.prod) cli.push('--prod');
    if (opts.message) cli.push('--message', opts.message);
    return run('netlify', cli, { cwd: work, env: { NETLIFY_AUTH_TOKEN: ctx.secrets.NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID: ctx.config.site_id }, scrub: ctx.scrub });
  },
  async status(name) {
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const s = await netlifyApi(ctx, `/sites/${ctx.config.site_id}`);
    const d = s.published_deploy ?? {};
    json({ name: s.name, url: s.ssl_url ?? s.url, admin_url: s.admin_url, account: s.account_slug,
      published_deploy: { id: d.id, state: d.state, published_at: d.published_at, title: d.title } });
    return 0;
  },
  async deploys(name) {
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const list = await netlifyApi(ctx, `/sites/${ctx.config.site_id}/deploys?per_page=10`);
    json(list.map((d) => ({ id: d.id, state: d.state, context: d.context, created_at: d.created_at, title: d.title, url: d.deploy_ssl_url })));
    return 0;
  },
  async logs(name, args) {
    const { opts, positional } = parseArgs(args, { since: 'string', function: 'list' });
    if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
    const since = opts.since ?? '1h';
    if (!/^\d{1,4}[smhd]$/.test(since)) fail('--since must look like 30m, 1h, 2d');
    const fns = (opts.function ?? []).map((f) => checkName(f, 'function'));
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const cli = ['logs', '--source', 'functions', '--since', since, ...(fns.length ? ['--function', ...fns] : [])];
    return run('netlify', cli, { cwd: await scratch(), env: { NETLIFY_AUTH_TOKEN: ctx.secrets.NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID: ctx.config.site_id }, scrub: ctx.scrub });
  },
  async 'blobs-list'(name, args) {
    const { opts, positional: [store, ...rest] } = parseArgs(args, { prefix: 'string' });
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const { blobs } = await (await blobStore(ctx, store)).list(opts.prefix ? { prefix: opts.prefix } : {});
    for (const b of blobs) process.stdout.write(`${JSON.stringify({ key: b.key, etag: b.etag })}\n`);
    return 0;
  },
  async 'blobs-get'(name, [store, key, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const body = await (await blobStore(ctx, store)).get(checkKey(key), { type: 'arrayBuffer' });
    if (body == null) { process.stderr.write(`agent-broker: no blob ${store}/${key}\n`); return 3; }
    const buf = Buffer.from(body);
    assertNoSecret(buf, ctx.values, `blob ${store}/${key}`);
    await new Promise((resolve, reject) => process.stdout.write(buf, (e) => (e ? reject(e) : resolve())));
    return 0;
  },
  async 'blobs-meta'(name, [store, key, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'netlify', ['NETLIFY_AUTH_TOKEN']);
    const meta = await (await blobStore(ctx, store)).getMetadata(checkKey(key));
    if (!meta) { process.stderr.write(`agent-broker: no blob ${store}/${key}\n`); return 3; }
    process.stdout.write(`${ctx.scrub(JSON.stringify({ etag: meta.etag, metadata: meta.metadata }))}\n`);
    return 0;
  },
};

// ---- Vercel ------------------------------------------------------------------------------------------------------

const vercelEnv = (ctx) => ({ VERCEL_TOKEN: ctx.secrets.VERCEL_TOKEN, VERCEL_ORG_ID: ctx.config.org_id, VERCEL_PROJECT_ID: ctx.config.project_id });

const vercel = {
  async deploy(name, args) {
    const { opts, positional } = parseArgs(args, { prod: 'bool' });
    if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
    const ctx = await context(name, 'vercel', ['VERCEL_TOKEN']);
    const work = await workCopy(name, ctx);
    if (!(await fs.stat(path.join(work, '.vercel', 'output')).catch(() => null))) fail('.vercel/output does not exist: run `vercel build` first (use `agent-broker vercel settings` for .vercel/project.json)');
    const cli = ['deploy', '--prebuilt', '--yes'];
    if (opts.prod) cli.push('--prod');
    return run('vercel', cli, { cwd: work, env: vercelEnv(ctx), scrub: ctx.scrub });
  },
  async settings(name) {
    const ctx = await context(name, 'vercel', ['VERCEL_TOKEN']);
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
  async deploys(name) {
    const ctx = await context(name, 'vercel', ['VERCEL_TOKEN']);
    const q = new URLSearchParams({ projectId: ctx.config.project_id, limit: '10', ...(ctx.config.org_id?.startsWith('team_') ? { teamId: ctx.config.org_id } : {}) });
    const res = await fetch(`https://api.vercel.com/v6/deployments?${q}`, { headers: { Authorization: `Bearer ${ctx.secrets.VERCEL_TOKEN}` } });
    if (!res.ok) fail(`Vercel API ${res.status}: ${ctx.scrub(await res.text()).slice(0, 500)}`);
    json((await res.json()).deployments.map((d) => ({ id: d.uid, state: d.state ?? d.readyState, target: d.target, created: new Date(d.created).toISOString(), url: d.url })));
    return 0;
  },
  async logs(name, [deployment, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    if (!/^[A-Za-z0-9._:/-]{1,300}$/.test(deployment ?? '')) fail('give a deployment URL or id');
    const ctx = await context(name, 'vercel', ['VERCEL_TOKEN']);
    return run('vercel', ['inspect', deployment, '--logs'], { cwd: await scratch(), env: vercelEnv(ctx), scrub: ctx.scrub });
  },
};

// ---- Supabase ----------------------------------------------------------------------------------------------------

const ROW_LIMIT = 2000;

const supabase = {
  async query(name, args) {
    if (args.length !== 1) fail('give the SQL as one argument: agent-broker supabase query <project> "select ..."');
    const ctx = await context(name, 'supabase', ['SUPABASE_READ_URL']);
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
  async migrate(name, args) {
    const { opts, positional } = parseArgs(args, { 'dry-run': 'bool', 'include-all': 'bool' });
    if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
    const ctx = await context(name, 'supabase', ['SUPABASE_ACCESS_TOKEN']);
    const work = await workCopy(name, ctx);
    const env = { SUPABASE_ACCESS_TOKEN: ctx.secrets.SUPABASE_ACCESS_TOKEN };
    const linked = await run('supabase', ['link', '--project-ref', ctx.config.project_ref, '--yes'], { cwd: work, env, scrub: ctx.scrub });
    if (linked) return linked;
    const cli = ['db', 'push', '--linked', '--yes'];
    if (opts['dry-run']) cli.push('--dry-run');
    if (opts['include-all']) cli.push('--include-all');
    return run('supabase', cli, { cwd: work, env, scrub: ctx.scrub });
  },
  async 'admin-query'(name, args) {
    if (args.length !== 1) fail('give the SQL as one argument: agent-broker supabase admin-query <project> "..."');
    await context(name, 'supabase', ['SUPABASE_ACCESS_TOKEN']);
    const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + randomUUID().slice(0, 6);
    await fs.writeFile(path.join(DIR.queue, `${id}.json`), JSON.stringify({ id, project: name, sql: args[0], created_at: new Date().toISOString(), status: 'pending' }, null, 2), { mode: 0o600 });
    process.stdout.write(`Waiting for approval: ${id}\nAsk the owner to run in their own Terminal:  agent-broker-admin approve ${id}\nThen read the result with:  agent-broker result ${id}\n`);
    return 0;
  },
};

// ---- Apify -------------------------------------------------------------------------------------------------------

const apifyRun = (ctx, args, cwd) => run('apify', args, { cwd, env: { APIFY_TOKEN: ctx.secrets.APIFY_TOKEN }, scrub: ctx.scrub });

const apify = {
  async push(name, args) {
    const { opts, positional } = parseArgs(args, { dir: 'string', force: 'bool', version: 'string', 'build-tag': 'string' });
    if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    const work = await workCopy(name, ctx);
    const dir = path.join(work, checkRelative(opts.dir ?? ctx.config.dir ?? '.', '--dir'));
    const cli = ['push'];
    if (opts.force) cli.push('--force');
    if (opts.version) cli.push('--version', checkId(opts.version, 'version'));
    if (opts['build-tag']) cli.push('--build-tag', checkId(opts['build-tag'], 'build tag'));
    return apifyRun(ctx, cli, dir);
  },
  async pull(name, [actor, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    const dir = await scratch();
    try {
      const out = path.join(dir, 'actor');
      const code = await run('apify', ['pull', checkActor(actor), '--dir', out], { cwd: dir, env: { APIFY_TOKEN: ctx.secrets.APIFY_TOKEN }, scrub: ctx.scrub, out: process.stderr });
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
  async info(name, [actor, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['actors', 'info', checkActor(actor), '--json'], await scratch());
  },
  async builds(name, [actor, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['builds', 'ls', checkActor(actor), '--json'], await scratch());
  },
  async 'build-log'(name, [build, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['builds', 'log', checkId(build, 'build id')], await scratch());
  },
  async runs(name, [actor, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['runs', 'ls', checkActor(actor), '--json'], await scratch());
  },
  async 'run-info'(name, [runId, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['runs', 'info', checkId(runId, 'run id'), '--json'], await scratch());
  },
  async logs(name, [runId, ...rest]) {
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    return apifyRun(ctx, ['runs', 'log', checkId(runId, 'run id')], await scratch());
  },
  async call(name, args) {
    const { opts, positional: [actor, ...rest] } = parseArgs(args, { 'input-file': 'string', input: 'string', build: 'string', memory: 'string', timeout: 'string' });
    if (rest.length) fail(`unexpected arguments: ${rest.join(' ')}`);
    const ctx = await context(name, 'apify', ['APIFY_TOKEN']);
    const dir = await scratch();
    const cli = ['call', checkActor(actor)];
    if (opts['input-file']) {
      if (!ctx.project.path) fail('--input-file needs the project folder (agent-broker-admin project --path)');
      const file = path.join(dir, 'input.json');
      const work = await workCopy(name, ctx);
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

const SERVICES = { netlify, vercel, supabase, apify };

// ---- Main --------------------------------------------------------------------------------------------------------

async function projectsList() {
  const out = [];
  for (const name of await listProjects()) {
    const p = await loadProject(name);
    out.push({ project: name, path: p.path ?? null, services: Object.keys(SERVICES).filter((s) => p[s]), keys: Object.keys(await loadSecrets(name)).sort(), note: p.note });
  }
  json(out);
  return 0;
}

async function result(id) {
  checkId(id, 'request id');
  const req = JSON.parse(await fs.readFile(path.join(DIR.queue, `${id}.json`), 'utf8').catch(() => fail(`no request ${id}`)));
  const values = await allSecretValues();
  process.stdout.write(`${makeScrubber(values)(JSON.stringify({ id, status: req.status, sql: req.sql, output: req.output }, null, 2))}\n`);
  return 0;
}

async function main(argv) {
  await mkdirs();
  process.chdir(DIR.tmp);
  const [service, action, project, ...rest] = argv;
  if (!service || service === 'help' || service === '--help') { process.stdout.write(`${HELP}\n`); return 0; }
  if (service === 'projects') return projectsList();
  if (service === 'result') return result(action);
  const actions = SERVICES[service] ?? fail(`unknown service: ${service} (netlify, vercel, supabase, apify)`);
  const fn = Object.hasOwn(actions, action ?? '') ? actions[action] : fail(`${service} has no action "${action ?? ''}". Allowed: ${Object.keys(actions).join(', ')}`);
  checkName(project);
  const code = await fn(project, rest);
  await audit({ service, action, project, code });
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
