// What `agent-broker compose` refuses before it lets Docker start or change containers. The compose file belongs to the
// agents and the Docker daemon runs as root, so a bind mount of the broker's own folder would hand over every stored
// value. The check reads the RESOLVED config (`docker compose config --format json`: includes, extends, profiles and .env
// already applied). It checks, per service: bind mounts and the other keys that make the client read or write a host path
// (env_file, label_file, build context / dockerfile / ssh / local cache, secret and config files), device and
// root-equivalent settings, and the compose file list itself (`-f`, `COMPOSE_FILE`). A guard for the usual routes, not a
// wall: see "What this does not stop" in SKILL.md (a file or symlink changed after the check, a socket under another name,
// the project name, and the Docker group of the owner's own user).
import fs from 'node:fs/promises';
import path from 'node:path';

const SOCKET = /(^|\/)(docker|podman|containerd|crio)\.sock$/;

/** realpath of the longest part that exists, plus the rest (a missing bind source is created by Docker, as root). */
async function realOf(p) {
  const rest = [];
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    try {
      return path.join(await fs.realpath(d), ...rest.reverse());
    } catch {
      if (d === path.dirname(d)) return path.resolve(p);
      rest.push(path.basename(d));
    }
  }
}

/** Why a host path must not reach a container, or null. `home` is the broker's home folder. */
async function hostPathProblem(p, home, cwd) {
  const given = path.resolve(cwd, p);
  const homes = [...new Set([path.resolve(home), await realOf(home)])];
  for (const c of [given, await realOf(given)]) {
    if (SOCKET.test(c)) return 'the Docker socket';
    for (const h of homes) {
      if (c === h || c.startsWith(`${h}/`)) return 'the broker home or a folder inside it';
      if (c === '/' || h.startsWith(`${c}/`)) return 'a folder that holds the broker home';
    }
  }
  return null;
}

const volumeSource = (v) => (typeof v === 'string' ? (/^[/.~]/.test(v.split(':')[0]) ? v.split(':')[0] : null) : v?.type === 'bind' ? v.source ?? null : null);

/**
 * The reasons to refuse a resolved config (the parsed `config --format json` output); [] when it is clean.
 * `otherValues`: stored values that are not this project's own: one in the config means a file of broker values got in.
 */
