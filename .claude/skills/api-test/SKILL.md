---
name: api-test
description: Test API endpoints med curl, verificer response struktur og fejlhåndtering
argument-hint: <endpoint> [metode] [beskrivelse]
allowed-tools: Bash, Read, Grep
---

# API Test - Validering af API Endpoints

Test webapplikationens API endpoints hurtigt og systematisk.

## Workflow

### 1. Identificer Endpoint
Find endpoint definition i `server.js`:
```bash
grep -n "app.get\|app.post\|app.put\|app.delete" server.js | grep "{endpoint}"
```

### 2. Kør Test
Brug curl til at teste endpoint:
```bash
# GET request
curl -s "http://localhost:3010{endpoint}" | jq .

# POST request med JSON body
curl -s -X POST "http://localhost:3010{endpoint}" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}' | jq .

# POST med form data
curl -s -X POST "http://localhost:3010{endpoint}" \
  -d "field=value" | jq .
```

### 3. Verificer Response
Check:
- HTTP status kode
- Response struktur
- Forventede felter

## Vigtige Endpoints

### Core API
```bash
# Søgning
curl -s "http://localhost:3010/api/search?q=test" | jq .

# Høring detaljer
curl -s "http://localhost:3010/api/hearing/{id}" | jq .

# Liste høringer
curl -s "http://localhost:3010/api/hearings" | jq .
```

### Pipeline Integration
```bash
# Pipeline status
curl -s "http://localhost:3010/api/pipeline/{id}/status" | jq .

# Start analyse
curl -s -X POST "http://localhost:3010/api/pipeline/{id}/start" | jq .

# Hent analyse
curl -s "http://localhost:3010/api/pipeline/{id}/analysis" | jq .
```

### GDPR Workflow
```bash
# GDPR høringer
curl -s "http://localhost:3010/api/gdpr/hearings" | jq .

# GDPR responses
curl -s "http://localhost:3010/api/gdpr/hearing/{id}/responses" | jq .
```

### Health Check
```bash
curl -s "http://localhost:3010/health" | jq .
curl -s "http://localhost:3010/healthz" | jq .
```

## Fejlhåndtering Test

Test at endpoints håndterer fejl korrekt:
```bash
# Ugyldig ID
curl -s "http://localhost:3010/api/hearing/999999" | jq .

# Manglende parametre
curl -s -X POST "http://localhost:3010/api/search" | jq .

# Forkert metode
curl -s -X DELETE "http://localhost:3010/api/hearing/1" -w "\n%{http_code}"
```

## Session Test

Test endpoints der kræver session:
```bash
# Med cookie jar
curl -c cookies.txt -b cookies.txt -s "http://localhost:3010{endpoint}"
```

## Output Analyse

Brug jq til at analysere responses:
```bash
# Tæl elementer
curl -s "http://localhost:3010/api/hearings" | jq 'length'

# Filtrer felter
curl -s "http://localhost:3010/api/hearing/223" | jq '{id, title, responseCount}'

# Check for fejl
curl -s "http://localhost:3010/api/search?q=test" | jq '.error // "OK"'
```

## Rapportering

Efter test, rapporter:
1. Endpoint testet
2. Request detaljer
3. Response status og struktur
4. Eventuelle problemer fundet
