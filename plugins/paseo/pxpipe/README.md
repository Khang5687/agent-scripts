# pxpipe for Paseo

Runs [pxpipe](https://github.com/teamchong/pxpipe) on the daemon host, routes chosen Paseo providers through it, and adds a pxpipe page to Paseo settings for configuration and stats.

pxpipe renders bulky request context (system prompt, tool docs, large tool results, older history) as images to cut input tokens. It is lossy: exact strings read back from images can be wrong without any error. Recent turns stay text. Keep weak readers off the model list if exact IDs matter to you.

## Supported versions

| Component | Version |
| --- | --- |
| Paseo daemon and app | `>=0.10.1` (manifest `requirements.paseo`) |
| pxpipe | `pxpipe-proxy@0.14.0`, pinned in `package.json` |
| OMP | Verified with 18.3.2 |

The dashboard reads pxpipe's loopback API and `events.jsonl` rows. Re-check `server/handlers.ts` and `server/event-log.ts` against pxpipe's `dist/dashboard/types.d.ts` and `dist/core/tracker.d.ts` before bumping pxpipe.

## What it does

- **Proxy.** Uses the pxpipe already answering on `127.0.0.1:<port>` (default 47821) when **Use an existing pxpipe** is on, which is the default. Otherwise it starts its own pxpipe with the plugin's settings and restarts it when a launch setting changes.
  - An existing pxpipe keeps its own launch settings. The plugin only drives its kill switch and model scope, which also affect that pxpipe's other clients and persist in its own config file. The plugin never stops it.
  - If the existing pxpipe stops answering, the plugin starts its own within about 5 seconds.
  - A pxpipe the plugin started is stopped on plugin reload, disable, or removal. One left behind by a killed plugin process is found through `~/.pxpipe/paseo-plugin.pid` and stopped on the next start.
- **Routing.** An `agent.session_open` hook sets `ANTHROPIC_BASE_URL` for agents whose provider is switched on under **Route agents through pxpipe**. It applies on create, resume, refresh, and import. It only routes while pxpipe answers, so a stopped proxy sends new agents direct. Running agents keep their route until refreshed.
- **Per model.** **Models pxpipe may compress** is pxpipe's model scope, applied live. Other models pass through byte-identical. The default is `claude-fable-5`, `gemini-3.6-flash`, `gemini-3.7-flash` (pxpipe 0.13.2's default). pxpipe 0.14.0 also enables Opus 5.5, whose exact-string recall on images is weak.
- **Kill switch.** **Compression** off forwards every request unchanged and keeps logging usage.
- **Stats.**
  - Token savings per model over the whole events log, counting rows with a successful `count_tokens` baseline probe. This is the view that matters on a subscription.
  - Dollar savings at API list price over the whole log, using pxpipe's own cache-weighted functions imported from `pxpipe-proxy/dist/core/baseline.js`. It covers Anthropic requests only. pxpipe's own dashboard replays only the last 50 rows after a restart, so its totals reset; these don't.
  - Paseo's subscription usage windows for routed providers.
  - Recent requests with the rendered page and its source text.
  - Sessions.
- **Advanced.** Port, command override, upstreams, render cache, max request size, GPT history image cap, session state, 4xx capture, and extra `KEY=VALUE` environment for any other pxpipe variable.

pxpipe's per-block `keepSharp` option is not reachable through its stock proxy, so this plugin cannot pin chosen tool results as text.

## Files it touches

| Path | Owner |
| --- | --- |
| `~/.pxpipe/events.jsonl` | pxpipe's default events log, shared with any standalone pxpipe. Set `PXPIPE_LOG` under Advanced to separate them. |
| `~/.pxpipe/paseo-plugin-config.json` | pxpipe's persisted model toggles for this instance |
| `~/.pxpipe/paseo-plugin-session-state.json` | pxpipe session state for this instance |
| `~/.pxpipe/paseo-plugin.pid` | Managed process ID |
| `$PASEO_HOME/plugin-settings/pxpipe/` | Plugin settings, deleted when the plugin is removed |

## Install

Plugins must be enabled on the daemon (`pluginsEnabled: true` in `$PASEO_HOME/config.json`). Plugin server code runs unsandboxed on the daemon host.

```bash
cd ~/git/agent-scripts/plugins/paseo/pxpipe
npm install
npm run typecheck
paseo plugin install ~/git/agent-scripts/plugins/paseo/pxpipe
paseo plugin ls   # expect pxpipe: running
```

The plugin locates `node_modules/pxpipe-proxy` through the daemon's plugin config. It runs pxpipe with the daemon's own Node runtime, including Paseo Desktop's Electron helper.

With **Use an existing pxpipe** off, a pxpipe already on the port stops the plugin from starting, and the page shows the error.

Open the page from **Settings → host → Plugins → pxpipe → ⋯ → pxpipe**, or from the Command Center (**Open pxpipe dashboard**).

## Reload, disable, remove

```bash
paseo plugin reload pxpipe    # after editing source
paseo plugin disable pxpipe   # stops pxpipe; new agents go direct
paseo plugin enable pxpipe
paseo plugin remove pxpipe    # deletes plugin settings, keeps ~/.pxpipe files
paseo plugin logs pxpipe      # supervisor and pxpipe output
```

## Smoke path

1. Install, then check that the page shows **Running** and `curl -s http://127.0.0.1:<port>/proxy-stats` answers.
2. Run a routed agent that reads a file over about 6k characters:
   `paseo run --provider omp --model anthropic/claude-opus-5-5 "Read ./big.txt and quote line 311"`.
   **Recent requests** should show `claude-opus-5-5 · compressed`. Tap the row to see the rendered page and its source text.
3. Turn off **Oh My Pi** under routing and run another agent. pxpipe's request count should not change.
4. Turn off **Compression**, and `/proxy-stats` should report `"compression_enabled": false`. Turn off a model, and `/fragments/models` should drop it.

## Verified

Verified on 2026-09-30 against an isolated Paseo 0.10.1 daemon, using its bundled web UI at desktop width and at 400 px compact width:

- The page renders in both layouts.
- Using an existing pxpipe:
  - It routed an OMP agent through the pxpipe already on the port, applied the kill switch to it, and showed it on the page.
  - When that pxpipe was killed, the plugin started its own on the same port.
  - A daemon stop left the existing pxpipe running.
- Savings totals stayed the same across a pxpipe restart. Over the window since the standalone pxpipe started, the log-derived dollar figure came to $175.61, against pxpipe's own $175.46.
- Port change and restart.
- OMP agents were routed and compressed (a 12-hex value was recalled correctly), and went direct when unrouted.
- The kill switch and model scope apply live.
- **Run pxpipe** off stops the process.
- A leftover pxpipe is cleaned up after the plugin process was SIGKILLed.
- Page preview with source text.
- Claude subscription usage windows.

Not verified:

- Native iOS and Android apps.
- Routing the `claude` provider.
