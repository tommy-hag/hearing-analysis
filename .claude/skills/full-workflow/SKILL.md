---
name: full-workflow
description: End-to-end implementation cycle med automatisk test og evaluering
argument-hint: <task-description>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Full Workflow

End-to-end implementation cycle der autonomt implementerer, tester og itererer.

## Formål

Komplet workflow fra opgave til færdig, testet løsning - med intelligent kvalitetsevaluering i hvert trin.

## Workflow Oversigt

```
┌─────────────────────────────────────────────────────────┐
│  1. UNDERSTAND                                          │
│     Parse opgave, identificér scope og succeskriterier  │
├─────────────────────────────────────────────────────────┤
│  2. IMPLEMENT                                           │
│     Skriv/edit kode eller prompts                       │
├─────────────────────────────────────────────────────────┤
│  3. TEST                                                │
│     Kør relevant test (pipeline, prompt-test)           │
├─────────────────────────────────────────────────────────┤
│  4. EVALUATE                                            │
│     Kvalitetsvurder output mod opgavens intent          │
├─────────────────────────────────────────────────────────┤
│  5. ITERATE OR COMPLETE                                 │
│     IF pass → TASK_COMPLETE                             │
│     ELSE → Fix issues og gentag fra step 2              │
└─────────────────────────────────────────────────────────┘
```

## Detaljeret Workflow

### Phase 1: Understand

1. **Parse Opgaven**
   - Hvad skal implementeres/ændres?
   - Hvilke filer er involveret?
   - Hvad er succeskriterier?

2. **Explore Codebase**
   - Læs relevante filer
   - Forstå eksisterende implementation
   - Identificér dependencies

### Phase 2: Implement

1. **Make Changes**
   - Edit eksisterende filer (foretrukket)
   - Skriv nye filer kun hvis nødvendigt
   - Hold ændringer minimale og fokuserede

2. **Document Changes**
   - Notér hvad der blev ændret
   - Notér forventet effekt

### Phase 3: Test

Vælg passende test baseret på ændring:

| Ændring | Test Kommando |
|---------|---------------|
| Prompt ændring | `/prompt-test` |
| Pipeline kode | `/pipeline-run` med begrænset data |
| Bug fix | Reproducér original fejl, verificér fix |

### Phase 4: Evaluate

Kør `/evaluate-quality` på output:
- Score alle dimensioner
- Identificér issues
- Vurdér task alignment

### Phase 5: Iterate or Complete

**IF PASS (score >= 3.5, no critical issues):**
```
TASK_COMPLETE

## Summary
[Hvad blev implementeret]

## Changes Made
- file1.md: [beskrivelse]
- file2.js: [beskrivelse]

## Quality Score: 4.2/5
- Faithfulness: 4
- Completeness: 4
- Clarity: 4
- Structure: 4
- Task Alignment: 5

## Test Results
[Pipeline kørsel eller test output]
```

**IF FAIL (score < 3.5 or critical issues):**
```
Iteration {n}: Score {score}

Issues identified:
1. [Issue 1] - Fix: [suggestion]
2. [Issue 2] - Fix: [suggestion]

Implementing fixes...
```

Fortsæt til Phase 2 med fixes.

## Eksempel Brug

```bash
/full-workflow "Tilføj støtte for at håndtere tomme responses i micro-summarizer"
```

## Iteration Limits

- Max 5 iterationer
- Ved 3+ iterationer uden forbedring: NEEDS_HUMAN_REVIEW
- Altid rapporter score-udvikling

## Quality Gates

Begge layers skal bestås:

**Layer 1: Teknisk**
- Ingen validation errors
- respondentCoverage.allRepresented: true
- Ingen pipeline errors

**Layer 2: Semantisk**
- overall_score >= 3.5
- Ingen critical issues
- Task alignment >= 3

## Completion Markers

Afslut altid med en af disse markers:

- `TASK_COMPLETE` - Opgave løst, quality gates bestået
- `NEEDS_HUMAN_REVIEW` - Automatisk løsning ikke mulig
- `BLOCKED` - Ekstern dependency eller information mangler

## Report Format

```markdown
## Full Workflow Report

**Task:** [Original opgavebeskrivelse]

**Status:** TASK_COMPLETE | NEEDS_HUMAN_REVIEW | BLOCKED

**Iterations:** 2

### Iteration History
| # | Action | Score | Result |
|---|--------|-------|--------|
| 1 | Initial implementation | 2.8 | Issues: completeness |
| 2 | Added handling for edge case | 4.1 | Pass |

### Changes Made
- `analysis-pipeline/prompts/micro-summary-prompt.md`: Added empty response handling

### Final Quality Score
Overall: 4.1/5
- Faithfulness: 4
- Completeness: 4
- Clarity: 4
- Structure: 4
- Task Alignment: 5

### Test Evidence
[Relevant output eller log excerpts]
```
