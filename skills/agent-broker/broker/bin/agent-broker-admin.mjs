#!/opt/agent-broker/node/bin/node
// agent-broker-admin: owner-only management of the broker (account stacks, projects, tokens, approvals). Runs as
// _deployer through `sudo -u _deployer` WITH the owner's password / Touch ID (wrapper /usr/local/bin/agent-broker-admin),
// so agents cannot use it. Values arrive on stdin and are never printed. The wizard (scripts/wizard.sh) drives it:
// one `apply` per wizard action, so one approval each. Guide: agent-scripts/skills/agent-broker/SKILL.md
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { accountLabel, lookup, verifyPins } from './accounts.mjs';
import {
  ACCOUNT_KEYS, DIR, KEY, SERVICES, UsageError, allSecretValues, audit, checkName, checkRelative, fail, listProjects,
  listStacks, loadProject, loadSecrets, loadStack, loadStackSecrets, makeScrubber, mkdirs, parseArgs, projectSecrets,
  run, saveProject, saveSecrets, saveStack, saveStackSecrets,
} from './lib.mjs';

const HELP = `agent-broker-admin <command>   (asks for your Mac password / Touch ID every time)

Usually run by the wizard: ~/git/agent-scripts/skills/agent-broker/scripts/wizard.sh

  apply [options] < values        one change, checked before anything is saved; values on stdin as
                                  stack:KEY=VALUE or project:KEY=VALUE lines
     --stack NAME [--new-stack] [--stack-note T] [--stack-from-project P]   account stack (tokens: stack:KEY lines)
     --project NAME [--new-project] [--note T]                              project (uses --stack when given)
     --path DIR | --add-path DIR | --remove-path DIR                        its folders
     --netlify-site ID [--netlify-dir D] | --supabase-ref REF | --apify [--apify-dir D]
     --vercel-org ID --vercel-project ID | --remove-service SERVICE
  lookup <stack>                  who the stack's tokens belong to; their sites and databases
  set <project> <KEY> | set-stack <stack> <KEY>     store one value (typed hidden)
  import <project> <env-file> <KEY>...              move keys out of a .env file
  unset <project> <KEY> | unset-stack <stack> <KEY>
  list                            stacks and projects (key names, never values)
  remove-project <name> | remove-stack <name>
  pending | approve <id> | reject <id>               Supabase admin queries waiting for you
  log [lines]                     recent broker calls`;

const readStdin = async () => {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
};

/** stdin lines `stack:KEY=VALUE` / `project:KEY=VALUE` (a bare KEY=VALUE counts as project). */
function parseValues(text) {
  const out = { stack: {}, project: {} };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(?:(stack|project):)?([A-Z][A-Z0-9_]{0,62})=(.*)$/s);
    if (!m) fail('stdin lines must look like stack:KEY=VALUE or project:KEY=VALUE');
    if (!m[3] || /[\r\0]/.test(m[3])) fail(`${m[2]}: empty or invalid value`);
    out[m[1] ?? 'project'][m[2]] = m[3];
  }
  return out;
}

const exists = async (list, name) => (await list()).includes(name);
const id = (v, what) => (/^[A-Za-z0-9_-]{1,100}$/.test(v ?? '') ? v : fail(`invalid ${what}: ${v ?? '(missing)'}`));

async function realFolder(dir) {
  const real = await fs.realpath(path.resolve(dir)).catch(() => fail(`${dir} does not exist`));
  if (!(await fs.stat(real)).isDirectory()) fail(`${real} is not a folder`);
  await fs.readdir(real).catch(() => fail(`the broker user cannot read ${real}`));
  return real;
}

