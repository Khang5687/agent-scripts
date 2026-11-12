#!/opt/agent-broker/node/bin/node
// agent-broker-admin: owner-only management of the broker (account stacks, projects, tokens, approvals). Runs as
// _deployer through `sudo -u _deployer` WITH the owner's password / Touch ID (wrapper /usr/local/bin/agent-broker-admin),
// so agents cannot use it. Values arrive on stdin and are never printed. The wizard (scripts/wizard.sh) drives it:
// one `apply` per wizard action, so one approval each. Guide: agent-scripts/skills/agent-broker/SKILL.md
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { accountLabel, createNetlifySite, lookup, verifyPins } from './accounts.mjs';
import {
  ACCOUNT_KEYS, DIR, KEY, NAME, ROOT, SERVICES, UsageError, allSecretValues, audit, checkGrantFile, checkName, checkUnit, fail,
  listGroups, listProjects, listStacks, loadGroup, loadGroupSecrets, loadProject, loadSecrets, loadStack,
  loadStackSecrets, loadSyncState, makeScrubber, mkdirs, parseArgs, projectSecrets, run, saveGroup, saveGroupSecrets,
  saveProject, saveSecrets, saveStack, saveStackSecrets, saveSyncState, validateGrants, writePrivate,
} from './lib.mjs';

const HELP = `agent-broker-admin <command>   (asks for your password every time; Touch ID on a Mac)

On a Mac usually run by the wizard: ~/git/agent-scripts/skills/agent-broker/scripts/wizard.sh (on Linux: run it directly)

  apply [options] < values        one change, checked before anything is saved; values on stdin as
                                  stack:KEY=VALUE, project:KEY=VALUE or group:KEY=VALUE lines
     --stack NAME [--new-stack] [--stack-note T] [--stack-from-project P]   account stack (tokens: stack:KEY lines)
     --project NAME [--new-project] [--note T]                              project (uses --stack when given)
     --path DIR | --add-path DIR | --remove-path DIR                        its folders
     --netlify-site ID | --netlify-new NAME [--netlify-team T] | --supabase-ref REF | --apify
     --vercel-org ID --vercel-project ID | --remove-service SERVICE
     --group NAME [--new-group]     a group: secrets for a service or program (values: group:KEY=VALUE lines).
        A grant is replaced as a whole by the unit / root / omp it names:
        --grant-file UNIT:FILE=KEY  (UNIT is e.g. demo.service)   --grant-env UNIT:KEY   --optional KEY
        --grant-root KEY  --grant-root-write KEY                  --grant-omp KEY [--omp-exe DIR] [--omp-cgroup UNIT]
        --add-grant-omp KEY  (adds to the omp grant's keys instead of replacing them)   --remove-grant UNIT|root|omp
     --ensure-group                 like --new-group, but fine when the group already exists
  lookup <stack>                  who the stack's tokens belong to; their sites and databases
  set <project> <KEY> | set-stack <stack> <KEY> | set-group <group> <KEY>     store one value (typed hidden)
  import <project> <env-file> <KEY>...              move keys out of a .env file
  import-group <group>            KEY=VALUE lines on stdin, taken literally (used by: agent-broker-admin import-files)
  omp-move --exe DIR [--file F] [--group G]   move literal provider keys out of OMP's models.yml into group G (default omp);
                                  run as yourself: backs up to F.pre-broker, stores the keys, rewrites the lines, one password
  unset <project> <KEY> | unset-stack <stack> <KEY> | unset-group <group> <KEY>
  list                            stacks, projects and groups (key names and grants, never values)
  remove-project <name> | remove-stack <name> [--stop-following] | remove-group <name>
                                  a stack that follows the Mac is changed there; --stop-following drops it here only
  receive-from-mac                the Mac's one forced SSH command: one JSON line on stdin (stack, key, value, seq); not for typing
  trust-mac '<ssh-ed25519 key line>' --from <address>    let the Mac send tokens: writes the one restricted key line
                                  (this machine's SSH host keys are printed: pin them on the Mac)
  untrust-mac                     removes that key line
  pending | approve <id> | reject <id>               Supabase admin queries waiting for you
  log [lines]                     recent broker calls`;

const readStdin = async () => {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
};

