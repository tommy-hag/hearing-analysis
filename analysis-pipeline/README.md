# Hearing Analysis Pipeline

En AI-drevet pipeline til analyse af høringssvar.

## 🚀 Kør Pipeline

### Ny analyse fra scratch
```bash
npm run pipeline:run -- 168 --checkpoint=test01 --save-checkpoints --write
npm run pipeline:run -- 225 --checkpoint=test01 --save-checkpoints --write
```

### Genoptag fra et trin
```bash
npm run pipeline:run -- 223 --checkpoint=test01 --resume=aggregate --save-checkpoints --write
```

### Brug eksisterende som baseline for ny test
```bash
npm run pipeline:run -- 223 --checkpoint=test12:test13 --resume=[vælg det trin som passer til dine ændringer] --save-checkpoints --write
```
↑ Læser fra `test07`, gemmer til `test11`, starter fra `aggregate`.

### 🔄 Inkrementel opdatering (kun nye/ændrede svar)
```bash
npm run pipeline:run -- 223 --incremental=test07 --checkpoint=test09 --save-checkpoints --write
```
↑ Genbruger materialer, taksonomi og uændrede svar fra `test04`, processerer kun nye svar, gemmer til `test06`.

**Hvad der genbruges:**
- ✅ `material-summary` - Hvis høringsmaterialet er uændret
- ✅ `analyze-material` - Taksonomi/temaer genbruges
- ✅ `extract-substance` - Substansekstraktion genbruges
- ✅ `embed-substance` - Embeddings af substans genbruges
- ✅ `edge-case-screening` - Kun NYE svar screenes, resten merges fra baseline
- ✅ `micro-summarize` - Kun NYE svar analyseres, resten merges fra baseline

**Hvornår bruges det?**
- Når en høring stadig er åben og der løbende kommer nye svar
- Til hurtigt at opdatere analysen uden at køre hele pipelinen
- Sparer LLM-kald (og penge!) ved kun at processere det nye

**Output:**
```
🔄 INCREMENTAL MODE: Using "test04" as baseline
  → Only new/modified responses will be processed
  → Materials, taxonomy, and unchanged responses will be reused
  → Results will be saved to "test05"

[IncrementalManager] Analysis complete:
  - Unchanged: 1239 responses
  - New: 527 responses
  - Modified: 0 responses
  
[Pipeline] 💰 Estimated savings: 70% responses reused (~$10.04)
```

### Trin du kan starte fra (--resume)
| Fase | Trin |
|------|------|
| Data | `load-data`, `material-summary`, `analyze-material`, `extract-substance`, `embed-substance`, `edge-case-screening`, `enrich-responses` |
| Embedding | `chunking`, `embedding`, `calculate-dynamic-parameters` |
| Analyse | `micro-summarize`, `citation-registry`, `embed-arguments`, `similarity-analysis`, `theme-mapping`, `validate-legal-scope` |
| Aggregering | `aggregate`, `consolidate-positions`, `extract-sub-positions`, `group-positions`, `validate-positions`, `sort-positions` |
| Output | `hybrid-position-writing`, `validate-writer-output`, `extract-citations`, `validate-citations`, `validate-coverage`, `considerations`, `format-output`, `build-docx` |

---

## 🏗️ Arkitektur

Pipelinen består af **30 modulære trin** organiseret i 5 hovedfaser:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HEARING ANALYSIS PIPELINE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐     │
│  │   FASE 1    │   │   FASE 2    │   │   FASE 3    │   │   FASE 4    │     │
│  │ INDLÆSNING  │ → │  ANALYSE    │ → │ AGGREGERING │ → │  SKRIVNING  │     │
│  └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘     │
│         ↓                 ↓                 ↓                 ↓             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐     │
│  │ Data Loader │   │MicroSummary │   │  Aggregator │   │ PositionWri │     │
│  │ Material    │   │ ThemeMapper │   │ Consolidator│   │ OutputFormat│     │
│  │ Substance   │   │ Embeddings  │   │SubPosExtract│   │ DOCXBuilder │     │
│  │ EdgeCaseDet │   │ Similarity  │   │   Grouper   │   │  Coverage   │     │
│  └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Pipeline-trin i Detaljer

### Fase 1: Indlæsning & Forberedelse (Trin 1-7)

