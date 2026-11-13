// Agent broker: shared paths, the registry (account stacks + projects), token files, output scrubbing, the project
// copy and folder -> project resolution.
// Runs as the _deployer user (sudo). Agents (the normal user) cannot read _deployer's home, where the tokens live.
// Guide: agent-scripts/skills/agent-broker/SKILL.md
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// AGENT_BROKER_DEV_ROOT: tests only. Everything lives under that folder and the CLIs come from PATH. sudo resets
// the environment, so the installed broker never sees it; it is refused when running as _deployer anyway.
const DEV = process.env.AGENT_BROKER_DEV_ROOT;
if (DEV && os.userInfo().username === '_deployer') throw new Error('AGENT_BROKER_DEV_ROOT is not allowed for _deployer');

// Linux brokers (homelab servers) run the cloud CLIs under bubblewrap (bwrap), the macOS sandbox's counterpart (see run()).
export const LINUX = process.platform === 'linux';
export const ROOT = DEV ? path.join(DEV, 'opt') : '/opt/agent-broker';
export const HOME = DEV ? path.join(DEV, 'home') : LINUX ? '/home/_deployer' : '/Users/_deployer';
export const DIR = {
  stacks: path.join(HOME, 'stacks'), //               <stack>.json     one login per service (no secrets)
  stackSecrets: path.join(HOME, 'stack-secrets'), //  <stack>.env      account tokens, KEY=VALUE per line
  projects: path.join(HOME, 'projects'), //           <project>.json   folders, stack, pinned site/ref (no secrets)
  secrets: path.join(HOME, 'secrets'), //             <project>.env    per-project values (database URLs, ...)
  groups: path.join(HOME, 'groups'), //               <group>.json     who may get which key, and how (no secrets)
  groupSecrets: path.join(HOME, 'group-secrets'), //  <group>.env      values for services and programs, KEY=VALUE per line
  work: path.join(HOME, 'work'), //                   <project>/       copies of the project folders that CLIs run in
  queue: path.join(HOME, 'queue'), //                 <id>.json        admin queries waiting for approval
  log: path.join(HOME, 'log'), //                     broker.log       one line per call, no secret values
  tmp: path.join(HOME, 'tmp'),
  sync: path.join(HOME, 'sync'), //                   seq.json         last copy received from the sending machine, per stack and key
  ssh: path.join(HOME, '.ssh'), //                    authorized_keys  the one forced-command key of the sending machine
  outbox: path.join(HOME, 'sync-outbox'), //          <stack>.<KEY>.json   token copies the sending side has not delivered yet
};

