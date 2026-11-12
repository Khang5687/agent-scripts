// What `agent-broker compose` refuses before it lets Docker start or change containers. The compose file belongs to the
// agents and the Docker daemon runs as root, so a bind mount of the broker's own folder would hand over every stored
// value. The check reads the RESOLVED config (`docker compose config --format json`: includes, extends, profiles and .env
// already applied), so one rule covers every way a path can get in. A guard for the usual routes, not a wall:
// see "What this does not stop" in SKILL.md (a symlink swapped after the check, env_file of broker files unless a stored
// value shows up, a socket under another name, and the Docker group of the owner's own user).
import fs from 'node:fs/promises';
import path from 'node:path';

const SOCKET = /(^|\/)(docker|podman|containerd|crio)\.sock$/;

// Commands that only read or stop what already exists: no new mount, no new container.
const NO_CHECK = new Set(['ps', 'logs', 'config', 'images', 'ls', 'top', 'port', 'events', 'version', 'stop', 'down', 'kill', 'rm', 'pause', 'unpause', 'pull', 'push', 'wait', 'exec', 'cp', 'help']);
export const needsCheck = (command) => !NO_CHECK.has(command);

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
    for (const d of svc.devices ?? []) out.push(`${at}: host device ${typeof d === 'string' ? d.split(':')[0] : d?.source ?? '?'}`);
    const ctx = svc.build?.context ?? (typeof svc.build === 'string' ? svc.build : null);
    if (ctx && path.isAbsolute(ctx)) await bad(`${at} build context`, ctx);
    for (const c of Object.values(svc.build?.additional_contexts ?? {})) if (typeof c === 'string' && path.isAbsolute(c)) await bad(`${at} build context`, c);
  }
  for (const [name, vol] of Object.entries(config?.volumes ?? {})) {
    const o = vol?.driver_opts ?? {};
    if (typeof o.device === 'string' && /bind/.test(String(o.o ?? ''))) await bad(`volume "${name}"`, o.device);
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

/** `compose run -v SRC:DST` / `--volume`: a source that reaches the broker home or the Docker socket. */
export async function runVolumeProblems(args, { home, cwd }) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const spec = a === '-v' || a === '--volume' ? args[++i] : a.startsWith('--volume=') ? a.slice(9) : /^-v./.test(a) ? a.slice(2) : null;
    if (spec === null) continue;
    const src = spec.split(':')[0];
    const why = src.startsWith('~') ? 'a home-relative path (not checked)' : /^[/.]/.test(src) ? await hostPathProblem(src, home, cwd) : null;
    if (why) out.push(`-v ${src} is ${why}`);
  }
  return out;
}

/** `compose cp`: a host path (an argument with no `service:` part) must stay inside the project folder. */
export function cpProblems(args, root) {
  const out = [];
  for (const a of args) {
    if (a.startsWith('-') || a.includes(':')) continue;
    const p = path.resolve(root, a);
    if (p !== root && !p.startsWith(`${root}/`)) out.push(`cp ${a}: a host path must be inside the project folder`);
  }
  return out;
}
