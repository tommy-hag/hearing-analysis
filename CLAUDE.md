# CLAUDE.md - AI Assistant Guide

This document provides context for AI assistants working on this codebase.

## Project Overview

**Bliv Hørt AI** is a full-stack application for analyzing Danish public consultation responses (høringssvar). It consists of two integrated parts:

1. **Web Application** (`server.js`, `public/`) - Search, browse, and manage hearing data
2. **Analysis Pipeline** (`analysis-pipeline/`) - AI-powered analysis generating structured summaries

**Primary Language:** JavaScript (Node.js)
**Domain Language:** Danish (user-facing output, prompts, and documentation)

## Quick Start

```bash
# Install all dependencies
npm install
npm run pipeline:install

# Start the web server
npm start

# Run analysis pipeline on a hearing
npm run pipeline:run -- 223 --checkpoint=test01 --save-checkpoints --write
```

## Architecture

```
hearing-analysis/
├── server.js              # Express server (10,800+ lines)
├── db/sqlite.js           # Database layer (SQLite)
├── public/                # Frontend files
│   ├── index.html         # Main search page
│   ├── gdpr.html          # GDPR data preparation
│   ├── analysis.html      # Analysis viewer
│   ├── work.html          # Work interface
│   └── js/                # Frontend JavaScript
├── analysis-pipeline/     # AI analysis pipeline
│   ├── CLAUDE.md          # Detailed pipeline documentation
│   ├── src/               # Pipeline modules
│   ├── prompts/           # LLM prompt templates
│   └── config/            # Pipeline configuration
├── scripts/               # Utility scripts (data fetch, cron, debug)
├── prompts/               # Web app prompts
├── templates/             # DOCX templates
├── data/                  # SQLite database and hearing data
└── uploads/               # GDPR file staging
```

## Key Components

### Web Application (server.js)

- **Search API**: `/api/search`, `/api/hearings/:id`
- **GDPR Preparation**: `/gdpr.html` - Prepare hearing data for analysis
- **Pipeline Integration**: `/api/pipeline/:hearingId/*` - Start/monitor/download analyses
- **Analysis Viewer**: `/analysis.html` - Interactive analysis results

### GDPR Workflow

The GDPR workflow prepares raw hearing data for AI analysis by allowing manual review and redaction of sensitive content.

**Flow:** Raw Data → GDPR Review → Published (ready for analysis)

Key endpoints:
- `/api/gdpr/hearings` - List GDPR-prepared hearings
- `/api/gdpr/hearing/:id/responses` - Get responses for review
- `/api/gdpr/hearing/:id/publish` - Publish approved data

### Analysis Pipeline

See `analysis-pipeline/CLAUDE.md` for detailed pipeline documentation.

Key entry points:
- CLI: `analysis-pipeline/scripts/run-pipeline.js`
- Orchestrator: `analysis-pipeline/src/pipeline/pipeline-orchestrator.js`

### Database Layer (db/sqlite.js)

Handles all data persistence:
- Hearing metadata and responses
- Vector embeddings for semantic search
- GDPR staging tables
- Analysis results

### API Endpoints

**Core API:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | GET | Search hearings and responses |
| `/api/hearing/:id` | GET | Get hearing details |
| `/api/hearings` | GET | List all hearings |

**Pipeline Integration:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pipeline/:id/status` | GET | Check pipeline status |
| `/api/pipeline/:id/start` | POST | Start new analysis |
| `/api/pipeline/:id/progress` | GET | Get progress details |
| `/api/pipeline/:id/download` | GET | Download DOCX result |
| `/api/pipeline/:id/analysis` | GET | Get analysis JSON |
| `/api/pipeline/:id/citation/:num` | GET | Get citation with context |
| `/api/pipeline/:id/search` | GET | Search in responses |

**GDPR Workflow:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/gdpr/hearings` | GET | List GDPR-prepared hearings |
| `/api/gdpr/hearing/:id/responses` | GET | Get responses for review |
| `/api/gdpr/hearing/:id/publish` | POST | Publish approved data |

