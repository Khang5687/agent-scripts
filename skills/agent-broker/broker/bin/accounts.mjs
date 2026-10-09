// Account lookups and changes with a service token: who the token belongs to, what sites / databases it can reach,
// whether a project's pinned site / database belongs to that account, creating a Netlify site and a read-only
// database user. Used by agent-broker (init / attach), agent-broker-admin (stored tokens) and the wizard's
// scripts/lookup.mjs (tokens the owner just typed). Tokens go only into request headers.
import { randomBytes } from 'node:crypto';

const API = {
  netlify: 'https://api.netlify.com/api/v1',
  supabase: 'https://api.supabase.com/v1',
  vercel: 'https://api.vercel.com',
  apify: 'https://api.apify.com/v2',
};

async function get(service, token, route) {
  const res = await fetch(`${API[service]}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${service} API ${res.status} for ${route.split('?')[0]}${res.status === 401 || res.status === 403 ? ' (token not valid or not allowed)' : ''}`);
  return res.json();
}

async function send(service, token, method, route, body) {
  const res = await fetch(`${API[service]}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${service} API ${res.status} for ${method} ${route.split('?')[0]}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Creates a Netlify site in a team (account slug). Returns { id, name, url }. */
export async function createNetlifySite(token, team, name) {
  const s = await send('netlify', token, 'POST', `/${encodeURIComponent(team)}/sites`, { name });
  return { id: s.id, name: s.name, url: s.ssl_url ?? s.url };
}

/**
 * Creates (or resets the password of) the read-only database user `agent_reader` in a Supabase project and returns
 * its Session pooler URL. The password is generated here and only stored by the caller (never shown).
 */
export async function createReadOnlyUser(token, ref) {
  const pw = randomBytes(24).toString('hex');
  await send('supabase', token, 'POST', `/projects/${encodeURIComponent(ref)}/database/query`, { query: `
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'agent_reader') then create role agent_reader login; end if;
    end $$;
    alter role agent_reader with login password '${pw}' bypassrls noinherit;
    alter role agent_reader set default_transaction_read_only = on;
    alter role agent_reader set statement_timeout = '120s';
    grant usage on schema public to agent_reader;
    grant select on all tables in schema public to agent_reader;
    alter default privileges in schema public grant select on tables to agent_reader;` });
  const poolers = (await get('supabase', token, `/projects/${encodeURIComponent(ref)}/config/database/pooler`)) ?? [];
  const p = poolers.find((x) => x.database_type === 'PRIMARY') ?? poolers[0];
  if (!p?.db_host) throw new Error(`Supabase project ${ref}: no connection pooler found`);
  // Session pooler: port 5432 on the pooler host, user <role>.<ref>.
  return `postgresql://agent_reader.${ref}:${pw}@${p.db_host}:5432/${p.db_name ?? 'postgres'}`;
}

