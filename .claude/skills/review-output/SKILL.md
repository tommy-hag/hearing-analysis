---
name: review-output
description: Kritisk gennemgang af pipeline output for at finde kvalitetsproblemer og identificere root cause
argument-hint: <hearingId> [checkpoint-label]
allowed-tools: Read, Grep, Glob
---

# Review Output - Diagnosticér Output Problemer

Find konkrete kvalitetsproblemer i pipeline output og identificér root cause.

## Rolle

Du er en kritisk reviewer. Læs outputtet som en forvaltningsmedarbejder der skal bruge det til at skrive høringssvar.

## Læseproces

### 1. Læs Final Output
```bash
cat analysis-pipeline/output/runs/{hearingId}/{label}/hearing-{hearingId}-analysis.md
```

Læs fra start til slut og notér alt der virker "off":
- Mærkelig formulering
- Uklar logik
- Løse påstande uden belæg

### 2. Spor Problemet Tilbage
For hvert problem: find årsagen i checkpoint data.

## Typiske Problemer

### Opsummeringer Matcher Ikke Citater
- Opsummeringen siger noget citatet ikke understøtter
- Check `hybridPositions` checkpoint for alignment issues

### Positioner Blander Holdninger
- En position indeholder modsatrettede synspunkter
- Check `aggregate` checkpoint for forkert gruppering

### Temaer Giver Ikke Mening
- Tema-titel matcher ikke indholdet
- Check `consolidate` checkpoint for mislabeling

### Gentagelser På Tværs
- Samme pointe gentages i flere positioner
- Check for overlap i `aggregate` clusters

### Citater Ud Af Kontekst
- Citatet betyder noget andet i original context
- Check `microSummaries` for korrekt ekstraktion

### Monotone Formuleringer
- Skabelon-agtige, gentagne sætningsstrukturer
- Check prompt instructions for variation guidance

### Orphaned Respondenter
- Respondent nævnt i citat men ikke i opsummering
- Check position writing for missing attribution

## Diagnose Workflow

```
Final Output Problem
        ↓
hybridPositions checkpoint - Fejl her?
        ↓
aggregate/consolidate checkpoint - Opstod ved gruppering?
        ↓
microSummaries checkpoint - Forkert ekstraktion?
        ↓
Identificér step der introducerede fejlen
```

## Checkpoint Stier

```bash
# Micro summaries
cat output/runs/{id}/{label}/checkpoints/microSummaries.json | jq '.summaries[:3]'

# Aggregated positions
cat output/runs/{id}/{label}/checkpoints/aggregate.json | jq '.clusters[:2]'

# Final positions
cat output/runs/{id}/{label}/checkpoints/hybridPositions.json | jq '.positions[:2]'
```

## Output Format

For hvert problem rapportér:

```
## PROBLEM: [Konkret beskrivelse med eksempel]

**LOKATION:** Tema X, Position Y

**ROOT CAUSE:**
- Step: [micro-summarize|aggregate|hybrid-position-writing]
- Årsag: [Specifik forklaring]

**FIX:**
- Fil: [path til kode/prompt]
- Ændring: [Konkret forslag]
```

## Kvalitetscheckliste

- [ ] Alle positioner har understøttende citater
- [ ] Opsummeringer er tro mod citaterne
- [ ] Ingen intern modstrid i positioner
- [ ] Temaer er meningsfulde grupperinger
- [ ] Professionel, neutral tone gennemgående
- [ ] Alle respondenter er repræsenteret
- [ ] Ingen løse påstande uden belæg
