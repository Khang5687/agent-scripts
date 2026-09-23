# Plan template

```
# <Title>
Status: draft
Depends on: none

## Ask
One paragraph. What the user wants and why, in their words.

## Current behaviour
Paths and line refs from the scout. What happens today, where.

## Decisions
D1. <decision>. Why: <reason>. Alternative rejected: <what, why>.
D2. ...

## Risks
R1. <risk> — mitigation or "accepted".

## Not in scope
- ...

## Tests
- <file>: <what it asserts>

## Implementation (dependency order)
1. <step, files touched>
2. ...

## Open product calls
- (empty when ready-for-agent)
```

Why each part exists: the runner never sees the discussion chat. Decisions
without reasons get re-litigated by workers; steps without file names make
workers collide; a missing "not in scope" list makes workers over-build.
