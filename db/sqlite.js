const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
let Database;

function tryRequireBetterSqlite3() {
    try { return require('better-sqlite3'); } catch (e) { return e; }
}

function needsRebuild(error) {
    const msg = String((error && error.message) || error || '').toLowerCase();
    return (
        msg.includes('node_module_version') ||
        msg.includes('was compiled against a different node.js version') ||
        msg.includes('invalid or incompatible binary') ||
        msg.includes('did not self-register') ||
        msg.includes('module did not self-register')
    );
}

function detectProjectRootFromError(error) {
    try {
        const msg = String((error && error.message) || '');
        const marker = '/node_modules/better-sqlite3/';
        const idx = msg.indexOf(marker);
        if (idx > 0) {
            const prefix = msg.slice(0, idx);
            const rootIdx = prefix.lastIndexOf('/');
            const root = prefix.slice(0, rootIdx);
            if (root && root.startsWith('/')) return root;
        }
    } catch {}
    return null;
}

function attemptRebuildOnce(hintError) {
    try {
        if (attemptRebuildOnce._did) return;
        attemptRebuildOnce._did = true;
        console.log('[SQLite] Attempting runtime rebuild of better-sqlite3...');
        const hinted = detectProjectRootFromError(hintError);
        const cwd = hinted || process.cwd();
        const env = { ...process.env, npm_config_build_from_source: 'true' };
        // Best-effort: rebuild native module for the current Node runtime
        const result = spawnSync('npm', ['rebuild', 'better-sqlite3', '--build-from-source', '--unsafe-perm'], {
            cwd,
            env,
            stdio: 'inherit'
        });
        console.log('[SQLite] Rebuild attempt completed with status:', result.status);
    } catch (e) { 
        console.error('[SQLite] Rebuild attempt failed:', e.message);
    }
}

(() => {
    const first = tryRequireBetterSqlite3();
    if (first && typeof first === 'object' && first.name) {
        // Received an Error instance
        console.log('[SQLite] Initial require failed:', first.message);
        if (needsRebuild(first) && process.env.ALLOW_RUNTIME_SQLITE_REBUILD === '1') {
            console.log('[SQLite] Runtime rebuild requested but skipping to avoid hangs');
            // Skip runtime rebuild as it can hang the process
            // attemptRebuildOnce(first);
            // const second = tryRequireBetterSqlite3();
            // if (typeof second === 'function' || (second && second.open)) {
            //     console.log('[SQLite] Successfully loaded after rebuild');
            //     Database = second;
            //     return;
            // } else {
            //     console.error('[SQLite] Failed to load even after rebuild');
            // }
        }
        Database = null;
    } else {
        // Successfully required the module
        console.log('[SQLite] better-sqlite3 loaded successfully on first try');
        Database = first;
    }
})();

// Detect if running on Render by checking for RENDER environment variable
const isRender = process.env.RENDER === 'true';
// On Render, the working directory is /opt/render/project/src
// The disk is mounted at /opt/render/project/src/data
// Force absolute path on Render
const defaultPath = isRender
    ? '/opt/render/project/src/data/hearings.db'
    : path.join(__dirname, '..', 'data', 'hearings.db');

// If DB_PATH is set but relative, make it absolute on Render
let DB_PATH = process.env.DB_PATH || defaultPath;
if (isRender && DB_PATH && !path.isAbsolute(DB_PATH)) {
    DB_PATH = path.join('/opt/render/project/src', DB_PATH);
}

console.log('[SQLite] Environment:', {
    isRender,
    DB_PATH,
    cwd: process.cwd(),
    __dirname
});

let db = null;