#### 1. `load-data`
**Modul:** `DataLoader`
**Formål:** Indlæser alle rådata fra databasen.
- Henter høringssvar fra SQLite-database
- Henter høringsmaterialer (PDF/Markdown)
- Understøtter begrænsning af antal svar via `--limit-responses`
- Bevarer metadata som respondenttype (borger, lokaludvalg, organisation, myndighed)
- **Output:** `responses[]` og `materials[]` arrays med alle rådata

#### 2. `material-summary`
**Modul:** `MaterialSummarizer`
**Formål:** Genererer forståelige opsummeringer af høringsmaterialet.
- Konverterer PDF-materialer til markdown via `pdf-to-markdown.py`
- Genererer to versioner af høringsmaterialet:
  - **Fuld opsummering** (~30.000 tegn) - til temaekstraktion og dybdegående analyse
  - **Lite opsummering** (~5.000 tegn) - til token-effektive operationer
- Identificerer dokumenttype (lokalplan, dispensation, etc.)
- **Output:** `materialSummary` med `full` og `lite` versioner

#### 3. `analyze-material`
**Modul:** `MaterialAnalyzer`
**Formål:** Ekstraherer struktureret taksonomi fra høringsmaterialet.
- Genererer en **taksonomi** af relevante temaer baseret på dokumentet
- Identificerer præcis dokumenttype med juridisk kontekst
- Opretter hierarkiske temaer med nøgleord og kategorier
- Bruges til at guide argumentekstraktion og tema-mapping
- **Output:** `taxonomy` med `documentType`, `themes[]`, og `legalContext`

#### 4. `extract-substance`
**Modul:** `SubstanceExtractor`
**Formål:** Udtrækker det konkrete indhold som dokumentet regulerer.
- Ekstraherer "substansen" - hvad dokumentet ændrer/regulerer/foreslår
- For lokalplaner: § bestemmelser og anvendelsesområder
- For dispensationer: Hvad der dispenseres fra/til
- For politikker: Mål, forslag, prioriteter
- Bruges til at koble høringssvar til specifikke dele af materialet
- **Output:** `substance` med strukturerede elementer og referencer

#### 5. `embed-substance`
**Modul:** `SubstanceEmbedder`
**Formål:** Skaber søgbare embeddings af substanselementer.
- Genererer embeddings for hver substansdel med `text-embedding-3-large`
- Muliggør RAG-baseret kontekstselektion i senere trin
- Gør det muligt at finde relevante materialeafsnit for hvert høringssvar
- **Output:** `embeddedSubstance[]` med vektorer for hver substansdel

#### 6. `edge-case-screening`
**Modul:** `EdgeCaseDetector`
**Formål:** Identificerer svar der kræver særlig håndtering.
- Screener alle høringssvar i parallel (batch-processing)
- Klassificerer hvert svar i kategorier:
  - `analyze-normally` - Standard analyse
  - `analyze-with-context` - Henviser til andre svar (f.eks. "Enig med henvendelse 45")
  - `no-opinion` - Indeholder ingen holdning (f.eks. kun spørgsmål, eller intet indhold)
- Identificerer krydsreferencer mellem svar
- **Output:** `edgeCases` med `classification`, `crossReferences[]`, og `noOpinionResponses[]`

#### 7. `enrich-responses`
**Formål:** Beriger svar med kontekst fra refererede svar.
- For svar der henviser til andre (f.eks. "Som henvendelse 45 skriver...")
- Tilføjer kontekst fra det refererede svar
- **Delta-storage optimering**: Gemmer kun ændringerne, ikke fulde svar
- Sikrer at krydsreferencer ikke taber information
- **Output:** `enrichedResponses` med berigede tekstversioner

### Fase 2: Chunking & Embedding (Trin 8-10)

#### 8. `chunking`
**Modul:** `StructuredChunker` + `ArgumentChunker`
**Formål:** Opdeler tekster i semantiske enheder til embedding.
- **Argument-aligned strategi** for høringssvar:
  - Respekterer argumentgrænser (holder argumenter samlet)
  - Inkluderer kildecitater i chunks
  - 1200 tegn pr. argument-chunk
- **Section-aware strategi** for materialer:
  - Respekterer markdown-overskrifter og hierarki
  - 400-1500 tegn pr. chunk
  - 100 tegn overlap mellem chunks
- **Output:** `chunks[]` for både responses og materials

