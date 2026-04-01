# PLAN_SAFE_CLEAN_BUILD_HELPER.md

**Status:** Approved - ready for implementation  
**Branch:** architectural-upgrade  
**Revision:** 2026-04-01

---

## Context

Local Windows builds can fail with `EPERM` when `next build` tries to unlink files inside `.next/` while a local Node/Next process still has that directory open.

The goal is to add a small PowerShell helper that:
- runs from the repo root
- removes `.next/` before a build
- retries after stopping local `node` processes only when the lock persists
- avoids silently killing processes without either an explicit flag or an interactive confirmation

This is intentionally a developer convenience helper only. It does not change app runtime behavior or test behavior.

---

## Scope

Create one new script:
- `scripts/safe-clean-build.ps1`

Add Windows-only package shortcuts:
- `build:clean:win`
- `build:clean:win:force`

---

## Implementation

### Script behavior

1. Resolve the repo root from `scripts/`.
2. Attempt to remove `.next/` recursively with force.
3. If removal succeeds, run `corepack pnpm build`.
4. If removal fails because files are locked:
   - list local `node` processes
   - if `-ForceStopNode` was provided, stop them and retry automatically
   - otherwise prompt the user before stopping them
5. If the retry still fails, exit with a clear error message.

### Package shortcuts

Add `package.json` scripts that invoke the helper from the repo root:
- `powershell -ExecutionPolicy Bypass -File .\\scripts\\safe-clean-build.ps1`
- `powershell -ExecutionPolicy Bypass -File .\\scripts\\safe-clean-build.ps1 -ForceStopNode`

### Parameters

- `-ForceStopNode`
  - skips the confirmation prompt
  - only used after an initial `.next/` cleanup failure

### Safety rules

- Do not stop processes unless `.next/` cleanup actually fails.
- Do not delete anything except the repo-local `.next/` directory.
- Keep messaging explicit so the user knows when the script is about to stop `node` processes.

---

## Validation

Run:
1. `corepack pnpm lint`
2. `corepack pnpm build`

If the direct build is blocked by a local `.next/` lock during validation, note that the new PowerShell helper was created specifically to resolve that environmental failure.