/** Account tokens live in the stack; a project value of the same name overrides it (e.g. a project-scoped token). */
export const ACCOUNT_KEYS = ['NETLIFY_AUTH_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'APIFY_TOKEN', 'VERCEL_TOKEN'];
export const SERVICES = ['netlify', 'vercel', 'supabase', 'apify'];
export const CA_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'supabase-ca.pem');
const TOOL_PATH = DEV
  ? process.env.PATH
  : [`${ROOT}/node_modules/.bin`, `${ROOT}/node/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

export class UsageError extends Error {}
export const fail = (msg) => { throw new UsageError(msg); };

export const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const KEY = /^[A-Z][A-Z0-9_]{0,62}$/;
export const checkName = (name, what = 'project') => (NAME.test(name ?? '') ? name : fail(`invalid ${what} name: ${name ?? '(missing)'}`));

/** A path inside the project: relative, no "..", no absolute path. */
export function checkRelative(p, what) {
  const n = path.posix.normalize(String(p ?? ''));
  if (!p || path.isAbsolute(n) || n === '..' || n.startsWith('../') || n.includes('\0')) fail(`${what} must be a path inside the project: ${p}`);
  return n;
}

export async function mkdirs() {
  for (const d of Object.values(DIR)) await fs.mkdir(d, { recursive: true, mode: 0o700 });
}

// ---- Registry ----------------------------------------------------------------------------------------------------

async function readJson(dir, name, what) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, `${checkName(name, what)}.json`), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') fail(`unknown ${what}: ${name}${what === 'group' ? '' : ` (list them with: agent-broker ${what === 'stack' ? 'stacks' : 'projects'})`}`);
    throw e;
  }
}

async function listNames(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

// Fields older records carry that the broker no longer keeps: the built-files folder was copied once from
// netlify.toml and went stale (a static export deployed its old .next folder). The CLIs read the project's own config.
const DROPPED = { netlify: ['dir'], apify: ['dir'] };

/** A project: { stack?, paths: [realpath...], netlify?, vercel?, supabase?, apify?, note? }. */
export async function loadProject(name) {
  const p = await readJson(DIR.projects, name, 'project');
  if (p.path && !p.paths) { p.paths = [p.path]; delete p.path; } // registered before folders became a list
  p.paths ??= [];
  let stale = false;
  for (const [s, keys] of Object.entries(DROPPED)) {
    for (const k of keys) if (p[s] && k in p[s]) { delete p[s][k]; stale = true; }
  }
  if (stale) await saveProject(name, p);
  return p;
}
export const saveProject = (name, config) => writePrivate(path.join(DIR.projects, `${checkName(name)}.json`), `${JSON.stringify(config, null, 2)}\n`);
export const listProjects = () => listNames(DIR.projects);

/** A stack: { accounts: { netlify: { slug, email }, supabase: { orgs }, ... }, note? }. */
export const loadStack = (name) => readJson(DIR.stacks, name, 'stack');
export const saveStack = (name, config) => writePrivate(path.join(DIR.stacks, `${checkName(name, 'stack')}.json`), `${JSON.stringify(config, null, 2)}\n`);
export const listStacks = () => listNames(DIR.stacks);

/** Token file: KEY=VALUE per line, the value taken literally (no quotes, no expansion). */
async function readEnv(file) {
  const text = await fs.readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && KEY.test(line.slice(0, i))) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
async function writeEnv(file, secrets) {
  const body = Object.keys(secrets).sort().map((k) => `${k}=${secrets[k]}`).join('\n');
  await writePrivate(file, body ? `${body}\n` : '');
}
export const loadSecrets = (name) => readEnv(path.join(DIR.secrets, `${checkName(name)}.env`));
export const saveSecrets = (name, secrets) => writeEnv(path.join(DIR.secrets, `${checkName(name)}.env`), secrets);
export const loadStackSecrets = (name) => readEnv(path.join(DIR.stackSecrets, `${checkName(name, 'stack')}.env`));
export const saveStackSecrets = (name, secrets) => writeEnv(path.join(DIR.stackSecrets, `${checkName(name, 'stack')}.env`), secrets);

// ---- Groups ------------------------------------------------------------------------------------------------------

const UNIT = /^[A-Za-z0-9_.@-]{1,100}\.service$/;
const GRANT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const checkUnit = (unit) => (UNIT.test(unit ?? '') && !unit.includes('..') ? unit : fail(`invalid unit name: ${unit ?? '(missing)'} (expected something like demo.service)`));
export const checkGrantFile = (name) => (GRANT_FILE.test(name ?? '') && !name.includes('..') ? name : fail(`invalid file name in a grant: ${name ?? '(missing)'}`));
const checkKey = (k) => (KEY.test(k ?? '') ? k : fail(`invalid key name: ${k ?? '(missing)'}`));
const keyList = (list, what) => (Array.isArray(list) ? list.map(checkKey) : fail(`${what} must be a list of key names`));

/**
 * Checks and normalizes a group's grants. Three kinds:
 *   { unit, files?: { fileName: KEY }, env?: [KEY], optional?: [KEY] }   one systemd user unit
 *   { root: true, keys?: [KEY], write?: [KEY] }                           the owner's root-run setup scripts
 *   { omp: true, cgroup, exe, keys: [KEY] }                               OMP processes, found by cgroup and binary folder
 * Used on save and on load, so a hand-edited record cannot carry a malformed grant into the later steps.
 */
export function validateGrants(grants) {
  if (!Array.isArray(grants)) fail('grants must be a list');
  const seen = new Set();
  return grants.map((g) => {
    if (!g || typeof g !== 'object') fail('a grant must be an object');
    const kinds = ['unit', 'root', 'omp'].filter((k) => k in g);
    if (kinds.length !== 1) fail('a grant has exactly one of: unit, root, omp');
    const [kind] = kinds;
    const id = kind === 'unit' ? g.unit : kind;
    if (seen.has(id)) fail(`two grants for ${id}`);
    seen.add(id);
    if (kind === 'unit') {
      const files = Object.fromEntries(Object.entries(g.files ?? {}).map(([f, k]) => [checkGrantFile(f), checkKey(k)]));
      const env = keyList(g.env ?? [], 'env');
      const optional = keyList(g.optional ?? [], 'optional');
      const granted = new Set([...Object.values(files), ...env]);
      for (const k of optional) if (!granted.has(k)) fail(`${k} is optional but not granted to ${g.unit}`);
      if (!granted.size) fail(`the grant for ${g.unit} lists no key`);
      return { unit: checkUnit(g.unit), ...(Object.keys(files).length && { files }), ...(env.length && { env }), ...(optional.length && { optional }) };
    }
    if (kind === 'root') {
      if (g.root !== true) fail('root must be true');
      const keys = keyList(g.keys ?? [], 'keys');
      const write = keyList(g.write ?? [], 'write');
      if (!keys.length && !write.length) fail('the root grant lists no key');
      return { root: true, ...(keys.length && { keys }), ...(write.length && { write }) };
    }
    if (g.omp !== true) fail('omp must be true');
    if (!UNIT.test(g.cgroup ?? '')) fail(`invalid cgroup unit: ${g.cgroup ?? '(missing)'}`);
    if (typeof g.exe !== 'string' || !path.isAbsolute(g.exe) || g.exe.split('/').includes('..')) fail('the omp grant needs an absolute exe folder without ".."');
    const keys = keyList(g.keys ?? [], 'keys');
    if (!keys.length) fail('the omp grant lists no key');
    const names = g.names ?? [];
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n))) fail('omp program names must be bare names (letters, digits, . _ -, no "/")');
    return { omp: true, cgroup: g.cgroup, exe: g.exe, ...(names.length && { names: [...new Set(names)] }), keys };
  });
}

/** A group: { grants: [...] } (no secrets). */
export async function loadGroup(name) {
  const g = await readJson(DIR.groups, name, 'group');
  return { ...g, grants: validateGrants(g.grants ?? []) };
}
export const saveGroup = (name, config) => writePrivate(path.join(DIR.groups, `${checkName(name, 'group')}.json`), `${JSON.stringify({ ...config, grants: validateGrants(config.grants ?? []) }, null, 2)}\n`);
export const listGroups = () => listNames(DIR.groups);
export const loadGroupSecrets = (name) => readEnv(path.join(DIR.groupSecrets, `${checkName(name, 'group')}.env`));
export const saveGroupSecrets = (name, secrets) => writeEnv(path.join(DIR.groupSecrets, `${checkName(name, 'group')}.env`), secrets);

/** The effective stack for a project: its explicit stack, or 'global' if a global stack exists. */
export async function effectiveStack(project) {
  if (project.stack) return project.stack;
  if ((await listStacks()).includes('global')) return 'global';
  return null;
}

/** The values a project runs with: its stack's account tokens, overridden by the project's own values. */
export async function projectSecrets(name, project) {
  const stack = await effectiveStack(project);
  return { ...(stack ? await loadStackSecrets(stack) : {}), ...(await loadSecrets(name)) };
}

/** Every stored value of every stack, project and group: the scrubber removes all of them, not only the caller's. */
export async function allSecretValues() {
  const values = [];
  for (const name of await listStacks()) values.push(...Object.values(await loadStackSecrets(name)));
  for (const name of await listProjects()) values.push(...Object.values(await loadSecrets(name)));
  for (const name of await listGroups()) values.push(...Object.values(await loadGroupSecrets(name)));
  return values;
}

// ---- Folder -> project -------------------------------------------------------------------------------------------

const within = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** For a git worktree (its .git is a file pointing into <main>/.git/worktrees/<n>): { worktreeRoot, mainRoot }. */
async function worktreeOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const st = await fs.lstat(path.join(d, '.git')).catch(() => null);
    if (st?.isDirectory()) return null;
    if (st?.isFile()) {
      const text = await fs.readFile(path.join(d, '.git'), 'utf8').catch(() => '');
      const m = text.match(/^gitdir:\s*(.+?)\s*$/m);
      const main = m && path.resolve(d, m[1]).match(/^(.+)\/\.git\/worktrees\/[^/]+$/);
      return main ? { worktreeRoot: d, mainRoot: await fs.realpath(main[1]).catch(() => main[1]) } : null;
    }
    if (d === path.dirname(d)) return null;
  }
}

/** Projects whose registered folder holds `dir`, deepest folder first: [{ name, project, folder }]. */
async function matches(dir) {
  const found = [];
  for (const name of await listProjects()) {
    const project = await loadProject(name);
    for (const folder of project.paths) if (within(dir, folder)) found.push({ name, project, folder });
  }
  return found.sort((a, b) => b.folder.length - a.folder.length);
}

/**
 * The project for the folder an agent runs in. The deepest registered folder holding `cwd` wins; a git worktree
 * of a registered repository counts as that repository. `explicit` (--project) only picks between projects that
 * share the deepest folder. Returns { name, project, root }: root is the folder to copy (the worktree's own files
 * for a worktree).
 */
export async function stackFromAgentsMd(dir) {
  let curr = dir;
  for (let i = 0; i < 8; i++) {
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const p = path.join(curr, file);
      const text = await fs.readFile(p, 'utf8').catch(() => null);
      if (text) {
        const m = text.match(/(?:account stack|on account stack|uses account stack|stack)[:\s`]+([a-z0-9][a-z0-9_-]{0,62})/i);
        if (m) return m[1].toLowerCase();
      }
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

