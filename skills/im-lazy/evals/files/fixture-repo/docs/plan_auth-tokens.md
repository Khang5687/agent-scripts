# Auth tokens
Status: ready-for-agent
Depends on: none

## Ask
Rotate session tokens every 24h.

## Decisions
D1. Use `src/auth.ts` `issueToken`. Why: single entry point.

## Not in scope
- refresh tokens

## Tests
- src/auth.test.ts: token expires after 24h

## Implementation (dependency order)
1. add `expiresAt` to token (src/auth.ts)
2. reject expired tokens in `verify` (src/auth.ts)
