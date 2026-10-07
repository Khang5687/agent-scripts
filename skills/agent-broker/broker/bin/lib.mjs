// Agent broker: shared paths, project registry, token files, output scrubbing and the project copy.
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
  projects: path.join(HOME, 'projects'), // <project>.json   configuration (no secrets)
  secrets: path.join(HOME, 'secrets'), //   <project>.env    KEY=VALUE, one per line
  work: path.join(HOME, 'work'), //         <project>/       copies of the project folders that CLIs run in
  queue: path.join(HOME, 'queue'), //       <id>.json        admin queries waiting for approval
  log: path.join(HOME, 'log'), //           broker.log       one line per call, no secret values
  tmp: path.join(HOME, 'tmp'),
};
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

export async function loadProject(name) {
  checkName(name);
  try {
    return JSON.parse(await fs.readFile(path.join(DIR.projects, `${name}.json`), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') fail(`unknown project: ${name} (list them with: agent-broker projects)`);
    throw e;
  }
}

export async function saveProject(name, config) {
  await writePrivate(path.join(DIR.projects, `${checkName(name)}.json`), `${JSON.stringify(config, null, 2)}\n`);
}

export async function listProjects() {
  const files = await fs.readdir(DIR.projects).catch(() => []);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/** Token file: KEY=VALUE per line, the value taken literally (no quotes, no expansion). */
export async function loadSecrets(name) {
  const text = await fs.readFile(path.join(DIR.secrets, `${checkName(name)}.env`), 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && KEY.test(line.slice(0, i))) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export async function saveSecrets(name, secrets) {
  const body = Object.keys(secrets).sort().map((k) => `${k}=${secrets[k]}`).join('\n');
  await writePrivate(path.join(DIR.secrets, `${checkName(name)}.env`), body ? `${body}\n` : '');
}

/** Values of every project's tokens: the scrubber removes all of them from output, not only the current project's. */
export async function allSecretValues() {
  const values = [];
  for (const name of await listProjects()) values.push(...Object.values(await loadSecrets(name)));
  return values;
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