export async function configProblems(config, { home, cwd, otherValues = [] }) {
  const out = [];
  const bad = async (where, p) => {
    const why = typeof p === 'string' && p ? await hostPathProblem(p, home, cwd) : null;
    if (why) out.push(`${where}: ${p} is ${why}`);
  };
  for (const [name, svc] of Object.entries(config?.services ?? {})) {
    const at = `service "${name}"`;
    for (const v of svc.volumes ?? []) await bad(at, volumeSource(v));
    if (svc.privileged === true) out.push(`${at}: privileged: true`);
    if (svc.pid === 'host') out.push(`${at}: pid: host`);
    if (svc.network_mode === 'host') out.push(`${at}: network_mode: host`);
    if (svc.userns_mode === 'host') out.push(`${at}: userns_mode: host`);
    if ((svc.cap_add ?? []).length) out.push(`${at}: cap_add ${svc.cap_add.join(',')}`);
    for (const s of svc.security_opt ?? []) if (!/^no-new-privileges([:=]true)?$/.test(String(s))) out.push(`${at}: security_opt ${s} (only no-new-privileges is offered)`);
    for (const d of svc.devices ?? []) out.push(`${at}: host device ${typeof d === 'string' ? d.split(':')[0] : d?.source ?? '?'}`);
    for (const key of ['network_mode', 'pid', 'ipc']) if (String(svc[key] ?? '').startsWith('container:')) out.push(`${at}: ${key} ${svc[key]} (joins a container outside this check)`);
    if ((svc.device_cgroup_rules ?? []).length) out.push(`${at}: device_cgroup_rules (lets the container make device nodes)`);
    // Keys that make the client (running as the broker user) read or write a host path. The resolved shapes: env_file is
    // a string, a list of strings, or a list of {path}; label_file a string or list; build.ssh a list of "id=path"
    // strings or {id, path}; cache_from/cache_to strings like "type=local,src=/x,dest=/y".
    for (const f of [svc.env_file].flat().filter(Boolean)) await bad(`${at} env_file`, typeof f === 'string' ? f : f?.path);
    for (const f of [svc.label_file].flat().filter(Boolean)) await bad(`${at} label_file`, f);
    const ctx = svc.build?.context ?? (typeof svc.build === 'string' ? svc.build : null);
    const ctxIsPath = typeof ctx === 'string' && !/^[a-z][a-z0-9+.-]*:|^git@/i.test(ctx);
    if (ctx && path.isAbsolute(ctx)) await bad(`${at} build context`, ctx);
    const dockerfile = svc.build?.dockerfile;
    if (typeof dockerfile === 'string') await bad(`${at} build dockerfile`, path.isAbsolute(dockerfile) ? dockerfile : ctxIsPath ? path.resolve(cwd, ctx, dockerfile) : null);
    for (const c of Object.values(svc.build?.additional_contexts ?? {})) if (typeof c === 'string' && path.isAbsolute(c)) await bad(`${at} build context`, c);
    const ssh = svc.build?.ssh ?? [];
    for (const s of Array.isArray(ssh) ? ssh : Object.entries(ssh).map(([id, p]) => `${id}=${p}`)) await bad(`${at} build ssh`, typeof s === 'string' ? s.split('=').slice(1).join('=') : s?.path);
    for (const key of ['cache_from', 'cache_to']) {
      for (const entry of svc.build?.[key] ?? []) {
        // buildx reads an entry as CSV and lowercases the keys: drop quotes and compare keys without case.
        const parts = String(entry).replaceAll('"', '').split(',').map((p) => p.trim());
        if (!parts.some((p) => /^type=local$/i.test(p))) continue;
        for (const part of parts) {
          const m = /^(?:src|dest)=(.*)$/i.exec(part);
          if (m) await bad(`${at} build ${key}`, m[1]);
        }
      }
    }
  }
  for (const [name, vol] of Object.entries(config?.volumes ?? {})) {
    const o = vol?.driver_opts ?? {};
    const isBind = String(o.o ?? '').split(',').some((x) => x === 'bind' || x === 'rbind');
    if (typeof o.device === 'string' && isBind) await bad(`volume "${name}"`, o.device);
    else if (o.device !== undefined) out.push(`volume "${name}": driver_opts device ${o.device} (only a bind that passes the folder checks is offered)`);
  }
  for (const kind of ['secrets', 'configs']) {
    for (const [name, item] of Object.entries(config?.[kind] ?? {})) await bad(`${kind.slice(0, -1)} "${name}"`, item?.file);
  }
  const text = JSON.stringify(config ?? {});
  if (otherValues.some((v) => typeof v === 'string' && v.length >= 6 && (text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1))))) {
    out.push('the config holds a stored value that is not this project\'s (an env_file or a path to broker files)');
  }
  return [...new Set(out)];
}

/**
 * `agent-broker compose` is an ALLOW list: a command and a flag run only when this table names them. Compose has more
 * client-side options that read or write host files as the broker user (`run --env-from-file`, `cp`, `export -o`,
 * `build --ssh`) than anyone can list, so what is not named is refused. Flags are read the way pflag reads them:
 * `--flag=value`, `--flag value`, `-f value`, `-f=value`, `-fvalue`, and bundled short flags (`-Tv x` is `-T -v x`).
 * `check`: the command can start or change containers, so the resolved config is checked first.
 * `stop`: run and exec end their flags at the first word (the rest is the container's own command). This leans on Compose
 *   turning interspersed flags off for those two commands (true in v5.3.1); recheck it when Compose is upgraded.
 * `no`: a flag that is refused with its own reason.
 * Never named, on purpose: --env-from-file, --env-file, --privileged, --cap-add, --ssh, --builder, -o/--output, -p,
 * --project-directory (the folder decides the project), and anything that writes a host file (cp, export, -o).
 */