#### 9. `embedding`
**Modul:** `BatchEmbedder`
**Formål:** Genererer vektorrepræsentationer for semantisk søgning.
- Bruger `text-embedding-3-large` model
- Batch-processing med 10 chunks pr. batch
- Automatisk retry ved rate limits (op til 5 forsøg)
- Validerer at alle chunks har embeddings
- **Output:** `embeddings` map med chunk-ID → vektor

#### 10. `calculate-dynamic-parameters`
**Modul:** `DynamicParameterCalculator`
**Formål:** Tilpasser pipeline-parametre til den specifikke høring.
- Beregner dynamiske parametre baseret på:
  - Antal svar (skala-justering)
  - Semantisk diversitet (clustering-parametre)
  - Gennemsnitlig svarlængde (batch-størrelser)
- Justerer thresholds for konsolidering automatisk
- Forhindrer over-aggregering ved mange ens svar
- **Output:** `dynamicParameters` med justerede thresholds

### Fase 3: Mikroanalyse & Temaklassificering (Trin 11-16)

#### 11. `micro-summarize`
**Modul:** `MicroSummarizer`
**Formål:** Ekstraherer strukturerede argumenter fra hvert høringssvar.
- Analyserer hvert svar og ekstraherer argumenter med struktur:
  - `what` - Hvad mener borgeren? (kerneholdning)
  - `why` - Hvorfor? (begrundelse/årsag)
  - `how` - Hvordan? (forslag til løsning/handling)
  - `sourceQuote` - Eksakt citat fra kildetekst
  - `relevantThemes` - Hvilke temaer argumentet vedrører
- **Citation Registry**: Registrerer alle citater med unikke ID'er (CITE_xxx)
- **RAG-baseret kontekst**: Bruger embeddet substans til at finde relevante materialeafsnit
- **Adaptiv model-selektion**: Bruger lettere model til korte svar (< 100 tegn)
- **Output:** `microSummaries[]` med strukturerede argumenter pr. svar

#### 12. `citation-registry`
**Modul:** `CitationRegistry`
**Formål:** Centraliserer citat-håndtering for hele pipelinen.
- Eksporterer alle registrerede citater med unikke ID'er
- Muliggør genskabelse af citat-registry ved genoptag (resume)
- Sikrer konsistens mellem MicroSummarizer og PositionWriter
- **Output:** `citationRegistryStats` med citat-statistik og mappings

#### 13. `embed-arguments`
**Formål:** Skaber søgbare vektorer af ekstraherede argumenter.
- Genererer embeddings af `what/why/how` kombinationer
- Bruges til semantisk clustering i aggregeringsfasen
- Muliggør at finde lignende argumenter på tværs af svar
- **Output:** `argumentEmbeddings` map

#### 14. `similarity-analysis`
**Modul:** `SimilarityAnalyzer`
**Formål:** Analyserer mønstre og grupperer lignende holdninger.
- Detekterer **masse-enighed** (kampagner, underskriftsindsamlinger)
- Beregner similaritets-matricer mellem argumenter
- Identificerer clusters af ens eller næsten-ens svar
- Justerer konsolideringsparametre ved høj lighed
- **Output:** `similarityAnalysis` med clusters og mønster-rapporter

#### 15. `theme-mapping`
**Modul:** `ThemeMapper`
**Formål:** Kobler argumenter til temaer fra taksonomien.
- Mapper hver argument til relevante temaer
- Håndterer fuzzy-matching af temanavne
- Opretter automatisk "Andre emner" for out-of-scope argumenter
- **Cross-theme deduplication**: Fjerner duplikerede argumenter på tværs af temaer
- **Output:** `themes[]` med argumenter grupperet under hvert tema

#### 16. `validate-legal-scope`
**Modul:** `LegalScopeContext`
**Formål:** Sikrer at argumenter er inden for dokumentets juridiske rammer.
- Validerer argumenter mod dokumenttypens beføjelser:
  - Lokalplan → kan regulere bebyggelse, ikke indretning
  - Dispensation → kun det specifikke der dispenseres fra
- Flytter out-of-scope argumenter til "Andre emner"
- Bruger dokumenttype til at bestemme hvad der kan reguleres
- **Output:** `legalScopeValidation` med in/out-of-scope kategorisering

### Fase 4: Aggregering & Konsolidering (Trin 17-22)