function init() {
    console.log('[SQLite] Initializing database...');
    console.log('[SQLite] DB_PATH:', DB_PATH);
    console.log('[SQLite] DB directory exists:', fs.existsSync(path.dirname(DB_PATH)));
    
    if (!Database) {
        throw new Error('better-sqlite3 is not installed or failed to load. Check build logs for native module errors.');
    }
    // Attempt to open DB; if ABI mismatch occurs at instantiation, try a one-time rebuild
    try {
        // Ensure parent directory exists to avoid SQLITE_CANTOPEN errors
        try { 
            fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); 
            console.log('[SQLite] Created directory:', path.dirname(DB_PATH));
        } catch (e) {
            console.log('[SQLite] Directory creation error (may already exist):', e.message);
        }
        db = new Database(DB_PATH);
        console.log('[SQLite] Database opened successfully');
    } catch (e) {
        if (needsRebuild(e) && process.env.ALLOW_RUNTIME_SQLITE_REBUILD === '1') {
            console.log('[SQLite] Database instantiation failed with rebuild error, but skipping runtime rebuild');
            // Don't attempt runtime rebuild as it can hang
            // attemptRebuildOnce(e);
            // const re = tryRequireBetterSqlite3();
            // if (typeof re === 'function' || (re && re.open)) {
            //     Database = re;
            // }
            // // Retry once after rebuild
            // try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
            // db = new Database(DB_PATH);
        }
            throw e;
    }
    try { db.pragma('journal_mode = WAL'); } catch (_) {}
    db.exec(`
        CREATE TABLE IF NOT EXISTS hearings(
          id INTEGER PRIMARY KEY,
          title TEXT,
          start_date TEXT,
          deadline TEXT,
          status TEXT,
          updated_at INTEGER,
          complete INTEGER,
          signature TEXT,
          total_responses INTEGER,
          total_materials INTEGER,
          last_success_at INTEGER,
          archived INTEGER
        );
        CREATE TABLE IF NOT EXISTS responses(
          hearing_id INTEGER,
          response_id INTEGER,
          text TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          PRIMARY KEY(hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS attachments(
          hearing_id INTEGER,
          response_id INTEGER,
          idx INTEGER,
          filename TEXT,
          url TEXT,
          PRIMARY KEY(hearing_id, response_id, idx)
        );
        CREATE TABLE IF NOT EXISTS materials(
          hearing_id INTEGER,
          idx INTEGER,
          type TEXT,
          title TEXT,
          url TEXT,
          content TEXT,
          PRIMARY KEY(hearing_id, idx)
        );
        CREATE TABLE IF NOT EXISTS raw_responses(
          hearing_id INTEGER,
          response_id INTEGER,
          text TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          page INTEGER,
          PRIMARY KEY(hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS raw_attachments(
          hearing_id INTEGER,
          response_id INTEGER,
          idx INTEGER,
          filename TEXT,
          url TEXT,
          PRIMARY KEY(hearing_id, response_id, idx)
        );
        CREATE TABLE IF NOT EXISTS raw_materials(
          hearing_id INTEGER,
          idx INTEGER,
          type TEXT,
          title TEXT,
          url TEXT,
          content TEXT,
          PRIMARY KEY(hearing_id, idx)
        );
        CREATE TABLE IF NOT EXISTS prepared_responses(
          hearing_id INTEGER,
          prepared_id INTEGER,
          source_response_id INTEGER,
          respondent_name TEXT,
          respondent_type TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          text_md TEXT,
          has_attachments INTEGER,
          attachments_ready INTEGER,
          approved INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          approved_at INTEGER,
          notes TEXT,
          focus_mode TEXT,
          PRIMARY KEY(hearing_id, prepared_id)
        );
        CREATE TABLE IF NOT EXISTS prepared_attachments(
          hearing_id INTEGER,
          prepared_id INTEGER,
          attachment_id INTEGER,
          source_attachment_idx INTEGER,
          original_filename TEXT,
          source_url TEXT,
          converted_md TEXT,
          conversion_status TEXT,
          approved INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          approved_at INTEGER,
          notes TEXT,
          PRIMARY KEY(hearing_id, prepared_id, attachment_id)
        );
        CREATE TABLE IF NOT EXISTS prepared_materials(
          hearing_id INTEGER,
          material_id INTEGER,
          title TEXT,
          source_filename TEXT,
          source_url TEXT,
          content_md TEXT,
          uploaded_path TEXT,
          approved INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          approved_at INTEGER,
          notes TEXT,
          PRIMARY KEY(hearing_id, material_id)
        );
        CREATE TABLE IF NOT EXISTS published_responses(
          hearing_id INTEGER,
          response_id INTEGER,
          source_response_id INTEGER,
          respondent_name TEXT,
          respondent_type TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          text TEXT,
          text_md TEXT,
          has_attachments INTEGER,
          approved_at INTEGER,
          published_at INTEGER,
          PRIMARY KEY(hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS published_attachments(
          hearing_id INTEGER,
          response_id INTEGER,
          attachment_id INTEGER,
          original_filename TEXT,
          content_md TEXT,
          approved_at INTEGER,
          published_at INTEGER,
          PRIMARY KEY(hearing_id, response_id, attachment_id)
        );
        CREATE TABLE IF NOT EXISTS published_materials(
          hearing_id INTEGER,
          material_id INTEGER,
          title TEXT,
          content_md TEXT,
          uploaded_path TEXT,
          approved_at INTEGER,
          published_at INTEGER,
          PRIMARY KEY(hearing_id, material_id)
        );
        CREATE TABLE IF NOT EXISTS hearing_preparation_state(
          hearing_id INTEGER PRIMARY KEY,
          status TEXT,
          responses_ready INTEGER,
          materials_ready INTEGER,
          vector_store_id TEXT,
          vector_store_updated_at INTEGER,
          last_modified_at INTEGER,
          published_at INTEGER,
          prepared_by TEXT,
          notes TEXT
        );
        CREATE TABLE IF NOT EXISTS vector_chunks(
          hearing_id INTEGER,
          chunk_id TEXT,
          source TEXT,
          content TEXT,
          embedding TEXT,
          created_at INTEGER,
          PRIMARY KEY(hearing_id, chunk_id)
        );
        CREATE TABLE IF NOT EXISTS hearing_index(
          id INTEGER PRIMARY KEY,
          title TEXT,
          start_date TEXT,
          deadline TEXT,
          status TEXT,
          normalized_title TEXT,
          title_tokens TEXT,
          deadline_ts INTEGER,
          is_open INTEGER,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS session_edits(
          session_id TEXT,
          hearing_id INTEGER,
          response_id INTEGER,
          respondent_name TEXT,
          respondent_type TEXT,
          author TEXT,
          organization TEXT,
          on_behalf_of TEXT,
          submitted_at TEXT,
          text TEXT,
          PRIMARY KEY(session_id, hearing_id, response_id)
        );
        CREATE TABLE IF NOT EXISTS session_materials(
          session_id TEXT,
          hearing_id INTEGER,
          idx INTEGER,
          included INTEGER,
          PRIMARY KEY(session_id, hearing_id, idx)
        );
        CREATE TABLE IF NOT EXISTS session_uploads(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          hearing_id INTEGER,
          stored_path TEXT,
          original_name TEXT,
          uploaded_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS gdpr_selected_hearings(
          hearing_id INTEGER PRIMARY KEY,
          added_at INTEGER
        );
        -- Background jobs for summarization
        CREATE TABLE IF NOT EXISTS jobs(
          job_id TEXT PRIMARY KEY,
          hearing_id INTEGER,
          state TEXT,
          phase TEXT,
          progress INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          idempotency_key TEXT,
          input_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
        CREATE INDEX IF NOT EXISTS idx_jobs_hearing ON jobs(hearing_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS job_variants(
          job_id TEXT,
          variant INTEGER,
          state TEXT,
          phase TEXT,
          progress INTEGER,
          response_id TEXT,
          markdown TEXT,
          summary TEXT,
          headings_json TEXT,
          partial_chars INTEGER,
          error TEXT,
          updated_at INTEGER,
          PRIMARY KEY(job_id, variant)
        );
        CREATE INDEX IF NOT EXISTS idx_job_variants_state ON job_variants(job_id, state);

        CREATE TABLE IF NOT EXISTS job_events(
          job_id TEXT,
          ts INTEGER,
          level TEXT,
          message TEXT,
          data_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, ts);
        CREATE INDEX IF NOT EXISTS idx_raw_responses_hearing ON raw_responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_prepared_responses_hearing ON prepared_responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_published_responses_hearing ON published_responses(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_prepared_materials_hearing ON prepared_materials(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_published_materials_hearing ON published_materials(hearing_id);
        CREATE INDEX IF NOT EXISTS idx_vector_chunks_hearing ON vector_chunks(hearing_id);

        -- Analysis drafts for interactive editing
        CREATE TABLE IF NOT EXISTS analysis_drafts(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hearing_id INTEGER NOT NULL,
          base_run_label TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE(hearing_id, status)
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_drafts_hearing ON analysis_drafts(hearing_id);

        CREATE TABLE IF NOT EXISTS draft_operations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          operation_type TEXT NOT NULL,
          operation_data TEXT NOT NULL,
          inverse_data TEXT,
          applied_at INTEGER,
          undone_at INTEGER,
          FOREIGN KEY (draft_id) REFERENCES analysis_drafts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_draft_operations_draft ON draft_operations(draft_id, sequence);

        CREATE TABLE IF NOT EXISTS draft_positions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL,
          position_id TEXT NOT NULL,
          theme_name TEXT NOT NULL,
          title TEXT NOT NULL,
          response_numbers TEXT,
          direction TEXT,
          is_deleted INTEGER DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER,
          FOREIGN KEY (draft_id) REFERENCES analysis_drafts(id),
          UNIQUE(draft_id, position_id)
        );
        CREATE INDEX IF NOT EXISTS idx_draft_positions_draft ON draft_positions(draft_id);

        CREATE TABLE IF NOT EXISTS draft_citations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL,
          position_id TEXT NOT NULL,
          response_number INTEGER NOT NULL,
          status TEXT DEFAULT 'active',
          priority_score REAL,
          moved_from_position_id TEXT,
          updated_at INTEGER,
          FOREIGN KEY (draft_id) REFERENCES analysis_drafts(id),
          UNIQUE(draft_id, position_id, response_number)
        );
        CREATE INDEX IF NOT EXISTS idx_draft_citations_draft ON draft_citations(draft_id);
        CREATE INDEX IF NOT EXISTS idx_draft_citations_response ON draft_citations(draft_id, response_number);

        CREATE TABLE IF NOT EXISTS draft_themes(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL,
          theme_id TEXT NOT NULL,
          name TEXT NOT NULL,
          display_order INTEGER,
          is_deleted INTEGER DEFAULT 0,
          updated_at INTEGER,
          FOREIGN KEY (draft_id) REFERENCES analysis_drafts(id),
          UNIQUE(draft_id, theme_id)
        );
        CREATE INDEX IF NOT EXISTS idx_draft_themes_draft ON draft_themes(draft_id);

        CREATE TABLE IF NOT EXISTS saved_searches(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hearing_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          filters_json TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_saved_searches_hearing ON saved_searches(hearing_id);
    `);
    try { bootstrapLegacyData(); } catch (e) { console.error('[SQLite] Legacy bootstrap failed:', e.message); }
    // Best-effort migrations to add new columns if they don't exist
    try { db.exec(`ALTER TABLE hearings ADD COLUMN complete INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN signature TEXT`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN total_responses INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN total_materials INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN last_success_at INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE hearings ADD COLUMN archived INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE prepared_responses ADD COLUMN focus_mode TEXT`); } catch (_) {}
    try { db.exec(`ALTER TABLE raw_responses ADD COLUMN page INTEGER`); } catch (_) {}
    // Add contentId and downloadUrl to raw_attachments for direct file access
    try { db.exec(`ALTER TABLE raw_attachments ADD COLUMN content_id TEXT`); } catch (_) {}
    try { db.exec(`ALTER TABLE raw_attachments ADD COLUMN download_url TEXT`); } catch (_) {}
    // Add uploaded_path to published_materials for PDF file references
    try { db.exec(`ALTER TABLE published_materials ADD COLUMN uploaded_path TEXT`); } catch (_) {}
}

function upsertHearing(hearing) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO hearings(id,title,start_date,deadline,status,updated_at)
      VALUES (@id,@title,@startDate,@deadline,@status,@now)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        start_date=excluded.start_date,
        deadline=excluded.deadline,
        status=excluded.status,
        updated_at=excluded.updated_at
    `).run({ ...hearing, now });
}

function markHearingComplete(hearingId, signature, totalResponses, totalMaterials) {
    const now = Date.now();
    db.prepare(`UPDATE hearings SET complete=1, signature=?, total_responses=?, total_materials=?, last_success_at=?, updated_at=? WHERE id=?`)
      .run(signature || null, Number(totalResponses)||0, Number(totalMaterials)||0, now, now, hearingId);
}

function isHearingComplete(hearingId) {
    const row = db.prepare(`SELECT complete, signature, total_responses as totalResponses, total_materials as totalMaterials FROM hearings WHERE id=?`).get(hearingId);
    if (!row) return { complete: false };
    return { complete: !!row.complete, signature: row.signature || null, totalResponses: row.totalResponses||0, totalMaterials: row.totalMaterials||0 };
}

function setHearingArchived(hearingId, archived) {
    const now = Date.now();
    db.prepare(`UPDATE hearings SET archived=?, updated_at=? WHERE id=?`).run(archived ? 1 : 0, now, hearingId);
}

function updateHearingIndex(hearingIndexData) {
    const now = Date.now();
    const tx = db.transaction(() => {
        // Clear existing index
        db.prepare(`DELETE FROM hearing_index`).run();
        
        // Insert new index entries
        const stmt = db.prepare(`
            INSERT INTO hearing_index(id, title, start_date, deadline, status, normalized_title, title_tokens, deadline_ts, is_open, updated_at)
            VALUES (@id, @title, @startDate, @deadline, @status, @normalizedTitle, @titleTokens, @deadlineTs, @isOpen, @now)
        `);
        
        for (const hearing of hearingIndexData) {
            stmt.run({
                id: hearing.id,
                title: hearing.title || `Høring ${hearing.id}`,
                startDate: hearing.startDate,
                deadline: hearing.deadline,
                status: hearing.status,
                normalizedTitle: hearing.normalizedTitle,
                titleTokens: JSON.stringify(hearing.titleTokens || []),
                deadlineTs: hearing.deadlineTs,
                isOpen: hearing.isOpen ? 1 : 0,
                now
            });
        }
    });
    tx();
}

