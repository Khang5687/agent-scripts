// Agent broker: shared paths, the registry (account stacks + projects), token files, output scrubbing, the project
// copy and folder -> project resolution.
// Runs as the _deployer user (sudo). Agents (the normal user) cannot read _deployer's home, where the tokens live.
// Guide: agent-scripts/skills/agent-broker/SKILL.md
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// AGENT_BROKER_DEV_ROOT: tests only. Everything lives under that folder and the CLIs come from PATH. sudo resets
// the environment, so the installed broker never sees it; it is refused when running as _deployer anyway.
const DEV = process.env.AGENT_BROKER_DEV_ROOT;
if (DEV && os.userInfo().username === '_deployer') throw new Error('AGENT_BROKER_DEV_ROOT is not allowed for _deployer');

export const ROOT = DEV ? path.join(DEV, 'opt') : '/opt/agent-broker';
export const HOME = DEV ? path.join(DEV, 'home') : '/Users/_deployer';
export const DIR = {
  stacks: path.join(HOME, 'stacks'), //               <stack>.json     one login per service (no secrets)
  stackSecrets: path.join(HOME, 'stack-secrets'), //  <stack>.env      account tokens, KEY=VALUE per line
  projects: path.join(HOME, 'projects'), //           <project>.json   folders, stack, pinned site/ref (no secrets)
  secrets: path.join(HOME, 'secrets'), //             <project>.env    per-project values (database URLs, ...)
  work: path.join(HOME, 'work'), //                   <project>/       copies of the project folders that CLIs run in
  queue: path.join(HOME, 'queue'), //                 <id>.json        admin queries waiting for approval
  log: path.join(HOME, 'log'), //                     broker.log       one line per call, no secret values
  tmp: path.join(HOME, 'tmp'),
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
    if (e.code === 'ENOENT') fail(`unknown ${what}: ${name} (list them with: agent-broker ${what === 'stack' ? 'stacks' : 'projects'})`);
    throw e;
  }
}

async function listNames(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/** A project: { stack?, paths: [realpath...], netlify?, vercel?, supabase?, apify?, note? }. */
export async function loadProject(name) {
  const p = await readJson(DIR.projects, name, 'project');
  if (p.path && !p.paths) { p.paths = [p.path]; delete p.path; } // registered before folders became a list
  p.paths ??= [];
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

/** The values a project runs with: its stack's account tokens, overridden by the project's own values. */
export async function projectSecrets(name, project) {
  return { ...(project.stack ? await loadStackSecrets(project.stack) : {}), ...(await loadSecrets(name)) };
}

/** Every stored value of every stack and project: the scrubber removes all of them, not only the caller's. */
export async function allSecretValues() {
  const values = [];
  for (const name of await listStacks()) values.push(...Object.values(await loadStackSecrets(name)));
  for (const name of await listProjects()) values.push(...Object.values(await loadSecrets(name)));
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
export async function resolveProject(cwd, explicit) {
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
    const all = [];
    for (const name of await listProjects()) all.push(`${name} -> ${(await loadProject(name)).paths.join(', ')}`);
    fail(`${dir} is not inside a registered project.\n  registered: ${all.join('; ') || 'none'}\n`
      + '  If this is a new project: ask the user which account stack it uses (agent-broker stacks), then run\n'
      + '  agent-broker init --stack <name> here. Otherwise cd into the project\'s folder.');
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
    owner = await resolveProject(folder);
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

async function writePrivate(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, file);
}

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

/** Returns text -> text that removes every known secret value and every token-shaped string. */
export function makeScrubber(values) {
  const exact = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 6))].sort((a, b) => b.length - a.length);
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

/**
 * Runs a CLI from the broker's own tool folder with a fixed environment (tool PATH, _deployer HOME, plus the given
 * variables). stdout/stderr are scrubbed; `out` replaces stdout as the destination (e.g. stderr when stdout carries
 * binary data). Arguments are passed as an array: no shell. Tokens go in `env`, never in arguments (macOS shows
 * every process's arguments to every user).
 */
export async function run(cmd, args, { cwd, env = {}, scrub, out = process.stdout }) {
  const child = spawn(cmd, args, {
    cwd,
    env: {
      PATH: TOOL_PATH,
      HOME,
      TMPDIR: DIR.tmp,
      LANG: 'en_US.UTF-8',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CI: '1', // no interactive prompts
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  await Promise.all([scrubStream(child.stdout, out, scrub), scrubStream(child.stderr, process.stderr, scrub)]);
  return done;
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
 *  - files are opened without following links;
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
