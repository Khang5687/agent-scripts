#!/usr/bin/env node
// Wizard helper: reads KEY=VALUE token lines on stdin (never arguments or environment, which other processes of the
// same user can see) and prints the account lookup as JSON: who each token belongs to, its sites and databases.
import { lookup } from '../broker/bin/accounts.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const tokens = {};
for (const line of input.split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) tokens[line.slice(0, i)] = line.slice(i + 1);
}
process.stdout.write(`${JSON.stringify(await lookup(tokens))}\n`);
