---
name: db-inspect
description: Undersøg database-tilstand, kør queries og forstå tabel-relationer
argument-hint: <tabel|query|hearing-id>
allowed-tools: Bash, Read, Grep, Glob
---

# Database Inspect - SQLite Undersøgelse

Inspicér databasen for at forstå data, relationer og tilstande.

## Database Lokation

```bash
DB_PATH="data/hearings.db"
```

## Workflow

### 1. Tabeloversigt
```bash
sqlite3 data/hearings.db ".tables"
```

### 2. Tabelstruktur
```bash
sqlite3 data/hearings.db ".schema {tabel}"
```

### 3. Kør Query
```bash
sqlite3 -header -column data/hearings.db "{query}"
```

## Vigtige Tabeller

### Høringer
```sql
-- Alle høringer
SELECT id, title, responseCount FROM hearings LIMIT 10;

-- Specifik høring
SELECT * FROM hearings WHERE id = 223;

-- Høringer med flest svar
SELECT id, title, responseCount FROM hearings ORDER BY responseCount DESC LIMIT 10;
```

### Responses
```sql
-- Responses for høring
SELECT id, personName, organizationName, LENGTH(response) as length
FROM responses WHERE hearingId = 223;

-- Tæl responses per høring
SELECT hearingId, COUNT(*) as count FROM responses GROUP BY hearingId;
```

### GDPR Workflow
```sql
-- GDPR staging status
SELECT * FROM gdpr_staging_hearings;

-- GDPR staged responses
SELECT hearingId, status, COUNT(*)
FROM gdpr_staging_responses
GROUP BY hearingId, status;
```

### Vector Store (Embeddings)
```sql
-- Chunks oversigt
SELECT hearingId, COUNT(*) as chunks
FROM vector_store_chunks
GROUP BY hearingId;

-- Chunk detaljer
SELECT id, LENGTH(content) as len, metadata
FROM vector_store_chunks
WHERE hearingId = 223 LIMIT 5;
```

### Analyse Resultater
```sql
-- Pipeline kørsler
SELECT * FROM pipeline_runs WHERE hearingId = 223;

-- Seneste analyser
SELECT hearingId, status, created_at
FROM pipeline_runs
ORDER BY created_at DESC LIMIT 10;
```

## Nyttige Queries

### Datakvalitet
```sql
-- Responses uden tekst
SELECT COUNT(*) FROM responses WHERE response IS NULL OR response = '';

-- Høringer uden responses
SELECT h.id, h.title FROM hearings h
LEFT JOIN responses r ON h.id = r.hearingId
WHERE r.id IS NULL;
```

### Relationer
```sql
-- Join høring med responses
SELECT h.title, r.personName, SUBSTR(r.response, 1, 100)
FROM hearings h
JOIN responses r ON h.id = r.hearingId
WHERE h.id = 223 LIMIT 5;
```

### GDPR Tilstand
```sql
-- Pending GDPR reviews
SELECT h.title, COUNT(r.id) as pending
FROM gdpr_staging_hearings h
JOIN gdpr_staging_responses r ON h.hearingId = r.hearingId
WHERE r.status = 'pending'
GROUP BY h.hearingId;
```

## Output Formattering

```bash
# Pæn tabelvisning
sqlite3 -header -column data/hearings.db "SELECT * FROM hearings LIMIT 5"

# CSV output
sqlite3 -header -csv data/hearings.db "SELECT id, title FROM hearings" > output.csv

# JSON output (via jq)
sqlite3 -json data/hearings.db "SELECT * FROM hearings LIMIT 5" | jq .

# Line-by-line
sqlite3 -line data/hearings.db "SELECT * FROM hearings WHERE id = 223"
```

## Database Schema Oversigt

Læs den fulde schema:
```bash
sqlite3 data/hearings.db ".schema" | less
```

Eller find tabeller i db/sqlite.js:
```bash
grep -n "CREATE TABLE" db/sqlite.js
```

## Debug Tips

1. **Check constraints**: `.schema {tabel}` viser FOREIGN KEY og UNIQUE
2. **Index info**: `PRAGMA index_list({tabel});`
3. **Row count**: `SELECT COUNT(*) FROM {tabel};`
4. **Sample data**: `SELECT * FROM {tabel} LIMIT 5;`

## Rapportering

Summarér fund med:
- Tabel(ler) undersøgt
- Antal rækker/data distribution
- Relevante observationer
- Eventuelle datakvalitetsproblemer