**Infrastructure:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health`, `/healthz` | GET | Health checks |
| `/api/rebuild-index` | POST | Rebuild search index |

## Development Philosophy

### Root Cause Focus
Large codebase. Always ensure solutions fix problems at the root - not quick-fixes on faulty architecture.

### Test Before Completion
Test and debug implementations. Only complete when you have a tested solution.

### Agenter: Brug CLI, Ikke Workbench (HÅRD CONSTRAINT)
Agenter og subagenter må **IKKE** bruge `pipeline-workbench.js` til pipeline-kørsler. Workbench er kun til manuel interaktiv udvikling.

Agenter skal bruge CLI-kommandoerne:
- `npm run pipeline:run -- {hearingId} [flags]`
- `npm run pipeline:step -- {hearingId} --step={step} [flags]`

Se `analysis-pipeline/CLAUDE.md` → "Iterativ Udvikling & Hurtig Test" for korrekt flag-brug.

### No Hardcoding (HÅRD CONSTRAINT)
Avoid hardcoding case-specific solutions. Test on multiple hearings to verify generic solutions.

**FORBUDT:**
- ❌ Keyword-lister: `['grim', 'bevaring', 'palads', 'hotel']` - case-specifik
- ❌ Regex med specifikke ord: `/palads|hotel|biograf/i` - virker kun for én høring
- ❌ Hardcodede tema-navne eller kategorier fra en specifik case

**TILLADT:**
- ✅ LLM-baseret forståelse via prompts (generiske instruktioner, ikke case-specifikke)
- ✅ Embedding-baseret semantisk lighed
- ✅ Strukturelle regler (fx "NEUTRAL merges ikke med AGAINST")
- ✅ Metadata fra micro-summary (`direction` felt er LLM-klassificeret)

**HVORFOR:** En løsning der virker på hearing 223 (Palads) skal OGSÅ virke på hearing om vejbyggeri, parkrenovering, skolelukninger, etc. Keyword "grim" betyder 1000 forskellige ting i forskellige kontekster.

## Common Tasks

### Starting the Server
```bash
npm start          # Production
npm run dev        # Development with watch
```

### Running Pipeline Analysis
```bash
# Basic pipeline run
npm run pipeline:run -- 223 --checkpoint=test01 --save-checkpoints --write

# Iterative testing with material cache (automatic reuse)
npm run pipeline:run -- 223 --limit-responses=10 --save-checkpoints  # First run
npm run pipeline:run -- 223 --limit-responses=50 --save-checkpoints  # Reuses material analysis

# Run SINGLE STEP for quick iteration (requires existing checkpoint)
npm run pipeline:step -- 223 --step=aggregate --checkpoint=baseline
npm run pipeline:step -- 223 --step=consolidate-positions --checkpoint=baseline --print
```

> **For advanced usage** (resume, checkpoints, response filtering, iterative testing, material cache):
> See `analysis-pipeline/CLAUDE.md` → "Iterativ Udvikling & Hurtig Test"

### Debugging
```bash
# Server logs
tail -f server.log

