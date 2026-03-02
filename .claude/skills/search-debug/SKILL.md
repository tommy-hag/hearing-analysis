---
name: search-debug
description: Debug søgefunktionalitet, vector store og embeddings
argument-hint: <søgeterm|hearing-id|problem-beskrivelse>
allowed-tools: Bash, Read, Grep, Glob
---

# Search Debug - Søgning og Embeddings Fejlfinding

Diagnosticér problemer med søgefunktionalitet og vector store.

## Søge-Arkitektur

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Search    │────▶│   SQLite    │────▶│   Vector    │
│   Query     │     │   FTS5      │     │   Store     │
└─────────────┘     └─────────────┘     └─────────────┘
                          │                    │
                    Keyword Match      Semantic Match
```

## Workflow

### 1. Test Søgning
```bash
# Simpel søgning
curl -s "http://localhost:3010/api/search?q=test" | jq .

# Med filtre
curl -s "http://localhost:3010/api/search?q=test&hearingId=223" | jq .
```

### 2. Analysér Resultater
- Relevans af resultater
- Manglende forventede matches
- Ranking problemer

### 3. Debug Component
- FTS5 keyword søgning
- Vector store embeddings
- Ranking/scoring logic

## FTS5 Debugging

### Check FTS Table
```bash
# FTS table struktur
sqlite3 data/hearings.db ".schema responses_fts"

# Test FTS direkte
sqlite3 data/hearings.db "SELECT rowid, * FROM responses_fts WHERE responses_fts MATCH 'test' LIMIT 5"
```

### FTS Query Syntax
```sql
-- Simpel match
SELECT * FROM responses_fts WHERE responses_fts MATCH 'klima';

-- Phrase match
SELECT * FROM responses_fts WHERE responses_fts MATCH '"grøn omstilling"';

-- OR søgning
SELECT * FROM responses_fts WHERE responses_fts MATCH 'klima OR miljø';

-- Prefix match
SELECT * FROM responses_fts WHERE responses_fts MATCH 'klima*';
```

### Rebuild FTS Index
```bash
# Via API
curl -s -X POST "http://localhost:3010/api/rebuild-index" | jq .

# Eller manuel
sqlite3 data/hearings.db "INSERT INTO responses_fts(responses_fts) VALUES('rebuild')"
```

## Vector Store Debugging

### Check Vector Store Status
```bash
# Antal chunks
sqlite3 data/hearings.db "SELECT COUNT(*) FROM vector_store_chunks"

# Chunks per høring
sqlite3 data/hearings.db "SELECT hearingId, COUNT(*) as chunks FROM vector_store_chunks GROUP BY hearingId"

# Chunk detaljer
sqlite3 data/hearings.db "SELECT id, hearingId, LENGTH(content), LENGTH(embedding) FROM vector_store_chunks WHERE hearingId = 223 LIMIT 5"
```

### Verify Embeddings
```bash
# Check embedding dimension
sqlite3 data/hearings.db "SELECT LENGTH(embedding) FROM vector_store_chunks LIMIT 1"

# Null embeddings
sqlite3 data/hearings.db "SELECT COUNT(*) FROM vector_store_chunks WHERE embedding IS NULL"
```

### Semantic Search Test
```bash
# Test via API
curl -s "http://localhost:3010/api/pipeline/223/search?q=bevaringshensyn" | jq .
```

## Ranking Analyse

### Score Breakdown
Find scoring logic i server.js:
```bash
grep -n "score\|rank\|weight" server.js | head -30
```

### Debug Ranking
```bash
# Get raw scores
curl -s "http://localhost:3010/api/search?q=test&debug=true" | jq '.results[] | {title, score}'
```

## Typiske Problemer

### 1. Ingen Resultater
```bash
# Check at data eksisterer
sqlite3 data/hearings.db "SELECT COUNT(*) FROM responses WHERE hearingId = 223"

# Check FTS coverage
sqlite3 data/hearings.db "SELECT COUNT(*) FROM responses_fts"
```

### 2. Dårlig Relevans
- FTS matcher for bredt/smalt
- Vector similarity threshold for høj/lav
- Manglende stemming på dansk

### 3. Langsom Søgning
```bash
# Check indexes
sqlite3 data/hearings.db ".indices responses"
sqlite3 data/hearings.db ".indices vector_store_chunks"

# Query timing
time curl -s "http://localhost:3010/api/search?q=test" > /dev/null
```

### 4. Manglende Chunks
```bash
# Compare response count vs chunks
sqlite3 data/hearings.db "
  SELECT
    r.hearingId,
    COUNT(DISTINCT r.id) as responses,
    COUNT(DISTINCT v.id) as chunks
  FROM responses r
  LEFT JOIN vector_store_chunks v ON r.hearingId = v.hearingId
  WHERE r.hearingId = 223
  GROUP BY r.hearingId
"
```

## Kode Lokationer

| Komponent | Fil | Funktion |
|-----------|-----|----------|
| Search API | server.js | `app.get('/api/search'...)` |
| FTS setup | db/sqlite.js | `createFTSTable()` |
| Vector store | db/sqlite.js | `vectorStore*` methods |
| Embeddings | server.js | `generateEmbedding()` |

## Find Søgekode
```bash
# Search endpoint
grep -n "api/search" server.js

# Vector search
grep -n "vectorSearch\|semanticSearch" server.js db/sqlite.js

# Embedding generation
grep -n "embedding\|embed" server.js
```

## Rapportering

Dokumentér debugging med:
1. Søgetermer testet
2. Forventede vs faktiske resultater
3. Identificeret problem
4. Anbefalet fix
