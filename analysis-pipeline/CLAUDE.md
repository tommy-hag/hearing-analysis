# CLAUDE.md - AI Assistant Guide

This document provides context for AI assistants working on this codebase.

> **Se også:** [STRATEGY.md](./STRATEGY.md) for domæne-strategi og heuristikker.
> - **CLAUDE.md** = HOW (implementering, kommandoer, kodestruktur)
> - **STRATEGY.md** = WHY (formål, afvejninger, beslutningslogik)

## Project Overview

This is an **AI-powered hearing analysis pipeline** for processing Danish public consultation responses (høringssvar). It analyzes citizen feedback on municipal documents (local plans, dispensations, policies) and generates structured summaries with citations.

**Primary Language:** JavaScript (Node.js ES modules)
**Domain Language:** Danish (user-facing output, prompts, and documentation)

## Development Philosophy

### Root Cause Focus
Dette er en stor kodebase. Sikr altid at løsninger fikser problemet ved roden - ikke quick-fixes på fejlagtig arkitektur. Undersøg kodebasen grundigt før du foreslår ændringer.

### Diagnosticér Først
Dyk ned i kodebasen og diagnosticér problemer. Forklar dine fund før du spørger brugeren om input.

### Test Før Afslutning
Test og debug altid implementeringer. Afslut først din tur når du har en gennemtestet løsning.

## Quick Start

```bash
# Install dependencies
npm install

# Run a full pipeline analysis
npm run pipeline:run -- 223 --checkpoint=test01 --save-checkpoints --write

# Resume from a specific step
npm run pipeline:run -- 223 --checkpoint=test01 --resume=aggregate --save-checkpoints --write

# Use baseline checkpoint for new experiment
npm run pipeline:run -- 223 --checkpoint=test01:test02 --resume=embedding --save-checkpoints
```

### Pipeline-trin (--resume muligheder)
| Fase | Trin |
|------|------|
| Data | `load-data`, `material-summary`, `analyze-material`, `edge-case-screening`, `enrich-responses` |
| Embedding | `chunking`, `embedding`, `calculate-dynamic-parameters` |
| Analyse | `micro-summarize`, `citation-registry`, `embed-arguments`, `similarity-analysis`, `theme-mapping`, `validate-legal-scope` |
| Aggregering | `aggregate`, `consolidate-positions`, `extract-sub-positions`, `group-positions`, `validate-positions`, `sort-positions` |
| Output | `extract-citations`, `validate-citations`, `hybrid-position-writing`, `validate-writer-output`, `validate-coverage`, `considerations`, `format-output`, `build-docx` |

### Checkpoint Genbrug (VIGTIG)

**Genbrug altid eksisterende checkpoints når du tester ændringer!** Dette sparer tid og penge.

```bash
# Find eksisterende kørsler
ls output/runs/223/

# Genbrug tidlige trin fra baseline, gem nye resultater i nyt checkpoint
npm run pipeline:run -- 223 --checkpoint=baseline:ny-test --resume=aggregate --save-checkpoints --write
```

**Hvilke trin skal du resume fra?**

| Ændring i fil | Resume fra trin |
|---------------|-----------------|
| `prompts/micro-summary-prompt.md` | `micro-summarize` |
| `src/analysis/aggregator.js` | `aggregate` |
| `src/analysis/embedding-clusterer.js` | `aggregate` |
| `src/analysis/position-consolidator.js` | `consolidate-positions` |
| `src/analysis/position-writer.js` | `hybrid-position-writing` |
| `prompts/hybrid-position-writer-prompt.md` | `hybrid-position-writing` |

> ⚠️ **KRITISK:** Resume ALTID fra det trin dit fix påvirker - ikke et senere trin!
> Et checkpoint indeholder pre-beregnede resultater. Hvis du fikser `aggregator.js` men
> resumer fra `hybrid-position-writing`, anvendes dit fix IKKE - checkpointet har
> allerede den gamle (forkerte) aggregering bagt ind.