#### 17. `aggregate`
**Modul:** `Aggregator`
**Formål:** Grupperer lignende argumenter til holdningspositioner.
- **Embedding-first clustering**: Grupperer semantisk lignende argumenter via cosine similarity
- **LLM-baseret raffinering**: Forfiner grupper med sprogforståelse
- **Object-aware grouping**: Tager højde for specifikke objekter (bygninger, steder, områder)
- Opretter **positions** (holdningsgrupper) med:
  - Foreløbig titel
  - Respondent-breakdown (borgere, lokaludvalg, organisationer)
  - Materiale-referencer
  - Alle inkluderede argumenter med citater
- **Output:** `aggregation` med positions pr. tema

#### 18. `consolidate-positions`
**Modul:** `PositionConsolidator`
**Formål:** Merger overlappende positioner for at undgå redundans.
- Merger positioner baseret på cosine similarity threshold
- **Cross-theme strategi**: Kan merge på tværs af temaer hvis semantisk ens
- Validerer at ingen respondenter går tabt under merge
- Bevarer alle citater fra mergede positioner
- **Output:** `consolidatedPositions` med reduceret antal positioner

#### 19. `extract-sub-positions`
**Modul:** `SubPositionExtractor`
**Formål:** Bevarer nuancer i store holdningsgrupper.
- Kun aktiveret for positioner med >15 respondenter
- Ekstraherer nuancerede sub-argumenter fra mega-positioner
- Identificerer variationer inden for samme overordnede holdning
- Skaber hierarki: hovedposition → sub-positioner
- **Output:** `subPositionExtracted` med hierarkisk struktur

#### 20. `group-positions`
**Modul:** `PositionGrouper`
**Formål:** Organiserer positioner i logisk hierarki.
- Opretter master/sub-position relationer
- Grupperer relaterede positioner under fælles overskrift
- Sikrer konsistent præsentation i output
- **Output:** `groupedPositions` med hierarkisk struktur

#### 21. `validate-positions`
**Modul:** `PositionQualityValidator`
**Formål:** Kvalitetssikrer positionerne før skrivning.
- Validerer positionskvalitet og struktur
- **Stopper pipelinen** hvis mega-positioner (>10 respondenter uden struktur) detekteres
- Tjekker for manglende citater eller respondenter
- Genererer anbefalinger til forbedring
- **Output:** `validatedPositions` eller pipeline-fejl ved problemer

#### 22. `sort-positions`
**Modul:** `PositionSorter`
**Formål:** Sikrer konsistent rækkefølge i output.
- Sorterer positioner efter respondentantal (faldende)
- Vigtigste/mest repræsenterede holdninger først
- Sikrer reproducerbar output-rækkefølge
- **Output:** `sortedPositions` i endelig rækkefølge

### Fase 5: Skrivning & Formatering (Trin 23-30)

#### 23. `hybrid-position-writing`
**Modul:** `PositionWriter`
**Formål:** Genererer menneskelig, administrativ opsummering af hver position.
- Skriver sammenhængende tekst der opsummerer holdningen
- Bruger **CriticMarkup** format med `<<REF_X>>` pladsholdere for citater
- Genererer forbedret titel fra LLM
- **Token-aware chunking**: Opdeler store positioner for at undgå context-window overflow
- **Adaptive model-selektion**: Vælger model baseret på positions kompleksitet:
  - Light: < 15 complexity score (få respondenter, kort tekst)
  - Heavy: 15-40 complexity score
  - Ultra: > 40 complexity score (mange respondenter, lang tekst)
- **Hierarkisk stitching**: Syr delopsummeringer sammen for mega-positioner
- **Output:** `hybridPositions` med `criticMarkupSummary` og `hybridReferences[]`

#### 24. `validate-writer-output`
**Formål:** Kvalitetssikrer PositionWriter output.
- Validerer CriticMarkup-syntax (`{==text==}`, `{>>comment<<}`)
- Tjekker at alle `<<REF_X>>` pladsholdere har tilhørende references
- Validerer reference-struktur og respondent-mappings
- **Output:** `positionWriterValidation` med status og eventuelle fejl

#### 25. `extract-citations`
**Modul:** `CitationExtractor`
**Formål:** Resolverer citatreferencer til faktiske citater.
- Resolverer citation-ID'er (CITE_xxx) til faktiske citater fra kildetekst
- Fallback til CitationExtractor hvis citater mangler i registry
- Validerer at citater findes i original tekst via fuzzy matching
- **Output:** `citedPositions` med udfyldte citater