function getHearingIndex() {
    const rows = db.prepare(`
        SELECT id, title, start_date as startDate, deadline, status, 
               normalized_title as normalizedTitle, title_tokens as titleTokens,
               deadline_ts as deadlineTs, is_open as isOpen
        FROM hearing_index
        ORDER BY deadline_ts ASC, id ASC
    `).all();
    
    return rows.map(row => ({
        ...row,
        titleTokens: row.titleTokens ? JSON.parse(row.titleTokens) : [],
        isOpen: !!row.isOpen
    }));
}

function listHearingsByStatusLike(statusLike) {
    const s = `%${String(statusLike || '').toLowerCase()}%`;
    return db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE ? ORDER BY deadline ASC, id ASC`).all(s);
}

function listIncompleteHearings() {
    return db.prepare(`SELECT id FROM hearings WHERE archived IS NOT 1 AND (complete IS NULL OR complete=0)`).all().map(r => r.id);
}

function listAllHearingIds() {
    return db.prepare(`SELECT id FROM hearings`).all().map(r => r.id);
}

function replaceRawResponses(hearingId, responses) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM raw_responses WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM raw_attachments WHERE hearing_id=?`).run(hearingId);
        const insR = db.prepare(`INSERT INTO raw_responses(hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at,page) VALUES (?,?,?,?,?,?,?,?)`);
        const insA = db.prepare(`INSERT INTO raw_attachments(hearing_id,response_id,idx,filename,url,content_id,download_url) VALUES (?,?,?,?,?,?,?)`);
        for (const r of (responses||[])) {
            const responseId = typeof r.id === 'number' || typeof r.id === 'string' ? r.id : r.responseId;
            if (typeof responseId === 'undefined') continue;
            const page = typeof r.page === 'number' ? r.page : null;
            insR.run(hearingId, Number(responseId), r.text || '', r.author || null, r.organization || null, r.onBehalfOf || null, r.submittedAt || null, page);
            (r.attachments||[]).forEach((a, i) => insA.run(hearingId, Number(responseId), i, a.filename || 'Dokument', a.url || null, a.contentId || null, a.downloadUrl || null));
        }
    });
    tx();
}

function replaceResponses(hearingId, responses) {
    replaceRawResponses(hearingId, responses);
}

function replaceRawMaterials(hearingId, materials) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM raw_materials WHERE hearing_id=?`).run(hearingId);
        const ins = db.prepare(`INSERT INTO raw_materials(hearing_id,idx,type,title,url,content) VALUES (?,?,?,?,?,?)`);
        (materials||[]).forEach((m, i) => ins.run(hearingId, i, m.type, m.title || null, m.url || null, m.content || null));
    });
    tx();
}

function replaceMaterials(hearingId, materials) {
    replaceRawMaterials(hearingId, materials);
}

function bootstrapLegacyData() {
    if (!db) return;
    try {
        const legacyCount = db.prepare(`SELECT COUNT(*) as c FROM responses`).get().c || 0;
        const rawCount = db.prepare(`SELECT COUNT(*) as c FROM raw_responses`).get().c || 0;
        if (legacyCount && !rawCount) {
            const tx = db.transaction(() => {
                db.prepare(`INSERT INTO raw_responses(hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at) SELECT hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at FROM responses`).run();
                db.prepare(`INSERT INTO raw_attachments(hearing_id,response_id,idx,filename,url) SELECT hearing_id,response_id,idx,filename,url FROM attachments`).run();
                db.prepare(`INSERT INTO raw_materials(hearing_id,idx,type,title,url,content) SELECT hearing_id,idx,type,title,url,content FROM materials`).run();
            });
            tx();
        }

        const publishedCount = db.prepare(`SELECT COUNT(*) as c FROM published_responses`).get().c || 0;
        if (legacyCount && !publishedCount) {
            const selectResponses = db.prepare(`SELECT hearing_id,response_id,text,author,organization,on_behalf_of,submitted_at FROM responses ORDER BY hearing_id,response_id`);
            const attachmentCountStmt = db.prepare(`SELECT COUNT(*) as c FROM attachments WHERE hearing_id=? AND response_id=?`);
            const insertPublished = db.prepare(`INSERT INTO published_responses(hearing_id,response_id,source_response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text,text_md,has_attachments,approved_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
            const now = Date.now();
            const tx = db.transaction(() => {
                for (const row of selectResponses.iterate()) {
                    const count = attachmentCountStmt.get(row.hearing_id, row.response_id)?.c || 0;
                    insertPublished.run(
                        row.hearing_id,
                        row.response_id,
                        row.response_id,
                        row.author || null,
                        null,
                        row.author || null,
                        row.organization || null,
                        row.on_behalf_of || null,
                        row.submitted_at || null,
                        row.text || '',
                        row.text || '',
                        count ? 1 : 0,
                        null,
                        now
                    );
                }
                db.prepare(`INSERT INTO published_attachments(hearing_id,response_id,attachment_id,original_filename,content_md,approved_at,published_at)
                             SELECT hearing_id,response_id,idx,filename,NULL,NULL,? FROM attachments`).run(now);
                db.prepare(`INSERT INTO published_materials(hearing_id,material_id,title,content_md,approved_at,published_at)
                             SELECT hearing_id,idx,title,content,NULL,? FROM materials`).run(now);
            });
            tx();
        }
    } catch (err) {
        console.error('[SQLite] bootstrapLegacyData error:', err.message);
    }
}

function getRawAggregate(hearingId) {
    const responses = db.prepare(`SELECT * FROM raw_responses WHERE hearing_id=? ORDER BY response_id ASC`).all(hearingId).map(r => ({
        id: r.response_id,
        text: r.text,
        author: r.author,
        organization: r.organization,
        onBehalfOf: r.on_behalf_of,
        submittedAt: r.submitted_at,
        page: r.page || null,
        attachments: db.prepare(`SELECT * FROM raw_attachments WHERE hearing_id=? AND response_id=? ORDER BY idx ASC`).all(hearingId, r.response_id)
            .map(a => ({ attachmentId: a.idx, filename: a.filename, url: a.url }))
    }));
    const materials = db.prepare(`SELECT * FROM raw_materials WHERE hearing_id=? ORDER BY idx ASC`).all(hearingId)
        .map(m => ({ materialId: m.idx, type: m.type, title: m.title, url: m.url, content: m.content }));
    return { responses, materials };
}

function getPublishedAggregate(hearingId) {
    const responses = db.prepare(`SELECT pr.*, p.focus_mode 
        FROM published_responses pr 
        LEFT JOIN prepared_responses p ON p.hearing_id = pr.hearing_id AND p.prepared_id = pr.response_id 
        WHERE pr.hearing_id=? 
        ORDER BY pr.response_id ASC`).all(hearingId).map(r => ({
        id: r.response_id,
        sourceId: r.source_response_id,
        text: r.text || r.text_md || '',
        textMd: r.text_md || r.text || '',
        respondentName: r.respondent_name || r.author || null,
        respondentType: r.respondent_type || null,
        author: r.author,
        organization: r.organization,
        onBehalfOf: r.on_behalf_of,
        submittedAt: r.submitted_at,
        hasAttachments: !!r.has_attachments,
        focusMode: r.focus_mode || null,
        attachments: db.prepare(`SELECT * FROM published_attachments WHERE hearing_id=? AND response_id=? ORDER BY attachment_id ASC`).all(hearingId, r.response_id)
            .map(a => ({ attachmentId: a.attachment_id, filename: a.original_filename, contentMd: a.content_md, publishedAt: a.published_at }))
    }));
    const materials = db.prepare(`SELECT * FROM published_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId)
        .map(m => ({ materialId: m.material_id, title: m.title, contentMd: m.content_md, publishedAt: m.published_at }));
    return { responses, materials };
}

function readAggregate(hearingId) {
    const hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    if (!hearing) return null;
    const published = getPublishedAggregate(hearingId);
    const usePublished = Array.isArray(published.responses) && published.responses.length;
    const source = usePublished ? published : getRawAggregate(hearingId);
    const responses = (source.responses || []).map(r => ({
        id: r.id,
        text: r.text,
        textMd: r.textMd || r.text,
        author: r.author || r.respondentName || null,
        respondentName: r.respondentName || r.author || null,
        respondentType: r.respondentType || null,
        organization: r.organization,
        onBehalfOf: r.onBehalfOf,
        submittedAt: r.submittedAt,
        hasAttachments: typeof r.hasAttachments === 'boolean' ? r.hasAttachments : Array.isArray(r.attachments) && r.attachments.length > 0,
        attachments: (r.attachments || []).map(a => ({
            attachmentId: a.attachmentId,
            filename: a.filename,
            url: a.url || null,
            contentMd: a.contentMd || null,
            publishedAt: a.publishedAt || null
        }))
    }));
    const materials = (source.materials || []).map(m => ({
        materialId: m.materialId,
        type: m.type,
        title: m.title,
        url: m.url || null,
        content: m.content || m.contentMd || null,
        contentMd: m.contentMd || m.content || null,
        publishedAt: m.publishedAt || null
    }));
    return {
        hearing: {
            id: hearing.id,
            title: hearing.title,
            startDate: hearing.start_date,
            deadline: hearing.deadline,
            status: hearing.status,
            url: `https://blivhoert.kk.dk/hearing/${hearing.id}/comments`
        },
        responses,
        materials,
        source: usePublished ? 'published' : 'raw'
    };
}