const list = (...names) => Object.fromEntries(names.map((n) => [n, 'bool']));
const take = (...names) => Object.fromEntries(names.map((n) => [n, 'value']));
const VOLUMES = 'removes volumes, which can hold live data: run it yourself, not through the broker';
export const COMPOSE_COMMANDS = {
  up: { check: true, flags: { ...list('-d', '--detach', '--build', '--no-build', '--remove-orphans', '--no-deps', '--force-recreate', '--no-recreate', '--wait', '--quiet-pull', '--no-start', '--no-color', '--no-log-prefix', '--abort-on-container-exit', '--attach-dependencies', '--timestamps'), ...take('--pull', '-t', '--timeout', '--wait-timeout', '--scale', '--attach', '--no-attach', '--exit-code-from') }, no: { '-V': 'renews anonymous volumes (live data)', '--renew-anon-volumes': 'renews anonymous volumes (live data)' } },
  down: { flags: { ...list('--remove-orphans'), ...take('-t', '--timeout') }, no: { '-v': VOLUMES, '--volumes': VOLUMES, '--rmi': 'removes images: run it yourself' } },
  ps: { flags: { ...list('-a', '--all', '-q', '--quiet', '--services', '--no-trunc'), ...take('--format', '--filter', '--status') } },
  logs: { flags: { ...list('-f', '--follow', '-t', '--timestamps', '--no-color', '--no-log-prefix'), ...take('--tail', '-n', '--since', '--until', '--index') } },
  exec: { stop: true, flags: { ...list('-d', '--detach', '-T', '--no-TTY'), ...take('-e', '--env', '-w', '--workdir', '-u', '--user', '--index') } },
  run: { check: true, stop: true, flags: { ...list('-d', '--detach', '--rm', '-T', '--no-TTY', '--no-deps', '--service-ports', '--build', '--quiet-pull', '--remove-orphans'), ...take('-e', '--env', '-w', '--workdir', '-u', '--user', '--name', '--pull', '--entrypoint', '-v', '--volume') } },
  pull: { flags: { ...list('-q', '--quiet', '--include-deps', '--ignore-pull-failures', '--ignore-buildable') } },
  restart: { check: true, flags: { ...list('--no-deps'), ...take('-t', '--timeout') } },
  stop: { flags: take('-t', '--timeout') },
  start: { check: true, flags: {} },
  rm: { flags: list('-f', '--force', '-s', '--stop'), no: { '-v': VOLUMES, '--volumes': VOLUMES } },
  config: { flags: { ...list('-q', '--quiet', '--services', '--volumes', '--profiles', '--images', '--no-interpolate'), ...take('--format') } },
  build: { check: true, flags: { ...list('--no-cache', '--pull', '-q', '--quiet', '--with-dependencies'), ...take('--build-arg') } },
  images: { flags: { ...list('-q', '--quiet'), ...take('--format') } },
  top: { flags: {} },
  port: { flags: take('--protocol', '--index') },
  version: { flags: { ...list('--short'), ...take('-f', '--format') } },
};
export const COMPOSE_COMMAND_NAMES = Object.keys(COMPOSE_COMMANDS);
export const needsCheck = (command) => Object.hasOwn(COMPOSE_COMMANDS, command) && COMPOSE_COMMANDS[command].check === true;

/**
 * Only `exec` gets the caller's stdin (it starts no container and is not checked). Every command that can start one runs
 * with stdin ignored, in the check and in the real call alike, so a compose file "from stdin" (`-`, however it got into
 * the file list) is empty both times. This, not the `.env` reading below, is what keeps the two reads the same.
 */
export const takesStdin = (command) => command === 'exec';

/** Set in the environment of the check and of the real call (an OS value wins over `.env`): no compose file fetched from git or a registry. */
export const COMPOSE_ENV = { COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false', COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false' };