#### 26. `validate-citations`
**Modul:** `CitationValidator`
**Formål:** Verificerer at alle citater er korrekte.
- Tjekker at hvert citat findes i den tilhørende kildetekst
- Bruger fuzzy matching for at håndtere mindre variationer
- Markerer citater der ikke kan verificeres
- **Output:** `citationValidation` med verificerings-status

#### 27. `validate-coverage`
**Formål:** Sikrer at alle respondenter er repræsenteret.
- Gennemgår alle originale responses
- Tjekker at hver respondent optræder i mindst én position
- Tilføjer manglende respondenter til "Ingen holdning fundet" position
- **Output:** `validatedCoverage` med fuld respondent-dækning

#### 28. `considerations`
**Modul:** `ConsiderationsGenerator` + `EdgeCaseDetector`
**Formål:** Genererer analytiske overvejelser til output.
- Skriver et kort analytisk afsnit om høringssvarene
- Dokumenterer edge cases og særlig håndtering:
  - Høringssvar uden holdning (med henvendelsesnumre)
  - Svar der henviser til andre svar
  - Mønstre i svarene (kampagner, masse-svar)
- **Output:** `considerations` tekst til dokumentets start

#### 29. `format-output`
**Modul:** `OutputFormatter`
**Formål:** Formaterer det endelige output som markdown med CriticMarkup.
- Konverterer `<<REF_X>>` pladsholdere til CriticMarkup-format:
  - `{==tekst==}` - Highlighted tekst (den der citeres)
  - `{>>kommentar<<}` - Citater og kilder
- Formaterer positioner med:
  - `## (N, LU/O) Titel` - Respondentantal og type i parentes
  - `Henvendelse X, Y og Z` - Liste af henvendelsesnumre
  - Sammenhængende tekst med indlejrede citater
- **Output:** `formattedOutput` som færdig markdown

#### 30. `build-docx`
**Modul:** `DocxBuilder`
**Formål:** Genererer det endelige DOCX-dokument.
- Konverterer markdown til DOCX via pandoc
- Bruger tilpasset template for konsistent formatering
- Renderer CriticMarkup som Word-kommentarer og highlights
- **Output:** `hearing-{id}-analysis.docx` fil

---

## 📤 Output-format & Struktur

### Endelig Output-mappe
```
output/runs/{hearingId}/{label}/
├── checkpoints/               # Trin-output (JSON per step)
│   ├── load-data.json
│   ├── micro-summarize.json
│   └── ...
├── llm-calls/                 # LLM-kald logs (separate JSON)
│   ├── 0001-micro-summarize-request.json
│   └── ...
├── step-logs/                 # Detaljerede markdown-logs per trin
├── debug/                     # Debug-rapporter
├── terminal.log               # Fuld terminal-log fra kørslen
├── progress.json              # Real-time progress (opdateres løbende)
├── run-summary.json           # Opsummering: LLM-cost, tokens, timing
├── run-summary.md             # Samme opsummering i Markdown
├── hearing-{id}-analysis.json # Endelig struktureret JSON
├── hearing-{id}-analysis.md   # Endelig Markdown med CriticMarkup
└── hearing-{id}-analysis.docx # Endelig DOCX
```

### Markdown Output Format

Det endelige markdown-output følger denne struktur:

```markdown
# {==Tema 1==} {>>Analytiske overvejelser...<<}
## (N, LU/O) Positionstitel
Henvendelse X, Y og Z
{==Label==}{>>**Henvendelse X**
*"Citat fra borger X"*

**Henvendelse Y**
*"Citat fra borger Y"*<<} tekst der beskriver holdningen...

# Tema 2
## (N) Anden positionstitel
Henvendelse A
{==Én borger==}{>>**Henvendelse A**
*"Citat"*<<} beskrivelse af holdningen...
```

#### Format-elementer forklaret:

| Element | Format | Beskrivelse |
|---------|--------|-------------|
| **Tema** | `# Temanavn` | H1-overskrift for hvert tema |
| **Position** | `## (N, LU/O) Titel` | H2 med respondentantal. LU=Lokaludvalg, O=Organisation |
| **Henvendelser** | `Henvendelse X, Y og Z` | Sorteret liste af henvendelsesnumre |
| **Highlight** | `{==tekst==}` | CriticMarkup highlight af den citerede aktør |
| **Kommentar** | `{>>citat<<}` | CriticMarkup kommentar med kildecitat |