function getPreparationState(hearingId) {
    const row = db.prepare(`SELECT * FROM hearing_preparation_state WHERE hearing_id=?`).get(hearingId);
    if (row) return row;
    return {
        hearing_id: hearingId,
        status: 'draft',
        responses_ready: 0,
        materials_ready: 0,
        vector_store_id: null,
        vector_store_updated_at: null,
        last_modified_at: null,
        published_at: null,
        prepared_by: null,
        notes: null
    };
}

function updatePreparationState(hearingId, patch) {
    const now = Date.now();
    const current = getPreparationState(hearingId);
    const payload = {
        status: patch.status !== undefined ? patch.status : current.status,
        responses_ready: patch.responses_ready !== undefined ? patch.responses_ready : current.responses_ready,
        materials_ready: patch.materials_ready !== undefined ? patch.materials_ready : current.materials_ready,
        vector_store_id: patch.vector_store_id !== undefined ? patch.vector_store_id : current.vector_store_id,
        vector_store_updated_at: patch.vector_store_updated_at !== undefined ? patch.vector_store_updated_at : current.vector_store_updated_at,
        last_modified_at: patch.last_modified_at !== undefined ? patch.last_modified_at : now,
        published_at: patch.published_at !== undefined ? patch.published_at : current.published_at,
        prepared_by: patch.prepared_by !== undefined ? patch.prepared_by : current.prepared_by,
        notes: patch.notes !== undefined ? patch.notes : current.notes
    };
    db.prepare(`
        INSERT INTO hearing_preparation_state(hearing_id,status,responses_ready,materials_ready,vector_store_id,vector_store_updated_at,last_modified_at,published_at,prepared_by,notes)
        VALUES (@hearingId,@status,@responses_ready,@materials_ready,@vector_store_id,@vector_store_updated_at,@last_modified_at,@published_at,@prepared_by,@notes)
        ON CONFLICT(hearing_id) DO UPDATE SET
          status=excluded.status,
          responses_ready=excluded.responses_ready,
          materials_ready=excluded.materials_ready,
          vector_store_id=excluded.vector_store_id,
          vector_store_updated_at=excluded.vector_store_updated_at,
          last_modified_at=excluded.last_modified_at,
          published_at=excluded.published_at,
          prepared_by=excluded.prepared_by,
          notes=excluded.notes
    `).run({ hearingId, ...payload });
    return getPreparationState(hearingId);
}

function recalcPreparationProgress(hearingId) {
    const totalResponses = db.prepare(`SELECT COUNT(*) as c FROM prepared_responses WHERE hearing_id=?`).get(hearingId)?.c || 0;
    const approvedResponses = db.prepare(`SELECT COUNT(*) as c FROM prepared_responses WHERE hearing_id=? AND approved=1`).get(hearingId)?.c || 0;
    const totalMaterials = db.prepare(`SELECT COUNT(*) as c FROM prepared_materials WHERE hearing_id=?`).get(hearingId)?.c || 0;
    const approvedMaterials = db.prepare(`SELECT COUNT(*) as c FROM prepared_materials WHERE hearing_id=? AND approved=1`).get(hearingId)?.c || 0;
    const responsesReady = totalResponses > 0 && totalResponses === approvedResponses ? 1 : 0;
    const materialsReady = totalMaterials > 0 && totalMaterials === approvedMaterials ? 1 : 0;
    let status = 'draft';
    if (responsesReady || materialsReady) status = 'in-progress';
    if (responsesReady && materialsReady) status = 'ready';
    const state = updatePreparationState(hearingId, { responses_ready: responsesReady, materials_ready: materialsReady, status, last_modified_at: Date.now() });
    return state;
}

function upsertPreparedResponse(hearingId, preparedId, payload) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO prepared_responses(hearing_id,prepared_id,source_response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text_md,has_attachments,attachments_ready,approved,created_at,updated_at,approved_at,notes,focus_mode)
      VALUES (@hearingId,@preparedId,@source_response_id,@respondent_name,@respondent_type,@author,@organization,@on_behalf_of,@submitted_at,@text_md,@has_attachments,@attachments_ready,@approved,@created_at,@updated_at,@approved_at,@notes,@focus_mode)
      ON CONFLICT(hearing_id,prepared_id) DO UPDATE SET
        source_response_id=excluded.source_response_id,
        respondent_name=excluded.respondent_name,
        respondent_type=excluded.respondent_type,
        author=excluded.author,
        organization=excluded.organization,
        on_behalf_of=excluded.on_behalf_of,
        submitted_at=excluded.submitted_at,
        text_md=excluded.text_md,
        has_attachments=excluded.has_attachments,
        attachments_ready=excluded.attachments_ready,
        approved=excluded.approved,
        updated_at=excluded.updated_at,
        approved_at=excluded.approved_at,
        notes=excluded.notes,
        focus_mode=excluded.focus_mode
    `).run({
        hearingId,
        preparedId,
        source_response_id: payload?.sourceResponseId ?? null,
        respondent_name: payload?.respondentName ?? null,
        respondent_type: payload?.respondentType ?? null,
        author: payload?.author ?? null,
        organization: payload?.organization ?? null,
        on_behalf_of: payload?.onBehalfOf ?? null,
        submitted_at: payload?.submittedAt ?? null,
        text_md: payload?.textMd ?? payload?.text ?? '',
        has_attachments: payload?.hasAttachments ? 1 : 0,
        attachments_ready: payload?.attachmentsReady ? 1 : 0,
        approved: payload?.approved ? 1 : 0,
        created_at: payload?.createdAt || now,
        updated_at: now,
        approved_at: payload?.approved ? (payload?.approvedAt || now) : null,
        notes: payload?.notes ?? null,
        focus_mode: payload?.focusMode ?? null
    });
    const state = recalcPreparationProgress(hearingId);
    return { state };
}

function deletePreparedResponse(hearingId, preparedId) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, preparedId);
        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, preparedId);
    });
    tx();
    return recalcPreparationProgress(hearingId);
}

function upsertPreparedAttachment(hearingId, preparedId, attachmentId, payload) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO prepared_attachments(hearing_id,prepared_id,attachment_id,source_attachment_idx,original_filename,source_url,converted_md,conversion_status,approved,created_at,updated_at,approved_at,notes)
      VALUES (@hearingId,@preparedId,@attachmentId,@source_attachment_idx,@original_filename,@source_url,@converted_md,@conversion_status,@approved,@created_at,@updated_at,@approved_at,@notes)
      ON CONFLICT(hearing_id,prepared_id,attachment_id) DO UPDATE SET
        source_attachment_idx=excluded.source_attachment_idx,
        original_filename=excluded.original_filename,
        source_url=excluded.source_url,
        converted_md=excluded.converted_md,
        conversion_status=excluded.conversion_status,
        approved=excluded.approved,
        updated_at=excluded.updated_at,
        approved_at=excluded.approved_at,
        notes=excluded.notes
    `).run({
        hearingId,
        preparedId,
        attachmentId,
        source_attachment_idx: payload?.sourceAttachmentIdx ?? null,
        original_filename: payload?.originalFilename ?? null,
        source_url: payload?.sourceUrl ?? null,
        converted_md: payload?.convertedMd ?? null,
        conversion_status: payload?.conversionStatus ?? null,
        approved: payload?.approved ? 1 : 0,
        created_at: payload?.createdAt || now,
        updated_at: now,
        approved_at: payload?.approved ? (payload?.approvedAt || now) : null,
        notes: payload?.notes ?? null
    });
    return recalcPreparationProgress(hearingId);
}

function deletePreparedAttachment(hearingId, preparedId, attachmentId) {
    db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=? AND attachment_id=?`).run(hearingId, preparedId, attachmentId);
    return recalcPreparationProgress(hearingId);
}

function upsertPreparedMaterial(hearingId, materialId, payload) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO prepared_materials(hearing_id,material_id,title,source_filename,source_url,content_md,uploaded_path,approved,created_at,updated_at,approved_at,notes)
      VALUES (@hearingId,@materialId,@title,@source_filename,@source_url,@content_md,@uploaded_path,@approved,@created_at,@updated_at,@approved_at,@notes)
      ON CONFLICT(hearing_id,material_id) DO UPDATE SET
        title=excluded.title,
        source_filename=excluded.source_filename,
        source_url=excluded.source_url,
        content_md=excluded.content_md,
        uploaded_path=excluded.uploaded_path,
        approved=excluded.approved,
        updated_at=excluded.updated_at,
        approved_at=excluded.approved_at,
        notes=excluded.notes
    `).run({
        hearingId,
        materialId,
        title: payload?.title ?? null,
        source_filename: payload?.sourceFilename ?? null,
        source_url: payload?.sourceUrl ?? null,
        content_md: payload?.contentMd ?? payload?.content ?? null,
        uploaded_path: payload?.uploadedPath ?? null,
        approved: payload?.approved ? 1 : 0,
        created_at: payload?.createdAt || now,
        updated_at: now,
        approved_at: payload?.approved ? (payload?.approvedAt || now) : null,
        notes: payload?.notes ?? null
    });
    return recalcPreparationProgress(hearingId);
}