**Før du resumer en kørsel - verificer tidslinje:**
```bash
# 1. Hvornår blev koden ændret?
stat src/analysis/aggregator.js | grep Modify

# 2. Hvornår kørte det relevante trin i checkpointet?
grep "aggregate" output/runs/223/{checkpoint}/terminal.log | head -5

# 3. Hvis trin kørte FØR kodeændring → resume fra det trin
# 4. Hvis trin kørte EFTER kodeændring → checkpoint har allerede dit fix
```

**Baseline-syntaks:** `--checkpoint=source:target` læser fra `source`, skriver til `target`.

## Architecture

The pipeline consists of **30 modular steps** organized in 5 phases:

```
Phase 1: Data Loading    → load-data, material-summary, analyze-material, extract-substance, edge-case-screening
Phase 2: Embedding       → chunking, embedding, calculate-dynamic-parameters
Phase 3: Analysis        → micro-summarize, theme-mapping, similarity-analysis, validate-legal-scope
Phase 4: Aggregation     → aggregate, consolidate-positions, group-positions, validate-positions, sort-positions
Phase 5: Output          → hybrid-position-writing, extract-citations, validate-coverage, format-output, build-docx
```

### Entry Point

- Main orchestrator: `src/pipeline/pipeline-orchestrator.js`
- CLI runner: `scripts/run-pipeline.js`

## Directory Structure

```
analysis-pipeline/
├── config/
│   ├── pipeline-config.json    # Chunking, embedding, retrieval settings
│   ├── theme-templates.json    # Document type definitions and legal context
│   └── .env                    # API keys and model configuration (copy from env.example.txt)
├── prompts/                    # LLM prompt templates (markdown files)
├── scripts/
│   ├── run-pipeline.js         # Main CLI entry point
│   └── pipeline-workbench.js   # Interactive development workbench
├── src/
│   ├── analysis/               # Core analysis modules
│   │   ├── micro-summarizer.js # Extracts structured arguments from responses
│   │   ├── aggregator.js       # Groups similar arguments into positions
│   │   ├── position-writer.js  # Generates human-readable summaries
│   │   ├── theme-mapper.js     # Maps arguments to taxonomy themes
│   │   ├── edge-case-detector.js # Identifies special cases
│   │   └── ...
│   ├── chunking/               # Text chunking strategies
│   ├── citation/               # Citation extraction and registry
│   ├── embedding/              # Vector embedding generation
│   ├── pipeline/               # Pipeline infrastructure
│   │   ├── pipeline-orchestrator.js  # Main orchestration
│   │   ├── checkpoint-manager.js     # Checkpoint save/load
│   │   ├── incremental-manager.js    # Incremental updates
│   │   └── progress-tracker.js       # Real-time progress
│   ├── retrieval/              # Hybrid retrieval (vector + keyword)
│   ├── utils/                  # Shared utilities
│   │   ├── openai-client.js    # LLM client wrapper
│   │   ├── output-formatter.js # CriticMarkup formatting
│   │   └── docx-builder.js     # DOCX generation
│   └── validation/             # Output validation
├── output/
│   └── runs/{hearingId}/{label}/  # Output per run
└── tests/
```

## Key Code Patterns

### 1. LLM Complexity Tiers

The pipeline uses adaptive model selection based on task complexity:

```javascript
// In openai-client.js - getComplexityConfig()
// Actual values configured in config/.env (LLM_*_MODEL, LLM_*_VERBOSITY, LLM_*_REASONING_LEVEL)
- 'light'       → simple classification
- 'light-plus'  → short but important texts
- 'medium'      → standard extraction
- 'medium-plus' → complex JSON output, focused tasks
- 'heavy'       → text synthesis
- 'ultra'       → critical positions
```

### 2. Citation Registry Pattern

Citations are tracked with unique IDs throughout the pipeline to prevent hallucination:

```javascript
// MicroSummarizer registers: CITE_xxx → original quote
// PositionWriter references: <<REF_X>> placeholders
// CitationExtractor resolves: REF → actual quotes
```

