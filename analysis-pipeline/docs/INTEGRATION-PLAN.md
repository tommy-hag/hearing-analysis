# Pipeline Integration Plan for Frontend Modal

This document describes the planned changes to the `analysis-pipeline` folder to fully integrate with the frontend modal in the main application.

## Overview

The main application (`server.js` + `public/index.html`) now has endpoints and UI for:
1. Checking pipeline status for a hearing
2. Starting a pipeline run (full or incremental)
3. Polling progress during execution
4. Downloading the generated `.docx` file

This integration is currently functional but could be improved with the changes outlined below.

---

## Current Integration Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Main Application (server.js)                  │
├─────────────────────────────────────────────────────────────────┤
│  /api/pipeline/:id/status   → Reads output/runs/{id}/*/progress │
│  /api/pipeline/:id/start    → Spawns: npm run pipeline:run      │
│  /api/pipeline/:id/progress → Reads progress.json               │
│  /api/pipeline/:id/download → Serves .docx file                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    spawn('npm', ['run', 'pipeline:run', ...])
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                 analysis-pipeline/scripts/run-pipeline.js        │
├─────────────────────────────────────────────────────────────────┤
│  - Reads DB_PATH from environment                                │
│  - Writes to output/runs/{hearingId}/{label}/                   │
│  - Creates progress.json (real-time updates)                     │
│  - Creates run-summary.json (after completion)                   │
│  - Creates hearing-{id}-analysis.docx                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Planned Improvements

### 1. Add `--json-output` flag for machine-readable output

**File:** `scripts/run-pipeline.js`

**Purpose:** Enable cleaner stdout parsing when spawned by server.

**Changes:**
```javascript
// Add to parseArgs handling
case 'json-output':
    options['json-output'] = true;
    break;

// In main(), wrap console output based on flag
if (args['json-output']) {
    // Suppress verbose console.log during run
    // Only output structured JSON at end
}

// At completion:
if (args['json-output']) {
    console.log(JSON.stringify({
        status: 'completed',
        hearingId,
        label: checkpointLabel,
        runDir: runDirManager.getRunDir(),
        docxPath: runDirManager.getFinalDocxPath(),
        qualityScore: summary.quality.score,
        qualityGrade: summary.quality.grade
    }));
}
```

**Priority:** Low - current implementation works via progress.json polling

---

### 2. Ensure `DB_PATH` is correctly inherited

**File:** `src/utils/data-loader.js`

**Current behavior:** Already reads `DB_PATH` from environment (line 51-71)

**Verification needed:**
- [ ] Confirm that relative paths in DB_PATH work when cwd is analysis-pipeline/
- [ ] Test with absolute path: `/home/laqzww/gdpr/data/hearing-data.db`

**Recommendation:** The server already passes the correct absolute path:
```javascript
// server.js line ~234
env: {
    ...process.env,
    DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data', 'hearing-data.db')
}
```

No changes required unless issues are discovered during testing.

---

### 3. Add health check for pipeline dependencies

**New file:** `scripts/check-dependencies.js`

**Purpose:** Quick verification that all required tools are available.

```javascript
#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const checks = [
    {
        name: 'Node.js version',
        check: () => {
            const version = process.version;
            const major = parseInt(version.slice(1).split('.')[0]);
            return major >= 18 ? { ok: true, version } : { ok: false, error: 'Node 18+ required' };
        }
    },
    {
        name: 'Pandoc',
        check: () => {
            try {
                const version = execSync('pandoc --version', { encoding: 'utf-8' }).split('\n')[0];
                return { ok: true, version };
            } catch {
                return { ok: false, error: 'Pandoc not found - DOCX generation will fail' };
            }
        }
    },
    {
        name: 'Database access',
        check: () => {
            const dbPath = process.env.DB_PATH || '../data/hearing-data.db';
            const exists = existsSync(resolve(dbPath));
            return exists ? { ok: true, path: dbPath } : { ok: false, error: `DB not found: ${dbPath}` };
        }
    },
    {
        name: 'OpenAI API key',
        check: () => {
            const key = process.env.OPENAI_API_KEY;
            return key && key.startsWith('sk-') 
                ? { ok: true, keyPrefix: key.substring(0, 7) + '...' }
                : { ok: false, error: 'OPENAI_API_KEY not set or invalid' };
        }
    }
];

async function main() {
    console.log('Pipeline Dependency Check\n');
    
    let allOk = true;
    for (const { name, check } of checks) {
        const result = check();
        if (result.ok) {
            console.log(`✅ ${name}: ${result.version || result.path || result.keyPrefix || 'OK'}`);
        } else {
            console.log(`❌ ${name}: ${result.error}`);
            allOk = false;
        }
    }
    
    process.exit(allOk ? 0 : 1);
}

main();
```

**Add to package.json:**
```json
"scripts": {
    "check": "node scripts/check-dependencies.js"
}
```

**Priority:** Medium - helps with debugging deployment issues

---

### 4. Optional: HTTP API wrapper for pipeline

**New file:** `scripts/api-server.js`

**Purpose:** Alternative to spawning child processes - run pipeline as HTTP service.

**Considerations:**
- Would require separate process management
- More complex deployment
- Better isolation and error handling
- Could support WebSocket for real-time progress

**Decision:** Not recommended for current scope. Child process approach is simpler and works well.

**Priority:** Low - only if child process approach proves problematic

---

### 5. Graceful shutdown and resume support

**File:** `src/pipeline/pipeline-orchestrator.js`

**Current behavior:** Pipeline supports `--resume=<step>` but doesn't auto-detect interrupted runs.

**Enhancement:** On pipeline start, check if an incomplete run exists:

```javascript
// In PipelineOrchestrator.run()
async checkForIncompleteRun(hearingId, label) {
    const progressPath = join(runDir, 'progress.json');
    if (!existsSync(progressPath)) return null;
    
    const progress = JSON.parse(readFileSync(progressPath, 'utf-8'));
    
    if (progress.status === 'running') {
        // Found interrupted run
        const lastCompletedStep = progress.completedSteps?.[progress.completedSteps.length - 1];
        console.log(`[Pipeline] Found interrupted run at step: ${lastCompletedStep}`);
        return lastCompletedStep;
    }
    
    return null;
}
```

**Server-side integration:**
```javascript
// In /api/pipeline/:hearingId/start
// Before spawning, check if last run was interrupted
const latestProgress = getLatestRunProgress(hearingId);
if (latestProgress?.status === 'running') {
    // Add --resume flag automatically
    args.push(`--resume=${latestProgress.currentStep}`);
}
```

**Priority:** High - important for failure recovery

---

### 6. Progress file locking / atomic writes

**File:** `src/pipeline/progress-tracker.js`

**Issue:** Potential race condition if server reads progress.json while pipeline is writing.

**Solution:** Write to temp file, then rename (atomic on most filesystems):

```javascript
import { writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';

function atomicWriteJson(filePath, data) {
    const tempPath = join(dirname(filePath), `.${Date.now()}.tmp`);
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempPath, filePath);
}
```

**Priority:** Low - unlikely to cause issues in practice

---

## Environment Variables

The pipeline expects these environment variables (can be inherited from parent process):

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | Yes | Absolute path to SQLite database |
| `OPENAI_API_KEY` | Yes | OpenAI API key for LLM calls |
| `LLM_LIGHT_MODEL` | No | Model for simple tasks (default: gpt-5-nano) |
| `LLM_MEDIUM_MODEL` | No | Model for standard analysis (default: gpt-5-nano) |
| `LLM_HEAVY_MODEL` | No | Model for complex tasks (default: gpt-5-mini) |
| `EMBEDDING_MODEL` | No | Embedding model (default: text-embedding-3-large) |
| `VERBOSE` | No | Enable verbose logging |

---

## Run Label Strategy

The server generates run labels using timestamp format: `run-{timestamp}`

Example: `run-1702828800000`

**Finding latest completed run:**
1. List all directories in `output/runs/{hearingId}/`
2. Read `progress.json` from each
3. Filter by `status === 'completed'`
4. Sort by `endTime` descending
5. Return first match

**Incremental run detection:**
1. Get latest completed run
2. Compare `responseCount` from run vs. current DB count
3. If current > run count, pass `--incremental={latestLabel}`

---

## Testing the Integration

1. **Start the main server:**
   ```bash
   cd /home/laqzww/gdpr
   npm start
   ```

2. **Open browser to localhost:3010**

3. **Search for a hearing and click on it**

4. **Modal should show pipeline section:**
   - If no analysis exists: "Start analyse" button
   - If analysis exists: "Download rapport" button + stats
   - If new responses exist: "Opdater analyse" button

5. **Click "Start analyse" to test spawning**

6. **Watch progress bar update in real-time**

7. **Download the generated DOCX when complete**

---

## Error Handling

### Pipeline failure scenarios:

| Scenario | Current Handling | Recommended |
|----------|------------------|-------------|
| OpenAI API error | Pipeline crashes | Retry with backoff |
| Out of memory | Process killed | Checkpoint enables resume |
| Invalid data | Pipeline crashes | Validate input, fail fast |
| Pandoc not found | No DOCX | Skip DOCX, still complete |

### Server-side failure tracking:

The server tracks failures per hearing:
- After 3 consecutive failures → 4-hour timeout
- Timeout clears automatically after expiry
- User sees remaining time in modal

---

## Future Considerations

1. **Queue system:** If multiple users try to analyze different hearings, they currently run in parallel. Consider adding a job queue for resource management.

2. **Cost estimation:** Before starting, show estimated cost based on response count.

3. **Partial downloads:** Allow downloading intermediate checkpoints (JSON analysis without DOCX).

4. **Email notification:** Notify user when long-running analysis completes.

---

## Implementation Checklist

- [x] Backend API endpoints in server.js
- [x] Frontend modal UI in index.html
- [ ] Add `--json-output` flag (optional)
- [ ] Add dependency check script (recommended)
- [ ] Add auto-resume for interrupted runs (recommended)
- [ ] Test full integration end-to-end
- [ ] Document in main README

---

*Last updated: December 2025*



