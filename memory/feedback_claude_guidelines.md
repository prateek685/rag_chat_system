---
name: Claude Working Guidelines
description: Hard rules for Claude's behavior in this project — secret file access, plan fidelity, and memory hygiene
type: feedback
---

**Never read .env files or API keys.**
Do not read, cat, grep, or scan `.env`, `.env.local`, `.env.production`, or any file whose name starts with `.env`. For env var names, read `.env.example` only.
**Why:** These files contain live secrets. Accidental exposure in tool output or context is a security risk.
**How to apply:** Every time you reach for environment context, check whether `.env.example` suffices. If a task genuinely requires knowing a secret value, ask the user — do not read the file.

---

**No drift from the implementation plan.**
Implement exactly what the plan or design document specifies. Do not add features, swap libraries, change interfaces, or introduce abstractions not in the plan — even if they seem better. If the plan is ambiguous or wrong, stop and ask rather than interpreting around it.
**Why:** Mid-phase drift breaks integration contracts between modules and invalidates tests written against the agreed design.
**How to apply:** Before writing any code, locate the relevant phase in `memory/`. Every file you touch must trace back to a plan item. Scope creep is a merge-block.

---

**Update memory files after every phase.**
When a phase or milestone completes (or is blocked), update the relevant `memory/project_mN_status.md` file before reporting done. Record: what was built, what was skipped, deviations from the plan and why, and next-phase status. Use absolute dates. Create a new memory file if the phase has none yet and add it to `MEMORY.md`.
**Why:** Memory files are the single source of truth for project progress. Stale or missing entries cause future sessions to re-do work or make incorrect assumptions.
**How to apply:** Treat a memory update as the final step of every phase — as mandatory as the tests passing.
