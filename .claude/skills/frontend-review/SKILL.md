---
name: frontend-review
description: Kvalitetsgennemgang af frontend-kode, patterns og tilgængelighed
argument-hint: <fil|komponent|område>
allowed-tools: Read, Grep, Glob
---

# Frontend Review - Kode Kvalitetsgennemgang

Systematisk gennemgang af frontend JavaScript og HTML for kvalitet, patterns og tilgængelighed.

## Frontend Struktur

```
public/
├── index.html        # Hovedsøgning
├── gdpr.html         # GDPR workflow
├── analysis.html     # Analyse viewer
├── work.html         # Arbejdsinterface
├── js/
│   ├── gdpr.js       # 2.600+ linjer - GDPR frontend logic
│   └── ...
└── css/
```

## Review Workflow

### 1. Identificer Scope
Hvad skal gennemgås?
- Specifik fil
- Komponent/feature
- Hele frontend

### 2. Pattern Analyse
Gennemgå for:
- DOM manipulation patterns
- Event handling
- State management
- Error handling
- API kommunikation

### 3. Kvalitetskriterier
Check for:
- Tilgængelighed (a11y)
- Performance
- Fejlhåndtering
- Kode læsbarhed
- Sikkerhed

## Review Checkliste

### DOM Manipulation
```bash
# Find DOM queries
grep -n "getElementById\|querySelector\|getElementsBy" public/js/*.js

# Find DOM mutations
grep -n "innerHTML\|textContent\|appendChild\|insertBefore" public/js/*.js
```

**Spørgsmål:**
- Caches DOM references korrekt?
- Undgår unødvendige reflows?
- Bruger template literals for kompleks HTML?

### Event Handling
```bash
# Find event listeners
grep -n "addEventListener\|onclick\|on[a-z]*=" public/js/*.js public/*.html
```

**Spørgsmål:**
- Event delegation brugt hvor relevant?
- Listeners cleaned up ved removal?
- Debounce/throttle på scroll/resize?

### State Management
```bash
# Find globale variabler
grep -n "^let \|^var \|^const " public/js/*.js | head -30

# Find state objekter
grep -n "state\|State\|DATA\|cache" public/js/*.js
```

**Spørgsmål:**
- State centraliseret eller spredt?
- Konsistent opdateringsmønster?
- Race conditions håndteret?

### API Kommunikation
```bash
# Find fetch calls
grep -n "fetch\|XMLHttpRequest\|ajax" public/js/*.js

# Find error handling
grep -B2 -A5 "\.catch\|\.then" public/js/*.js
```

**Spørgsmål:**
- Loading states vist?
- Fejl håndteret og vist til bruger?
- Retries implementeret?

### Error Handling
```bash
# Find try-catch
grep -n "try.*{" public/js/*.js

# Find error logging
grep -n "console.error\|console.warn" public/js/*.js
```

**Spørgsmål:**
- User-facing fejlbeskeder på dansk?
- Graceful degradation?
- Error recovery hvor muligt?

## Tilgængelighed (a11y)

### HTML Semantik
```bash
# Check for semantiske elementer
grep -n "<nav\|<main\|<article\|<section\|<aside\|<header\|<footer" public/*.html

# Find ARIA attributter
grep -n "aria-\|role=" public/*.html
```

### Fokus Management
```bash
# Find focus handling
grep -n "focus\(\)\|tabindex" public/js/*.js public/*.html
```

### Labelling
```bash
# Find form labels
grep -n "<label\|aria-label\|aria-labelledby" public/*.html
```

**Checkliste:**
- [ ] Alle interaktive elementer har tilgængelige navne
- [ ] Fokus synlig og logisk rækkefølge
- [ ] Fejlbeskeder associeret med form felter
- [ ] Keyboard navigation virker

## Performance

```bash
# Find potentielle performance issues
grep -n "setInterval\|setTimeout" public/js/*.js
grep -n "\.style\." public/js/*.js
```

**Spørgsmål:**
- Unødvendige loops over store datasæt?
- Layout thrashing?
- Memory leaks (ubrugte listeners/timers)?

## Sikkerhed

```bash
# Find potentielle XSS
grep -n "innerHTML.*=\|document.write" public/js/*.js

# Find eval-lignende
grep -n "eval\|Function\(" public/js/*.js
```

**Spørgsmål:**
- Input saniteret før rendering?
- Undgår inline event handlers med user data?

## Rapportering

Strukturér review output som:

### Positive Findings
- Gode patterns observeret
- Velstruktureret kode

### Issues
| Prioritet | Fil:Linje | Problem | Anbefaling |
|-----------|-----------|---------|------------|
| Høj | gdpr.js:123 | XSS risiko | Brug textContent |
| Medium | ... | ... | ... |

### Anbefalinger
- Konkrete forbedringer
- Refactoring muligheder
