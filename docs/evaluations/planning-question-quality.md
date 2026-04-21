# Planning Question Quality Evaluation

This benchmark compares planning behavior before and after the adaptive primary-kind + overlay upgrade, with extra focus on grill-me questioning quality, explicit pattern approvals, and concrete handoff specificity.

## Goal

Measure whether `/plan` detects the right planning shape earlier, uses grill-me branch-by-branch questioning instead of a thin generic prompt, explicitly asks the human to confirm fallback or non-obvious pattern choices, deep-grills execution-critical gaps without becoming lazy or generic, and leaves `/work` with no need to rediscover the approved contract.

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
- whether it used `grill-me` style branch-by-branch questioning and recommendations
- whether it deep-grilled unresolved execution branches internally while still asking a thoughtful, prioritized question set
- whether the visible questions are forward-facing, concrete, and worth the human thinking time instead of generic planner prompts
- whether broad prompts are first narrowed through a repo-grounded default path and likely file scope before subjective quality-target questions
- whether the planner explicitly separates repo-owned branches (structure, precedent, affected files) from human-owned branches (priority pain, trade-offs, anti-goals, success bar) on broad qualitative asks
- whether the first visible question targets the next unresolved child branch instead of an umbrella approval gate
- whether broad prompts keep grilling through branch frontiers until execution-critical branches are resolved (scope, blast radius, ownership, interfaces, sequencing, verification), not just until one quality axis is chosen
- whether broad qualitative prompts continue past scope + one axis to resolve human-owned trade-off tolerance, unacceptable regressions, and success evidence (or explicit accepted defaults)
- whether recommendations narrow the active branch without short-circuiting unresolved sibling branches
- whether multiple unresolved child branches are handled one-at-a-time in dependency order instead of collapsed into one broad approval question
- whether it asked enough important questions before saving instead of stopping after one thin question
- whether it made missing-context behavior explicit instead of leaving `/work` to guess
- whether it made state ownership explicit instead of leaving source-of-truth questions open
- whether it surfaced a concrete pattern decision or a bounded best-practice fallback
- whether fallback or non-obvious pattern choices got explicit human confirmation with concrete file references and a minimal code example
- whether pattern approval was requested only when the interview had actually reached that fallback/risky/ambiguous pattern branch
- whether context-heavy approval rounds used the native `question` tool well, including inline context such as file references or fenced code snippets when needed
- whether the saved plan named a concrete file change map with explicit add/edit/delete intent
- whether it resolved the execution contract branches required by the chosen kind/overlay (`non_goals`, `happy_path`, `expected_outcome`, `missing_context_behavior`, `approval_readiness_rules`, `state_ownership`, `dependencies`, `triggers`, `invariants`, `tests`)
- whether approved guidance was persisted in plan context with `primary_kind`, `overlays`, `source_type`, `code_example`, and the detailed file change map

For the implementation follow-through (`/work` or equivalent execution):
- number of follow-up clarification questions asked before coding starts
- whether the agent reused the approved implementation reference instead of rediscovering patterns
- whether the agent reused the saved file change map instead of rediscovering which files to add, edit, or delete
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
   - `1`: asks for approval for some patterns or without a useful example
   - `2`: asks for approval for fallback or non-obvious pattern choices with concrete references and a minimal code example

5. `persistence_quality`
   - `0`: no canonical implementation reference or adaptive context persisted
   - `1`: stores some context, but misses key adaptive fields
   - `2`: stores `primary_kind`, `overlays`, execution branches, `source_type`, `code_example`, and `file_change_map_json`

6. `deep_grill_quality`
      - `0`: stops after the first obvious gap or dumps a lazy questionnaire
      - `1`: partially probes deeper branches, but misses overlay-specific gaps or asks weak questions
      - `2`: deep-grills unresolved execution branches, asks the next unresolved child branch in dependency order, avoids umbrella approval gates while branches remain, and keeps unresolved human-owned branches explicit when they still affect execution

7. `question_quality`
   - `0`: asks generic, shallow, or low-value questions
   - `1`: asks some useful questions, but misses depth, prioritization, or clarity
     - `2`: asks the necessary forward-facing, concrete, decision-shaping next-child-branch questions, grounding broad asks in repo-default scope/blast radius before subjective preference branches, then resolving remaining human-owned trade-off/anti-goal/success branches before save while avoiding umbrella approvals or interview padding

8. `plan_specificity`
   - `0`: saved plan remains generic and does not map file operations
   - `1`: names some affected files or pattern references, but file operations stay vague
   - `2`: names concrete files and explicit add/edit/delete intent with rationale

9. `execution_clarification_load`
    - `0`: execution re-opens execution-critical branches or needs 3+ follow-up clarification questions
    - `1`: execution needs 1-2 follow-up clarification questions, but they are not execution-critical branch resets
    - `2`: execution needs at most 1 non-critical follow-up clarification question and does not re-interview execution-critical branches

10. `handoff_reuse`
    - `0`: `/work` reclassifies the task or ignores the approved planning contract
    - `1`: `/work` reuses some context, but still re-asks or rediscoveries remain
    - `2`: `/work` reuses the saved contract, follows approved references and file change map, and preserves the right blocker context through follow-through

## Success Threshold

The change is a win when:
- `after.primary_kind_detection` improves in most cases
- `after.overlay_activation` improves in most cases
- `after.deep_grill_quality` improves in most cases
- `after.question_quality` improves in most cases
- `after.plan_specificity` improves in most cases
- `after.execution_clarification_load` improves in most cases
- mixed-overlay cases reach `2` for `handoff_reuse`
- repo-pattern cases reach `2` for `repo_pattern_grounding`
- fallback cases reach `2` for `approval_quality` and `persistence_quality`
- `after` runs avoid umbrella approval questions while material child branches are still unresolved
- `after` runs do not optimize for "0 follow-up questions" by saving before execution-critical branches are resolved
- broad qualitative `after` runs do not save after scope + one axis when unresolved human-owned branches still materially affect execution
- the median number of execution-time follow-up clarification questions drops versus `before`

## Notes

- This benchmark stays lightweight and repo-grounded.
- It is acceptable to run it manually at first; the artifact exists so the comparison stays repeatable.
- The key regressions to catch are single-mode planning, shallow questioning, missing pattern confirmations, vague file scope, lost overlay context, and `/work` re-asking already confirmed branches.