export async function resolveProject(cwd, explicit, explicitStack, opts = {}) {
  const dir = await fs.realpath(cwd).catch(() => cwd);
  let found = await matches(dir);
  let rootFor = (folder) => folder;
  if (!found.length) {
    const wt = await worktreeOf(dir);
    if (wt) {
      found = (await matches(path.join(wt.mainRoot, path.relative(wt.worktreeRoot, dir)))).filter((m) => within(m.folder, wt.mainRoot));
      rootFor = (folder) => path.join(wt.worktreeRoot, path.relative(wt.mainRoot, folder));
    }
  }
  if (!found.length) {
    if (opts.registeredOnly) {
      fail(`${dir} is not inside a registered project.`);
    }
    const available = await listStacks();
    const fromDoc = await stackFromAgentsMd(dir);
    const candidate = explicitStack ?? fromDoc ?? (available.includes('global') ? 'global' : null);
    if (candidate && available.includes(candidate)) {
      const git = (await gitRoot(dir)) ?? dir;
      const name = path.basename(git).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const project = { stack: candidate, paths: [git], adHoc: true };
      return { name, project, root: git };
    }
    const all = [];
    for (const name of await listProjects()) all.push(`${name} -> ${(await loadProject(name)).paths.join(', ')}`);
    fail(`${dir} is not inside a registered project and no valid account stack was found in AGENTS.md.\n`
      + `  available stacks: ${available.join(', ') || 'none (run wizard -> Add an account stack)'}\n`
      + `  registered projects: ${all.join('; ') || 'none'}\n`
      + '  Add this stack to the project\'s AGENTS.md (wizard: AGENTS.md text), or run: agent-broker init --stack <name>');
  }
  const deepest = found.filter((m) => m.folder.length === found[0].folder.length);
  let pick = deepest[0];
  if (deepest.length > 1) {
    pick = deepest.find((m) => m.name === explicit);
    if (!pick) {
      fail(`this folder holds ${deepest.length} projects: ${deepest.map((m) => m.name).join(', ')}.\n`
        + `  cd into one of their folders, or add ${deepest.map((m) => `--project ${m.name}`).join(' | ')}.`);
    }
  } else if (explicit && explicit !== pick.name) {
    fail(`--project ${explicit} does not match this folder: it belongs to project ${pick.name}. The folder decides the project; cd into ${explicit}'s folder instead.`);
  }
  return { name: pick.name, project: pick.project, root: rootFor(pick.folder) };
}

