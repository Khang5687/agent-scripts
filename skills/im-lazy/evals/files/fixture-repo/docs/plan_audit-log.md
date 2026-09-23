# Audit log
Status: ready-for-agent
Depends on: plan_auth-tokens

## Ask
Log every token issue/verify.

## Decisions
D1. Append to `src/audit.ts`. Why: existing sink.

## Not in scope
- log rotation

## Tests
- src/audit.test.ts: issue writes a row

## Implementation (dependency order)
1. call audit from issueToken (src/auth.ts, src/audit.ts)