#### Citatformat:
- **≤15 respondenter**: Individuelle citater med `**Henvendelse X**` headers
- **>15 respondenter**: Samlet liste med `Svarnumre: X, Y, Z...`

### JSON Output Struktur

```json
{
  "hearingId": 223,
  "considerations": "Analytiske overvejelser...",
  "topics": [
    {
      "name": "Bebyggelsens omfang og placering",
      "positions": [
        {
          "title": "Ønske om bevaring af Palads",
          "responseNumbers": [1, 2, 3, ...],
          "respondentBreakdown": {
            "total": 150,
            "citizens": 145,
            "localCommittees": ["Indre By Lokaludvalg"],
            "organizations": ["By og Land Danmark"],
            "publicAuthorities": []
          },
          "summary": "Der fremhæves et overordnet ønske...",
          "criticMarkupSummary": "{==Der==}{>>citater...<<} fremhæves...",
          "hybridReferences": [
            {
              "id": "REF_1",
              "label": "150 borgere",
              "respondents": [1, 2, 3, ...],
              "quotes": [
                { "responseNumber": 1, "quote": "Palads skal bevares..." }
              ]
            }
          ],
          "arguments": [
            {
              "what": "Palads bør bevares som kulturarv",
              "why": "Bygningen har historisk betydning",
              "how": "Fredning eller bevarende lokalplan",
              "sourceQuote": "Det er en del af byens sjæl...",
              "responseId": 1
            }
          ]
        }
      ]
    }
  ]
}
```

### Progress Tracking

Under kørsel opdateres `progress.json` efter hvert trin:
```json
{
  "status": "running",
  "progress": 45,
  "currentStep": "theme-mapping",
  "completedSteps": ["load-data", "material-summary", "..."],
  "estimatedTimeRemaining": "2m 30s",
  "dataStats": {
    "responseCount": 150,
    "themeCount": 8,
    "positionCount": 45
  }
}
```

### Run Summary

`run-summary.md` indeholder efter kørsel:
- **Quality Score**: 0-100 score med karakter (A-F)
- **Data Statistics**: Antal responses, temaer, positioner
- **Respondent Coverage**: Hvor mange respondenter er repræsenteret
- **Cost Breakdown**: LLM-cost + embedding-cost per model
- **Timing**: Total varighed + per-step timing
- **Validation Results**: Status for alle validerings-trin
- **Issues**: Advarsler og fejl fra kørslen

---

## 🔧 Konfiguration

### Centrale Konfigurationsfiler

| Fil | Beskrivelse |
|-----|-------------|
| `config/pipeline-config.json` | Hovedkonfiguration (chunking, embedding, retrieval) |
| `config/theme-templates.json` | Dokumenttype-definitioner og lovramme |
| `config/.env` | Environment-variabler (API-nøgler, model-config) |

### `pipeline-config.json`
```json
{
  "chunking": {
    "responseStrategy": "argument-aligned",
    "shortResponseThreshold": 800,
    "chunkSize": 600,
    "chunkOverlap": 0
  },
  "materialChunking": {
    "strategy": "section-aware",
    "minChunkSize": 400,
    "maxChunkSize": 1500,
    "chunkOverlap": 100
  },
  "embedding": {
    "model": "text-embedding-3-large",
    "batchSize": 10
  },
  "retrieval": {
    "hybrid": true,
    "topK": 20,
    "reRank": true,
    "reRankTopK": 10
  },
  "analysis": {
    "microSummary": true,
    "themeMapping": true,
    "edgeCaseScreening": true,
    "batchProcessing": true
  }
}
```

### LLM Model Konfiguration (`.env`)
```bash
# Light tier - simple klassifikationer
LLM_LIGHT_MODEL=gpt-5-nano
LLM_LIGHT_VERBOSITY=low
LLM_LIGHT_REASONING_LEVEL=minimal

# Medium tier - standard analyse
LLM_MEDIUM_MODEL=gpt-5-mini
LLM_MEDIUM_VERBOSITY=medium
LLM_MEDIUM_REASONING_LEVEL=high

# Heavy tier - kompleks aggregering
LLM_HEAVY_MODEL=gpt-5-mini
LLM_HEAVY_VERBOSITY=medium
LLM_HEAVY_REASONING_LEVEL=high

# Embedding model
EMBEDDING_MODEL=text-embedding-3-large
```