function deletePreparedMaterial(hearingId, materialId) {
    db.prepare(`DELETE FROM prepared_materials WHERE hearing_id=? AND material_id=?`).run(hearingId, materialId);
    return recalcPreparationProgress(hearingId);
}

function listPreparedHearings() {
    const baseRows = db.prepare(`
        SELECT h.id,h.title,h.status,h.deadline,h.start_date,h.updated_at,s.status as prep_status,s.responses_ready,s.materials_ready,s.last_modified_at,s.published_at,s.vector_store_id,s.vector_store_updated_at
        FROM hearings h
        LEFT JOIN hearing_preparation_state s ON s.hearing_id = h.id
        ORDER BY h.deadline ASC, h.id ASC
    `).all();
    const mapCounts = (rows) => {
        const out = new Map();
        for (const row of rows) out.set(row.hearing_id, row.count);
        return out;
    };
    const rawCounts = mapCounts(db.prepare(`SELECT hearing_id, COUNT(*) as count FROM raw_responses GROUP BY hearing_id`).all());
    const preparedCounts = mapCounts(db.prepare(`SELECT hearing_id, COUNT(*) as count FROM prepared_responses GROUP BY hearing_id`).all());
    const publishedCounts = mapCounts(db.prepare(`SELECT hearing_id, COUNT(*) as count FROM published_responses GROUP BY hearing_id`).all());
    return baseRows.map(row => ({
        hearingId: row.id,
        title: row.title,
        status: row.status,
        deadline: row.deadline,
        startDate: row.start_date,
        updatedAt: row.updated_at,
        preparation: {
            status: row.prep_status || 'draft',
            responsesReady: !!row.responses_ready,
            materialsReady: !!row.materials_ready,
            lastModifiedAt: row.last_modified_at || null,
            publishedAt: row.published_at || null,
            vectorStoreId: row.vector_store_id || null,
            vectorStoreUpdatedAt: row.vector_store_updated_at || null
        },
        counts: {
            rawResponses: rawCounts.get(row.id) || 0,
            preparedResponses: preparedCounts.get(row.id) || 0,
            publishedResponses: publishedCounts.get(row.id) || 0
        }
    }));
}

function getPreparedBundle(hearingId) {
    const hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    if (!hearing) return null;
    const state = getPreparationState(hearingId);
    const preparedResponses = db.prepare(`SELECT * FROM prepared_responses WHERE hearing_id=? ORDER BY prepared_id ASC`).all(hearingId);
    const preparedAttachments = db.prepare(`SELECT * FROM prepared_attachments WHERE hearing_id=? ORDER BY prepared_id ASC, attachment_id ASC`).all(hearingId);
    const preparedMaterials = db.prepare(`SELECT * FROM prepared_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId);
    
    // Get page numbers for raw responses
    const rawPageMap = new Map();
    const rawPages = db.prepare(`SELECT response_id, page FROM raw_responses WHERE hearing_id=?`).all(hearingId);
    for (const rp of rawPages) {
        if (rp.page !== null && rp.page !== undefined) {
            rawPageMap.set(Number(rp.response_id), Number(rp.page));
        }
    }
    
    const attachmentsByResponse = new Map();
    for (const att of preparedAttachments) {
        const key = att.prepared_id;
        if (!attachmentsByResponse.has(key)) attachmentsByResponse.set(key, []);
        attachmentsByResponse.get(key).push(att);
    }
    const prepared = {
        responses: preparedResponses.map(r => ({
            preparedId: r.prepared_id,
            sourceResponseId: r.source_response_id,
            sourcePage: r.source_response_id ? rawPageMap.get(Number(r.source_response_id)) || null : null,
            respondentName: r.respondent_name,
            respondentType: r.respondent_type,
            author: r.author,
            organization: r.organization,
            onBehalfOf: r.on_behalf_of,
            submittedAt: r.submitted_at,
            textMd: r.text_md,
            hasAttachments: !!r.has_attachments,
            attachmentsReady: !!r.attachments_ready,
            approved: !!r.approved,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            approvedAt: r.approved_at,
            notes: r.notes,
            focusMode: r.focus_mode || 'response',
            attachments: (attachmentsByResponse.get(r.prepared_id) || []).map(a => ({
                attachmentId: a.attachment_id,
                sourceAttachmentIdx: a.source_attachment_idx,
                originalFilename: a.original_filename,
                sourceUrl: a.source_url,
                convertedMd: a.converted_md,
                conversionStatus: a.conversion_status,
                approved: !!a.approved,
                createdAt: a.created_at,
                updatedAt: a.updated_at,
                approvedAt: a.approved_at,
                notes: a.notes
            }))
        })),
        materials: preparedMaterials.map(m => ({
            materialId: m.material_id,
            title: m.title,
            sourceFilename: m.source_filename,
            sourceUrl: m.source_url,
            contentMd: m.content_md,
            uploadedPath: m.uploaded_path,
            approved: !!m.approved,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
            approvedAt: m.approved_at,
            notes: m.notes
        }))
    };
    const raw = getRawAggregate(hearingId);
    const published = getPublishedAggregate(hearingId);
    return {
        hearing: {
            id: hearing.id,
            title: hearing.title,
            startDate: hearing.start_date,
            deadline: hearing.deadline,
            status: hearing.status
        },
        state,
        prepared,
        raw,
        published
    };
}

// Paginated version - returns only a subset of responses for performance
function getPreparedBundlePaginated(hearingId, options = {}) {
    const {
        page = 1,
        pageSize = 50,
        pendingOnly = true,  // Default: only show non-approved
        search = ''
    } = options;
    
    const hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    if (!hearing) return null;
    
    const state = getPreparationState(hearingId);
    
    // Build WHERE clause for filtering
    let whereClause = 'WHERE hearing_id = ?';
    const params = [hearingId];
    
    if (pendingOnly) {
        whereClause += ' AND approved = 0';
    }
    
    if (search && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        whereClause += ' AND (respondent_name LIKE ? OR text_md LIKE ? OR CAST(source_response_id AS TEXT) LIKE ?)';
        params.push(searchTerm, searchTerm, searchTerm);
    }
    
    // Get total count for pagination
    const countResult = db.prepare(`SELECT COUNT(*) as total FROM prepared_responses ${whereClause}`).get(...params);
    const totalResponses = countResult?.total || 0;
    const totalPages = Math.ceil(totalResponses / pageSize);
    
    // Get counts by status for summary
    const statusCounts = db.prepare(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved,
            SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as pending
        FROM prepared_responses WHERE hearing_id = ?
    `).get(hearingId);
    
    // Get paginated responses - sort by original response number (source_response_id)
    const offset = (page - 1) * pageSize;
    const preparedResponses = db.prepare(`
        SELECT * FROM prepared_responses 
        ${whereClause}
        ORDER BY COALESCE(source_response_id, prepared_id) ASC
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    
    // Get attachments only for the responses we're returning
    const responseIds = preparedResponses.map(r => r.prepared_id);
    let preparedAttachments = [];
    if (responseIds.length > 0) {
        const placeholders = responseIds.map(() => '?').join(',');
        preparedAttachments = db.prepare(`
            SELECT * FROM prepared_attachments 
            WHERE hearing_id = ? AND prepared_id IN (${placeholders})
            ORDER BY prepared_id ASC, attachment_id ASC
        `).all(hearingId, ...responseIds);
    }
    
    // Get page numbers for raw responses (only for current page)
    const rawPageMap = new Map();
    if (responseIds.length > 0) {
        const sourceIds = preparedResponses.map(r => r.source_response_id).filter(Boolean);
        if (sourceIds.length > 0) {
            const placeholders = sourceIds.map(() => '?').join(',');
            const rawPages = db.prepare(`SELECT response_id, page FROM raw_responses WHERE hearing_id = ? AND response_id IN (${placeholders})`).all(hearingId, ...sourceIds);
            for (const rp of rawPages) {
                if (rp.page !== null && rp.page !== undefined) {
                    rawPageMap.set(Number(rp.response_id), Number(rp.page));
                }
            }
        }
    }
    
    // Materials are typically few, so load all
    const preparedMaterials = db.prepare(`SELECT * FROM prepared_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId);
    
    const attachmentsByResponse = new Map();
    for (const att of preparedAttachments) {
        const key = att.prepared_id;
        if (!attachmentsByResponse.has(key)) attachmentsByResponse.set(key, []);
        attachmentsByResponse.get(key).push(att);
    }
    
    const prepared = {
        responses: preparedResponses.map(r => ({
            preparedId: r.prepared_id,
            sourceResponseId: r.source_response_id,
            sourcePage: r.source_response_id ? rawPageMap.get(Number(r.source_response_id)) || null : null,
            respondentName: r.respondent_name,
            respondentType: r.respondent_type,
            author: r.author,
            organization: r.organization,
            onBehalfOf: r.on_behalf_of,
            submittedAt: r.submitted_at,
            textMd: r.text_md,
            hasAttachments: !!r.has_attachments,
            attachmentsReady: !!r.attachments_ready,
            approved: !!r.approved,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            approvedAt: r.approved_at,
            notes: r.notes,
            focusMode: r.focus_mode || 'response',
            attachments: (attachmentsByResponse.get(r.prepared_id) || []).map(a => ({
                attachmentId: a.attachment_id,
                sourceAttachmentIdx: a.source_attachment_idx,
                originalFilename: a.original_filename,
                sourceUrl: a.source_url,
                convertedMd: a.converted_md,
                conversionStatus: a.conversion_status,
                approved: !!a.approved,
                createdAt: a.created_at,
                updatedAt: a.updated_at,
                approvedAt: a.approved_at,
                notes: a.notes
            }))
        })),
        materials: preparedMaterials.map(m => ({
            materialId: m.material_id,
            title: m.title,
            sourceFilename: m.source_filename,
            sourceUrl: m.source_url,
            contentMd: m.content_md,
            uploadedPath: m.uploaded_path,
            approved: !!m.approved,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
            approvedAt: m.approved_at,
            notes: m.notes
        }))
    };
    
    // Get lightweight raw/published counts (not full data)
    const rawCount = db.prepare(`SELECT COUNT(*) as c FROM raw_responses WHERE hearing_id=?`).get(hearingId)?.c || 0;
    const publishedCount = db.prepare(`SELECT COUNT(*) as c FROM published_responses WHERE hearing_id=?`).get(hearingId)?.c || 0;
    
    return {
        hearing: {
            id: hearing.id,
            title: hearing.title,
            startDate: hearing.start_date,
            deadline: hearing.deadline,
            status: hearing.status
        },
        state,
        prepared,
        pagination: {
            page,
            pageSize,
            totalResponses,
            totalPages,
            pendingOnly,
            search
        },
        counts: {
            total: statusCounts?.total || 0,
            approved: statusCounts?.approved || 0,
            pending: statusCounts?.pending || 0,
            raw: rawCount,
            published: publishedCount
        }
    };
}