# Pipeline logs (label auto-genereres som YYYYMMDD-HHMM-xx[-checkpoint])
cat analysis-pipeline/output/runs/223/{label}/terminal.log
```

## Available Skills (Slash Commands)

Claude Code har adgang til specialiserede skills. **Brug dem proaktivt**:

### Pipeline Skills

| Skill | Brug når... |
|-------|-------------|
| `/pipeline-run` | En analyse skal køres eller kodeændringer skal testes |
| `/pipeline-debug` | En kørsel fejler eller giver uventede resultater |
| `/prompt-test` | En prompt-fil er ændret og skal verificeres |
| `/review-output` | Output skal kvalitetstjekkes før det præsenteres |
| `/evaluate-quality` | Output skal vurderes mod opgavens intent (LLM-baseret) |
| `/auto-fix-pipeline` | Automatisk fix-test loop indtil kvalitetsmål opfyldt |
| `/full-workflow` | End-to-end implementation med test og evaluering |

### Web Application Skills

| Skill | Brug når... |
|-------|-------------|
| `/api-test` | Et API endpoint skal testes eller verificeres |
| `/db-inspect` | Database-tilstand eller relationer skal undersøges |
| `/server-debug` | Server-fejl skal diagnosticeres via logs |
| `/frontend-review` | Frontend-kode skal gennemgås for kvalitet |
| `/web-feature` | En ny feature skal implementeres end-to-end |
| `/search-debug` | Søgefunktionalitet eller embeddings skal debugges |

**Autonomt workflow eksempel:**
`/full-workflow "Forbedre micro-summary"` → implementer → test → evaluer → fix → gentag indtil score >= 3.5

**Manuelt workflow eksempel:**
Efter ændring af `micro-summary-prompt.md` → kør `/prompt-test` → ved problemer `/pipeline-debug` → til sidst `/review-output`.

**Web debugging eksempel:**
API fejler → `/server-debug` → find fejl i logs → `/db-inspect` for data → `/api-test` verificer fix.

## External Dependencies

- **OpenAI API**: LLM calls and embeddings
- **SQLite (better-sqlite3)**: Data storage
- **Pandoc**: DOCX generation (optional)
- **Python 3**: PDF conversion (optional)

## Utility Scripts

The `scripts/` directory contains utility scripts for data management and operations:

**Data Fetching:**
- `complete_data_fetch.js` - Full data sync from Bliv Hørt API
- `fetch_api_hearing_data.js` - Fetch hearing data from API

**Scheduled Jobs:**
- `combined-cron.js` - Main scheduled refresh job
- `combined-cron-full.js` - Full refresh including all hearings

**Maintenance:**
- `export_published_hearings.js` - Export hearing data
- Various debugging and testing scripts

## Environment Variables

Key environment variables (see `README.md` for full list):

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key for LLM calls | Yes |
| `DB_PATH` | Path to SQLite database | No (default: `data/hearings.db`) |
| `PORT` | Server port | No (default: 3010) |
| `MODEL_ID` | OpenAI model for analysis | No (default: gpt-5) |

## Important Constraints

1. **Citation Integrity**: Never modify or hallucinate citations
2. **Respondent Coverage**: Every respondent must appear in at least one position
3. **Danish Language**: User-facing text must be in Danish
4. **Security**: Validate all inputs, escape outputs

## Autonomous Workflow Guidelines

### Two-Layer Quality System

Kvalitetsvurdering sker på to niveauer:

**Layer 1: Teknisk Validering** (automatisk fra run-summary)
- Ingen validation errors
- `respondentCoverage.allRepresented: true`
- Ingen pipeline errors

**Layer 2: Semantisk Evaluering** (via quality-evaluator / `/evaluate-quality`)
- Faithfulness >= 4 (summaries matcher citations)
- Completeness >= 3 (vigtige pointer med)
- Task Alignment >= 4 (opfylder specifik opgave)
- Overall score >= 3.5

### Plan Execution Protocol

Efter ExitPlanMode (plan godkendt), følg denne protokol:

1. **Eksekvér plan-items sekventielt**
   - Arbejd gennem hvert item i planen
   - Marker mentalt hvilke items der er færdige

2. **Test efter relevante ændringer**
   - Prompt ændret → `/prompt-test`
   - Pipeline kode ændret → `/pipeline-run` med begrænset data
   - Bug fix → Reproducér og verificér

3. **Evaluer output**
   - Efter pipeline kørsel → `/evaluate-quality`
   - Kræv score >= 3.5 før videre

4. **Marker TASK_COMPLETE**
   - Kun når ALLE plan-items er implementeret
   - Og relevante quality gates er bestået

**Eksempel plan-execution flow:**
```
Plan godkendt med 3 items:
  [x] Item 1: Opdater prompt → testet med /prompt-test
  [x] Item 2: Tilføj edge case → testet
  [ ] Item 3: Kør fuld test → mangler
→ Stop hook: continue, next_action: "Kør /pipeline-run for item 3"
```

### Auto-Continue Logic

Stop hook evaluerer automatisk og fortsætter hvis:
1. Plan-items mangler implementation/test
2. Ingen `TASK_COMPLETE` marker
3. Tekniske valideringer fejler
4. Semantisk score < 3.5
5. Quality-evaluator anbefaler fortsættelse

### Completion Markers

Brug disse markers til at signalere status:
- `TASK_COMPLETE` - Opgave løst, begge quality layers bestået
- `NEEDS_HUMAN_REVIEW` - Ambivalent situation, manuel vurdering nødvendig
- `BLOCKED` - Ekstern dependency eller information mangler

### Iteration Limits

- Max 5 automatiske fix-test cycles
- Ved 3+ iterationer uden score-forbedring: request human guidance
- Altid rapporter score-udvikling over iterationer

### Workflow Skills

| Skill | Formål |
|-------|--------|
| `/evaluate-quality` | LLM-baseret kvalitetsevaluering af output |
| `/auto-fix-pipeline` | Automatisk fix-test loop indtil kvalitetsmål opfyldt |
| `/full-workflow` | End-to-end implementation med test og evaluering |

## See Also

- `analysis-pipeline/CLAUDE.md` - Detailed pipeline documentation
- `analysis-pipeline/STRATEGY.md` - Domain strategy and heuristics
- `analysis-pipeline/docs/INTEGRATION-PLAN.md` - Frontend integration roadmap