### 3. Checkpoint System

Every step saves its output as JSON, enabling resume and experimentation:

```javascript
// Checkpoint files: output/runs/{hearingId}/{label}/checkpoints/{step}.json
// Resume from step: --resume=aggregate
// Baseline feature: --checkpoint=source:target (read from source, write to target)
```

### 4. CriticMarkup Output Format

Final output uses CriticMarkup syntax for citations:

```markdown
{==highlighted text==}{>>**Henvendelse X**
*"Quote from source"*<<}
```

### 5. Batch Processing

Large operations use batch processing with automatic concurrency control:

```javascript
// Embedding: batch-embedder.js with configurable batch sizes
// Analysis: parallel processing with rate limit handling
// Concurrency: controlled via EMBEDDING_GLOBAL_MAX_CONCURRENCY env var
```

## Configuration

### Environment Variables (config/.env)

Key configuration options:

```bash
# API
OPENAI_API_KEY=...

# LLM tiers (model, verbosity, reasoning level per tier)
LLM_LIGHT_MODEL=gpt-5-nano
LLM_MEDIUM_MODEL=gpt-5-mini
LLM_HEAVY_MODEL=gpt-5-mini

# Embedding
EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_GLOBAL_MAX_CONCURRENCY=5

# Database
DB_PATH=../data/app.sqlite

# Testing
TEST_LIMIT_RESPONSES=35  # Limit responses for testing
```

### Pipeline Config (config/pipeline-config.json)

Controls chunking, embedding, and retrieval behavior. Key sections:

- `chunking`: Response chunking strategy (argument-aligned)
- `materialChunking`: Document chunking (section-aware)
- `embedding`: Model and batch settings
- `retrieval`: Hybrid search configuration

## Common Development Tasks

### Adding a New Pipeline Step

1. Create module in `src/analysis/` or appropriate directory
2. Add step to `stepNameToArtifactKey()` in `pipeline-orchestrator.js`
3. Add execution logic in the orchestrator's run method
4. Create prompt template in `prompts/` if LLM-based

### Adding a New LLM Module (VIGTIGT!)

Når du opretter et nyt modul der bruger `OpenAIClientWrapper`, skal du implementere **alle** følgende punkter for korrekt cost tracking og LLM tracing:

#### 1. I dit nye modul (`src/analysis/my-module.js`):

```javascript
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';

export class MyModule {
  constructor(options = {}) {
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });

    console.log(`[MyModule] Initialized with model=${this.client.model}`);
  }

  /**
   * Set Job ID for tracing - PÅKRÆVET for cost tracking!
   * @param {string} jobId - The job ID for LLM call tracking
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
    // Hvis du har flere clients (light, heavy), sæt på alle:
    // if (this.lightClient) this.lightClient.setJobId(jobId);
  }

  // ... resten af din kode
}
```

#### 2. I orchestratoren (`src/pipeline/pipeline-orchestrator.js`):

**A. Importer og initialiser modulet** (omkring linje 50-130):
```javascript
import { MyModule } from '../analysis/my-module.js';
// ...
this.myModule = new MyModule(options.myModule);
```

**B. Tilføj setJobId kald** (omkring linje 460-470):
```javascript
// Enable tracing for consolidation/grouping components
if (this.positionConsolidator?.setJobId) this.positionConsolidator.setJobId(jobId);
if (this.myModule?.setJobId) this.myModule.setJobId(jobId);  // ← TILFØJ
```

**C. Tilføj til componentsWithClients array** (omkring linje 480-495):
```javascript
const componentsWithClients = [
  this.microSummarizer,
  // ... andre komponenter
  this.myModule,  // ← TILFØJ - nødvendigt for run directory setup
];
```

#### Tjekliste for nyt LLM-modul:

