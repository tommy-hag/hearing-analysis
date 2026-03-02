---
name: prompt-test
description: Test ændringer i LLM prompts med målrettede pipeline-kørsler og sammenligning
argument-hint: <prompt-fil> [hearingId]
allowed-tools: Bash, Read, Grep, Glob
---

# Prompt Test - Test Prompt Ændringer

Test ændringer i LLM prompts uden fuld pipeline-kørsel.

## Prompt → Step Mapping

| Prompt Fil | Pipeline Step |
|------------|---------------|
| `micro-summary-prompt.md` | `micro-summarize` |
| `aggregation-prompt.md` | `aggregate` |
| `hybrid-position-writer-prompt.md` | `hybrid-position-writing` |
| `format-output-prompt.md` | `format-output` |

Prompts ligger i: `analysis-pipeline/prompts/`

## Test Strategi

### Test Micro-Summarize Prompt
Kører på rå responses, så vi kan teste fra scratch:
```bash
npm run pipeline:run -- {hearingId} --checkpoint=prompt-test --save-checkpoints --write --limit-responses=15 --sample-strategy=diverse
```

### Test Senere Steps
Brug eksisterende baseline og resume fra det relevante step:
```bash
# Test aggregation prompt
npm run pipeline:run -- {hearingId} --checkpoint=baseline:agg-test --resume=aggregate --save-checkpoints --write

# Test position writing prompt
npm run pipeline:run -- {hearingId} --checkpoint=baseline:pos-test --resume=hybrid-position-writing --save-checkpoints --write
```

## Workbench (Interaktiv Test)

For hurtig iteration på et enkelt step:
```bash
node analysis-pipeline/scripts/pipeline-workbench.js {hearingId} --step={step} --checkpoint={label}
```

## Evalueringskriterier

### Citation Match
- Citater skal matche faktisk indhold i responses
- Kontekst skal være korrekt bevaret

### Position Consistency
- Positioner skal være internt konsistente
- Ingen modsætninger mellem opsummering og citater

### Professionel Tone
- Forvaltningssprog uden følelsesladet sprog
- Neutral og objektiv fremstilling

### Respondent Coverage
- Alle respondenter skal være repræsenteret
- Ingen "orphaned" respondenter

## Sammenligning

Efter test, sammenlign output:
```bash
# Diff mellem baseline og test
diff output/runs/{id}/baseline/hearing-{id}-analysis.md output/runs/{id}/test/hearing-{id}-analysis.md
```

Eller brug run-summary.json metrics til kvantitativ sammenligning.