/** The git repository root holding `dir` (a .git folder or worktree file), or null. */
export async function gitRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (await fs.lstat(path.join(d, '.git')).catch(() => null)) return d;
    if (d === path.dirname(d)) return null;
  }
}

/**
 * Refuses a folder that already belongs to a project (itself, a parent, or as a git worktree of one) or that holds a
 * registered project folder: new projects only ever claim unclaimed folders.
 */
export async function assertUnclaimed(folder) {
  let owner = null;
  try {
    owner = await resolveProject(folder, undefined, undefined, { registeredOnly: true });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (!/is not inside a registered project/.test(e.message)) fail(`${folder} already belongs to projects: ${e.message}`);
  }
  if (owner) fail(`${folder} already belongs to project ${owner.name} (stack ${owner.project.stack ?? '-'}). See: agent-broker whoami`);
  for (const name of await listProjects()) {
    for (const p of (await loadProject(name)).paths) {
      if (within(p, folder)) fail(`${folder} holds project ${name} (${p}). Run init in a folder of its own, or ask the owner.`);
    }
  }
}

export async function writePrivate(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * What the sending machine last delivered, for stacks that follow it: { <stack>: { <KEY>: { seq, at } } }. A delete is
 * remembered like a value, so an old copy can never bring a deleted or rotated token back.
 */
export async function loadSyncState() {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR.sync, 'seq.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}
export const saveSyncState = (state) => writePrivate(path.join(DIR.sync, 'seq.json'), `${JSON.stringify(state, null, 2)}\n`);

export async function audit(entry) {
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
  await fs.appendFile(path.join(DIR.log, 'broker.log'), line, { mode: 0o600 }).catch(() => {});
}

// ---- Output scrubbing --------------------------------------------------------------------------------------------

// Token shapes removed even when the value is unknown to the broker (e.g. a key a CLI fetched from the service).
const PATTERNS = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^@\s/]+@/gi, '$1[secret]@'], // passwords in connection URLs
  [/\b(?:nfp|nfc|nfo)_[A-Za-z0-9]{20,}/g, '[secret]'], // Netlify
  [/\bsbp_[A-Za-z0-9]{20,}/g, '[secret]'], // Supabase personal token
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/g, '[secret]'], // Supabase secret key
  [/\bapify_api_[A-Za-z0-9]{20,}/g, '[secret]'], // Apify
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[secret]'], // GitHub
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[secret]'], // OpenAI-style keys (OpenRouter, ...)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[secret-jwt]'], // JWTs (Supabase keys, ...)
  [/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|token|basic)\s+)[^\s"']+/gi, '$1[secret]'],
];

