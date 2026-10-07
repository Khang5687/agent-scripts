#!/opt/agent-broker/node/bin/node
// agent-broker-admin: owner-only management of the broker (projects, tokens, approvals). Runs as _deployer through
// `sudo -u _deployer` WITH the owner's password (wrapper /usr/local/bin/agent-broker-admin), so agents cannot use it.
// Token values arrive on stdin (the wrapper reads them hidden from the keyboard or from a .env file) and are never
// printed. Guide: agent-scripts/skills/agent-broker/SKILL.md
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  DIR, KEY, UsageError, allSecretValues, audit, checkName, checkRelative, fail, listProjects, loadProject, loadSecrets,
  makeScrubber, mkdirs, parseArgs, run, saveProject, saveSecrets,
} from './lib.mjs';

const HELP = `agent-broker-admin <command>   (asks for your Mac password every time)

  project <name> [--path DIR] [--note TEXT]               create or change a project
          [--netlify-site SITE_ID] [--netlify-dir web/dist]
          [--vercel-org ORG_ID --vercel-project PROJECT_ID]
          [--supabase-ref PROJECT_REF]
          [--apify] [--apify-dir DIR]
          [--remove-service netlify|vercel|supabase|apify]
  remove-project <name>                                   delete the project, its tokens and its work copy
  set <project> <KEY>                                     store one token (typed hidden)
  import <project> <env-file> <KEY>...                    move keys from a .env file into the broker
  unset <project> <KEY>                                   delete one token
  list [project]                                          configuration and key names (never values)
  pending | approve <id> | reject <id>                    Supabase admin queries waiting for you
  log [lines]                                             recent broker calls

Keys the actions use: NETLIFY_AUTH_TOKEN, VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN, SUPABASE_READ_URL (a read-only
database user), APIFY_TOKEN. Other keys are only stored.`;

const readStdin = async () => {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
};

async function project(name, args) {
  checkName(name);
  const { opts, positional } = parseArgs(args, {
    path: 'string', note: 'string', 'netlify-site': 'string', 'netlify-dir': 'string', 'vercel-org': 'string',
    'vercel-project': 'string', 'supabase-ref': 'string', apify: 'bool', 'apify-dir': 'string', 'remove-service': 'list',
  });
  if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
  const p = (await listProjects()).includes(name) ? await loadProject(name) : {};
  if (opts.path) {
    const dir = path.resolve(opts.path);
    if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) fail(`${dir} is not a folder _deployer can read`);
    await fs.readdir(dir).catch(() => fail(`_deployer cannot read ${dir}`));
    p.path = dir;
  }
  if (opts.note) p.note = opts.note;
  const id = (v, what) => (/^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : fail(`invalid ${what}: ${v}`));
  if (opts['netlify-site'] || opts['netlify-dir']) {
    p.netlify = { ...p.netlify };
    if (opts['netlify-site']) p.netlify.site_id = id(opts['netlify-site'], 'Netlify site id');
    if (opts['netlify-dir']) p.netlify.dir = checkRelative(opts['netlify-dir'], '--netlify-dir');
    if (!p.netlify.site_id) fail('--netlify-site is required for Netlify');
    p.netlify.dir ??= '.';
  }
  if (opts['vercel-org'] || opts['vercel-project']) {
    p.vercel = { ...p.vercel };
    if (opts['vercel-org']) p.vercel.org_id = id(opts['vercel-org'], 'Vercel org id');
    if (opts['vercel-project']) p.vercel.project_id = id(opts['vercel-project'], 'Vercel project id');
    if (!p.vercel.org_id || !p.vercel.project_id) fail('Vercel needs both --vercel-org and --vercel-project');
  }
  if (opts['supabase-ref']) p.supabase = { project_ref: id(opts['supabase-ref'], 'Supabase project ref') };
  if (opts.apify || opts['apify-dir']) {
    p.apify = { ...p.apify };
    if (opts['apify-dir']) p.apify.dir = checkRelative(opts['apify-dir'], '--apify-dir');
  }
  for (const s of opts['remove-service'] ?? []) delete p[s];
  await saveProject(name, p);
  await audit({ admin: 'project', project: name });
  return list(name);
}

async function list(name) {
  const names = name ? [checkName(name)] : await listProjects();
  for (const n of names) {
    const p = await loadProject(n);
    console.log(JSON.stringify({ project: n, ...p, keys: Object.keys(await loadSecrets(n)).sort() }, null, 2));
  }
  if (!names.length) console.log('no projects yet: agent-broker-admin project <name> --path DIR ...');
  return 0;
}

