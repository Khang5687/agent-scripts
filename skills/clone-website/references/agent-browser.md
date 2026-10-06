# Drive the browser with agent-browser

This fork uses the `agent-browser` CLI, run through the shell, for every browser step. Do not use Chrome MCP, the Claude in Chrome connector, or another browser MCP; the workflow must run the same in any agent harness. Verify with `agent-browser --help`.

## Core commands

| Need | Command |
|---|---|
| Open a page | `agent-browser open <url>` |
| Set viewport (before opening or measuring) | `agent-browser set viewport 1440 900` (also 768, 390) |
| Reduced motion / color scheme | `agent-browser set media dark\|light reduced-motion` |
| Real wheel input (smooth-scroll libraries, scroll scenes) | `agent-browser mouse wheel <dy>` |
| Scripted scroll | `agent-browser scroll down <px>`, `agent-browser scrollintoview <sel>` |
| Wait | `agent-browser wait <ms\|sel>` |
| Screenshot | `agent-browser screenshot <abs-path>`, full page `agent-browser screenshot --full <abs-path>` |
| DOM evaluation | `agent-browser eval '<js>'` |
| Computed styles / box | `agent-browser get styles <sel> --json`, `agent-browser get box <sel> --json` (without `--json` they print nothing) |
| Accessibility tree | `agent-browser snapshot` |
| Loaded resources | `agent-browser network requests --filter <pattern>` |
| Runtime errors | `agent-browser console` |
| Compare to a baseline | `agent-browser diff screenshot --baseline <path>` |
| Finish | `agent-browser close` |

## Lessons from earlier clones

- **Flags go before the path.** `screenshot --full <path>`. A flag after the path is parsed as the filename.
- **Absolute screenshot paths only.** agent-browser resolves relative paths against its own working directory, which can differ from the shell cwd. Run `ls -la <path>` after every capture.
- **Create the output directory first.** `screenshot` exits 1 when the directory is missing.
- **`eval` shares one JS context across calls.** Top-level `const`/`let` persists and throws "already declared". Wrap code in `(() => { ... })()` and return one `JSON.stringify(...)` value.
- **Shell quoting mangles JS.** In zsh, `!` and `$word` inside double quotes expand before the browser sees them. Single-quote the JS. For anything over ~10 lines, write a temp `.js` file and pass `"$(cat file.js)"`.
- **Full-page captures stitch.** Sticky or fixed layers repeat down the image, and mid-flight animations render as phantom clutter. Never fix a defect seen only in a full-page capture; confirm it live with `document.elementsFromPoint(x, y)`, computed styles, and a viewport screenshot at that scroll position.
- **Trigger lazy loading first.** Scroll the whole page with ~1 s pauses so lazy images and IntersectionObserver reveals settle before capturing.
- **Wait 1 to 2 s after navigation, viewport change, or scroll** before a screenshot; otherwise you capture half-finished transitions.
- **Screenshots may come back downscaled.** Multiply coordinates by the stated scale before mapping them to real pixels.
- **Re-check the viewport** after `open` or reload; some flows reset it. Use the same widths for source and clone captures.
- **Extract, do not guess.** Read font and image URLs from `performance.getEntriesByType('resource')`, `document.fonts`, and CSS rule scans. CDN font URLs, weights, and letter spacing were only reliable this way.
- **DOM handles go stale** after HMR, file edits, `open`, or reload. Re-query elements inside each `eval`.
