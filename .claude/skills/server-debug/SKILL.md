---
name: server-debug
description: Diagnosticér server-fejl via logs, request tracing og kode-analyse
argument-hint: [fejl-beskrivelse|endpoint|log-søgning]
allowed-tools: Bash, Read, Grep, Glob
---

# Server Debug - Express Server Fejlfinding

Diagnosticér og debug problemer i webapplikationens Express server.

## Workflow

### 1. Check Server Status
```bash
# Er serveren kørende?
curl -s http://localhost:3010/health | jq .

# Process status
pgrep -f "node server.js" && echo "Running" || echo "Not running"
```

### 2. Læs Logs
```bash
# Seneste log entries
tail -100 server.log

# Søg efter fejl
grep -i "error\|exception\|fail" server.log | tail -50

# Følg log live
tail -f server.log
```

### 3. Find Endpoint i Kode
```bash
# Find route definition
grep -n "app.get.*{endpoint}\|app.post.*{endpoint}" server.js

# Find handler funktion
grep -B5 -A50 "app.get.*{endpoint}" server.js
```

## Log Analyse

### Fejltyper
```bash
# HTTP fejl (4xx, 5xx)
grep -E "\" (4|5)[0-9]{2} " server.log

# Uncaught exceptions
grep -i "uncaught\|unhandled" server.log

# Database fejl
grep -i "sqlite\|database\|SQLITE" server.log

# API timeout
grep -i "timeout\|ETIMEDOUT" server.log
```

### Request Tracing
```bash
# Find specifikke requests
grep "GET /api/hearing/223" server.log

# Response times
grep -E "\" [0-9]{3} [0-9]+ms" server.log | tail -20

# Langsomme requests (>1000ms)
grep -E "\" [0-9]{3} [0-9]{4,}ms" server.log
```

## Kodeanalyse

### Endpoint Struktur
```bash
# Liste alle endpoints
grep -n "app\.\(get\|post\|put\|delete\|use\)" server.js | head -50

# Find middleware
grep -n "app.use" server.js
```

### Fejlhåndtering
```bash
# Find error handlers
grep -n "catch\|error\|err =>" server.js

# Global error handler
grep -B5 -A20 "app.use.*err.*req.*res" server.js
```

### Database Kald
```bash
# Find db operationer for endpoint
grep -A30 "app.get.*{endpoint}" server.js | grep -E "db\.|sqlite"
```

## Typiske Problemer

### 1. 500 Internal Server Error
```bash
# Find seneste 500 fejl
grep "\" 500 " server.log | tail -10

# Stack trace
grep -A20 "Error:" server.log | tail -30
```

### 2. Database Locked
```bash
# Check for lock fejl
grep -i "locked\|busy" server.log

# Find åbne db connections
lsof data/hearings.db
```

### 3. Memory Issues
```bash
# Node memory usage
ps -o pid,rss,command | grep node

# Heap snapshots (hvis aktiveret)
ls -la *.heapsnapshot 2>/dev/null
```

### 4. Port Already in Use
```bash
# Check port 3010
lsof -i :3010

# Kill existing process
kill $(lsof -t -i :3010)
```

## Server.js Navigation

Key sections i server.js (10.900+ linjer):
```bash
# Database setup
grep -n "require.*sqlite\|new Database" server.js

# Route grupper
grep -n "// API\|// GDPR\|// Pipeline" server.js

# Middleware
grep -n "app.use" server.js | head -20
```

## Debug Teknikker

### Tilføj Logging
```javascript
console.log('[DEBUG]', { endpoint, params, query });
```

### Request Replay
```bash
# Gem request og replay
curl -v "http://localhost:3010{endpoint}" 2>&1 | tee request.log
```

### Environment Check
```bash
# Check env vars
env | grep -E "PORT|DB_PATH|OPENAI|NODE_ENV"
```

## Rapportering

Summarér debugging med:
1. Fejlbeskrivelse
2. Relevant log output
3. Identificeret root cause
4. Foreslået fix