| Krav | Fil | Hvad |
|------|-----|------|
| ✅ `setJobId()` metode | `my-module.js` | Metode der kalder `this.client.setJobId(jobId)` |
| ✅ setJobId kald | `pipeline-orchestrator.js` | `if (this.myModule?.setJobId) this.myModule.setJobId(jobId);` |
| ✅ componentsWithClients | `pipeline-orchestrator.js` | Tilføj `this.myModule` til arrayet |
| ✅ Log ved init | `my-module.js` | `console.log(\`[MyModule] Initialized with model=${this.client.model}\`)` |

**Konsekvens hvis dette mangler:** LLM-kald trackes ikke i `llm-calls/` og medregnes ikke i cost-rapportering i `run-summary.json`.

### Modifying Prompts

Prompt files are in `prompts/*.md`. Key prompts:
- `micro-summary-prompt.md` - Argument extraction
- `aggregation-prompt.md` - Position grouping
- `hybrid-position-writer-prompt.md` - Summary generation

**Vigtig regel**: Undgå at hardcode løsninger fra den konkrete case ind i prompts. Hvis vi gør det, kan vi ikke verificere om vi løser det grundlæggende problem i andre cases. Test altid på flere høringer.

### Debugging a Run

```bash
# View terminal log (label auto-genereres som YYYYMMDD-HHMM-xx[-checkpoint])
cat output/runs/223/{label}/terminal.log

# Check progress
cat output/runs/223/{label}/progress.json | jq

# View run summary (cost, timing, quality)
cat output/runs/223/{label}/run-summary.md

# Inspect checkpoint data
cat output/runs/223/{label}/checkpoints/{step}.json | jq
```

## Testing

```bash
# Run with limited responses for quick testing
TEST_LIMIT_RESPONSES=10 npm run pipeline:run -- 223 --checkpoint=quick-test --save-checkpoints

# Run Python evaluation
python tests/evaluation/test_hearing_223.py
```

## Iterativ Udvikling & Hurtig Test

### Beslutningsmatrix: Hvilken test-tilgang?

| Hvad ændrer du? | Kommando | Tid | Pris |
|-----------------|----------|-----|------|
| Prompt (micro-summarize) | `--limit-responses=15 --sample-strategy=diverse` (fra start) | 5 min | ~$0.15 |
| Aggregator logik | `--checkpoint=base:test --resume=aggregate` | 2 min | ~$0.05 |
| Position writer prompt | `--checkpoint=base:test --resume=hybrid-position-writing` | 5-10 min | ~$0.50 |
| Specifik respondent (i baseline) | `--checkpoint=base:test --response-ids=6,7,42 --resume=micro-summarize` | Varierer | Varierer |
| **Re-process specifikke respondenter (ANBEFALET)** | `--patch-baseline=base --response-ids=6,7,42` | **~5 min** | **~$0.20** |
| Fuld test på sample | `--limit-responses=30 --sample-strategy=representative` (fra start) | 15 min | ~$1.50 |

> ⚠️ **Bemærk:** `--limit-responses` og `--sample-strategy` kan KUN bruges ved ny kørsel fra start - ikke ved resume fra baseline. Se "Vigtig Begrænsning" nedenfor.

### Hurtige Test-Kommandoer

```bash
# NY KØRSEL: Test micro-summarize prompt på 15 diverse responses (fra start)
npm run pipeline:run -- 223 --limit-responses=15 \
  --sample-strategy=diverse --save-checkpoints

# GENBRUG: Test aggregering/konsolidering (genbruger eksisterende micro-summaries)
npm run pipeline:run -- 223 --checkpoint=baseline:agg-test \
  --resume=aggregate --save-checkpoints --write

# GENBRUG: Test specifik respondent fra baseline (skal være i baseline data)
npm run pipeline:run -- 223 --checkpoint=baseline:specifik-test \
  --response-ids=6,7,42,100 --resume=micro-summarize --save-checkpoints

# GENBRUG: Test position writer
npm run pipeline:run -- 223 --checkpoint=baseline:writer-test \
  --resume=hybrid-position-writing --save-checkpoints --write
```

### Response Filtering