/** stdin lines `stack:KEY=VALUE` / `project:KEY=VALUE` / `group:KEY=VALUE` (a bare KEY=VALUE counts as project). */
function parseValues(text) {
  const out = { stack: {}, project: {}, group: {} };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(?:(stack|project|group):)?([A-Z][A-Z0-9_]{0,62})=(.*)$/s);
    if (!m) fail('stdin lines must look like stack:KEY=VALUE, project:KEY=VALUE or group:KEY=VALUE');
    if (!m[3] || /[\r\0]/.test(m[3])) fail(`${m[2]}: empty or invalid value`);
    out[m[1] ?? 'project'][m[2]] = m[3];
  }
  return out;
}

/** `--grant-file UNIT:FILE=KEY` / `--grant-env UNIT:KEY` -> [unit, rest]. A unit name never holds ":" or "=". */
function splitUnit(spec, flag) {
  const i = spec.indexOf(':');
  if (i < 1) fail(`--${flag} expects UNIT:...`);
  return [checkUnit(spec.slice(0, i)), spec.slice(i + 1)];
}

/** One change to a group: its grants (each named grant replaced whole) and its values. Nothing is saved until all is checked. */
async function applyGroup(opts, values) {
  const name = checkName(opts.group, 'group');
  if (opts.stack || opts.project || Object.keys(values.stack).length || Object.keys(values.project).length) fail('--group cannot be combined with --stack, --project or their values');
  const known = await exists(listGroups, name);
  if (opts['new-group'] && opts['ensure-group']) fail('--new-group and --ensure-group cannot be combined');
  if (opts['new-group'] && known) fail(`group ${name} already exists`);
  if (!opts['new-group'] && !opts['ensure-group'] && !known) fail(`unknown group ${name} (add --new-group to create it)`);
  const group = known ? await loadGroup(name) : { grants: [] };
  const idOf = (g) => g.unit ?? (g.root ? 'root' : 'omp');
  const grants = new Map(group.grants.map((g) => [idOf(g), g]));
  const summary = [];

  for (const id of opts['remove-grant'] ?? []) {
    if (!grants.delete(id === 'root' || id === 'omp' ? id : checkUnit(id))) fail(`group ${name} has no grant for ${id}`);
    summary.push(`group ${name}: removed the grant for ${id}`);
  }

  const units = new Map();
  const unitGrant = (unit) => { if (!units.has(unit)) units.set(unit, { unit, files: {}, env: [] }); return units.get(unit); };
  for (const spec of opts['grant-file'] ?? []) {
    const [unit, rest] = splitUnit(spec, 'grant-file');
    const eq = rest.indexOf('=');
    if (eq < 1) fail('--grant-file expects UNIT:FILE=KEY');
    unitGrant(unit).files[checkGrantFile(rest.slice(0, eq))] = rest.slice(eq + 1);
  }
  for (const spec of opts['grant-env'] ?? []) {
    const [unit, key] = splitUnit(spec, 'grant-env');
    unitGrant(unit).env.push(key);
  }
  const optional = opts.optional ?? [];
  if (optional.length && !units.size) fail('--optional goes with --grant-file or --grant-env');
  const granted = new Set();
  for (const g of units.values()) {
    const keys = new Set([...Object.values(g.files), ...g.env]);
    for (const k of keys) granted.add(k);
    g.optional = optional.filter((k) => keys.has(k));
    grants.set(g.unit, g);
    summary.push(`group ${name}: grant for ${g.unit} (${[...keys].join(', ')})`);
  }
  for (const k of optional) if (!granted.has(k)) fail(`${k} is optional but not named in any --grant-file / --grant-env`);

  if (opts['grant-root'] || opts['grant-root-write']) {
    grants.set('root', { root: true, keys: opts['grant-root'] ?? [], write: opts['grant-root-write'] ?? [] });
    summary.push(`group ${name}: root grant`);
  }
  if (opts['grant-omp'] || opts['add-grant-omp'] || opts['omp-exe'] || opts['omp-cgroup']) {
    if (opts['grant-omp'] && opts['add-grant-omp']) fail('--grant-omp replaces the keys, --add-grant-omp adds to them: use one');
    const old = grants.get('omp');
    const exe = opts['omp-exe'] ?? old?.exe;
    if (!opts['grant-omp'] && !opts['add-grant-omp']) fail('--omp-exe and --omp-cgroup go with --grant-omp KEY or --add-grant-omp KEY');
    if (!exe) fail('--grant-omp needs --omp-exe DIR (the folder the OMP program runs from)');
    const keys = opts['grant-omp'] ?? [...new Set([...(old?.keys ?? []), ...opts['add-grant-omp']])];
    grants.set('omp', { omp: true, cgroup: opts['omp-cgroup'] ?? old?.cgroup ?? 'paseo.service', exe, keys });
    summary.push(`group ${name}: omp grant`);
  }

  const next = validateGrants([...grants.values()]);
  const secrets = { ...(known ? await loadGroupSecrets(name) : {}), ...values.group };
  await saveGroup(name, { ...group, grants: next });
  await saveGroupSecrets(name, secrets);
  if (Object.keys(values.group).length) summary.push(`group ${name}: stored ${Object.keys(values.group).join(', ')}`);
  if (!summary.length) summary.push(`group ${name}: ${known ? 'unchanged' : 'created'}`);
  await audit({ admin: 'apply', group: name, keys: Object.keys(values.group), grants: next.map(idOf) });
  for (const line of summary) console.log(`✓ ${line}`);
  return 0;
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
    'netlify-site': 'string', 'netlify-new': 'string', 'netlify-team': 'string',
    'supabase-ref': 'string', apify: 'bool',
    'vercel-org': 'string', 'vercel-project': 'string', 'remove-service': 'list',
    group: 'string', 'new-group': 'bool', 'grant-file': 'list', 'grant-env': 'list', optional: 'list',
    'grant-root': 'list', 'grant-root-write': 'list', 'grant-omp': 'list', 'omp-exe': 'string', 'omp-cgroup': 'string',
    'remove-grant': 'list', 'ensure-group': 'bool', 'add-grant-omp': 'list',
  });
  if (positional.length) fail(`unexpected arguments: ${positional.join(' ')}`);
  const values = parseValues(await readStdin());
  if (opts.group) return applyGroup(opts, values);
  if (Object.keys(values.group).length) fail('group:KEY values need --group NAME');
  for (const f of ['new-group', 'ensure-group', 'grant-file', 'grant-env', 'optional', 'grant-root', 'grant-root-write', 'grant-omp', 'add-grant-omp', 'omp-exe', 'omp-cgroup', 'remove-grant']) {
    if (opts[f]) fail(`--${f} needs --group NAME`);
  }
  // Tests only (dev root, never for _deployer): no calls to the services to check tokens and pins.
  const skipVerify = Boolean(process.env.AGENT_BROKER_DEV_ROOT) && process.env.AGENT_BROKER_SKIP_VERIFY === '1';
  const summary = [];

  // Stack: tokens (new values, or moved from a project that held them itself), account labels.
  let stack = null;
  let stackSecrets = {};
  const moveFrom = opts['stack-from-project'] && checkName(opts['stack-from-project']);
  if (opts.stack) {
    checkName(opts.stack, 'stack');
    if (values.stack && (Object.keys(values.stack).length || moveFrom)) await assertLocalStack(opts.stack);
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
    if (opts.stack) {
      if (known && project.stack && project.stack !== opts.stack) {
        for (const s of SERVICES) {
          if (project[s] && !opts[`${s}-site`] && !opts[`${s}-new`] && !opts[`${s}-ref`] && !opts[`${s}-project`]) {
            delete project[s];
          }
        }
      }
      project.stack = opts.stack;
    }
    if (opts.note) project.note = opts.note;
    if (opts.path) project.paths = [await realFolder(opts.path)];
    for (const p of opts['add-path'] ?? []) { const r = await realFolder(p); if (!project.paths.includes(r)) project.paths.push(r); }
    for (const p of opts['remove-path'] ?? []) project.paths = project.paths.filter((x) => x !== path.resolve(p));
    if (!project.paths.length) fail(`project ${opts.project} needs a folder (--path DIR)`);
    projectValues = { ...(known ? await loadSecrets(opts.project) : {}), ...values.project };
    if (moveFrom === opts.project) for (const k of ACCOUNT_KEYS) delete projectValues[k];
    // The tokens the project will run with (stack, overridden by its own values): create the site, check the pins.
    const stackTokens = project.stack === opts.stack ? stackSecrets : project.stack ? await loadStackSecrets(project.stack) : {};
    const tokens = { ...stackTokens, ...projectValues };
    if (opts['netlify-new']) {
      const stackName = project.stack ?? opts.stack;
      if (!stackName) fail('cannot create Netlify site without a stack');
      const stackObj = await loadStack(stackName);
      const team = opts['netlify-team'] ?? stackObj.accounts?.netlify?.teams?.[0]
        ?? (await lookup({ NETLIFY_AUTH_TOKEN: tokens.NETLIFY_AUTH_TOKEN })).netlify?.account?.teams?.[0];
      if (!team) fail(`could not find a Netlify team for stack ${stackName}; give --netlify-team`);
      const site = await createNetlifySite(tokens.NETLIFY_AUTH_TOKEN, team, opts['netlify-new']).catch((e) => fail(`creating the Netlify site: ${e.message}`));
      project.netlify = { site_id: site.id, site_name: site.name, site_url: site.url };
      summary.push(`created Netlify site ${site.name} (${site.url}) in team ${team}`);
    } else if (opts['netlify-site']) {
      project.netlify = { site_id: id(opts['netlify-site'], 'Netlify site id') };
    }
    if (opts['supabase-ref']) project.supabase = { project_ref: id(opts['supabase-ref'], 'Supabase project ref') };
    if (opts['vercel-org'] || opts['vercel-project']) {
      if (!opts['vercel-org'] || !opts['vercel-project']) fail('Vercel needs both --vercel-org and --vercel-project');
      project.vercel = { org_id: id(opts['vercel-org'], 'Vercel org id'), project_id: id(opts['vercel-project'], 'Vercel project id') };
    }
    if (opts.apify) project.apify ??= {};
    for (const s of opts['remove-service'] ?? []) { if (!SERVICES.includes(s)) fail(`unknown service ${s}`); delete project[s]; }
    if (project.stack && !(await exists(listStacks, project.stack)) && project.stack !== opts.stack) fail(`project uses unknown stack ${project.stack}`);
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
    console.log(JSON.stringify({ stack: name, accounts: s.accounts, keys: Object.keys(await loadStackSecrets(name)).sort(), note: s.note, followsMac: s.followsMac }, null, 2));
  }
  for (const name of await listProjects()) {
    const p = await loadProject(name);
    console.log(JSON.stringify({ project: name, ...p, keys: Object.keys(await loadSecrets(name)).sort() }, null, 2));
  }
  for (const name of await listGroups()) {
    const g = await loadGroup(name);
    console.log(JSON.stringify({ group: name, ...g, keys: Object.keys(await loadGroupSecrets(name)).sort() }, null, 2));
  }
  return 0;
}

