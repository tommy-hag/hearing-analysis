---
name: evaluate-quality
description: Evaluer output kvalitet mod opgavens hensigt
argument-hint: <output-path> [original-task]
allowed-tools: Read, Grep, Glob
---

# Evaluate Quality

Evaluer om et pipeline output opfylder den oprindelige opgave med LLM-baseret kvalitetsvurdering.

## Formål

Intelligent kvalitetsevaluering der forstår opgavens intent - ikke bare tekniske metrics.

## Workflow

### 1. Forstå Opgaven

- Læs original task description (fra argument eller konversation)
- Identificer succeskriterier
- Forstå hvad brugeren ønsker at opnå

### 2. Læs Output

Find og læs relevant output:

```bash
# Final analysis
analysis-pipeline/output/runs/{hearingId}/{label}/hearing-{hearingId}-analysis.md

# Run summary (tekniske metrics)
analysis-pipeline/output/runs/{hearingId}/{label}/run-summary.md

# Checkpoints hvis relevant
analysis-pipeline/output/runs/{hearingId}/{label}/checkpoints/
```

### 3. Evaluer Dimensioner

| Dimension | Spørgsmål at stille |
|-----------|---------------------|
| **Faithfulness** | Er summaries tro mod citations? Siger opsummeringen noget citatet ikke understøtter? |
| **Completeness** | Mangler der vigtige pointer? Er alle relevante aspekter dækket? |
| **Clarity** | Er sproget klart og professionelt? Kan en forvaltningsmedarbejder forstå det? |
| **Structure** | Er output velorganiseret? Giver temaer og positioner mening? |
| **Task Alignment** | Opfylder det specifikt det efterspurgte? Matcher det brugerens mål? |

### 4. Tjek Tekniske Metrics

Fra `run-summary.md` eller `run-summary.json`:
- `validation.errors` - Skal være tom
- `respondentCoverage.allRepresented` - Skal være true
- `citations.invalid` - Skal være 0

### 5. Generer Output

Returner struktureret evaluering:

```json
{
  "overall_score": 4.2,
  "pass": true,
  "dimensions": {
    "faithfulness": { "score": 5, "note": "..." },
    "completeness": { "score": 4, "note": "..." },
    "clarity": { "score": 4, "note": "..." },
    "structure": { "score": 4, "note": "..." },
    "task_alignment": { "score": 4, "note": "..." }
  },
  "technical_checks": {
    "validation_errors": 0,
    "all_respondents_represented": true,
    "invalid_citations": 0
  },
  "issues": [
    {
      "severity": "medium",
      "location": "Tema 2, Position 3",
      "description": "...",
      "fix_suggestion": "..."
    }
  ],
  "continue_recommended": false,
  "summary": "Kort opsummering af evalueringen"
}
```

## Scoring Guide

| Score | Betydning |
|-------|-----------|
| 5 | Fremragende - Ingen forbedringer nødvendige |
| 4 | Godt - Mindre justeringer mulige |
| 3 | Acceptabelt - Fungerer men med klare forbedringspotentialer |
| 2 | Problematisk - Væsentlige issues der bør adresseres |
| 1 | Utilstrækkeligt - Fundamentale problemer |

## Pass/Fail Kriterier

**PASS (overall_score >= 3.5):**
- Output opfylder opgaven tilfredsstillende
- Ingen critical issues
- Tekniske checks bestået

**FAIL (overall_score < 3.5):**
- Output har væsentlige mangler
- Fortsættelse anbefalet med specifik guidance

## Eksempel

```bash
# Evaluer seneste kørsel
/evaluate-quality analysis-pipeline/output/runs/223/20260127-1430-test/hearing-223-analysis.md

# Med explicit task
/evaluate-quality analysis-pipeline/output/runs/223/latest/hearing-223-analysis.md "Forbedre håndtering af korte svar"
```

## Output Lokationer

Typiske stier at evaluere:

```
analysis-pipeline/output/runs/{hearingId}/{label}/
├── hearing-{hearingId}-analysis.md    # Final output
├── run-summary.md                      # Teknisk rapport
├── run-summary.json                    # Maskinlæsbar rapport
└── checkpoints/                        # Step outputs
    ├── microSummaries.json
    ├── aggregate.json
    └── hybridPositions.json
```