| Flag | Beskrivelse | Eksempel |
|------|-------------|----------|
| `--limit-responses=N` | Første N responses | `--limit-responses=20` |
| `--response-ids=IDs` | Specifikke response IDs | `--response-ids=6,7,42,100` |
| `--response-pattern=REGEX` | Filter på navn/tekst | `--response-pattern="Lokaludvalg"` |
| `--sample-strategy=TYPE` | Sampling strategi | `--sample-strategy=diverse` |

**Sampling strategier:**
- `random` - Tilfældig udvælgelse
- `diverse` - Varierende response-længder (spreder på tværs af fordelingen)
- `representative` - Mix af korte/medium/lange (20%/60%/20%)

### 🔧 Patch Mode: Multi-Level Inkrementel Processing

Patch mode er den hurtigste måde at re-processere specifikke respondenter på en eksisterende baseline. Det genbruger så meget som muligt fra baseline og kun re-processer hvad der er nødvendigt.

**Hvornår skal man bruge patch mode?**
- Du har en fuld baseline (fx 3000 respondenter) og vil kun rette 3-50 respondenter
- Du har identificeret problemer med specifikke respondenter og vil re-processere dem
- Du vil iterativt forbedre kvaliteten uden at køre alt forfra

**Kommando:**
```bash
# Patch 3 respondenter og merge med baseline
npm run pipeline:run -- 223 \
  --patch-baseline=baseline \
  --response-ids=6,7,42 \
  --save-checkpoints --write
```

**Hvad sker der?**
1. **Niveau 1 (Micro-summaries)**: Kun response 6, 7, 42 re-summeres og merges med baseline
2. **Niveau 2 (Aggregering)**: Kun temaer der berøres af 6, 7, 42 re-aggregeres
3. **Niveau 3 (Position-writing)**: Kun positioner med 6, 7, 42 re-skrives

**🚀 Light Patch Mode (automatisk for små patches):**

Når du patcher < 1% af respondenterne, aktiveres **Light Patch Mode** automatisk:
- Aggregering skippes helt - baseline position-struktur genbruges
- Kun citation-referencer opdateres for patchede respondenter
- Position-writer re-skriver kun berørte positioner

Dette reducerer patch-tid fra ~8-15 min til ~5 min for 3 respondenter.

```bash
# Light Patch Mode aktiveres automatisk (3/3000 = 0.1%)
npm run pipeline:run -- 223 --patch-baseline=baseline --response-ids=6,7,42 --save-checkpoints --write

# Force fuld re-aggregering (override light patch mode)
npm run pipeline:run -- 223 --patch-baseline=baseline --response-ids=6,7,42 --force-reaggregate --save-checkpoints --write
```

**Estimeret tidsbesparelse:**

| Scenario | Standard | Patch Mode | Light Patch |
|----------|----------|------------|-------------|
| Patch 3 respondenter | 90 min | ~8 min | **~5 min** |
| Patch 10 respondenter | 90 min | ~15 min | ~8 min |
| Patch 50 respondenter (>1%) | 90 min | ~30 min | N/A (full) |

**Vigtige noter:**
- `--patch-baseline` kræver `--response-ids` for at specificere hvilke respondenter der skal patches
- Baseline citation registry hydrates automatisk (nye citations får nye CITE_xxx numre)
- Materiale-relaterede steps (taxonomy, substance, embeddings) genbruges altid fra baseline
- Light Patch Mode aktiveres automatisk når patched responses < 1% af total
- Brug `--force-reaggregate` for at tvinge fuld re-aggregering

**⚠️ Hvornår IKKE at bruge Patch Mode:**

Patch mode er ikke altid den bedste tilgang. Overvej at køre en **ny test med færre responses** i stedet når:

| Situation | Problem med Patch Mode | Bedre alternativ |
|-----------|------------------------|------------------|
| Patchede responses er i mega-positioner | Position-writing tager stadig lang tid (én mega-position = 400s+) | `--limit-responses=30 --sample-strategy=diverse` |
| Du tester prompt-ændringer | Patch mode tester kun de få patchede responses | Fuld test på sample viser bredere effekt |
| Du vil validere ende-til-ende flow | Consolidate/extract-sub-positions kører stadig på ALLE positioner | Mindre dataset giver hurtigere feedback |
| Usikker på hvilke responses der skal patches | Svært at vide hvilke responses der "fejler" | Sample-test identificerer mønstre |

**Tommelfingerregel:** Hvis du ikke ved præcis hvilke respondenter der skal fixes, er `--limit-responses=20-50 --sample-strategy=diverse` ofte hurtigere og mere informativt end patch mode.

```bash
# Alternativ til patch mode: Ny test på diverse sample
npm run pipeline:run -- 223 --limit-responses=30 --sample-strategy=diverse --save-checkpoints --write
# Tid: ~15 min, tester HELE flowet på tværs af forskellige response-typer
```

### 📦 Material Cache: Automatisk genbrug af materiale-analyse

Material cache gemmer materiale-relaterede steps på hearing-niveau, så de kan genbruges på tværs af kørsler med forskellige respondent-scopes.

**Hvad caches?**
- `material-summary` - Sammenfatning af høringsmaterialer
- `analyze-material` - Tema-taksonomi (themes)
- `extract-substance` - Hvad dokumentet regulerer/foreslår
- `embed-substance` - Substance embeddings for RAG

**Cache Location:**
```
output/hearings/{hearingId}/material-cache/
├── cache-metadata.json      # Hash, timestamp, source run
├── material-summary.json
├── analyze-material.json
├── extract-substance.json
└── embed-substance.json
```

**Standard workflow (automatisk):**
```bash
# Første kørsel - opretter cache
npm run pipeline:run -- 223 --limit-responses=10 --save-checkpoints

# Anden kørsel - genbruger materials automatisk (~$0.35 + ~45s sparet)
npm run pipeline:run -- 223 --limit-responses=50 --save-checkpoints
# Output: 📦 Material cache: VALID - skipping 4 steps
```

**Avanceret brug:**
```bash
# Tving fresh (efter prompt-ændringer i material-analyzer)
npm run pipeline:run -- 223 --clear-material-cache --limit-responses=10

# Disable automatisk cache (for debugging)
npm run pipeline:run -- 223 --no-material-cache --limit-responses=10

# Brug materials fra specifik historisk run
npm run pipeline:run -- 223 --material-baseline=20260131-baseline --limit-responses=10
```

**Cache invalidering:**
- ✅ Automatisk ved ændret material-indhold (hash ændres)
- ✅ Manuelt med `--clear-material-cache`
- ❌ IKKE ved ændret respondent-scope (det er hele pointen)

**Estimeret besparelse per kørsel:** ~$0.35 + ~45 sekunder

### ⚠️ KRITISK: Response-antal er LÅST i checkpoints

**Du kan IKKE ændre antal responses når du genoptager fra et checkpoint. ALDRIG.**

Dette er en HÅRD teknisk begrænsning - ikke bare en anbefaling:

```bash
# ❌ DETTE VIRKER IKKE - baseline har 3000 responses, men du beder om 10
npm run pipeline:run -- 223 --checkpoint=baseline:test --resume=aggregate --limit-responses=10
# Fejl: Checkpoint indeholder data for 3000 responses, men du filtrerer til 10.
# Aggregator forventer micro-summaries for alle responses i checkpoint.

# ✅ DETTE VIRKER - start forfra med færre responses
npm run pipeline:run -- 223 --limit-responses=10 --save-checkpoints
```

**Hvorfor virker det ikke?**
- `micro-summarize` checkpoint indeholder 3000 micro-summaries
- `aggregate` step forventer at alle 3000 er tilgængelige
- Hvis du filtrerer til 10 responses, mangler aggregator data for 2990 responses

**Hvornår skal du starte forfra vs. genbruge checkpoint?**