async function apply(args) {
  const { opts, positional } = parseArgs(args, {
    stack: 'string', 'new-stack': 'bool', 'stack-note': 'string', 'stack-from-project': 'string',
    project: 'string', 'new-project': 'bool', note: 'string', path: 'string', 'add-path': 'list', 'remove-path': 'list',
    'netlify-site': 'string', 'netlify-dir': 'string', 'supabase-ref': 'string', apify: 'bool', 'apify-dir': 'string',
    'vercel-org': 'string', 'vercel-project': 'string', 'remove-service': 'list',
  });
  if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
  const values = parseValues(await readStdin());
  // Tests only (dev root, never for _deployer): no calls to the services to check tokens and pins.
  const skipVerify = Boolean(process.env.AGENT_BROKER_DEV_ROOT) && process.env.AGENT_BROKER_SKIP_VERIFY === '1';
  const summary = [];

  // Stack: tokens (new values, or moved from a project that held them itself), account labels.
  let stack = null;
  let stackSecrets = {};
  const moveFrom = opts['stack-from-project'] && checkName(opts['stack-from-project']);
  if (opts.stack) {
    checkName(opts.stack, 'stack');
    const known = await exists(listStacks, opts.stack);
    if (opts['new-stack'] && known) fail(`stack ${opts.stack} already exists`);
    if (!opts['new-stack'] && !known) fail(`unknown stack ${opts.stack} (add --new-stack to create it)`);
    stack = known ? await loadStack(opts.stack) : { accounts: {} };
    stackSecrets = known ? await loadStackSecrets(opts.stack) : {};
    if (opts['stack-note']) stack.note = opts['stack-note'];
    if (moveFrom) {
      const from = await loadSecrets(moveFrom);
      for (const k of ACCOUNT_KEYS) if (from[k]) stackSecrets[k] = from[k];
    }
    for (const [k, v] of Object.entries(values.stack)) {
      if (!ACCOUNT_KEYS.includes(k)) fail(`${k} is not an account token (stack keys: ${ACCOUNT_KEYS.join(', ')}); give it as project:${k}=...`);
      stackSecrets[k] = v;
    }
    const changed = moveFrom ? ACCOUNT_KEYS : Object.keys(values.stack);
    const found = skipVerify ? {} : await lookup(Object.fromEntries(changed.filter((k) => stackSecrets[k]).map((k) => [k, stackSecrets[k]])));
    for (const [service, r] of Object.entries(found)) {
      if (r.error) fail(`${service} token: ${r.error}`);
      stack.accounts = { ...stack.accounts, [service]: r.account };
      summary.push(`stack ${opts.stack}: ${service} = ${accountLabel(r.account)}`);
    }
  } else if (Object.keys(values.stack).length) fail('stack:KEY values need --stack NAME');

  // Project: folders, stack, pinned site / database, own values.
  let project = null;
  let projectValues = null;
  if (opts.project) {
    checkName(opts.project);
    const known = await exists(listProjects, opts.project);
    if (opts['new-project'] && known) fail(`project ${opts.project} already exists`);
    if (!opts['new-project'] && !known) fail(`unknown project ${opts.project} (add --new-project to create it)`);
    project = known ? await loadProject(opts.project) : { paths: [] };
    if (opts.stack) project.stack = opts.stack;
    if (opts.note) project.note = opts.note;
    if (opts.path) project.paths = [await realFolder(opts.path)];
    for (const p of opts['add-path'] ?? []) { const r = await realFolder(p); if (!project.paths.includes(r)) project.paths.push(r); }
    for (const p of opts['remove-path'] ?? []) project.paths = project.paths.filter((x) => x !== path.resolve(p));
    if (!project.paths.length) fail(`project ${opts.project} needs a folder (--path DIR)`);
    if (opts['netlify-site'] || opts['netlify-dir']) {
      project.netlify = { ...project.netlify };
      if (opts['netlify-site']) project.netlify = { site_id: id(opts['netlify-site'], 'Netlify site id'), dir: project.netlify.dir };
      if (opts['netlify-dir']) project.netlify.dir = checkRelative(opts['netlify-dir'], '--netlify-dir');
      if (!project.netlify.site_id) fail('--netlify-site is required for Netlify');
      project.netlify.dir ??= '.';
    }
    if (opts['supabase-ref']) project.supabase = { project_ref: id(opts['supabase-ref'], 'Supabase project ref') };
    if (opts['vercel-org'] || opts['vercel-project']) {
      if (!opts['vercel-org'] || !opts['vercel-project']) fail('Vercel needs both --vercel-org and --vercel-project');
      project.vercel = { org_id: id(opts['vercel-org'], 'Vercel org id'), project_id: id(opts['vercel-project'], 'Vercel project id') };
    }
    if (opts.apify || opts['apify-dir']) project.apify = { dir: opts['apify-dir'] ? checkRelative(opts['apify-dir'], '--apify-dir') : project.apify?.dir ?? '.' };
    for (const s of opts['remove-service'] ?? []) { if (!SERVICES.includes(s)) fail(`unknown service ${s}`); delete project[s]; }
    if (project.stack && !(await exists(listStacks, project.stack)) && project.stack !== opts.stack) fail(`project uses unknown stack ${project.stack}`);

    projectValues = { ...(known ? await loadSecrets(opts.project) : {}), ...values.project };
    if (moveFrom === opts.project) for (const k of ACCOUNT_KEYS) delete projectValues[k];
    // Check the pins with the tokens the project will run with (stack, overridden by its own values).
    const stackTokens = project.stack === opts.stack ? stackSecrets : project.stack ? await loadStackSecrets(project.stack) : {};
    const tokens = { ...stackTokens, ...projectValues };
    if (!skipVerify) {
      const { names, unverified } = await verifyPins(project, tokens).catch((e) => fail(e.message));
      for (const [s, n] of Object.entries(names)) project[s] = { ...project[s], ...n };
      if (unverified.length) summary.push(`project ${opts.project}: ${unverified.join(', ')} not checked yet (no token): add it with the wizard`);
    }
    const pins = SERVICES.filter((s) => project[s]).map((s) => `${s} ${project[s].site_name ?? project[s].name ?? project[s].site_id ?? project[s].project_ref ?? ''}`.trim());
    summary.push(`project ${opts.project}: stack ${project.stack ?? '(none)'}; folders ${project.paths.join(', ')}; ${pins.join('; ') || 'no services'}`);
    if (Object.keys(values.project).length) summary.push(`project ${opts.project}: stored ${Object.keys(values.project).join(', ')}`);
  } else if (Object.keys(values.project).length) fail('project:KEY values need --project NAME');
  if (!stack && !project) fail('nothing to do: give --stack and/or --project');

  // Everything checked: save.
  if (stack) {
    await saveStack(opts.stack, stack);
    await saveStackSecrets(opts.stack, stackSecrets);
  }
  if (moveFrom && moveFrom !== opts.project) {
    const from = await loadSecrets(moveFrom);
    for (const k of ACCOUNT_KEYS) delete from[k];
    await saveSecrets(moveFrom, from);
    const p = await loadProject(moveFrom);
    p.stack = opts.stack;
    await saveProject(moveFrom, p);
    summary.push(`project ${moveFrom}: now uses stack ${opts.stack}`);
  }
  if (project) {
    await saveProject(opts.project, project);
    await saveSecrets(opts.project, projectValues);
  }
  await audit({ admin: 'apply', stack: opts.stack, project: opts.project, keys: [...Object.keys(values.stack), ...Object.keys(values.project)] });
  for (const line of summary) console.log(`✓ ${line}`);
  return 0;
}

