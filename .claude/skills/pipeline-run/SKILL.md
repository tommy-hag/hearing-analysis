---
name: pipeline-run
description: Kør analysepipeline på en høring med korrekte flags baseret på formål (test, iteration, patch, fuld analyse)
argument-hint: <hearingId> [formål]
allowed-tools: Bash, Read, Grep
---

# Pipeline Run - Kør Pipeline Analyser

Kør analysepipeline med korrekte flags baseret på brugerens mål.

## Kommando

```bash
npm run pipeline:run -- {hearingId} --checkpoint={label} --save-checkpoints --write [flags]
```

## Flag Strategi

Vælg flags baseret på brugerens formål:

### Ny Feature Test
Test ny funktionalitet på begrænset data:
```bash
--limit-responses=20-50 --sample-strategy=diverse
```

### Prompt Iteration
Sammenlign baseline med test-ændringer:
```bash
--checkpoint=baseline:test --resume={step}
```

### Specifik Respondent Fix
Patch kun bestemte respondenter:
```bash
--patch-baseline={baseline} --response-ids={ids}
```

### Fuld Analyse
Kør komplet analyse:
```bash
--checkpoint={label} --save-checkpoints --write
```

## Vigtige Steps til --resume

- `micro-summarize` - Ekstraher hovedpointer fra hver response
- `aggregate` - Gruppér lignende micro-summaries
- `hybrid-position-writing` - Skriv positioner med citater
- `format-output` - Generer final markdown/docx

## Efter Kørsel

1. Læs `output/runs/{hearingId}/{label}/run-summary.md` for kvalitetsrapport
2. Check `terminal.log` for eventuelle fejl
3. Foreslå næste skridt baseret på resultatet

## Eksempler

```bash
# Test ny prompt på 30 responses
npm run pipeline:run -- 223 --checkpoint=prompt-v2 --save-checkpoints --write --limit-responses=30 --sample-strategy=diverse

# Resume fra aggregate step
npm run pipeline:run -- 223 --checkpoint=baseline:test --resume=aggregate --save-checkpoints --write

# Fuld analyse af høring 456
npm run pipeline:run -- 456 --checkpoint=full-run --save-checkpoints --write
```