const KINDS = {
  project: { load: loadProject, loadSecrets, saveSecrets },
  stack: { load: loadStack, loadSecrets: loadStackSecrets, saveSecrets: saveStackSecrets },
  group: { load: loadGroup, loadSecrets: loadGroupSecrets, saveSecrets: saveGroupSecrets },
};

async function setValues(kind, name, entries) {
  const k = KINDS[kind];
  checkName(name, kind);
  if (kind === 'stack') await assertLocalStack(name);
  await k.load(name);
  const secrets = await k.loadSecrets(name);
  for (const [key, v] of entries) {
    if (!KEY.test(key)) fail(`invalid key name: ${key}`);
    if (kind === 'stack' && !ACCOUNT_KEYS.includes(key)) fail(`${key} is not an account token (stack keys: ${ACCOUNT_KEYS.join(', ')})`);
    if (!v || /[\r\n\0]/.test(v)) fail(`${key}: the value is empty or has line breaks`);
    secrets[key] = v;
  }
  await k.saveSecrets(name, secrets);
  await audit({ admin: `set-${kind}`, [kind]: name, keys: entries.map(([key]) => key) });
  console.log(`stored for ${kind} ${name}: ${entries.map(([key]) => key).join(', ')} (values not shown)`);
  return 0;
}

