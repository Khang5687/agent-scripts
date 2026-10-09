// Writes the agent-broker block into the project's AGENTS.md / CLAUDE.md. Runs as the CALLER (the _deployer user
// cannot write in the owner's folders): /usr/local/bin/agent-broker runs it after `init`, and for `agents-md --write`.
// The block text and the project folder come from the broker (`agent-broker agents-md --json`).
//   - every existing AGENTS.md / AGENTS.MD / CLAUDE.md gets the block (a CLAUDE.md that imports @AGENTS.md is left
//     alone: it already includes it);
//   - with none of them, AGENTS.md gets the block and CLAUDE.md imports it (Claude Code reads CLAUDE.md only).
// Running again replaces the block between <!-- agent-broker:start --> and <!-- agent-broker:end -->.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BLOCK = /<!-- agent-broker:start -->[\s\S]*?<!-- agent-broker:end -->/;

/** The file text with the block replaced, or appended after a blank line. */
export function withBlock(text, block) {
  if (BLOCK.test(text)) return text.replace(BLOCK, () => block);
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}\n`;
}

/** Writes the block into the folder's agent files; returns the file names written. */
export function writeBlocks(folder, block) {
  // Exact names from the folder listing: macOS disks ignore case, so existsSync('AGENTS.MD') finds AGENTS.md too.
  const names = new Set(fs.readdirSync(folder));
  const existing = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md'].filter((f) => names.has(f));
  if (!existing.length) {
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), withBlock('', block));
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '@AGENTS.md\n');
    return ['AGENTS.md', 'CLAUDE.md (imports AGENTS.md)'];
  }
  const written = [];
  for (const f of existing) {
    const file = path.join(folder, f);
    const text = fs.readFileSync(file, 'utf8');
    if (f === 'CLAUDE.md' && /^@AGENTS\.md\s*$/im.test(text) && !BLOCK.test(text)) continue;
    fs.writeFileSync(file, withBlock(text, block));
    written.push(f);
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const out = execFileSync('/usr/bin/sudo', ['-n', '-u', '_deployer', '/opt/agent-broker/bin/agent-broker.mjs', 'agents-md', '--json', ...process.argv.slice(2)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const { project, folder, block } = JSON.parse(out);
    const files = writeBlocks(folder, block);
    console.log(`agent-broker: wrote the ${project} block into ${files.join(', ')} in ${folder}`);
  } catch (e) {
    console.error(`agent-broker: could not write the AGENTS.md block: ${e.message?.split('\n')[0]}`);
    process.exitCode = e.status ?? 1;
  }
}