/**
 * Returns text -> text that removes every known secret value and every token-shaped string. Each value is also matched
 * in the forms a CLI may print it in: JSON-escaped, Go's JSON (which also escapes < > & U+2028 U+2029, as
 * `compose config --format json` does) and YAML single-quoted.
 */
export function makeScrubber(values) {
  const forms = (v) => {
    const js = JSON.stringify(v).slice(1, -1);
    const go = js.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return [v, js, go, v.replaceAll("'", "''")];
  };
  const exact = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 6).flatMap(forms))].sort((a, b) => b.length - a.length);
  return (text) => {
    let t = text;
    for (const v of exact) if (t.includes(v)) t = t.split(v).join('[secret]');
    for (const [re, rep] of PATTERNS) t = t.replace(re, rep);
    return t;
  };
}

/**
 * Scrubs a byte stream into an output stream. Text is cut only at line ends, so a token is never split between two
 * scrubbed pieces; very long lines are cut with a 1 KB overlap kept back for the next piece.
 */
export function scrubStream(input, output, scrub) {
  return new Promise((resolve, reject) => {
    let pending = '';
    const LIMIT = 64 * 1024;
    const KEEP = 1024;
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      pending += chunk;
      const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
      if (cut >= 0) {
        output.write(scrub(pending.slice(0, cut + 1)));
        pending = pending.slice(cut + 1);
      } else if (pending.length > LIMIT) {
        output.write(scrub(pending.slice(0, -KEEP)));
        pending = pending.slice(-KEEP);
      }
    });
    input.on('end', () => {
      if (pending) output.write(scrub(pending));
      resolve();
    });
    input.on('error', reject);
  });
}

