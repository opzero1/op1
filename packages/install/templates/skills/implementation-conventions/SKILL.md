---
name: implementation-conventions
description: Apply these conventions during planning and implementation from the start (not only after review feedback). Use for frontend and backend changes when deciding whether to add layers, where to place formatting/validation, how much typing to keep, how to place helper files (.dto.ts/.type.ts/.constant.ts/.util.ts), and how to match existing module patterns during /plan and /work.
---

# Skill: implementation-conventions

Apply these conventions during planning and implementation from the start (not only after review feedback).

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

8. useMemo/useCallback/useEffect decision guide
- Default to NOT using `useMemo`/`useCallback`/`useEffect`.
- Add them only when at least one is true:
  1) The computation is expensive and runs frequently.
  2) You need referential stability for a memoized child/dependency-sensitive hook.
  3) Profiling or clear evidence shows rerender/perf problems.
- Avoid them for tiny maps/filters/string concat/object literals unless required by dependency identity.
- Re-check after adding: does it improve clarity + performance? If not, remove.
- Add `useEffect` only when synchronizing with something outside React such as subscriptions, timers, network side effects, or imperative browser APIs.
- Do not use `useEffect` for derived state, straightforward data transforms, or work that can happen directly in event handlers.

9. Benchmark the nearest mature module first
- Before inventing a new structure, find the closest well-maintained module in the same codebase and match it.
- Match the nearest proven pattern for:
  - controller/service/formatter or controller/service/mapper split
  - DTO/schema organization
  - test structure and mocking style
  - explicit vs inferred public method signatures

10. Keep layer responsibilities clean
- **Controller** should own HTTP concerns and final response formatting when the local benchmark module does so.
- **Service** should own business logic, orchestration, guards, and upstream coordination.
- **Formatter/mapper** should own response shaping only.
- Do not let a service shape FE/API DTOs if the benchmark module formats in the controller.
- Small request-to-filter/context derivation helpers may live in the controller when they are purely HTTP/user-context shaping and not business logic.

11. Split large services by operation family when the behavior diverges
- If one service starts mixing clearly different responsibilities (for example: query/read paths vs mutation/provisioning paths), extract focused collaborator services instead of growing one god-service.
- Keep the top-level service as the orchestration entry point only when that matches the local module pattern.

12. Avoid thin repository layers
- If a repository only forwards one call into another service and adds little or no real data-access behavior, remove it.
- Keep a repository only when it provides meaningful persistence/query behavior or a seam that earns its cost.

13. Validate once at the right boundary
- Keep request DTO validation at the boundary.
- Avoid stacking repeated validation layers for the same call path.
- If a module treats an upstream contract as trusted, use typed responses and keep downstream types/formatters consistent with that trust model.
- If a module treats an upstream contract as untrusted, parse it once at the boundary and keep the rest of the code on trusted shapes.
- Do not add Zod response validation for every API call by default.
- Use Zod for upstream/API responses only when the contract is genuinely unstable, the boundary is known to be unsafe, or the user explicitly asks for runtime response validation.
- If response validation is needed, do it once at the boundary instead of re-validating the same payload in multiple layers.

14. Keep schema helpers local until reuse is real
- Small DTO/schema helpers belong in the `*.dto.ts` file.
- Do not extract a `*.util.ts` for helpers that are only used by one DTO file.
- Extract helpers only when they are reused across files or represent a true shared domain concept.
- Inline small enum schemas where that improves readability.
- Prefer inline enums for small, local schema-only cases.
- Extract enum values only when they are reused across files, needed at runtime outside the schema, or clearly improve readability.

15. Be deliberate about helper file boundaries
- `*.type.ts`
  - Keep pure types and interfaces only.
  - Do not put runtime logic, regexes, schema helpers, constants, or parsers here.
  - Use it when the file is only describing trusted shapes/contracts.
- `*-service.types.ts` (or another semantic feature-type file)
  - Use when a feature needs shared payload types, enums, and constants across services/query-builders/DTOs, but a generic `types.ts` would be too vague.
  - Prefer semantic naming over generic `types.ts` when the file carries domain meaning.
- `*.constant.ts`
  - Keep shared runtime values that are reused across multiple files in the same module.
  - Do not move a constant here if it only serves one DTO/helper flow and hurts local readability.
  - Good candidates: shared error messages, route-independent limits, repeated tokens.
- `*.formatter.ts` / `*.mapper.ts`
  - Keep response shaping and field translation only.
  - Do not put business orchestration, upstream calls, or persistence logic here.
  - Use `Formatter` when shaping API/FE-facing responses; use `Mapper` only when the codebase already uses that term for the same job.
  - Make the formatter request-scoped only when it actually needs request/user context; otherwise keep it singleton.