async function lookupStack(name) {
  checkName(name, 'stack');
  await loadStack(name);
  const result = await lookup(await loadStackSecrets(name));
  process.stdout.write(`${makeScrubber(await allSecretValues())(JSON.stringify(result))}\n`);
  return 0;
}

async function list() {
  for (const name of await listStacks()) {
    const s = await loadStack(name);
    console.log(JSON.stringify({ stack: name, accounts: s.accounts, keys: Object.keys(await loadStackSecrets(name)).sort(), note: s.note }, null, 2));
  }
  for (const name of await listProjects()) {
    const p = await loadProject(name);
    console.log(JSON.stringify({ project: name, ...p, keys: Object.keys(await loadSecrets(name)).sort() }, null, 2));
  }
  return 0;
}

async function setValues(kind, name, entries) {
  const isStack = kind === 'stack';
  checkName(name, kind);
  isStack ? await loadStack(name) : await loadProject(name);
  const secrets = isStack ? await loadStackSecrets(name) : await loadSecrets(name);
  for (const [k, v] of entries) {
    if (!KEY.test(k)) fail(`invalid key name: ${k}`);
    if (isStack && !ACCOUNT_KEYS.includes(k)) fail(`${k} is not an account token (stack keys: ${ACCOUNT_KEYS.join(', ')})`);
    if (!v || /[\r\n\0]/.test(v)) fail(`${k}: the value is empty or has line breaks`);
    secrets[k] = v;
  }
  await (isStack ? saveStackSecrets : saveSecrets)(name, secrets);
  await audit({ admin: `set-${kind}`, [kind]: name, keys: entries.map(([k]) => k) });
  console.log(`stored for ${kind} ${name}: ${entries.map(([k]) => k).join(', ')} (values not shown)`);
  return 0;
}

async function unset(kind, name, key) {
  const isStack = kind === 'stack';
  const secrets = isStack ? await loadStackSecrets(checkName(name, kind)) : await loadSecrets(checkName(name));
  if (!(key in secrets)) fail(`${kind} ${name} has no ${key}`);
  delete secrets[key];
  await (isStack ? saveStackSecrets : saveSecrets)(name, secrets);
  await audit({ admin: `unset-${kind}`, [kind]: name, key });
  console.log(`deleted ${key} from ${kind} ${name}`);
  return 0;
}

async function queueItem(qid) {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(qid ?? '')) fail(`invalid request id: ${qid}`);
  const file = path.join(DIR.queue, `${qid}.json`);
  const req = JSON.parse(await fs.readFile(file, 'utf8').catch(() => fail(`no request ${qid}`)));
  return { file, req };
}