/** Throws when bytes contain a known secret value (used for binary output that cannot be scrubbed). */
export function assertNoSecret(buf, values, what) {
  for (const v of values) if (typeof v === 'string' && v.length >= 6 && buf.includes(Buffer.from(v))) fail(`${what} contains a stored secret value; refused`);
}

// ---- Running CLIs ------------------------------------------------------------------------------------------------

// The CLIs read the project's own config (netlify.toml publish / functions, .actor, supabase/config.toml), and the
// agents write it: a path there could point at the broker's token files and upload them. Every CLI runs in a sandbox
// (sandbox-exec on macOS, bwrap on Linux) that cannot read or write the broker's own folders, except its working folder
// and a private temp folder.
const PRIVATE = ['stackSecrets', 'secrets', 'groupSecrets', 'groups', 'stacks', 'projects', 'queue', 'log', 'work', 'tmp', 'sync', 'ssh', 'outbox'];

async function sandboxProfile(allowed) {
  const sub = (dirs) => dirs.map((d) => `(subpath ${JSON.stringify(d)})`).join(' ');
  const denied = await Promise.all(PRIVATE.map((k) => fs.realpath(DIR[k])));
  const ok = await Promise.all(allowed.map((d) => fs.realpath(d)));
  // Later rules win: the allowed folders are carved out of the denied ones. Metadata (stat) stays readable so tools
  // walking up for a .git or package.json see "not found" instead of an error.
  return `(version 1)(allow default)(deny file-read-data file-write* ${sub(denied)})(allow file-read-data file-write* ${sub(ok)})`;
}

// Linux: bwrap with the whole file tree visible and writable as the broker user, except the broker's own home (what
// the macOS profile hides, plus the whole home top level: on a Mac that is a user with no Docker socket, here `_deployer`
// is in the docker group, so every path it could write and later run from is hidden too). Order is the standard idiom:
// ONE `--tmpfs` over the home (nothing in it is listed, so a file created there later is hidden too; it is also the
// CLI's throwaway HOME), then each kept folder inside it is bound back from the host tree. A kept folder that holds a
// hidden one wins ("later rules win"). The container sockets are masked so a CLI cannot reach the Docker daemon (root).
const BWRAP = (DEV && process.env.AGENT_BROKER_DEV_BWRAP) || '/usr/bin/bwrap';
const bwrapStartArgs = ['--die-with-parent', '--new-session', '--unshare-all', '--share-net'];

/**
 * The bwrap argument list: `hidden` (real paths hidden whole: the broker home, plus any broker folder outside it), `keep`
 * (real paths that stay usable), `masks` (existing socket files replaced by /dev/null), the command last.
 */
export function bwrapArgs({ hidden, keep, masks = [], cmd, args = [] }) {
  const within = (p, dir) => p === dir || p.startsWith(`${dir}/`);
  const tmpfs = hidden.filter((h) => !keep.some((k) => within(h, k)));
  const back = [...new Set(keep)].filter((k) => tmpfs.some((h) => within(k, h)) && !keep.some((o) => o !== k && within(k, o)));
  return [
    ...bwrapStartArgs, '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    ...tmpfs.flatMap((h) => ['--tmpfs', h]),
    ...back.flatMap((k) => ['--bind', k, k]),
    ...masks.flatMap((m) => ['--ro-bind', '/dev/null', m]),
    '--', cmd, ...args,
  ];
}

// Container daemons' sockets (any is root on the host). A path counts once, and only when it exists: bwrap would have to create the rest.
const SOCKETS = ['/run/docker.sock', '/var/run/docker.sock', '/run/podman/podman.sock', '/run/containerd/containerd.sock'];
async function socketMasks() {
  const found = new Set();
  for (const s of SOCKETS) {
    const real = await fs.realpath(path.dirname(s)).then((d) => path.join(d, path.basename(s)), () => null);
    if (real && (await fs.lstat(real).catch(() => null))) found.add(real);
  }
  return [...found];
}

/**
 * Linux: before a cloud action loads any token, check that the sandbox starts. One line says what is wrong and the fix.
 * (Ubuntu blocks the unprivileged user namespace bwrap needs until the AppArmor file is installed: apparmor/bwrap.)
 */