| Situation | Anbefaling |
|-----------|------------|
| Ændrer prompt/logik i sen step (aggregate, writer) | ✅ Genbrug checkpoint |
| Vil teste med færre responses | ❌ Start forfra med `--limit-responses` |
| Vil teste specifik respondent-håndtering | ✅ Genbrug checkpoint + `--response-ids` |
| Fuld regressionstest | ❌ Start forfra |

**Afvejning: Færre responses vs. færre steps**

Begge strategier reducerer tid/pris, men på forskellige måder:

| Strategi | Fordel | Ulempe |
|----------|--------|--------|
| `--limit-responses=N` | Tester hele flowet ende-til-ende | Kræver ny kørsel fra start |
| `--resume=<step>` | Genbruger dyre steps (embedding, micro-summarize) | Tester kun dele af pipelinen |

**Tommelfingerregel:**
- Første test af ny feature: `--limit-responses=20-50` (fuld flow, lav pris)
- Iteration på specifik step: `--resume=<step>` (genbrug checkpoint)
- Final validering: Fuld kørsel uden begrænsninger

### Auto-Navngivning af Kørsler

Auto-navngivning er **ALTID aktiveret** for at forhindre overskrivning af kørsler.

Format: `YYYYMMDD-HHMM-{random}[-label]`

| Input | Output |
|-------|--------|
| `--checkpoint=baseline` | `20260122-1430-a7-baseline` |
| `--checkpoint=test` | `20260122-1430-k9-test` |
| (ingen checkpoint) | `20260122-1430-m3` |

For at bruge et EKSAKT navn (uden timestamp), brug `--no-auto-name`:
```bash
npm run pipeline:run -- 223 --checkpoint=exact-name --no-auto-name --save-checkpoints
```

### Pipeline Workbench: Kør Enkelt-Trin

**ANBEFALET TIL HURTIG ITERATION.** For at teste ét specifikt trin uden at køre hele pipelinen:

```bash
# Kør KUN ét step (kræver checkpoint med alle tidligere trin)
node scripts/pipeline-workbench.js 223 --step=aggregate --checkpoint=baseline

# Kør range af steps (fra → til)
node scripts/pipeline-workbench.js 223 --from=aggregate --to=validate-positions \
  --checkpoint=baseline --save-checkpoints

# Se artifact output direkte
node scripts/pipeline-workbench.js 223 --step=theme-mapping \
  --checkpoint=baseline --print

# List tilgængelige checkpoints for en høring
node scripts/pipeline-workbench.js 223 --list --checkpoint=baseline
```

**Typiske use cases:**

| Ændring du tester | Kommando | Estimeret tid |
|-------------------|----------|---------------|
| Aggregator logik | `--step=aggregate` | ~2 min |
| Position-consolidator | `--step=consolidate-positions` | ~30 sek |
| Theme-mapping | `--step=theme-mapping --print` | ~1 min |
| Writer-prompt | `--from=hybrid-position-writing --to=validate-writer-output` | ~5 min |
| Validering af grupperinger | `--step=validate-grouping-quality` | ~10 sek |

**Krav:** Checkpoint skal indeholde alle steps FØR det step du vil køre.

**Eksempel workflow:**
```bash
# 1. Du har en baseline med alle trin kørt
# 2. Du ændrer position-consolidator.js
# 3. Test kun consolidate-positions trinnet:
node scripts/pipeline-workbench.js 223 --step=consolidate-positions \
  --checkpoint=baseline --save-checkpoints --print

# 4. Inspect output, gentag ved behov
```

**Forskellen fra `--resume`:**
- `--resume=aggregate` kører fra aggregate OG ALLE EFTERFØLGENDE trin
- `--step=aggregate` kører KUN aggregate-trinnet og stopper

### Tids/Pris-Guide per Step

| Step | Tid (3000 resp) | Pris | Cacheværdi |
|------|-----------------|------|------------|
| load-data | 5s | $0 | Lav |
| embedding | 10-15 min | $5-10 | **Høj!** |
| micro-summarize | **60-90 min** | **$15-25** | **Høj!** |
| aggregate | 5-10 min | $1-2 | Medium |
| consolidate-positions | 2 min | $0.50 | Medium |
| hybrid-position-writing | 10-20 min | $2-5 | Medium |

