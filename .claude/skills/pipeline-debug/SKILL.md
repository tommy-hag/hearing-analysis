---
name: pipeline-debug
description: Diagnosticér fejl i pipeline kørsler ved at læse logs, checkpoints og LLM-kald
argument-hint: <hearingId> [checkpoint-label]
allowed-tools: Bash, Read, Grep, Glob
---

# Pipeline Debug - Diagnosticér Pipeline Problemer

Debug workflow til at finde og diagnosticere fejl i pipeline kørsler.

## Filstruktur

Pipeline output ligger i:
```
analysis-pipeline/output/runs/{hearingId}/{label}/
├── terminal.log          # Komplet log output
├── progress.json         # Progress status
├── run-summary.json      # Kvalitetsmetrics
├── run-summary.md        # Læsbar kvalitetsrapport
├── checkpoints/          # Step outputs som JSON
├── llm-calls/            # Rå LLM requests/responses
└── step-logs/            # Per-step logs
```

## Debug Workflow

### 1. Læs Run Summary
Start med kvalitetsrapporten for at forstå hvad der gik galt:
```bash
cat output/runs/{hearingId}/{label}/run-summary.md
```

### 2. Søg Fejl i Logs
Find errors og failures:
```bash
grep -i "error\|fail\|exception" output/runs/{hearingId}/{label}/terminal.log
```

### 3. Inspicér Checkpoints
Se checkpoint data for at finde data-issues:
```bash
ls output/runs/{hearingId}/{label}/checkpoints/
# Læs specifikt checkpoint
cat output/runs/{hearingId}/{label}/checkpoints/{step}.json | head -100
```

### 4. Undersøg LLM Kald
Find problematiske LLM responses:
```bash
ls output/runs/{hearingId}/{label}/llm-calls/
# Læs et specifikt kald
cat output/runs/{hearingId}/{label}/llm-calls/{step}-{n}.json
```

## Typiske Problemer

### API Fejl
- Rate limiting: Check for 429 errors
- Token overflow: Check prompt length i llm-calls

### Data Problemer
- Manglende responses: Check input data
- Encoding issues: Check for unicode problemer

### Logic Fejl
- Step skipped: Check progress.json for step status
- Partial completion: Check checkpoint for incomplete data

## Output Format

Rapportér:
1. **Root Cause**: Hvad forårsagede fejlen
2. **Relevante Filer**: Paths til logs/checkpoints med problemet
3. **Foreslået Fix**: Konkret løsningsforslag