function publishPreparedHearing(hearingId, options = {}) {
    const prepared = db.prepare(`SELECT * FROM prepared_responses WHERE hearing_id=? ORDER BY prepared_id ASC`).all(hearingId);
    const materials = db.prepare(`SELECT * FROM prepared_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(hearingId);
    const attachments = db.prepare(`SELECT * FROM prepared_attachments WHERE hearing_id=? ORDER BY prepared_id ASC, attachment_id ASC`).all(hearingId);
    const now = Date.now();
    const onlyApproved = options.onlyApproved !== false;
    const includeResponse = (r) => !onlyApproved || r.approved;
    const includeMaterial = (m) => !onlyApproved || m.approved;
    const groupedAttachments = new Map();
    for (const att of attachments) {
        if (onlyApproved && !att.approved) continue;
        if (!groupedAttachments.has(att.prepared_id)) groupedAttachments.set(att.prepared_id, []);
        groupedAttachments.get(att.prepared_id).push(att);
    }
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM published_responses WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM published_attachments WHERE hearing_id=?`).run(hearingId);
        db.prepare(`DELETE FROM published_materials WHERE hearing_id=?`).run(hearingId);

        const insertResp = db.prepare(`INSERT INTO published_responses(hearing_id,response_id,source_response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text,text_md,has_attachments,approved_at,published_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insertAtt = db.prepare(`INSERT INTO published_attachments(hearing_id,response_id,attachment_id,original_filename,content_md,approved_at,published_at) VALUES (?,?,?,?,?,?,?)`);
        let responseCounter = 0;
        for (const r of prepared) {
            if (!includeResponse(r)) continue;
            responseCounter += 1;
            const responseId = responseCounter;
            const atts = groupedAttachments.get(r.prepared_id) || [];
            insertResp.run(
                hearingId,
                responseId,
                r.source_response_id,
                r.respondent_name || r.author || null,
                r.respondent_type || null,
                r.author || null,
                r.organization || null,
                r.on_behalf_of || null,
                r.submitted_at || null,
                r.text_md || '',
                r.text_md || '',
                atts.length ? 1 : 0,
                r.approved ? (r.approved_at || now) : null,
                now
            );
            if (atts.length) {
                atts.forEach((a, idx) => {
                    insertAtt.run(hearingId, responseId, idx + 1, a.original_filename || `Bilag ${idx + 1}`, a.converted_md || null, a.approved ? (a.approved_at || now) : null, now);
                });
            }
        }

        const insertMat = db.prepare(`INSERT INTO published_materials(hearing_id,material_id,title,content_md,uploaded_path,approved_at,published_at) VALUES (?,?,?,?,?,?,?)`);
        let matCounter = 0;
        for (const m of materials) {
            if (!includeMaterial(m)) continue;
            matCounter += 1;
            insertMat.run(hearingId, matCounter, m.title || `Materiale ${matCounter}`, m.content_md || null, m.uploaded_path || null, m.approved ? (m.approved_at || now) : null, now);
        }
    });
    tx();

    const afterState = updatePreparationState(hearingId, {
        status: 'published',
        published_at: now,
        last_modified_at: now
    });

    try {
        // Ensure hearing exists in hearings table (required for search index)
        let hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
        if (!hearing) {
            // Try to get hearing data from prepared bundle
            const bundle = getPreparedBundle(hearingId);
            if (bundle && bundle.hearing) {
                upsertHearing({
                    id: hearingId,
                    title: bundle.hearing.title || `Høring ${hearingId}`,
                    startDate: bundle.hearing.startDate || null,
                    deadline: bundle.hearing.deadline || null,
                    status: bundle.hearing.status || null
                });
                hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
            } else {
                // Fallback: create minimal hearing entry
                upsertHearing({
                    id: hearingId,
                    title: `Høring ${hearingId}`,
                    startDate: null,
                    deadline: null,
                    status: null
                });
                hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
            }
        }
        
        // Add hearing to hearing_index if it exists
        if (hearing) {
            try {
                const normalizedTitle = (hearing.title || '').toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                const titleTokens = normalizedTitle.length ? normalizedTitle.split(' ') : [];
                const deadlineTs = hearing.deadline ? new Date(hearing.deadline).getTime() : null;
                const statusNorm = (hearing.status || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const statusHintsOpen = /(i hoering|i horing|i høring|open|aaben|åben|aktiv|offentlig|hoering|horing)/.test(statusNorm);
                const statusHintsClosed = /(afslut|luk|lukket|afsluttet|konklud|konklusion|konkluderet)/.test(statusNorm);
                let isOpen = false;
                if (Number.isFinite(deadlineTs)) {
                    if (deadlineTs >= Date.now()) isOpen = true;
                    else if (deadlineTs < Date.now() && statusHintsClosed) isOpen = false;
                }
                if (statusHintsOpen) isOpen = true;
                if (statusHintsClosed) isOpen = false;
                
                db.prepare(`
                    INSERT INTO hearing_index(id, title, start_date, deadline, status, normalized_title, title_tokens, deadline_ts, is_open, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title,
                        start_date=excluded.start_date,
                        deadline=excluded.deadline,
                        status=excluded.status,
                        normalized_title=excluded.normalized_title,
                        title_tokens=excluded.title_tokens,
                        deadline_ts=excluded.deadline_ts,
                        is_open=excluded.is_open,
                        updated_at=excluded.updated_at
                `).run(
                    hearingId,
                    hearing.title || `Høring ${hearingId}`,
                    hearing.start_date || null,
                    hearing.deadline || null,
                    hearing.status || null,
                    normalizedTitle,
                    JSON.stringify(titleTokens),
                    deadlineTs,
                    isOpen ? 1 : 0,
                    Date.now()
                );
            } catch (idxErr) {
                console.warn('[SQLite] Failed to add hearing to index:', idxErr.message);
            }
        }
        
        const publishedAggregate = getPublishedAggregate(hearingId);
        const totalResponses = publishedAggregate.responses ? publishedAggregate.responses.length : 0;
        const totalMaterials = publishedAggregate.materials ? publishedAggregate.materials.length : 0;
        markHearingComplete(hearingId, 'manual-publish', totalResponses, totalMaterials);
    } catch (err) {
        console.error('[SQLite] publishPreparedHearing mark complete failed:', err.message);
    }

    return afterState;
}

function replaceVectorChunks(hearingId, chunks) {
    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(hearingId);
        const insert = db.prepare(`INSERT INTO vector_chunks(hearing_id,chunk_id,source,content,embedding,created_at) VALUES (?,?,?,?,?,?)`);
        const createdAt = Date.now();
        for (const chunk of chunks || []) {
            insert.run(
                hearingId,
                chunk.chunkId || chunk.id || cryptoRandomId(),
                chunk.source || null,
                chunk.content || '',
                JSON.stringify(chunk.embedding || []),
                createdAt
            );
        }
    });
    tx();
}

function listVectorChunks(hearingId) {
    const rows = db.prepare(`SELECT chunk_id as chunkId, source, content, embedding FROM vector_chunks WHERE hearing_id=? ORDER BY created_at ASC`).all(hearingId);
    return rows.map(row => ({
        chunkId: row.chunkId,
        source: row.source || null,
        content: row.content || '',
        embedding: row.embedding ? JSON.parse(row.embedding) : []
    }));
}

function cryptoRandomId() {
    try {
        return crypto.randomUUID();
    } catch (_) {
        return Math.random().toString(36).slice(2);
    }
}


function getSessionEdits(sessionId, hearingId) {
    const rows = db.prepare(`SELECT * FROM session_edits WHERE session_id=? AND hearing_id=?`).all(sessionId, hearingId);
    const map = {};
    for (const r of rows) {
        map[r.response_id] = {
            respondentName: r.respondent_name || undefined,
            respondentType: r.respondent_type || undefined,
            author: r.author || undefined,
            organization: r.organization || undefined,
            onBehalfOf: r.on_behalf_of || undefined,
            submittedAt: r.submitted_at || undefined,
            text: r.text || undefined
        };
    }
    return map;
}

function upsertSessionEdit(sessionId, hearingId, responseId, patch) {
    db.prepare(`
      INSERT INTO session_edits(session_id,hearing_id,response_id,respondent_name,respondent_type,author,organization,on_behalf_of,submitted_at,text)
      VALUES (@sessionId,@hearingId,@responseId,@respondentName,@respondentType,@author,@organization,@onBehalfOf,@submittedAt,@text)
      ON CONFLICT(session_id,hearing_id,response_id) DO UPDATE SET
        respondent_name=excluded.respondent_name,
        respondent_type=excluded.respondent_type,
        author=excluded.author,
        organization=excluded.organization,
        on_behalf_of=excluded.on_behalf_of,
        submitted_at=excluded.submitted_at,
        text=excluded.text
    `).run({ sessionId, hearingId, responseId, ...patch });
}

function setMaterialFlag(sessionId, hearingId, idx, included) {
    db.prepare(`
      INSERT INTO session_materials(session_id,hearing_id,idx,included)
      VALUES (?,?,?,?)
      ON CONFLICT(session_id,hearing_id,idx) DO UPDATE SET included=excluded.included
    `).run(sessionId, hearingId, idx, included ? 1 : 0);
}

function getMaterialFlags(sessionId, hearingId) {
    const rows = db.prepare(`SELECT idx,included FROM session_materials WHERE session_id=? AND hearing_id=?`).all(sessionId, hearingId);
    const flags = {};
    rows.forEach(r => { flags[r.idx] = !!r.included; });
    return flags;
}

function addUpload(sessionId, hearingId, stored_path, original_name) {
    db.prepare(`INSERT INTO session_uploads(session_id,hearing_id,stored_path,original_name,uploaded_at) VALUES (?,?,?,?,?)`)
      .run(sessionId, hearingId, stored_path, original_name, Date.now());
}

function listUploads(sessionId, hearingId) {
    return db.prepare(`SELECT id,stored_path as path,original_name as originalName,uploaded_at as uploadedAt FROM session_uploads WHERE session_id=? AND hearing_id=? ORDER BY id ASC`)
      .all(sessionId, hearingId);
}

// ============================================================================
// ANALYSIS DRAFTS - Interactive editing of pipeline groupings
// ============================================================================

/**
 * Get active draft for a hearing
 * @param {number} hearingId
 * @returns {Object|null} Draft object or null if none exists
 */
function getActiveDraft(hearingId) {
    const draft = db.prepare(`
        SELECT * FROM analysis_drafts
        WHERE hearing_id = ? AND status = 'active'
    `).get(hearingId);

    if (!draft) return null;

    return {
        id: draft.id,
        hearingId: draft.hearing_id,
        baseRunLabel: draft.base_run_label,
        status: draft.status,
        createdAt: draft.created_at,
        updatedAt: draft.updated_at
    };
}

/**
 * Create a new draft for a hearing
 * @param {number} hearingId
 * @param {string} baseRunLabel - Pipeline run label to base draft on
 * @returns {Object} Created draft
 */
function createDraft(hearingId, baseRunLabel) {
    const now = Date.now();

    // Archive any existing active draft
    db.prepare(`
        UPDATE analysis_drafts SET status = 'archived', updated_at = ?
        WHERE hearing_id = ? AND status = 'active'
    `).run(now, hearingId);

    // Create new draft
    const result = db.prepare(`
        INSERT INTO analysis_drafts (hearing_id, base_run_label, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
    `).run(hearingId, baseRunLabel, now, now);

    return {
        id: result.lastInsertRowid,
        hearingId,
        baseRunLabel,
        status: 'active',
        createdAt: now,
        updatedAt: now
    };
}

/**
 * Update draft status
 * @param {number} draftId
 * @param {string} status - 'active', 'applied', or 'archived'
 */
function updateDraftStatus(draftId, status) {
    db.prepare(`
        UPDATE analysis_drafts SET status = ?, updated_at = ?
        WHERE id = ?
    `).run(status, Date.now(), draftId);
}

/**
 * Add an operation to the draft
 * @param {number} draftId
 * @param {string} operationType - e.g., 'move_citation', 'merge_positions'
 * @param {Object} operationData - JSON-serializable operation data
 * @param {Object} inverseData - Data needed to reverse the operation
 * @returns {Object} Created operation
 */
function addDraftOperation(draftId, operationType, operationData, inverseData) {
    const now = Date.now();

    // Get next sequence number
    const maxSeq = db.prepare(`
        SELECT MAX(sequence) as maxSeq FROM draft_operations WHERE draft_id = ?
    `).get(draftId);
    const sequence = (maxSeq?.maxSeq || 0) + 1;

    const result = db.prepare(`
        INSERT INTO draft_operations (draft_id, sequence, operation_type, operation_data, inverse_data, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(draftId, sequence, operationType, JSON.stringify(operationData), JSON.stringify(inverseData), now);

    // Update draft timestamp
    db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);

    return {
        id: result.lastInsertRowid,
        draftId,
        sequence,
        operationType,
        operationData,
        inverseData,
        appliedAt: now
    };
}

/**
 * Undo the last operation in a draft
 * @param {number} draftId
 * @returns {Object|null} Undone operation or null if nothing to undo
 */
function undoDraftOperation(draftId) {
    const lastOp = db.prepare(`
        SELECT * FROM draft_operations
        WHERE draft_id = ? AND undone_at IS NULL
        ORDER BY sequence DESC LIMIT 1
    `).get(draftId);

    if (!lastOp) return null;

    const now = Date.now();
    db.prepare(`
        UPDATE draft_operations SET undone_at = ? WHERE id = ?
    `).run(now, lastOp.id);

    db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);

    return {
        id: lastOp.id,
        sequence: lastOp.sequence,
        operationType: lastOp.operation_type,
        operationData: JSON.parse(lastOp.operation_data),
        inverseData: JSON.parse(lastOp.inverse_data || '{}'),
        undoneAt: now
    };
}

/**
 * Redo the last undone operation
 * @param {number} draftId
 * @returns {Object|null} Redone operation or null if nothing to redo
 */
function redoDraftOperation(draftId) {
    const lastUndone = db.prepare(`
        SELECT * FROM draft_operations
        WHERE draft_id = ? AND undone_at IS NOT NULL
        ORDER BY sequence ASC LIMIT 1
    `).get(draftId);

    if (!lastUndone) return null;

    const now = Date.now();
    db.prepare(`
        UPDATE draft_operations SET undone_at = NULL WHERE id = ?
    `).run(lastUndone.id);

    db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);

    return {
        id: lastUndone.id,
        sequence: lastUndone.sequence,
        operationType: lastUndone.operation_type,
        operationData: JSON.parse(lastUndone.operation_data),
        inverseData: JSON.parse(lastUndone.inverse_data || '{}'),
        redoneAt: now
    };
}

/**
 * Get all operations for a draft (excluding undone ones)
 * @param {number} draftId
 * @returns {Array} List of operations
 */
function getDraftOperations(draftId) {
    const rows = db.prepare(`
        SELECT * FROM draft_operations
        WHERE draft_id = ? AND undone_at IS NULL
        ORDER BY sequence ASC
    `).all(draftId);

    return rows.map(row => ({
        id: row.id,
        sequence: row.sequence,
        operationType: row.operation_type,
        operationData: JSON.parse(row.operation_data),
        inverseData: JSON.parse(row.inverse_data || '{}'),
        appliedAt: row.applied_at
    }));
}

/**
 * Initialize draft positions from pipeline groupings
 * @param {number} draftId
 * @param {Array} themes - Array of {name, positions} from pipeline
 */
function initializeDraftPositions(draftId, themes) {
    const now = Date.now();

    const insertTheme = db.prepare(`
        INSERT INTO draft_themes (draft_id, theme_id, name, display_order, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `);

    const insertPosition = db.prepare(`
        INSERT INTO draft_positions (draft_id, position_id, theme_name, title, response_numbers, direction, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertCitation = db.prepare(`
        INSERT INTO draft_citations (draft_id, position_id, response_number, status, updated_at)
        VALUES (?, ?, ?, 'active', ?)
    `);

    const tx = db.transaction(() => {
        // Clear existing data for this draft
        db.prepare(`DELETE FROM draft_themes WHERE draft_id = ?`).run(draftId);
        db.prepare(`DELETE FROM draft_positions WHERE draft_id = ?`).run(draftId);
        db.prepare(`DELETE FROM draft_citations WHERE draft_id = ?`).run(draftId);

        themes.forEach((theme, themeIdx) => {
            const themeId = `theme-${themeIdx}-${cryptoRandomId().slice(0, 8)}`;
            insertTheme.run(draftId, themeId, theme.name, themeIdx, now);

            (theme.positions || []).forEach((pos, posIdx) => {
                const positionId = `pos-${themeIdx}-${posIdx}-${cryptoRandomId().slice(0, 8)}`;
                const responseNumbers = pos.responseNumbers || [];
                insertPosition.run(
                    draftId,
                    positionId,
                    theme.name,
                    pos.title || `Position ${posIdx + 1}`,
                    JSON.stringify(responseNumbers),
                    pos.direction || null,
                    now,
                    now
                );

                // Add citations for each response
                responseNumbers.forEach(respNum => {
                    insertCitation.run(draftId, positionId, respNum, now);
                });
            });
        });
    });

    tx();
}

/**
 * Get all positions for a draft
 * @param {number} draftId
 * @returns {Array} Positions grouped by theme
 */
function getDraftPositions(draftId) {
    const themes = db.prepare(`
        SELECT * FROM draft_themes
        WHERE draft_id = ? AND is_deleted = 0
        ORDER BY display_order ASC
    `).all(draftId);

    const positions = db.prepare(`
        SELECT * FROM draft_positions
        WHERE draft_id = ? AND is_deleted = 0
    `).all(draftId);

    const citations = db.prepare(`
        SELECT * FROM draft_citations
        WHERE draft_id = ? AND status = 'active'
    `).all(draftId);

    // Group citations by position
    const citationsByPosition = {};
    citations.forEach(c => {
        if (!citationsByPosition[c.position_id]) {
            citationsByPosition[c.position_id] = [];
        }
        citationsByPosition[c.position_id].push(c.response_number);
    });

    // Group positions by theme
    const positionsByTheme = {};
    positions.forEach(p => {
        if (!positionsByTheme[p.theme_name]) {
            positionsByTheme[p.theme_name] = [];
        }
        positionsByTheme[p.theme_name].push({
            positionId: p.position_id,
            title: p.title,
            responseNumbers: citationsByPosition[p.position_id] || JSON.parse(p.response_numbers || '[]'),
            direction: p.direction
        });
    });

    return themes.map(t => ({
        themeId: t.theme_id,
        name: t.name,
        positions: positionsByTheme[t.name] || []
    }));
}

/**
 * Move a citation from one position to another
 * @param {number} draftId
 * @param {number} responseNumber
 * @param {string} fromPositionId
 * @param {string} toPositionId
 */
function moveDraftCitation(draftId, responseNumber, fromPositionId, toPositionId) {
    const now = Date.now();

    const tx = db.transaction(() => {
        // Remove from source position
        db.prepare(`
            UPDATE draft_citations
            SET status = 'moved', moved_from_position_id = ?, updated_at = ?
            WHERE draft_id = ? AND position_id = ? AND response_number = ?
        `).run(fromPositionId, now, draftId, fromPositionId, responseNumber);

        // Add to target position
        db.prepare(`
            INSERT INTO draft_citations (draft_id, position_id, response_number, status, moved_from_position_id, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            ON CONFLICT(draft_id, position_id, response_number) DO UPDATE SET
                status = 'active',
                moved_from_position_id = excluded.moved_from_position_id,
                updated_at = excluded.updated_at
        `).run(draftId, toPositionId, responseNumber, fromPositionId, now);

        db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);
    });

    tx();
}

/**
 * Create a new position in a draft
 * @param {number} draftId
 * @param {string} themeName
 * @param {string} title
 * @param {Array<number>} responseNumbers
 * @returns {string} New position ID
 */
function createDraftPosition(draftId, themeName, title, responseNumbers = []) {
    const now = Date.now();
    const positionId = `pos-new-${cryptoRandomId().slice(0, 12)}`;

    const tx = db.transaction(() => {
        db.prepare(`
            INSERT INTO draft_positions (draft_id, position_id, theme_name, title, response_numbers, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(draftId, positionId, themeName, title, JSON.stringify(responseNumbers), now, now);

        // Add citations
        const insertCitation = db.prepare(`
            INSERT INTO draft_citations (draft_id, position_id, response_number, status, updated_at)
            VALUES (?, ?, ?, 'active', ?)
        `);
        responseNumbers.forEach(respNum => {
            insertCitation.run(draftId, positionId, respNum, now);
        });

        db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);
    });

    tx();
    return positionId;
}

/**
 * Delete a position from a draft
 * @param {number} draftId
 * @param {string} positionId
 */
function deleteDraftPosition(draftId, positionId) {
    const now = Date.now();

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE draft_positions SET is_deleted = 1, updated_at = ?
            WHERE draft_id = ? AND position_id = ?
        `).run(now, draftId, positionId);

        db.prepare(`
            UPDATE draft_citations SET status = 'position_deleted', updated_at = ?
            WHERE draft_id = ? AND position_id = ?
        `).run(now, draftId, positionId);

        db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);
    });

    tx();
}

/**
 * Merge multiple positions into one
 * @param {number} draftId
 * @param {Array<string>} sourcePositionIds
 * @param {string} newTitle
 * @param {string} themeName
 * @returns {string} New merged position ID
 */
function mergeDraftPositions(draftId, sourcePositionIds, newTitle, themeName) {
    const now = Date.now();
    const mergedPositionId = `pos-merged-${cryptoRandomId().slice(0, 12)}`;

    const tx = db.transaction(() => {
        // Get all response numbers from source positions
        const allResponseNumbers = new Set();
        sourcePositionIds.forEach(posId => {
            const citations = db.prepare(`
                SELECT response_number FROM draft_citations
                WHERE draft_id = ? AND position_id = ? AND status = 'active'
            `).all(draftId, posId);
            citations.forEach(c => allResponseNumbers.add(c.response_number));
        });

        // Create merged position
        db.prepare(`
            INSERT INTO draft_positions (draft_id, position_id, theme_name, title, response_numbers, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(draftId, mergedPositionId, themeName, newTitle, JSON.stringify([...allResponseNumbers]), now, now);

        // Add citations to merged position
        const insertCitation = db.prepare(`
            INSERT INTO draft_citations (draft_id, position_id, response_number, status, updated_at)
            VALUES (?, ?, ?, 'active', ?)
        `);
        allResponseNumbers.forEach(respNum => {
            insertCitation.run(draftId, mergedPositionId, respNum, now);
        });

        // Mark source positions as deleted
        sourcePositionIds.forEach(posId => {
            db.prepare(`
                UPDATE draft_positions SET is_deleted = 1, updated_at = ?
                WHERE draft_id = ? AND position_id = ?
            `).run(now, draftId, posId);

            db.prepare(`
                UPDATE draft_citations SET status = 'merged', updated_at = ?
                WHERE draft_id = ? AND position_id = ?
            `).run(now, draftId, posId);
        });

        db.prepare(`UPDATE analysis_drafts SET updated_at = ? WHERE id = ?`).run(now, draftId);
    });

    tx();
    return mergedPositionId;
}