async function approve(qid) {
  const { file, req } = await queueItem(qid);
  if (req.status !== 'pending') fail(`request ${qid} is ${req.status}`);
  const p = await loadProject(req.project);
  const secrets = await projectSecrets(req.project, p);
  if (!p.supabase || !secrets.SUPABASE_ACCESS_TOKEN) fail(`project ${req.project} has no Supabase project or SUPABASE_ACCESS_TOKEN`);
  console.log(`Project: ${req.project} (Supabase ${p.supabase.name ?? ''} ${p.supabase.project_ref})\nAsked at: ${req.created_at}\n\n${req.sql}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Run this SQL with full rights? Type "yes": ')).trim();
  rl.close();
  if (answer !== 'yes') return reject(qid);
  const scrub = makeScrubber(await allSecretValues());
  let output = '';
  const sink = { write: (s) => { output += s; process.stdout.write(s); } };
  const code = await run('supabase', ['db', 'query', '--linked', '--project-ref', p.supabase.project_ref, '-o', 'json', req.sql],
    { cwd: DIR.tmp, env: { SUPABASE_ACCESS_TOKEN: secrets.SUPABASE_ACCESS_TOKEN }, scrub, out: sink });
  await fs.writeFile(file, JSON.stringify({ ...req, status: code ? 'failed' : 'done', approved_at: new Date().toISOString(), output: output.slice(0, 1 << 20) }, null, 2), { mode: 0o600 });
  await audit({ admin: 'approve', id: qid, project: req.project, code });
  return code;
}

async function reject(qid) {
  const { file, req } = await queueItem(qid);
  await fs.writeFile(file, JSON.stringify({ ...req, status: 'rejected' }, null, 2), { mode: 0o600 });
  console.log(`rejected ${qid}`);
  return 0;
}

async function pending() {
  let n = 0;
  for (const f of (await fs.readdir(DIR.queue)).filter((x) => x.endsWith('.json')).sort()) {
    const req = JSON.parse(await fs.readFile(path.join(DIR.queue, f), 'utf8'));
    if (req.status !== 'pending') continue;
    n++;
    console.log(`${req.id}  ${req.project}  ${req.created_at}\n  ${req.sql.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (!n) console.log('nothing waiting');
  return 0;
}

async function remove(kind, name) {
  if (kind === 'stack') {
    checkName(name, 'stack');
    await loadStack(name);
    for (const p of await listProjects()) if ((await loadProject(p)).stack === name) fail(`project ${p} still uses stack ${name}: move it first`);
    for (const f of [path.join(DIR.stacks, `${name}.json`), path.join(DIR.stackSecrets, `${name}.env`)]) await fs.rm(f, { force: true });
  } else {
    checkName(name);
    await loadProject(name);
    for (const f of [path.join(DIR.projects, `${name}.json`), path.join(DIR.secrets, `${name}.env`), path.join(DIR.work, name)]) await fs.rm(f, { recursive: true, force: true });
  }
  await audit({ admin: `remove-${kind}`, name });
  console.log(`removed ${kind} ${name}`);
  return 0;
}

const pairs = (text) => text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]);

async function main([cmd, ...args]) {
  await mkdirs();
  process.chdir(DIR.tmp);
  switch (cmd) {
    case 'apply': return apply(args);
    case 'lookup': return lookupStack(args[0]);
    case 'list': return list();
    case 'set': return setValues('project', args[0], [[args[1], (await readStdin()).replace(/\r?\n$/, '')]]);
    case 'set-stack': return setValues('stack', args[0], [[args[1], (await readStdin()).replace(/\r?\n$/, '')]]);
    case 'import': {
      const entries = pairs(await readStdin());
      if (!entries.length) fail('no KEY=VALUE lines on stdin');
      return setValues('project', args[0], entries);
    }
    case 'unset': return unset('project', args[0], args[1]);
    case 'unset-stack': return unset('stack', args[0], args[1]);
    case 'remove-project': return remove('project', args[0]);
    case 'remove-stack': return remove('stack', args[0]);
    case 'pending': return pending();
    case 'approve': return approve(args[0]);
    case 'reject': return reject(args[0]);
    case 'log': {
      const n = Math.min(Number.parseInt(args[0] ?? '30', 10) || 30, 1000);
      const text = await fs.readFile(path.join(DIR.log, 'broker.log'), 'utf8').catch(() => '');
      process.stdout.write(`${text.split('\n').filter(Boolean).slice(-n).join('\n')}\n`);
      return 0;
    }
    default:
      console.log(HELP);
      return cmd && cmd !== 'help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  async (e) => {
    const msg = e instanceof UsageError ? e.message : `internal error: ${e?.message ?? e}`;
    console.error(`agent-broker-admin: ${makeScrubber(await allSecretValues().catch(() => []))(msg)}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
