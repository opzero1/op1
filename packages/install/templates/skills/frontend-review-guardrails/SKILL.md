---
name: frontend-review-guardrails
description: Frontend implementation and review guardrails for fail-closed API boundaries, schema validation, UX parity, async UI-state isolation, and deprecation hygiene. Use for FE coding and review across products.
---

# Frontend Review Guardrails

Apply this checklist when implementing or reviewing frontend work.

## 1) API/Query Layer

- Treat API responses as `unknown` first, then parse.
- Use schema validation (`zod`) for response boundaries.
- Keep critical fields non-optional after parsing (fail-closed).
- Keep API hooks in shared query/data layer; keep UI composition in feature module.

## 2) Async UI/Download Flows

- Prefer mutation/imperative semantics for click-to-download interactions.
- Do not let shared query state unintentionally couple independent buttons.
- Keep loading ownership local to each button/component unless global lock is intentional.
- Keep one clear error-copy source for equivalent domain actions.

## 3) UI/Formatting Parity

- Match product spec/staging formatting exactly (dates, separators, labels).
- Reuse existing translation key families when behavior is equivalent.
- Keep layout ownership in feature wrappers/styles; do not rely on internal design-system styled props.

## 4) Code Style

- In new/touched code, avoid explicit `(): React.ReactElement` unless required.
- Extract row-level actions from large table containers.
- Fix deprecation warnings in touched code paths.

## 5) Review Pass

- Verify fail-closed behavior at API boundaries.
- Verify no unintended cross-component loading/disabled coupling.
- Verify message/copy consistency for equivalent actions.
- Run targeted typecheck/tests for touched feature.