/** Why one compose file entry (`-f` value, or one `COMPOSE_FILE` entry) is refused, or null: it must be a file inside the project. */
export function fileEntryProblem(e) {
  if (e === '-') return 'reads the compose file from stdin, which the check cannot see';
  if (/[:@]|^\w+\/\//.test(e)) return 'is a remote reference (the check cannot see what it fetches)';
  const n = path.posix.normalize(e);
  if (path.isAbsolute(n) || n === '..' || n.startsWith('../') || e.includes('\0')) return 'is not a path inside the project';
  return null;
}

/** The value of KEY in a `.env` file for a plain `KEY=v` or `export KEY="v"` line. Compose's own parser accepts more forms (`KEY: v`, inline comments, escapes): this is a courtesy check, not the guarantee. */
function dotenvValue(text, key) {
  let found;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] === key) found = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return found;
}

/**
 * A clear message for the plain cases: `COMPOSE_FILE` split on `COMPOSE_PATH_SEPARATOR` (default `:`), from the project's
 * stored values and then the folder's `.env`; each entry follows the `-f` rule; `COMPOSE_ENV_FILES` is refused. A `.env`
 * line written in a form this reader misses is NOT caught here. What then still holds: stdin is ignored for every
 * command that starts containers (takesStdin), remote files are off (COMPOSE_ENV), and whatever local files the list
 * names are the same files in the check and in the real call.
 */
export async function fileListProblems(env, cwd) {
  const dotenv = await fs.readFile(path.join(cwd, '.env'), 'utf8').catch(() => '');
  const get = (k) => env?.[k] ?? dotenvValue(dotenv, k);
  const out = [];
  if (get('COMPOSE_ENV_FILES')) out.push('COMPOSE_ENV_FILES points Compose at other env files, which the check cannot see');
  const list = get('COMPOSE_FILE');
  if (!list) return out;
  if (/\$/.test(list)) out.push('COMPOSE_FILE uses a ${variable}; write the file names out');
  const sep = get('COMPOSE_PATH_SEPARATOR') || ':';
  for (const e of list.split(sep)) {
    const why = e === '' ? null : fileEntryProblem(e);
    if (why) out.push(`COMPOSE_FILE entry "${e}" ${why}`);
  }
  return out;
}

/**
 * Why this command and these flags must not run, or []. Positional words (service names, the container's own command)
 * are not checked here. `-v SRC:DST` of `run` goes through hostPathProblem like a mount in the compose file.
 */
export async function commandProblems(command, args, { home, cwd }) {
  const spec = Object.hasOwn(COMPOSE_COMMANDS, command) ? COMPOSE_COMMANDS[command] : undefined;
  if (!spec) return [`compose ${command} is not offered (allowed: ${COMPOSE_COMMAND_NAMES.join(', ')})`];
  const out = [];
  const volumes = [];
  const flag = (name, value) => {
    if (spec.no?.[name]) out.push(`${command} ${name} ${spec.no[name]}`);
    else if (!spec.flags[name]) out.push(`${command} ${name} is not offered`);
    else if (spec.flags[name] === 'value' && value === undefined) out.push(`${command} ${name} needs a value`);
    else if (value !== undefined && (name === '-v' || name === '--volume')) volumes.push(value);
    return spec.flags[name];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') {
      if (spec.stop) break;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      const kind = spec.flags[name];
      if (kind === 'value' && eq < 0) flag(name, args[++i]);
      else if (kind === 'bool' && eq >= 0 && !/^(true|false)$/.test(a.slice(eq + 1))) out.push(`${command} ${name} takes no value`);
      else flag(name, eq < 0 ? undefined : a.slice(eq + 1));
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const name = `-${a[j]}`;
      const kind = spec.flags[name];
      if (kind !== 'value') {
        flag(name, kind ? undefined : '');
        if (!kind) break;
        continue;
      }
      const glued = a.slice(j + 1);
      flag(name, glued === '' ? args[++i] : glued.replace(/^=/, ''));
      break;
    }
  }
  for (const v of volumes) {
    const src = v.split(':')[0];
    const why = src.startsWith('~') ? 'a home-relative path (not checked)' : /^[/.]/.test(src) ? await hostPathProblem(src, home, cwd) : null;
    if (why) out.push(`run -v ${src} is ${why}`);
  }
  return [...new Set(out)];
}
