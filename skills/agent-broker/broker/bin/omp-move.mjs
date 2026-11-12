#!/usr/bin/env node
// omp-move: moves every literal provider apiKey out of OMP's models.yml into a broker group and leaves a key line behind.
// Run by the wrapper `agent-broker-admin omp-move` AS THE OWNER (only the owner may read the models file); the one admin
// call (sudo, one password) is passed after `--`. Values travel on that call's stdin only: never in arguments, never printed.
//
//   omp-move.mjs --exe DIR [--file models.yml] [--group omp] -- <admin command...>
//
// The file is read line by line, not parsed as YAML: it understands only what it can rewrite safely and stops (changing
// nothing) at anything else. Order, so a failure never loses a key: backup <file>.pre-broker (0600, refused when one exists),
// then the admin call (values + program grant), then the models file is replaced in one step (temp file, same mode, rename).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const GROUP = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,62}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

class Stop extends Error {
  constructor(line, message) {
    super(line ? `line ${line}: ${message}` : message);
  }
}

/** The value of a quoted or plain scalar on one line, or a Stop. `tail` is what follows it (spaces and a comment). */
function scalar(v, lineNo) {
  const first = v[0];
  if (first === '"' || first === "'") {
    let out = '';
    let i = 1;
    for (; i < v.length; i++) {
      const c = v[i];
      if (first === '"' && c === '\\') {
        const n = v[++i];
        if (n !== '"' && n !== '\\') throw new Stop(lineNo, 'the apiKey value has an escape sequence this command does not read');
        out += n;
      } else if (first === "'" && c === "'" && v[i + 1] === "'") {
        out += "'";
        i++;
      } else if (c === first) break;
      else out += c;
    }
    if (i >= v.length) throw new Stop(lineNo, 'the apiKey value is a quoted string that does not end on this line (multi-line value)');
    const tail = v.slice(i + 1);
    if (!/^(?:\s+#.*)?\s*$/.test(tail)) throw new Stop(lineNo, 'the apiKey value has text after its closing quote');
    return { value: out, tail };
  }
  const why = { '|': 'a block scalar', '>': 'a block scalar', '&': 'an anchor', '*': 'an alias', '[': 'a flow list', '{': 'a flow mapping', '?': 'a complex key', '%': 'a directive', '@': 'a reserved indicator', '`': 'a reserved indicator' }[first];
  if (why) throw new Stop(lineNo, `the apiKey value is ${why}`);
  const hash = v.search(/\s#/);
  const value = (hash === -1 ? v : v.slice(0, hash)).replace(/\s+$/, '');
  if (/:(\s|$)/.test(value)) throw new Stop(lineNo, 'the apiKey value contains ": " (not a plain one-line value)');
  if (/^(?:~|null|true|false)$/i.test(value)) throw new Stop(lineNo, `the apiKey value is ${value}, not a key`);
  return { value, tail: v.slice(value.length) };
}

const keyNameOf = (provider) => `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;

/**
 * What to move. Returns { moves: [{ line, provider, key, value, text }], skipped: [{ line, provider, why }] } where `text` is the
 * rewritten line (without its line end). Throws Stop for anything not understood.
 */
export function plan(source, group, program = '/usr/local/bin/agent-broker') {
  const lines = source.split('\n');
  const code = (i) => lines[i].replace(/\r$/, '');
  const blank = (s) => /^\s*(?:#.*)?$/.test(s);
  const moves = [];
  const skipped = [];
  const keys = new Map();
  let inProviders = false;
  let providerIndent = -1;
  let provider = null; // { name, indent: field indent or -1, seenKey }
  for (let i = 0; i < lines.length; i++) {
    const s = code(i);
    const n = i + 1;
    if (blank(s)) continue;
    const indent = s.length - s.trimStart().length;
    if (/^ *\t/.test(s) && /apiKey/.test(s)) throw new Stop(n, 'a tab in the indentation of an apiKey line');
    if (indent === 0 && !s.startsWith('-')) {
      inProviders = /^providers\s*:\s*(?:#.*)?$/.test(s);
      providerIndent = -1;
      provider = null;
      if (inProviders) continue;
    }
    const candidate = /(?:^|[\s{,[-])["']?apiKey["']?\s*:/.test(s);
    if (inProviders && indent > 0) {
      if (providerIndent === -1) providerIndent = indent;
      if (indent === providerIndent) {
        const m = /^ *(?:"([^"]+)"|'([^']+)'|([^\s"'#:-][^:]*?))\s*:(?:\s+(.*))?$/.exec(s);
        if (!m) {
          if (candidate) throw new Stop(n, 'an apiKey at a place this command does not understand');
          provider = null;
          continue;
        }
        const rest = (m[4] ?? '').replace(/(?:^|\s)#.*$/, '').trim();
        if (/^[&*]|^<</.test(rest) || /^<<\s*$/.test(m[1] ?? m[2] ?? m[3] ?? '')) throw new Stop(n, 'a provider with an anchor, alias or merge key');
        provider = { name: m[1] ?? m[2] ?? m[3], indent: -1, seen: false };
        if (candidate) throw new Stop(n, 'an apiKey at a place this command does not understand');
        continue;
      }
      if (provider && provider.indent === -1 && indent > providerIndent) provider.indent = indent;
      if (provider && indent === provider.indent) {
        if (/^ *<<\s*:/.test(s)) throw new Stop(n, 'a merge key (<<:) in a provider');
        const m = /^( *)apiKey:(\s.*)?$/.exec(s);
        if (m) {
          if (provider.seen) throw new Stop(n, `provider ${provider.name} has two apiKey lines`);
          provider.seen = true;
          const v = (m[2] ?? '').trim();
          if (v === '' || v.startsWith('#')) throw new Stop(n, 'the apiKey has no value on its line (a value on the next lines is not supported)');
          if (v.startsWith('!')) {
            skipped.push({ line: n, provider: provider.name, why: 'already a command (starts with !)' });
            continue;
          }
          const { value, tail } = scalar(m[2].replace(/^\s+/, ''), n);
          for (let j = i + 1; j < lines.length; j++) {
            const next = code(j);
            if (/^\s*$/.test(next)) continue;
            if (/^\s*#/.test(next) || next.length - next.trimStart().length <= indent) break;
            throw new Stop(n, 'the apiKey value continues on the next line (multi-line value)');
          }
          if (value.startsWith('!')) {
            skipped.push({ line: n, provider: provider.name, why: 'already a command (starts with !)' });
            continue;
          }
          if (ENV_NAME.test(value)) {
            skipped.push({ line: n, provider: provider.name, why: `an environment variable name (${value})` });
            continue;
          }
          if (value === '') {
            skipped.push({ line: n, provider: provider.name, why: 'empty' });
            continue;
          }
          if (/[\x00-\x1f\x7f]/.test(value)) throw new Stop(n, 'the apiKey value has a control character');
          const key = keyNameOf(provider.name);
          if (!KEY.test(key)) throw new Stop(n, `provider ${provider.name} does not give a valid key name (${key})`);
          if (keys.has(key)) throw new Stop(n, `providers ${keys.get(key).provider} (line ${keys.get(key).line}) and ${provider.name} both map to ${key}`);
          keys.set(key, { line: n, provider: provider.name });
          const lead = s.slice(0, indent);
          moves.push({ line: n, provider: provider.name, key, value, text: `${lead}apiKey: "!${program} key ${group} ${key}"${tail}` });
          continue;
        }
      }
    }
    if (candidate) throw new Stop(n, 'an apiKey at a place this command does not understand');
  }
  return { moves, skipped };
}

const fail = (message, code = 2) => {
  console.error(`agent-broker-admin omp-move: ${message}`);
  process.exit(code);
};

/** Runs the admin command with `input` on stdin; its own output goes to the terminal (key names only). */
function adminCall(cmd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (e) => {
      console.error(`agent-broker-admin omp-move: cannot run the admin command: ${e.message}`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function main(argv) {
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const admin = sep === -1 ? [] : argv.slice(sep + 1);
  const opt = { file: path.join(process.env.HOME ?? '', '.omp/agent/models.yml'), group: 'omp', names: [] };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const name = f.replace(/^--/, '');
    if (!['file', 'group', 'exe', 'name'].includes(name) || !f.startsWith('--')) fail(`unexpected argument: ${f}\nusage: agent-broker-admin omp-move --exe DIR --name omp [--file models.yml] [--group omp]`);
    const value = flags[++i] ?? fail(`--${name} needs a value`);
    if (name === 'name') opt.names.push(value);
    else opt[name] = value;
  }
  if (!opt.exe) fail('--exe DIR is required: the folder OMP runs from (the broker only hands keys to a program started from there)');
  if (!opt.names.length) fail('--name is required: the bare program name OMP runs under (check a running OMP: `tr \\0 " " < /proc/<pid>/cmdline`). Without it a key line that runs `omp ...` is refused.');
  if (!path.isAbsolute(opt.exe) || opt.exe.split('/').includes('..')) fail('--exe must be an absolute folder without ".."');
  if (!GROUP.test(opt.group)) fail(`invalid group name: ${opt.group}`);
  for (const n of opt.names) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)) fail(`--name must be a bare program name (no "/"): ${n}`);
  if (!admin.length) fail('no admin command given (run this through agent-broker-admin omp-move)');

  const file = await fs.realpath(opt.file).catch(() => fail(`no such file: ${opt.file}`));
  const buf = await fs.readFile(file);
  const source = buf.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(buf)) fail(`${file} is not valid UTF-8; nothing changed`);
  let result;
  try {
    result = plan(source, opt.group);
  } catch (e) {
    if (e instanceof Stop) fail(`${file}: ${e.message}. Nothing was changed.`);
    throw e;
  }
  const { moves, skipped } = result;
  const report = (head) => {
    console.log(head);
    for (const m of moves) console.log(`  ${m.provider} -> ${m.key} (line ${m.line})`);
    if (skipped.length) {
      console.log('left alone:');
      for (const s of skipped) console.log(`  ${s.provider} (line ${s.line}): ${s.why}`);
    }
  };
  if (!moves.length) {
    console.log(`nothing to move in ${file}: no provider has a literal apiKey.`);
    for (const s of skipped) console.log(`  ${s.provider} (line ${s.line}): ${s.why}`);
    return 0;
  }

  const backup = `${file}.pre-broker`;
  const mode = (await fs.stat(file)).mode & 0o7777;
  try {
    const fh = await fs.open(backup, 'wx', 0o600);
    await fh.chmod(0o600);
    await fh.writeFile(buf);
    await fh.close();
  } catch (e) {
    if (e.code === 'EEXIST') fail(`${backup} already exists; delete it (or move it away) first. Nothing was changed.`);
    fail(`cannot write the backup ${backup}: ${e.message}. Nothing was changed.`);
  }

  const keys = moves.map((m) => m.key);
  const args = ['apply', '--group', opt.group, '--ensure-group', '--omp-exe', opt.exe, ...opt.names.flatMap((n) => ['--omp-name', n]), ...keys.flatMap((k) => ['--add-grant-omp', k])];
  const code = await adminCall(admin, args, moves.map((m) => `group:${m.key}=${m.value}\n`).join(''));
  if (code !== 0) {
    await fs.rm(backup, { force: true });
    fail(`the admin call failed (exit ${code}). ${file} is unchanged and the backup is removed.`, code);
  }

  const lines = source.split('\n');
  for (const m of moves) lines[m.line - 1] = m.text + (lines[m.line - 1].endsWith('\r') ? '\r' : '');
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.omp-move-${process.pid}`);
  try {
    if (!(await fs.readFile(file)).equals(buf)) throw new Error(`${file} changed while this ran`);
    const fh = await fs.open(temp, 'wx', mode);
    await fh.chmod(mode);
    await fh.writeFile(lines.join('\n'));
    await fh.close();
    await fs.rename(temp, file);
  } catch (e) {
    await fs.rm(temp, { force: true });
    await fs.rm(backup, { force: true });
    fail(`the keys are stored in group ${opt.group}, but ${file} was not rewritten (${e.message}); it is unchanged and the backup is removed. Run the command again.`, 1);
  }

  report(`moved ${moves.length} provider key${moves.length === 1 ? '' : 's'} from ${file} into group ${opt.group} (program grant: ${opt.exe}${opt.names.length ? `, or named ${opt.names.join(', ')}` : ''}):`);
  console.log(`backup of the old file, holding the old keys (mode 0600): ${backup}`);
  console.log('Next, you:');
  console.log(`  1. Start a test agent on each moved provider (${[...new Set(moves.map((m) => m.provider))].join(', ')}); one short prompt each should answer.`);
  console.log(`  2. When they all answer, delete the backup: shred -u '${backup}'`);
  return 0;
}

if (process.argv[1]?.endsWith('omp-move.mjs')) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => fail(e.message, 1));
}