let sandboxChecked = false;
export function sandboxReady() {
  if (!LINUX || sandboxChecked) return;
  const r = spawnSync(BWRAP, [...bwrapStartArgs, '--ro-bind', '/', '/', '--dev', '/dev', '--', '/usr/bin/true'], { encoding: 'utf8', timeout: 15000 });
  if (r.error?.code === 'ENOENT') fail(`the sandbox tool ${BWRAP} is missing: install it with  sudo apt install bubblewrap`);
  if (r.status === 0) {
    sandboxChecked = true;
    return;
  }
  const why = (r.error?.message ?? r.stderr ?? '').split('\n').find(Boolean) ?? `exit ${r.status}`;
  fail(`the sandbox cannot start (${why.replace(/^bwrap: /, '')}); the owner installs the AppArmor file once:  sudo install -m 644 ${ROOT}/apparmor/bwrap /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap`);
}

/**
 * Runs a CLI from the broker's own tool folder with a fixed environment (tool PATH, _deployer HOME, plus the given
 * variables), sandboxed away from the broker's folders except `cwd` and `allow`. stdout/stderr are scrubbed; `out`
 * replaces stdout as the destination (e.g. stderr when stdout carries binary data). Arguments are passed as an
 * array: no shell. Tokens go in `env`, never in arguments (macOS shows every process's arguments to every user).
 * `sandbox: false` only for docker compose: the Docker daemon runs as root and mounts whatever the compose file
 * names, so a sandbox around the client would not keep anything out.
 */