- `*.schema.ts`
  - Use when schemas are shared across multiple DTOs/files or when a DTO file becomes too noisy.
  - Keep schemas in `*.dto.ts` if they are local to one request/response contract and easier to read in place.
- `*.util.ts`
  - Use only when helpers are reused across files or the helper logic is meaningfully independent of DTO/controller/service concerns.
  - Avoid creating a util file for one-off local helpers.
  - If moving code to `*.util.ts` makes a module harder to read because callers must jump files for one local rule, keep it local.
- `*.query-builder.ts`
  - Keep query composition, filter normalization, and query-shape helpers only.
  - Do not mix repository calls, controller parsing, or formatter logic into it.
- `*.api-error.ts`
  - Keep typed upstream error classes and API-specific error wrappers only.
  - Do not mix generic business exceptions into these files.

16. Keep tests scoped to the layer
- Controller specs should test controller behavior, delegation, and formatting ownership.
- Service specs should test business logic and orchestration, not formatter behavior.
- Formatter specs should test mapping and parse/error behavior.
- Avoid standalone DTO-only specs by default unless the schema logic is unusually tricky, has already regressed, or the user explicitly wants it.

17. Prefer string-safe decimal validation for user-entered money values
- Normalize numeric input to strings before enforcing decimal precision rules.
- Apply the same positivity and precision rules to both string and number paths.
- Avoid float-sensitive checks that can false-negative valid decimal input.

18. Keep AOP and transport decorators declarative
- Interceptors, guards, pipes, and decorators must not contain business logic.
- Keep transport-binding decorators (`@MessagePattern`, `@EventPattern`, route decorators) in controllers, not services.
- Example:
  - Good: a guard checks authentication, a pipe validates input shape, and the service decides whether a repayment deposit is allowed.
  - Bad: a guard or interceptor contains repayment eligibility rules, mutates business state, or hides domain decisions outside the service.

19. Name things after their real responsibility
- Module, service, and class names should match the business/domain role they actually serve.
- If a class named `Adapter` only shapes output, rename it to `Formatter` (or the repo's equivalent).
- Multiple controllers in one module are fine when they improve traceability.

20. Keep TypeScript strict without escape hatches
- Remove double assertions like `as unknown as X`; fix the underlying type mismatch instead.
- Follow the project convention for `interface` vs `type` on object shapes. When no convention exists, prefer `interface` for object contracts.
- Add explicit access modifiers (`private`, `protected`, `readonly`) to injected constructor fields.

21. Log deliberately
- Never log full request or response bodies by default.
- Log only the fields you explicitly need.
- Sanitize PII and secrets before writing logs.
- Ensure validation and parse failures produce a useful structured log entry.

22. Treat clients and deployments as failure-prone boundaries
- Do not enable automatic retries on mutation-capable HTTP calls unless the retry policy is explicitly safe.
- Treat frontend and backend as independently deployable; avoid changes that assume synchronized rollout.
- Do not allow circular dependencies between shared libraries and app-layer code.

23. Remove stale artifacts while touching code
- Replace stale lint-suppression comments with idiomatic fixes when you are already in the file.
- Remove leftover spies, mocks, fixtures, duplicate interfaces, and stale comments after refactors.
- If an existing pattern keeps causing downstream issues, fix the root pattern instead of layering more workarounds.

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
- [ ] Used `useMemo`/`useCallback`/`useEffect` only with a clear reason
- [ ] Matched the nearest mature module before inventing a new layer split
- [ ] Kept controller/service/formatter or controller/service/mapper responsibilities clean
- [ ] Split oversized services by operation family when needed
- [ ] Avoided thin repositories and duplicate validation layers
- [ ] Put helpers in the right file boundary (`.dto.ts`, `.type.ts`, `.constant.ts`, `.util.ts`)
- [ ] Kept DTO helpers local unless reuse justified extraction
- [ ] Kept tests scoped to the layer under test
- [ ] Used string-safe decimal validation for user-entered money values
- [ ] Kept AOP/decorator code declarative with no business logic
- [ ] Names match actual responsibilities
- [ ] Avoided double assertions and added explicit access modifiers where needed
- [ ] Logging avoids full bodies and sanitizes sensitive data
- [ ] No automatic retries on unsafe mutation clients; no synchronized-deploy assumptions
- [ ] Removed stale suppressions, stale comments, and leftover test artifacts
- [ ] Ran lint/typecheck/tests and ensured no new warnings in touched scope

## Suggested Trigger Phrases

- "implementation conventions"
- "avoid overengineering"
- "clean up dead code"
- "should we use useMemo here"
- "match the existing module pattern"
- "controller service formatter split"
- "do we need this repository"
- "where should this validation live"
- "should this be in constants"
- "do we need a util file"
- "should this stay in type ts"
- "should this live in the controller or service"
- "is this really a formatter"
- "double assertion"
- "should this retry"
- "is this safe for staggered deploys"
- "can I log this body"