const LOOKUP = {
  async netlify(token) {
    const [user, accounts, sites] = await Promise.all([get('netlify', token, '/user'), get('netlify', token, '/accounts'), get('netlify', token, '/sites?filter=all&per_page=100')]);
    return {
      account: { email: user?.email, name: user?.full_name, teams: (accounts ?? []).map((a) => a.slug) },
      sites: (sites ?? []).map((s) => ({ id: s.id, name: s.name, url: s.ssl_url ?? s.url, team: s.account_slug })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
  async supabase(token) {
    const [orgs, projects] = await Promise.all([get('supabase', token, '/organizations'), get('supabase', token, '/projects')]);
    const orgName = new Map((orgs ?? []).map((o) => [o.id, o.name]));
    return {
      account: { orgs: (orgs ?? []).map((o) => o.name) },
      projects: (projects ?? []).map((p) => ({ ref: p.id ?? p.ref, name: p.name, org: orgName.get(p.organization_id) ?? p.organization_id, status: p.status }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
  async vercel(token) {
    const [user, teams] = await Promise.all([get('vercel', token, '/v2/user'), get('vercel', token, '/v2/teams')]);
    const scopes = [{ id: user?.user?.id, slug: user?.user?.username, team: false }, ...(teams?.teams ?? []).map((t) => ({ id: t.id, slug: t.slug, team: true }))];
    const projects = [];
    for (const s of scopes) {
      if (!s.id) continue;
      const list = await get('vercel', token, `/v9/projects?limit=100${s.team ? `&teamId=${s.id}` : ''}`).catch(() => null);
      for (const p of list?.projects ?? []) projects.push({ id: p.id, name: p.name, org_id: s.id, scope: s.slug });
    }
    return { account: { email: user?.user?.email, name: user?.user?.username, teams: scopes.filter((s) => s.team).map((s) => s.slug) }, projects };
  },
  async apify(token) {
    const me = await get('apify', token, '/users/me');
    return { account: { name: me?.data?.username, email: me?.data?.email } };
  },
};

/** Lookup for every service whose token is given: { netlify: { account, sites }, supabase: { account, projects }, ... }. */
export async function lookup(tokens) {
  const keys = { netlify: 'NETLIFY_AUTH_TOKEN', supabase: 'SUPABASE_ACCESS_TOKEN', vercel: 'VERCEL_TOKEN', apify: 'APIFY_TOKEN' };
  const out = {};
  await Promise.all(Object.entries(keys).map(async ([service, key]) => {
    if (!tokens[key]) return;
    try {
      out[service] = await LOOKUP[service](tokens[key]);
    } catch (e) {
      out[service] = { error: e.message };
    }
  }));
  return out;
}

/** A one-line label for an account lookup, e.g. "theDoor <a@b.c>, teams: thedoorapi". */
export function accountLabel(account = {}) {
  const who = [account.name, account.email && `<${account.email}>`].filter(Boolean).join(' ');
  const extra = account.teams?.length ? `teams: ${account.teams.join(', ')}` : account.orgs?.length ? `orgs: ${account.orgs.join(', ')}` : '';
  return [who, extra].filter(Boolean).join(', ') || 'unknown account';
}

/**
 * Checks that a project's pinned site / database belongs to the account of the given tokens. Returns names to
 * record ({ netlify: { site_name, site_url }, ... }); throws when a pin is not in that account. Services without a
 * token are reported in `unverified`.
 */
export async function verifyPins(project, tokens) {
  const names = {};
  const unverified = [];
  if (project.netlify) {
    if (!tokens.NETLIFY_AUTH_TOKEN) unverified.push('netlify');
    else {
      const s = await get('netlify', tokens.NETLIFY_AUTH_TOKEN, `/sites/${encodeURIComponent(project.netlify.site_id)}`);
      if (!s) throw new Error(`Netlify site ${project.netlify.site_id} is not in this stack's Netlify account`);
      names.netlify = { site_name: s.name, site_url: s.ssl_url ?? s.url };
    }
  }
  if (project.supabase) {
    if (!tokens.SUPABASE_ACCESS_TOKEN) unverified.push('supabase');
    else {
      const p = await get('supabase', tokens.SUPABASE_ACCESS_TOKEN, `/projects/${encodeURIComponent(project.supabase.project_ref)}`);
      if (!p) throw new Error(`Supabase project ${project.supabase.project_ref} is not in this stack's Supabase account`);
      names.supabase = { name: p.name };
    }
  }
  if (project.vercel) {
    if (!tokens.VERCEL_TOKEN) unverified.push('vercel');
    else {
      const team = project.vercel.org_id?.startsWith('team_') ? `?teamId=${encodeURIComponent(project.vercel.org_id)}` : '';
      const p = await get('vercel', tokens.VERCEL_TOKEN, `/v9/projects/${encodeURIComponent(project.vercel.project_id)}${team}`);
      if (!p) throw new Error(`Vercel project ${project.vercel.project_id} is not in this stack's Vercel account`);
      names.vercel = { name: p.name };
    }
  }
  if (project.apify && !tokens.APIFY_TOKEN) unverified.push('apify');
  return { names, unverified };
}
