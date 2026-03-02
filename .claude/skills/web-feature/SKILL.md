---
name: web-feature
description: End-to-end web feature udvikling med backend, frontend og test
argument-hint: <feature-beskrivelse>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Web Feature - End-to-End Feature Udvikling

Implementér nye features i webapplikationen med backend API, frontend UI og test.

## Arkitektur Oversigt

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Express   │────▶│   SQLite    │
│  (Vanilla)  │◀────│   Server    │◀────│   Database  │
└─────────────┘     └─────────────┘     └─────────────┘
```

- **Frontend**: Vanilla JS, ingen build, direkte DOM manipulation
- **Backend**: Express.js i `server.js` (10.900+ linjer)
- **Database**: SQLite via `db/sqlite.js`

## Workflow

### 1. Forstå Kravet
- Hvad skal featuren gøre?
- Hvilke eksisterende patterns ligner?
- Påvirker det eksisterende funktionalitet?

### 2. Design API
```javascript
// Eksempel endpoint struktur
app.get('/api/{resource}', (req, res) => {
  // Input validation
  // Database query
  // Response formatting
});
```

### 3. Implementér Backend
1. Find relevant sektion i `server.js`
2. Tilføj endpoint(s)
3. Tilføj database operations hvis nødvendigt

### 4. Implementér Frontend
1. Tilføj UI elementer i HTML
2. Tilføj JavaScript logik
3. Style med eksisterende CSS patterns

### 5. Test
1. API test med curl
2. Frontend test manuelt
3. Edge cases og fejlhåndtering

## Kode Patterns

### Backend Endpoint
```javascript
// GET endpoint
app.get('/api/example/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.getExample(id);
    if (!result) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST endpoint
app.post('/api/example', async (req, res) => {
  try {
    const { field1, field2 } = req.body;
    if (!field1 || !field2) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const result = await db.createExample({ field1, field2 });
    res.status(201).json(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### Database Operation
```javascript
// I db/sqlite.js
getExample(id) {
  return this.db.prepare('SELECT * FROM examples WHERE id = ?').get(id);
}

createExample({ field1, field2 }) {
  const stmt = this.db.prepare(
    'INSERT INTO examples (field1, field2) VALUES (?, ?)'
  );
  const result = stmt.run(field1, field2);
  return { id: result.lastInsertRowid, field1, field2 };
}
```

### Frontend API Call
```javascript
async function loadExample(id) {
  const response = await fetch(`/api/example/${id}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function createExample(data) {
  const response = await fetch('/api/example', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create');
  }
  return response.json();
}
```

### Frontend DOM Update
```javascript
function renderExample(container, data) {
  container.innerHTML = '';
  const element = document.createElement('div');
  element.className = 'example-item';
  element.textContent = data.title;
  container.appendChild(element);
}
```

## Sikkerhed Checkliste

- [ ] Input validering på backend
- [ ] SQL parameterisering (aldrig string concatenation)
- [ ] XSS prevention (textContent over innerHTML)
- [ ] Ingen sensitiv data i responses
- [ ] Rate limiting hvis relevant

## Test Procedure

### 1. API Test
```bash
# Test endpoint
curl -s "http://localhost:3010/api/example/1" | jq .

# Test med data
curl -s -X POST "http://localhost:3010/api/example" \
  -H "Content-Type: application/json" \
  -d '{"field1": "test", "field2": "value"}' | jq .
```

### 2. Fejlhåndtering Test
```bash
# Ugyldig input
curl -s "http://localhost:3010/api/example/invalid" | jq .

# Manglende data
curl -s -X POST "http://localhost:3010/api/example" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

### 3. Frontend Test
1. Åbn browser til localhost:3010
2. Test user flow
3. Check console for fejl
4. Test edge cases

## Fil Lokationer

| Komponent | Fil(er) |
|-----------|---------|
| Backend routes | `server.js` |
| Database layer | `db/sqlite.js` |
| Frontend HTML | `public/*.html` |
| Frontend JS | `public/js/*.js` |
| Styles | `public/*.html` (inline) eller `public/css/` |

## Rapportering

Efter implementation, dokumentér:
1. Tilføjede/ændrede filer
2. Nye endpoints
3. Test resultater
4. Eventuelle kendte begrænsninger