async function setKeys(name, entries, mode) {
  await loadProject(name);
  const secrets = await loadSecrets(name);
  for (const [k, v] of entries) {
    if (!KEY.test(k)) fail(`invalid key name: ${k}`);
    if (!v || /[\r\n\0]/.test(v)) fail(`${k}: the value is empty or has line breaks`);
    secrets[k] = v;
  }
  await saveSecrets(name, secrets);
  await audit({ admin: mode, project: name, keys: entries.map(([k]) => k) });
  console.log(`stored for ${name}: ${entries.map(([k]) => k).join(', ')} (values not shown)`);
  return 0;
}

async function queueItem(id) {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(id ?? '')) fail(`invalid request id: ${id}`);
  const file = path.join(DIR.queue, `${id}.json`);
  const req = JSON.parse(await fs.readFile(file, 'utf8').catch(() => fail(`no request ${id}`)));
  return { file, req };
}

async function approve(id) {
  const { file, req } = await queueItem(id);
  if (req.status !== 'pending') fail(`request ${id} is ${req.status}`);
  const p = await loadProject(req.project);
  const secrets = await loadSecrets(req.project);
  if (!p.supabase || !secrets.SUPABASE_ACCESS_TOKEN) fail(`project ${req.project} has no Supabase project ref or SUPABASE_ACCESS_TOKEN`);
  console.log(`Project: ${req.project} (Supabase ${p.supabase.project_ref})\nAsked at: ${req.created_at}\n\n${req.sql}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Run this SQL with full rights? Type "yes": ')).trim();
  rl.close();
  if (answer !== 'yes') return reject(id);
  const scrub = makeScrubber(await allSecretValues());
  let output = '';
  const sink = { write: (s) => { output += s; process.stdout.write(s); } };
  const code = await run('supabase', ['db', 'query', '--linked', '--project-ref', p.supabase.project_ref, '-o', 'json', req.sql],
    { cwd: DIR.tmp, env: { SUPABASE_ACCESS_TOKEN: secrets.SUPABASE_ACCESS_TOKEN }, scrub, out: sink });
  await fs.writeFile(file, JSON.stringify({ ...req, status: code ? 'failed' : 'done', approved_at: new Date().toISOString(), output: output.slice(0, 1 << 20) }, null, 2), { mode: 0o600 });
  await audit({ admin: 'approve', id, project: req.project, code });
  return code;
}

async function reject(id) {
  const { file, req } = await queueItem(id);
  await fs.writeFile(file, JSON.stringify({ ...req, status: 'rejected' }, null, 2), { mode: 0o600 });
  console.log(`rejected ${id}`);
  return 0;
}

async function pending() {
  const files = (await fs.readdir(DIR.queue)).filter((f) => f.endsWith('.json')).sort();
  let n = 0;
  for (const f of files) {
    const req = JSON.parse(await fs.readFile(path.join(DIR.queue, f), 'utf8'));
    if (req.status !== 'pending') continue;
    n++;
    console.log(`${req.id}  ${req.project}  ${req.created_at}\n  ${req.sql.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (!n) console.log('nothing waiting');
  return 0;
}

async function main([cmd, ...args]) {
  await mkdirs();
  process.chdir(DIR.tmp);
  switch (cmd) {
    case 'project': return project(args[0], args.slice(1));
    case 'remove-project': {
      const name = checkName(args[0]);
      await loadProject(name);
      for (const f of [path.join(DIR.projects, `${name}.json`), path.join(DIR.secrets, `${name}.env`), path.join(DIR.work, name)]) await fs.rm(f, { recursive: true, force: true });
      await audit({ admin: 'remove-project', project: name });
      console.log(`removed ${name}`);
      return 0;
    }
    case 'set': {
      const [name, key] = args;
      return setKeys(checkName(name), [[key, (await readStdin()).replace(/\r?\n$/, '')]], 'set');
    }
    case 'import': {
      const name = checkName(args[0]);
      const entries = (await readStdin()).split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]);
      if (!entries.length) fail('no KEY=VALUE lines on stdin');
      return setKeys(name, entries, 'import');
    }
    case 'unset': {
      const [name, key] = args;
      const secrets = await loadSecrets(checkName(name));
      if (!(key in secrets)) fail(`${name} has no ${key}`);
      delete secrets[key];
      await saveSecrets(name, secrets);
      await audit({ admin: 'unset', project: name, key });
      console.log(`deleted ${key} from ${name}`);
      return 0;
    }
    case 'list': return list(args[0]);
    case 'pending': return pending();
    case 'approve': return approve(args[0]);
    case 'reject': return reject(args[0]);
    case 'log': {
      const n = Math.min(Number.parseInt(args[0] ?? '30', 10) || 30, 1000);
      const text = await fs.readFile(path.join(DIR.log, 'broker.log'), 'utf8').catch(() => '');
      process.stdout.write(text.split('\n').filter(Boolean).slice(-n).join('\n') + '\n');
      return 0;
    }
    default:
      console.log(HELP);
      return cmd && cmd !== 'help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    console.error(`agent-broker-admin: ${e instanceof UsageError ? e.message : `internal error: ${e?.message ?? e}`}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
