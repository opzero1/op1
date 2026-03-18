---
name: implementation-conventions
description: Apply these conventions during implementation from the start (not only after review feedback).
---

# Skill: implementation-conventions

Apply these conventions during implementation from the start (not only after review feedback).

## Core Rules

1. Reuse existing UI patterns first
- Before creating new UI wrappers, check what already exists in this repository:
  - design system / component library (if present)
  - shared component package(s)
  - existing feature patterns in the same module
- Match the repo's styling approach (for example styled-components, Tailwind, CSS modules).
- If the needed primitive does not exist, create the smallest local abstraction.

2. Avoid unnecessary explicit typing
- Do not add explicit type annotations where TypeScript inference is already clear.
- Examples: local handler functions, simple derived constants, obvious return types.

3. Hook placement discipline
- Keep hooks (`useState`, `useEffect`, `useMemo`, etc.) before render return.
- Keep hook ordering stable and predictable.

4. Prefer component-provided lifecycle callbacks
- Check for built-in callbacks (`onClose`, `onChange`, etc.) before adding custom listeners/workarounds.
- Avoid custom `document` listeners if component API can handle the behavior.

5. Single source of truth
- Avoid duplicated state ownership for the same value across local/component state and global store.
- Pick one owner and simplify around it.

6. Eliminate dead code while refactoring
- Remove now-unused helpers, types, files, and store actions immediately after simplification.

7. Tests must be stable
- Remove `act(...)` warnings in touched tests.
- Use `userEvent` + async waits for keyboard/focus interactions.

8. useMemo/useCallback decision guide
- Default to NOT using `useMemo`/`useCallback`.
- Add them only when at least one is true:
  1) The computation is expensive and runs frequently.
  2) You need referential stability for a memoized child/dependency-sensitive hook.
  3) Profiling or clear evidence shows rerender/perf problems.
- Avoid them for tiny maps/filters/string concat/object literals unless required by dependency identity.
- Re-check after adding: does it improve clarity + performance? If not, remove.

### Quick examples
- Good use: expensive sorted/filtered list powering a memoized table.
- Usually unnecessary: mapping 2-3 static options each render.

## Apply Checklist (per change)

- [ ] Reused existing repo/component patterns before adding new abstractions
- [ ] Avoided unnecessary explicit local type annotations
- [ ] Kept all hooks before render return
- [ ] Preferred component callback API over custom listeners
- [ ] Ensured no duplicated state ownership
- [ ] Removed dead code introduced by simplification
- [ ] Used `useMemo`/`useCallback` only with a clear performance or identity reason
- [ ] Ran lint/typecheck/tests and ensured no new warnings in touched scope

## Suggested Trigger Phrases

- "implementation conventions"
- "avoid overengineering"
- "clean up dead code"
- "should we use useMemo here"