// ============================================================================
// SAVED SEARCHES
// ============================================================================

function createSavedSearch(hearingId, name, filters) {
    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO saved_searches (hearing_id, name, filters_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(hearingId, name, JSON.stringify(filters), now, now);

    return { id: result.lastInsertRowid, hearingId, name, filters, createdAt: now };
}

function getSavedSearches(hearingId) {
    const rows = db.prepare(`
        SELECT * FROM saved_searches WHERE hearing_id = ? ORDER BY updated_at DESC
    `).all(hearingId);

    return rows.map(row => ({
        id: row.id,
        name: row.name,
        filters: JSON.parse(row.filters_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}

function deleteSavedSearch(searchId) {
    db.prepare(`DELETE FROM saved_searches WHERE id = ?`).run(searchId);
}

// Export an API object with a live getter for `db` so callers always see the current handle
const api = {
    DB_PATH,
    init,
    upsertHearing,
    replaceRawResponses,
    replaceResponses,
    replaceRawMaterials,
    replaceMaterials,
    readAggregate,
    getRawAggregate,
    getPublishedAggregate,
    getPreparationState,
    updatePreparationState,
    recalcPreparationProgress,
    upsertPreparedResponse,
    deletePreparedResponse,
    upsertPreparedAttachment,
    deletePreparedAttachment,
    upsertPreparedMaterial,
    deletePreparedMaterial,
    listPreparedHearings,
    getPreparedBundle,
    getPreparedBundlePaginated,
    publishPreparedHearing,
    replaceVectorChunks,
    listVectorChunks,
    markHearingComplete,
    isHearingComplete,
    setHearingArchived,
    listHearingsByStatusLike,
    listIncompleteHearings,
    listAllHearingIds,
    getSessionEdits,
    upsertSessionEdit,
    setMaterialFlag,
    getMaterialFlags,
    addUpload,
    listUploads,
    updateHearingIndex,
    getHearingIndex,
    // Analysis drafts
    getActiveDraft,
    createDraft,
    updateDraftStatus,
    addDraftOperation,
    undoDraftOperation,
    redoDraftOperation,
    getDraftOperations,
    initializeDraftPositions,
    getDraftPositions,
    moveDraftCitation,
    createDraftPosition,
    deleteDraftPosition,
    mergeDraftPositions,
    // Saved searches
    createSavedSearch,
    getSavedSearches,
    deleteSavedSearch
};
Object.defineProperty(api, 'db', { get: () => db });
module.exports = api;


