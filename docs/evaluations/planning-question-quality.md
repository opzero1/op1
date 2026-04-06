# Planning Question Quality Evaluation

This benchmark compares planning behavior before and after the adaptive primary-kind + overlay upgrade.

## Goal

Measure whether `/plan` detects the right planning shape earlier, deep-grills execution-critical gaps without showing a questionnaire, and leaves `/work` with no need to rediscover the approved contract.

## Evaluation Inputs

Use the cases in `docs/evaluations/planning-question-quality-cases.json`.

For each case, capture two runs:
- `before`: planner behavior before adaptive primary-kind + overlay planning
- `after`: planner behavior after adaptive primary-kind + overlay planning

## What To Measure

For the planning run:
- whether the planner detected the right `primary_kind`
- whether it activated the right additive `overlays`
- whether it ran a bounded repo scout before drafting
- whether it deep-grilled unresolved execution branches internally while still asking one question at a time
- whether it made missing-context behavior explicit instead of leaving `/work` to guess
- whether it made state ownership explicit instead of leaving source-of-truth questions open
- whether it surfaced a concrete pattern decision or a bounded best-practice fallback
- whether the approval step included concrete file references and a minimal code example
- whether it resolved the execution contract branches (`non_goals`, `happy_path`, `expected_outcome`, `missing_context_behavior`, `approval_readiness_rules`, `state_ownership`, `dependencies`, `triggers`, `invariants`, `tests`)
- whether approved guidance was persisted in plan context with `primary_kind`, `overlays`, `source_type`, and `code_example`

For the implementation follow-through (`/work` or equivalent execution):
- number of follow-up clarification questions asked before coding starts
- whether the agent reused the approved implementation reference instead of rediscovering patterns
- whether `/work` reused the persisted `primary_kind` + `overlays` contract instead of reclassifying the task
- whether execution stayed inside the planned blast radius
- whether mixed-overlay plans resumed with the right unresolved blocker summary after delegated child work completes
- for frontend-ownership cases, whether clearly frontend-owned work is delegated/rerouted to `frontend` instead of being implemented directly by `build`/`coder`

## Scoring Rubric

Score each case from 0-2 on each dimension:

1. `repo_pattern_grounding`
   - `0`: no concrete scout evidence
   - `1`: mentions precedent but without tight references
   - `2`: cites concrete files/symbols from a bounded scout pass

2. `primary_kind_detection`
   - `0`: no explicit kind detection
   - `1`: kind is implied but not stated clearly
   - `2`: planner states the primary kind explicitly and uses it to shape the interview

3. `overlay_activation`
   - `0`: planner behaves as single-mode
   - `1`: mentions overlays or extra branches, but incompletely
   - `2`: planner activates the right additive overlays and maps them to extra branches

4. `approval_quality`
   - `0`: no explicit pattern approval question
   - `1`: asks for approval but without a useful example
   - `2`: asks for approval with concrete references and a minimal code example

5. `persistence_quality`
   - `0`: no canonical implementation reference or adaptive context persisted
   - `1`: stores some context, but misses key adaptive fields
   - `2`: stores `primary_kind`, `overlays`, execution branches, `source_type`, and `code_example`

6. `deep_grill_quality`
   - `0`: stops after the first obvious gap or dumps a questionnaire
   - `1`: partially probes deeper branches, but misses overlay-specific gaps
   - `2`: deep-grills unresolved execution branches while still keeping one visible question at a time

7. `execution_clarification_load`
   - `0`: execution needs 3+ follow-up clarification questions
   - `1`: execution needs 1-2 follow-up clarification questions
   - `2`: execution starts coding with 0 follow-up clarification questions

8. `handoff_reuse`
   - `0`: `/work` reclassifies the task or ignores the approved planning contract
   - `1`: `/work` reuses some context, but still re-asks or rediscoveries remain
   - `2`: `/work` reuses the saved contract, follows approved references, and preserves the right blocker context through follow-through

## Success Threshold

The change is a win when:
- `after.primary_kind_detection` improves in most cases
- `after.overlay_activation` improves in most cases
- `after.deep_grill_quality` improves in most cases
- `after.execution_clarification_load` improves in most cases
- mixed-overlay cases reach `2` for `handoff_reuse`
- repo-pattern cases reach `2` for `repo_pattern_grounding`
- fallback cases reach `2` for `approval_quality` and `persistence_quality`
- the median number of execution-time follow-up clarification questions drops versus `before`

## Notes

- This benchmark stays lightweight and repo-grounded.
- It is acceptable to run it manually at first; the artifact exists so the comparison stays repeatable.
- The key regressions to catch are single-mode planning, shallow questioning, lost overlay context, and `/work` re-asking already confirmed branches.
