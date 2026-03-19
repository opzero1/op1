# Planning Question Quality Evaluation

This benchmark compares planning behavior before and after the planning-mode pattern-scout change.

## Goal

Measure whether planning removes uncertainty earlier so implementation starts with fewer follow-up clarification questions.

## Evaluation Inputs

Use the cases in `docs/evaluations/planning-question-quality-cases.json`.

For each case, capture two runs:
- `before`: planner behavior without the new pattern-scout flow
- `after`: planner behavior with the new pattern-scout flow enabled

## What To Measure

For the planning run:
- whether the planner ran a bounded repo scout before drafting
- whether it surfaced a concrete pattern decision or a bounded best-practice fallback
- whether the approval step included concrete file references and a minimal code example
- whether approved guidance was persisted in plan context with `source_type` and `code_example`

For the implementation follow-through (`/work` or equivalent execution):
- number of follow-up clarification questions asked before coding starts
- whether the agent reused the approved implementation reference instead of rediscovering patterns
- whether execution stayed inside the planned blast radius

## Scoring Rubric

Score each case from 0-2 on each dimension:

1. `repo_pattern_grounding`
   - `0`: no concrete scout evidence
   - `1`: mentions precedent but without tight references
   - `2`: cites concrete files/symbols from a bounded scout pass

2. `approval_quality`
   - `0`: no explicit pattern approval question
   - `1`: asks for approval but without a useful example
   - `2`: asks for approval with concrete references and a minimal code example

3. `persistence_quality`
   - `0`: no canonical implementation reference persisted
   - `1`: pattern stored, but example is incomplete
   - `2`: approved guidance stored with `source_type` and `code_example`

4. `execution_clarification_load`
   - `0`: execution needs 3+ follow-up clarification questions
   - `1`: execution needs 1-2 follow-up clarification questions
   - `2`: execution starts coding with 0 follow-up clarification questions

## Success Threshold

The change is a win when:
- `after.execution_clarification_load` improves in most cases
- repo-pattern cases reach `2` for `repo_pattern_grounding`
- fallback cases reach `2` for `approval_quality` and `persistence_quality`
- the median number of execution-time follow-up clarification questions drops versus `before`

## Notes

- This benchmark is intentionally lightweight and repo-grounded.
- It is acceptable to run it manually at first; the artifact exists so the comparison stays repeatable.