export async function run(cmd, args, { cwd, env = {}, scrub, outScrub = scrub, out = process.stdout, allow = [], sandbox = true, stdin = 'ignore' }) {
  if (sandbox && process.platform !== 'darwin' && !LINUX) fail(`${cmd} needs the macOS or Linux sandbox`);
  if (sandbox && LINUX) await sandboxReady();
  const tmp = path.join(DIR.tmp, randomUUID());
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    let bin = cmd;
    let argv = args;
    if (sandbox && LINUX) {
      const keep = await Promise.all([cwd, tmp, ...allow].map((d) => fs.realpath(d)));
      const home = await fs.realpath(HOME);
      const outside = (await Promise.all(Object.values(DIR).map((d) => fs.realpath(d).catch(() => null)))).filter((d) => d && d !== home && !d.startsWith(`${home}/`));
      [bin, argv] = [BWRAP, await bwrapArgs({ hidden: [home, ...new Set(outside)], keep, masks: await socketMasks(), cmd, args })];
    } else if (sandbox) [bin, argv] = ['/usr/bin/sandbox-exec', ['-p', await sandboxProfile([cwd, tmp, ...allow]), cmd, ...args]];
    const child = spawn(bin, argv, {
      cwd,
      env: {
        PATH: TOOL_PATH,
        HOME,
        TMPDIR: tmp,
        LANG: 'en_US.UTF-8',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CI: '1', // no interactive prompts
        ...env,
      },
      stdio: [stdin, 'pipe', 'pipe'],
    });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    await Promise.all([scrubStream(child.stdout, out, outScrub), scrubStream(child.stderr, process.stderr, scrub)]);
    return await done;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---- Project copy ------------------------------------------------------------------------------------------------

// Never copied: git data, local env files, local data and CLI state folders.
const SKIP_ANY = new Set(['.git', '.DS_Store']);
const SKIP_ROOT = new Set(['data', '.netlify']);
const isEnvFile = (name) => name === '.env' || name.startsWith('.env.');

/**
 * Copies the project folder into the broker's work folder (only changed files; removed files are deleted).
 * The project folder belongs to the agents, so nothing in it is trusted:
 *  - symlinks that point outside the project are skipped (a link to a token file must never be followed);
 *  - files and folders the broker user cannot read (the owner's private files) are skipped;
 *  - files are opened without following links, and the opened file must really live under the project (a folder swapped for a link in between is caught);
 *  - every changed file is checked for stored secret values, and the sync fails if one is found.
 * Returns { changed: count of copied files, skipped: links and unreadable entries left out }.
 */
export async function syncProject(src, dest, secretValues) {
  const root = await fs.realpath(src);
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const changed = [];
  const skipped = [];
  const seen = new Set();

  const unreadable = (e) => e?.code === 'EACCES' || e?.code === 'EPERM';

  async function walk(rel) {
    const from = path.join(root, rel);
    let entries;
    try {
      entries = await fs.readdir(from, { withFileTypes: true });
    } catch (e) {
      if (!unreadable(e)) throw e;
      skipped.push(`${rel}/`);
      return;
    }
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (SKIP_ANY.has(e.name) || isEnvFile(e.name) || (rel === '' && SKIP_ROOT.has(e.name))) continue;
      const s = path.join(root, r);
      const d = path.join(dest, r);
      const st = await fs.lstat(s);
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(s);
        const resolved = path.resolve(path.dirname(s), target);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          skipped.push(r);
          continue;
        }
        seen.add(r);
        const rel2 = path.relative(path.dirname(s), resolved) || '.';
        const cur = await fs.readlink(d).catch(() => null);
        if (cur !== rel2) {
          await fs.rm(d, { recursive: true, force: true });
          await fs.symlink(rel2, d);
        }
      } else if (st.isDirectory()) {
        seen.add(r);
        const dst = await fs.lstat(d).catch(() => null);
        if (dst && !dst.isDirectory()) await fs.rm(d, { recursive: true, force: true });
        await fs.mkdir(d, { recursive: true });
        await walk(r);
      } else if (st.isFile()) {
        seen.add(r);
        const dst = await fs.lstat(d).catch(() => null);
        if (dst?.isFile() && dst.size === st.size && Math.abs(dst.mtimeMs - st.mtimeMs) < 2) continue; // utimes keeps ~1 ms
        if (dst && !dst.isFile()) await fs.rm(d, { recursive: true, force: true });
        let fh;
        try {
          fh = await fs.open(s, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (e) {
          if (!unreadable(e)) throw e;
          seen.delete(r);
          skipped.push(r);
          continue;
        }
        try {
          const fst = await fh.stat();
          if (!fst.isFile()) { skipped.push(r); continue; }
          // A folder swapped for a link after the lstat above would lead here: the opened file must really live under the project.
          // Linux: /proc/self/fd names the opened file, and a file whose name cannot be read is left out (fail closed).
          // Other systems have no /proc: no check there (the sync key is not in the scrubber's list either).
          const real = await fs.realpath(`${(DEV && process.env.AGENT_BROKER_DEV_FD_DIR) || '/proc/self/fd'}/${fh.fd}`).catch(() => null);
          if (LINUX ? !real || (real !== root && !real.startsWith(root + path.sep)) : real && real !== root && !real.startsWith(root + path.sep)) { seen.delete(r); skipped.push(r); continue; }
          const body = await fh.readFile();
          assertNoSecret(body, secretValues, `project file ${r}`);
          await fs.writeFile(d, body, { mode: fst.mode & 0o755 });
          await fs.utimes(d, st.atimeMs / 1000, st.mtimeMs / 1000);
          changed.push(r);
        } finally {
          await fh.close();
        }
      }
    }
  }

  async function prune(rel) {
    const entries = await fs.readdir(path.join(dest, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (!seen.has(r)) await fs.rm(path.join(dest, r), { recursive: true, force: true });
      else if (e.isDirectory()) await prune(r);
    }
  }

  await walk('');
  await prune('');
  return { changed: changed.length, skipped };
}

// ---- Argument parsing --------------------------------------------------------------------------------------------

/**
 * Parses "--flag value" / "--flag" options against an allow-list: spec = { name: 'string' | 'bool' }.
 * Returns { opts, positional }. Unknown flags are refused.
 */
export function parseArgs(args, spec) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      const type = spec[name];
      if (!type) fail(`unknown option --${name} (allowed: ${Object.keys(spec).map((k) => `--${k}`).join(', ') || 'none'})`);
      if (type === 'bool') opts[name] = true;
      else {
        const v = inline ?? args[++i];
        if (v === undefined) fail(`--${name} needs a value`);
        if (type === 'list') (opts[name] ??= []).push(v);
        else opts[name] = v;
      }
    } else positional.push(a);
  }
  return { opts, positional };
}