### `theme-templates.json`
Definerer dokumenttyper og deres juridiske rammer:
- **lokalplan** - Planloven: bebyggelse, anvendelse, veje, parkering
- **dispensation** - Planloven § 19: specifikke undtagelser
- **partshøring** - Forvaltningsloven: partsinddragelse
- **politik** - Kommunalfuldmagten: politikker og strategier
- **bygningsreglement** - Bygningsloven: tekniske krav

---

## 📁 Mappestruktur

```
analysis-pipeline/
├── config/
│   ├── pipeline-config.json      # Pipeline-konfiguration
│   ├── theme-templates.json      # Dokumenttype-definitioner
│   └── .env                      # API-nøgler og model-config
├── prompts/                       # LLM prompt-templates
│   ├── micro-summary-prompt.md
│   ├── aggregation-prompt.md
│   ├── hybrid-position-writer-prompt.md
│   ├── hybrid-position-stitch-prompt.md
│   ├── substance-extraction-prompt.md
│   └── ...
├── scripts/
│   ├── run-pipeline.js           # Hoved-entry point
│   └── pipeline-workbench.js     # Interaktiv workbench
├── src/
│   ├── analysis/                  # Analyse-moduler
│   │   ├── micro-summarizer.js
│   │   ├── aggregator.js
│   │   ├── position-writer.js
│   │   ├── theme-mapper.js
│   │   ├── substance-extractor.js
│   │   ├── edge-case-detector.js
│   │   ├── position-consolidator.js
│   │   ├── sub-position-extractor.js
│   │   └── ...
│   ├── chunking/
│   │   ├── structured-chunker.js
│   │   └── argument-chunker.js
│   ├── citation/
│   │   ├── citation-extractor.js
│   │   └── citation-registry.js
│   ├── embedding/
│   │   ├── batch-embedder.js
│   │   ├── substance-embedder.js
│   │   └── embedding-service.js
│   ├── pipeline/
│   │   ├── pipeline-orchestrator.js  # Hovedorkestrering
│   │   ├── checkpoint-manager.js     # Checkpoint-håndtering
│   │   ├── incremental-manager.js    # Inkrementel opdatering
│   │   ├── run-directory-manager.js  # Output-håndtering
│   │   ├── progress-tracker.js       # Real-time progress
│   │   └── run-summary-generator.js  # Kørsel-opsummering
│   ├── retrieval/
│   │   └── hybrid-retriever.js
│   ├── utils/
│   │   ├── openai-client.js
│   │   ├── output-formatter.js
│   │   ├── docx-builder.js
│   │   └── ...
│   └── validation/
│       ├── citation-validator.js
│       ├── format-validator.js
│       └── criticmarkup-validator.js
├── output/
│   └── runs/{hearingId}/{label}/     # Output per kørsel
└── tests/
    └── evaluation/                    # DeepEval tests
```

---

## 🎯 Centrale Designprincipper

### 1. Citation Registry Pattern
Alle citater registreres med unikke ID'er (`CITE_xxx`) i MicroSummarizer og resolveres senere i PositionWriter. Dette forhindrer:
- Citat-korruption ved LLM-behandling
- Quote hallucinations
- Tab af kildehenvisninger

### 2. Adaptive Model Selection
Pipelinen vælger automatisk LLM baseret på opgavens kompleksitet:
- **Light** (gpt-5-nano): Simple klassifikationer, korte svar
- **Light-plus** (gpt-5-nano + høj reasoning): Korte men vigtige svar
- **Medium** (gpt-5-mini): Standard analyse
- **Heavy** (gpt-5-mini high-reasoning): Kompleks aggregering, store positioner
- **Ultra** (gpt-5-mini): Meget komplekse mega-positioner

### 3. Token-Aware Processing
- Dynamisk batch-størrelse baseret på indhold
- Hierarkisk stitching for mega-positioner (>25 respondenter)
- Automatisk chunking ved context-window grænser
- RAG-baseret kontekstselektion for at spare tokens

### 4. Quality Gates
Pipelinen stopper med fejl hvis:
- Mega-positioner uden struktur detekteres (>10 respondenter)
- Respondenter går tabt under konsolidering
- Citater ikke kan verificeres i kildetekst
- CriticMarkup-syntax er ugyldig