**Regel:** Genbrug ALTID embedding og micro-summarize checkpoints når muligt!

## Quality Evaluation

### Automatiske Validatorer
Pipeline-trin der validerer output:
- `validate-positions` - Positionskvalitet og struktur
- `validate-citations` - Citationsintegritet
- `validate-coverage` - Respondentdækning (alle skal være repræsenteret)

Validatorer i `src/validation/`:
- `citation-validator.js` - Citation-format
- `citation-integrity-validator.js` - Citater matcher kilder
- `format-validator.js` - Output-format
- `criticmarkup-validator.js` - CriticMarkup syntax

### Kvalitetskriterier (Manuel Evaluering)
Når du evaluerer `.md`-output, tjek:

1. **Citation-opsummering match**: Ingen pointer i opsummeringen som ikke understøttes af citaterne. Man skal ud fra citaterne kunne forstå hvorfor opsummeringen er skrevet.

2. **Ingen doven citering**: Undgå "Se tidligere REF#" eller lignende. Hver citation skal være selvstændig.

3. **Konsistent holdning**: Grupperede positioner skal have samme grundlæggende holdning.

4. **Professionel tone**: Sproget skal have en professionel formidlende forvaltningstone. Letlæseligt, og man skal let kunne afspejle holdninger fra kildematerialet.

5. **Tema-alignment**: Temaer skal følge overskrifterne i høringsmaterialet der hvor der reguleres.

### SOTA Evaluering
For systematisk kvalitetsforbedring:
- Sammenlign output med `golden-output/` eksempler (hvis tilgængelige)
- Kør `python tests/evaluation/test_hearing_223.py` for automatiseret evaluering
- Gennemgå `run-summary.json` for cost/quality metrics
- Læs `output/runs/{id}/{label}/terminal.log` for warnings og fejl

## Output Structure

Each run produces:
- `checkpoints/` - JSON checkpoint per step
- `llm-calls/` - Individual LLM request/response logs
- `terminal.log` - Full console output
- `progress.json` - Real-time progress (updated during run)
- `run-summary.json` - Cost, timing, quality metrics
- `hearing-{id}-analysis.md` - Final markdown with CriticMarkup
- `hearing-{id}-analysis.docx` - Final Word document

## Code Conventions

### Imports

- Use ES module syntax (`import`/`export`)
- Relative imports for local modules
- Group: external deps → local modules

### Error Handling

- Pipeline steps should throw on critical failures
- Use quality gates to stop pipeline on validation failures
- Retry logic built into embedding and LLM calls

### Logging

- Use `console.log` for info (captured to terminal.log)
- Prefix with `[ModuleName]` for identification
- Include context in error messages

### Comments

- JSDoc for public functions
- Inline comments for non-obvious logic
- Danish allowed in user-facing strings and prompts

## Important Constraints

1. **Citation Integrity**: Never modify or hallucinate citations. Use citation registry.
2. **Respondent Coverage**: Every respondent must appear in at least one position.
3. **Quality Gates**: Pipeline stops if mega-positions (>10 respondents without structure) detected.
4. **Token Limits**: Use RAG and hierarchical stitching for large positions.
5. **Dynamisk Skalering**: Pipelinen skal håndtere 1-1.500 høringssvar og forskellige dokumenttyper. Undgå hardcoding - tænk dynamiske løsninger.

## External Dependencies

- **OpenAI API**: LLM calls and embeddings
- **SQLite (better-sqlite3)**: Source data storage
- **Pandoc**: DOCX generation (system dependency)
- **Python**: PDF conversion and evaluation (optional)

> **Dokumentation**: Brug `WebSearch` til at slå op i nyeste OpenAI-dokumentation når nødvendigt - API'er udvikler sig hurtigere end LLM knowledge cutoffs.
