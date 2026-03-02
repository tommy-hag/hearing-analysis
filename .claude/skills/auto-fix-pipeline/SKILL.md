---
name: auto-fix-pipeline
description: Automatisk fix-test loop med intelligent kvalitetsevaluering
argument-hint: <hearingId> <task-description>
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# Auto-Fix Pipeline

Automatisk fix-test loop der itererer indtil kvalitetsmål er opfyldt.

## Formål

Autonomt implementere, teste og forbedre indtil output opfylder kvalitetskrav - med minimal manuel intervention.

## Workflow

```
┌─────────────────────────────────────────────────────────┐
│  1. Kør Pipeline                                        │
│     npm run pipeline:run -- {id} --checkpoint={label}   │
├─────────────────────────────────────────────────────────┤
│  2. Evaluer Output                                      │
│     /evaluate-quality på analysis.md                    │
├─────────────────────────────────────────────────────────┤
│  3. Score Check                                         │
│     IF score >= 3.5 AND no critical issues → DONE       │
│     ELSE → Continue to step 4                           │
├─────────────────────────────────────────────────────────┤
│  4. Analysér Issues                                     │
│     Identificér root cause fra evaluering               │
├─────────────────────────────────────────────────────────┤
│  5. Implementér Fix                                     │
│     Edit relevant prompt/kode                           │
├─────────────────────────────────────────────────────────┤
│  6. Re-kør Pipeline                                     │
│     Tilbage til step 1 (max 5 iterationer)              │
└─────────────────────────────────────────────────────────┘
```

## Iteration Tracking

Hold styr på score-udvikling:

```
Iteration 1: score=2.8 (issues: faithfulness, completeness)
Iteration 2: score=3.2 (issues: completeness)
Iteration 3: score=3.8 (pass!)
```

## Stop Conditions

**Success:**
- overall_score >= 3.5
- Ingen critical issues
- Tekniske checks bestået

**Failure (request human guidance):**
- Max 5 iterationer nået
- 3+ iterationer uden score-forbedring
- Samme issue gentages 2+ gange

## Eksempel Brug

```bash
/auto-fix-pipeline 223 "Forbedre micro-summary prompten så korte svar håndteres bedre"
```

## Detaljeret Workflow

### Step 1: Initial Pipeline Run

```bash
npm run pipeline:run -- {hearingId} --checkpoint=autofix-iter1 --save-checkpoints --write --limit-responses=30 --sample-strategy=diverse
```

### Step 2: Evaluate Output

Kør kvalitetsevaluering:
- Læs `hearing-{id}-analysis.md`
- Score alle dimensioner
- Identificér issues med fix-forslag

### Step 3: Analyze and Fix

For hvert issue:
1. Find root cause (micro-summarize, aggregate, eller position-writing)
2. Identificér relevant fil (prompt eller kode)
3. Implementér præcis fix

### Step 4: Re-run with New Checkpoint

```bash
npm run pipeline:run -- {hearingId} --checkpoint=autofix-iter2 --save-checkpoints --write --limit-responses=30 --sample-strategy=diverse
```

### Step 5: Compare and Report

```
## Auto-Fix Report

**Task:** Forbedre håndtering af korte svar

**Iterations:**
| # | Score | Key Issues | Fix Applied |
|---|-------|------------|-------------|
| 1 | 2.8   | Faithfulness: 2, Completeness: 2 | Added nuance instructions |
| 2 | 3.2   | Completeness: 3 | Expanded extraction guidance |
| 3 | 3.8   | None critical | - |

**Result:** PASS after 3 iterations

**Files Modified:**
- analysis-pipeline/prompts/micro-summary-prompt.md

**Final Score Breakdown:**
- Faithfulness: 4
- Completeness: 4
- Clarity: 4
- Structure: 4
- Task Alignment: 3.5

TASK_COMPLETE
```

## Flags for Hurtig Iteration

Brug begrænsede kørsler under iteration:

```bash
--limit-responses=20-30      # Hurtig feedback
--sample-strategy=diverse    # Repræsentativ sample
--resume=micro-summarize     # Hvis kun prompt ændres
```

## Fallback til Human

Hvis auto-fix ikke lykkes:

```
## Auto-Fix Stalled

**Iterations without improvement:** 3
**Recurring issue:** Completeness score stuck at 2.5

**Attempted fixes:**
1. Added extraction instructions
2. Increased context window
3. Added explicit short-answer handling

**Recommendation:** Human review needed for micro-summary-prompt.md

NEEDS_HUMAN_REVIEW
```