async function unset(kind, name, key) {
  const k = KINDS[kind];
  if (kind === 'stack') await assertLocalStack(name);
  const secrets = await k.loadSecrets(checkName(name, kind));
  if (!(key in secrets)) fail(`${kind} ${name} has no ${key}`);
  delete secrets[key];
  await k.saveSecrets(name, secrets);
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

async function remove(kind, name, stopFollowing = false) {
  if (kind === 'group') {
    checkName(name, 'group');
    await loadGroup(name);
    for (const f of [path.join(DIR.groups, `${name}.json`), path.join(DIR.groupSecrets, `${name}.env`)]) await fs.rm(f, { force: true });
  } else if (kind === 'stack') {
    checkName(name, 'stack');
    if ((await loadStack(name)).followsMac && !stopFollowing) fail('this stack follows the Mac; change it there (to drop it on this machine only: remove-stack NAME --stop-following)');
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

/**
 * A .env value as Docker Compose reads it: surrounding quotes removed ("..." also unescapes \" and \\), an unquoted
 * value loses a trailing ` # comment`. The broker hands values to Compose through the environment, where nothing is
 * expanded, so a `$` that Compose would have expanded is refused: store that value with `set` as Compose used it.
 */
function envValue(key, raw) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  const double = v.length >= 2 && v.startsWith('"') && v.endsWith('"');
  const out = double ? v.slice(1, -1).replace(/\\(["\\])/g, '$1') : v.replace(/\s+#.*$/, '');
  if (out.replaceAll('$$', '').includes('$')) fail(`${key}: the value has a $ that Compose expands; store it with: agent-broker-admin set <project> ${key}`);
  return out.replaceAll('$$', '$');
}

// ---- Copy from the sending machine (a Mac) -------------------------------------------------------------------------

/** A refusal with a code the sender can act on. Exit 2 = refused for good, 3 = stale (already applied or replaced), 4 = busy (retry). */
class Refused extends UsageError {
  constructor(code, message, exit = 2) {
    super(`refused (${code}): ${message}`);
    this.exit = exit;
  }
}

/** Stacks that follow the Mac are changed there only: one source of truth. */
async function assertLocalStack(name) {
  const s = await loadStack(checkName(name, 'stack')).catch(() => null);
  if (s?.followsMac) fail('this stack follows the Mac; change it there');
}

const SYNC_LINE_MAX = 64 * 1024;

/** stdin must hold exactly one line (a final newline is fine), at most SYNC_LINE_MAX bytes. */
async function readMessageLine() {
  if (process.stdin.isTTY) throw new Refused('bad-message', 'no message on stdin');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > SYNC_LINE_MAX + 1) throw new Refused('too-large', `the message is longer than ${SYNC_LINE_MAX} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!line) throw new Refused('bad-message', 'the message is empty');
  if (/[\r\n]/.test(line)) throw new Refused('bad-message', 'the message must be one line');
  return line;
}

const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Account labels as the stack record holds them (name, email, teams, orgs per service); anything else is dropped. */
function cleanAccounts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const service of SERVICES) {
    const a = raw[service];
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const label = {};
    for (const f of ['name', 'email']) if (text(a[f], 200)) label[f] = a[f];
    for (const f of ['teams', 'orgs']) if (Array.isArray(a[f]) && a[f].length <= 50 && a[f].every((t) => text(t, 100))) label[f] = a[f];
    if (Object.keys(label).length) out[service] = label;
  }
  return out;
}

function parseMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    throw new Refused('bad-message', 'the message is not JSON');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Refused('bad-message', 'the message must be a JSON object');
  for (const f of Object.keys(msg)) if (!['v', 'stack', 'key', 'value', 'seq', 'accounts'].includes(f)) throw new Refused('bad-message', `unknown field ${JSON.stringify(f.slice(0, 40))}`);
  if (msg.v !== 1) throw new Refused('bad-version', 'v must be 1');
  if (typeof msg.stack !== 'string' || !NAME.test(msg.stack)) throw new Refused('bad-stack', 'invalid stack name');
  if (!ACCOUNT_KEYS.includes(msg.key)) throw new Refused('bad-key', `only account tokens are accepted (${ACCOUNT_KEYS.join(', ')})`);
  if (!Number.isSafeInteger(msg.seq) || msg.seq < 1) throw new Refused('bad-seq', 'seq must be a positive integer');
  if (msg.value !== null && (typeof msg.value !== 'string' || !msg.value || /[\r\n\0]/.test(msg.value))) {
    throw new Refused('bad-value', 'value must be null (delete) or a non-empty text without line breaks');
  }
  return msg;
}

/** One copy at a time: a lock folder (stale after 30 s). */
async function withSyncLock(fn) {
  const lock = path.join(DIR.sync, 'lock');
  for (let tries = 0; ; tries++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const born = (await fs.stat(lock).catch(() => null))?.mtimeMs ?? Date.now();
      if (Date.now() - born > 30000) await fs.rmdir(lock).catch(() => {});
      else if (tries > 100) throw new Refused('busy', 'another copy is being stored; try again', 4);
      else await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

async function storeCopy(msg) {
  const known = await exists(listStacks, msg.stack);
  const stack = known ? await loadStack(msg.stack) : { accounts: {} };
  if (known && !stack.followsMac) throw new Refused('local-stack', 'this stack was made here; it does not follow the Mac');
  const state = await loadSyncState();
  const last = state[msg.stack]?.[msg.key]?.seq ?? 0;
  if (msg.seq <= last) throw new Refused('stale-seq', `seq ${msg.seq} is not higher than ${last} for ${msg.key} in stack ${msg.stack}`, 3);
  const secrets = known ? await loadStackSecrets(msg.stack) : {};
  if (msg.value === null) delete secrets[msg.key];
  else secrets[msg.key] = msg.value;
  // Value first, the remembered seq last: a crash in between lets the sender's retry land instead of being called stale.
  await saveStack(msg.stack, { ...stack, followsMac: true, accounts: { ...stack.accounts, ...cleanAccounts(msg.accounts) } });
  await saveStackSecrets(msg.stack, secrets);
  await saveSyncState({ ...state, [msg.stack]: { ...state[msg.stack], [msg.key]: { seq: msg.seq, at: new Date().toISOString() } } });
  return msg.value === null ? `deleted ${msg.key} from stack ${msg.stack} (seq ${msg.seq})` : `stored ${msg.key} in stack ${msg.stack} (seq ${msg.seq})`;
}

/**
 * The forced command of the Mac's SSH key. Everything it trusts is one JSON line on stdin; SSH_ORIGINAL_COMMAND and any
 * other argument are ignored. Prints one line without the value; the audit line has stack, key, seq and the result.
 */
async function receiveFromMac() {
  const seen = {};
  try {
    const msg = parseMessage(await readMessageLine());
    Object.assign(seen, { stack: msg.stack, key: msg.key, seq: msg.seq });
    const line = await withSyncLock(() => storeCopy(msg));
    await audit({ admin: 'receive-from-mac', ...seen, result: line.split(' ')[0] });
    console.log(line);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) await audit({ admin: 'receive-from-mac', ...seen, result: e.message });
    throw e;
  }
}

const TRUST_MARK = '# agent-broker:trust-mac';
const SSH_KEY = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}( [A-Za-z0-9@._+ -]{1,100})?$/;
const authorizedKeys = () => path.join(DIR.ssh, 'authorized_keys');

async function readKeyLines() {
  const raw = await fs.readFile(authorizedKeys(), 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
  return raw.split('\n').filter(Boolean);
}

async function writeKeyLines(lines) {
  await fs.mkdir(DIR.ssh, { recursive: true, mode: 0o700 });
  await fs.chmod(DIR.ssh, 0o700);
  await writePrivate(authorizedKeys(), lines.length ? `${lines.join('\n')}\n` : '');
}

/** This machine's SSH host public keys (type and key only), to pin on the sending side: it must never trust on first use. */
async function hostKeys() {
  const dir = process.env.AGENT_BROKER_DEV_ROOT ? path.join(process.env.AGENT_BROKER_DEV_ROOT, 'etc-ssh') : '/etc/ssh';
  const out = [];
  for (const f of (await fs.readdir(dir).catch(() => [])).filter((n) => /^ssh_host_.*_key\.pub$/.test(n)).sort()) {
    const [type, key] = (await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')).trim().split(/\s+/);
    if (type && key) out.push(`${type} ${key}`);
  }
  return { dir, out };
}

async function trustMac(args) {
  const { opts, positional } = parseArgs(args, { from: 'string' });
  const key = positional.join(' ');
  if (/[\r\n]/.test(key)) fail('give one key line (no line breaks)');
  if (!SSH_KEY.test(key)) fail("the key must be one plain ssh-ed25519 public key line: ssh-ed25519 AAAA... [comment] (no options, no other key type)");
  const from = opts.from ?? fail('--from <address> is required: the sending machine\'s address (IPv4 or IPv6)');
  if (!/^[0-9A-Fa-f:.]+$/.test(from) || !isIP(from)) fail(`--from must be a plain IPv4 or IPv6 address: ${from.slice(0, 60)}`);
  const command = `${path.join(ROOT, 'bin', 'agent-broker-admin.mjs')} receive-from-mac`;
  if (!/^[\w./ -]+$/.test(command)) fail('the installed admin path has characters that cannot go in an authorized_keys command');
  const ours = `restrict,from="${from}",command="${command}" ${key} ${TRUST_MARK}`;
  const lines = await readKeyLines();
  const others = lines.filter((l) => !l.endsWith(TRUST_MARK));
  for (const l of others) if (!l.startsWith('#')) console.error(`warning: ${authorizedKeys()} has a key line agent-broker did not write (left alone; it may let someone in): ${l.slice(0, 50)}...`);
  await writeKeyLines([...others, ours]);
  const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(key.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '')}`;
  await audit({ admin: 'trust-mac', from, fingerprint });
  console.log(`trusted ${fingerprint} from ${from}; it may run only: ${command}`);
  const { dir, out } = await hostKeys();
  if (!out.length) console.log(`no SSH host keys found in ${dir}: is sshd installed here? Pin the host key on the sending machine once it is.`);
  for (const k of out) console.log(`host key (pin it on the sending machine, never trust on first use): ${k}`);
  return 0;
}

async function untrustMac() {
  const lines = await readKeyLines();
  const kept = lines.filter((l) => !l.endsWith(TRUST_MARK));
  if (kept.length === lines.length) {
    console.log('no trust-mac key line to remove');
    return 0;
  }
  await writeKeyLines(kept);
  await audit({ admin: 'untrust-mac' });
  console.log('removed the trust-mac key line');
  return 0;
}

async function main([cmd, ...args]) {
  await mkdirs();
  process.chdir(DIR.tmp);
  switch (cmd) {
    case 'apply': return apply(args);
    case 'lookup': return lookupStack(args[0]);
    case 'list': return list();
    case 'set': return setValues('project', args[0], [[args[1], (await readStdin()).replace(/\r?\n$/, '')]]);
    case 'set-stack': return setValues('stack', args[0], [[args[1], (await readStdin()).replace(/\r?\n$/, '')]]);
    case 'receive-from-mac': return receiveFromMac();
    case 'trust-mac': return trustMac(args);
    case 'untrust-mac': return untrustMac();
    case 'import': {
      const entries = pairs(await readStdin()).map(([k, v]) => [k, envValue(k, v)]);
      if (!entries.length) fail('no KEY=VALUE lines on stdin');
      return setValues('project', args[0], entries);
    }
    case 'unset': return unset('project', args[0], args[1]);
    case 'unset-stack': return unset('stack', args[0], args[1]);
    case 'remove-project': return remove('project', args[0]);
    case 'set-group': return setValues('group', args[0], [[args[1], (await readStdin()).replace(/\r?\n$/, '')]]);
    case 'import-group': {
      const entries = pairs(await readStdin());
      if (!entries.length) fail('no KEY=VALUE lines on stdin');
      return setValues('group', args[0], entries);
    }
    case 'unset-group': return unset('group', args[0], args[1]);
    case 'remove-group': return remove('group', args[0]);
    case 'remove-stack': {
      const flags = args.slice(1);
      if (flags.some((f) => f !== '--stop-following')) fail(`unknown option ${flags.find((f) => f !== '--stop-following')}`);
      return remove('stack', args[0], flags.length > 0);
    }
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
    process.exitCode = e instanceof Refused ? e.exit : e instanceof UsageError ? 2 : 1;
  },
);