### 5. Checkpoint & Resume
Hvert trin gemmes som JSON-checkpoint, hvilket muliggør:
- Genoptag fra specifikt trin
- Jupyter-style iterativ udvikling
- Debugging af individuelle trin
- Baseline-feature til eksperimentering

### 6. Inkrementel Opdatering
**IncrementalManager** muliggør effektiv opdatering af løbende høringer:
- **Content-baseret hashing**: Detekterer ændringer via SHA-256 hash
- **Selektiv processing**: Kun nye/ændrede svar processeres
- **Automatisk merge**: Nye resultater merges med baseline
- **Metadata tracking**: Gemmer hash-information for fremtidige kørsler

---

## 🔍 Debugging

### Nyttige Kommandoer
```bash
# Kør pipeline med checkpoints og output
npm run pipeline:run -- 223 --checkpoint=test01 --save-checkpoints --write

# Genoptag fra et specifikt trin
npm run pipeline:run -- 223 --resume=aggregate --checkpoint=test01 --save-checkpoints

# Inkrementel opdatering (kun nye svar)
npm run pipeline:run -- 223 --incremental=test04 --checkpoint=test05 --save-checkpoints --write

# Se tilgængelige kørsler
ls output/runs/223/

# Se alle filer fra en specifik kørsel
ls -la output/runs/223/test01/

# Se checkpoints fra en kørsel
ls output/runs/223/test01/checkpoints/

# Se LLM-kald fra en kørsel
ls output/runs/223/test01/llm-calls/

# Vis terminal-loggen fra en kørsel
cat output/runs/223/test01/terminal.log

# Følg terminal-loggen live (under kørsel)
tail -f output/runs/223/test01/terminal.log

# Følg progress live (under kørsel)
watch -n 1 'cat output/runs/223/test01/progress.json | jq "{status, progress, currentStep}"'

# Se run-summary (kvalitetsscore, cost, timing)
cat output/runs/223/test01/run-summary.md

# Sammenlign cost mellem kørsler
for dir in output/runs/223/*/; do echo "$dir:"; jq '.usage.totals.totalCostFormatted' "$dir/run-summary.json" 2>/dev/null; done
```

### Environment Variables
```bash
VERBOSE=1              # Detaljeret logging
DEBUG=1                # Debug-mode
TEST_LIMIT_RESPONSES=5 # Begræns til N svar (test)
```

---

## 📊 Metrics & Evaluering

### DeepEval Integration
```bash
# Kør evaluering efter pipeline
npm run pipeline:run -- 223 --checkpoint=test --save-checkpoints --write --evaluate

# Direkte evaluering
python tests/evaluation/test_hearing_223.py
```

### Evalueringsmetrikker
- **Faithfulness**: Er opsummeringer tro mod kildetekst?
- **Coverage**: Er alle respondenter repræsenteret?
- **Citation Accuracy**: Er citater korrekte?

---

## 🔗 Dependencies

### NPM
```json
{
  "openai": "^6.7.0",
  "better-sqlite3": "^9.6.0",
  "dotenv": "^16.3.1"
}
```

### Python (til evaluering)
```
deepeval
pytest
```

### Systemkrav
- Node.js 18+
- Python 3.8+ (til evaluering og PDF-konvertering)
- Pandoc (til DOCX-generering)

---

## 📝 Prompt Engineering

Pipelinen bruger en "Hybrid Prompting" tilgang:

1. **Strict JSON Output**: Alle LLM-trin returnerer struktureret JSON
2. **CriticMarkup**: Writer genererer tekst med `<<REF_X>>` pladsholdere
3. **Evidence-Based**: Prompterne forbyder at tillægge respondenter holdninger uden direkte kildecitater
4. **Anti-Hallucination**: Ingen vage kvantifikatorer ("nogle", "flere") - kun specifikke tal

---

## 🛡️ Fejlhåndtering

### Automatiske Retries
- MicroSummarizer: Op til 2 forsøg ved citatfejl
- PositionWriter: Op til 3 forsøg ved valideringsfejl
- Embedding: Op til 5 forsøg ved rate limits

### Fallback-strategier
- Hvis LLM fejler → Regel-baseret gruppering
- Hvis citater ikke findes → Fallback til CitationExtractor
- Hvis embeddings mangler → Skip deduplication

### Validering
- Citat-integritet valideres på alle trin
- Respondent-coverage tjekkes før output
- CriticMarkup-syntax valideres
