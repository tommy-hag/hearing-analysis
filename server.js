// Polyfill for File object in Node.js environments
if (typeof File === 'undefined') {
    global.File = class File {};
}

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
let DocxLib = null;
try { DocxLib = require('docx'); } catch (_) { DocxLib = null; }
// Ensure .env is loaded from this folder, regardless of current working directory
try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
    try { require('dotenv').config(); } catch (_) {}
}
let OpenAILib = null;
try { OpenAILib = require('openai'); } catch (_) { OpenAILib = null; }
const multer = require('multer');
const session = require('express-session');
let SQLiteStore;
try { SQLiteStore = require('connect-sqlite3')(session); }
catch (_) { SQLiteStore = null; }
const cron = require('node-cron');

// Wrap db/sqlite require in try-catch to handle better-sqlite3 load failures gracefully
let initDb, sqliteModule, sqliteDb, upsertHearing, replaceRawResponses, replaceResponses, replaceRawMaterials, replaceMaterials, readAggregate, getRawAggregate, getPublishedAggregate, getPreparationState, updatePreparationState, recalcPreparationProgress, upsertPreparedResponse, deletePreparedResponse, upsertPreparedAttachment, deletePreparedAttachment, upsertPreparedMaterial, deletePreparedMaterial, listPreparedHearings, getPreparedBundle, getPreparedBundlePaginated, publishPreparedHearing, replaceVectorChunks, listVectorChunks, getSessionEdits, upsertSessionEdit, setMaterialFlag, getMaterialFlags, addUpload, listUploads, markHearingComplete, isHearingComplete, setHearingArchived, listHearingsByStatusLike, listAllHearingIds;
try {
    sqliteModule = require('./db/sqlite');
    ({ init: initDb, upsertHearing, replaceRawResponses, replaceResponses, replaceRawMaterials, replaceMaterials, readAggregate, getRawAggregate, getPublishedAggregate, getPreparationState, updatePreparationState, recalcPreparationProgress, upsertPreparedResponse, deletePreparedResponse, upsertPreparedAttachment, deletePreparedAttachment, upsertPreparedMaterial, deletePreparedMaterial, listPreparedHearings, getPreparedBundle, getPreparedBundlePaginated, publishPreparedHearing, replaceVectorChunks, listVectorChunks, getSessionEdits, upsertSessionEdit, setMaterialFlag, getMaterialFlags, addUpload, listUploads, markHearingComplete, isHearingComplete, setHearingArchived, listHearingsByStatusLike, listAllHearingIds } = sqliteModule);
    // Get initial db reference (will be updated after initDb() is called)
    sqliteDb = sqliteModule.db;
    console.log('[Server] SQLite module loaded successfully');
} catch (e) {
    console.error('[Server] CRITICAL: Failed to load SQLite module:', e.message);
    console.error('[Server] Stack:', e.stack);
    console.error('[Server] Server will continue but database features will not work');
    // Create stub functions so server can continue
    initDb = () => { console.warn('[Server] SQLite not available - initDb is a no-op'); };
    sqliteDb = null;
    upsertHearing = () => {};
    replaceRawResponses = () => {};
    replaceResponses = () => {};
    replaceRawMaterials = () => {};
    replaceMaterials = () => {};
    getRawAggregate = () => ({ responses: [], materials: [] });
    getPublishedAggregate = () => ({ responses: [], materials: [] });
    getPreparationState = () => ({ status: 'draft', responses_ready: 0, materials_ready: 0 });
    updatePreparationState = () => ({ status: 'draft', responses_ready: 0, materials_ready: 0 });
    recalcPreparationProgress = () => ({ status: 'draft', responses_ready: 0, materials_ready: 0 });
    upsertPreparedResponse = () => ({ state: { status: 'draft' } });
    deletePreparedResponse = () => ({ status: 'draft' });
    upsertPreparedAttachment = () => ({ status: 'draft' });
    deletePreparedAttachment = () => ({ status: 'draft' });
    upsertPreparedMaterial = () => ({ status: 'draft' });
    deletePreparedMaterial = () => ({ status: 'draft' });
    listPreparedHearings = () => [];
    getPreparedBundle = () => null;
    getPreparedBundlePaginated = () => null;
    publishPreparedHearing = () => ({ status: 'draft' });
    replaceVectorChunks = () => {};
    listVectorChunks = () => [];
    readAggregate = () => null;
    getSessionEdits = () => ({});
    upsertSessionEdit = () => {};
    setMaterialFlag = () => {};
    getMaterialFlags = () => ({});
    addUpload = () => {};
    listUploads = () => [];
    markHearingComplete = () => {};
    isHearingComplete = () => ({ complete: false });
    setHearingArchived = () => {};
    listHearingsByStatusLike = () => [];
    listAllHearingIds = () => [];
}

// OpenAI client (optional). If library or key is missing, summarization endpoints will return an error.
const openai = OpenAILib && (process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_KEY)
    ? new OpenAILib({ apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_KEY })
    : null;
const MODEL_ID = process.env.MODEL_ID || process.env.OPENAI_MODEL || 'gpt-5';
const TEMPERATURE = typeof process.env.TEMPERATURE !== 'undefined' ? Number(process.env.TEMPERATURE) : 0.1;
const MAX_TOKENS = typeof process.env.MAX_TOKENS !== 'undefined' ? Number(process.env.MAX_TOKENS) : null;
// Increase internal HTTP timeout for long-running local API calls used during summarization
const INTERNAL_API_TIMEOUT_MS = Number(process.env.INTERNAL_API_TIMEOUT_MS || 1500000);
// Conservative timeout for internal calls made by light endpoints (e.g., classification)
const CLASSIFY_INTERNAL_TIMEOUT_MS = Number(process.env.CLASSIFY_INTERNAL_TIMEOUT_MS || 60000);
// Max time the summarization SSE should be allowed to run (25 minutes default)
const SUMMARIZE_TIMEOUT_MS = Number(process.env.SUMMARIZE_TIMEOUT_MS || 1500000);
// Warmup configuration
const WARM_ALL_ON_START = String(process.env.WARM_ALL_ON_START || '').toLowerCase() === 'true';
// LITE_MODE: Disable all automatic warming/scraping - data is only fetched on-demand via GDPR settings
const LITE_MODE = String(process.env.LITE_MODE || '').toLowerCase() === 'true';
// Open-hearings refresh configuration (only target 'Afventer konklusion')
const REFRESH_TARGET_STATUSES = (process.env.REFRESH_TARGET_STATUSES || 'Afventer konklusion')
    .split(',')
    .map(s => s.trim())
    .map(s => s.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, ''))
    .map(s => s.toLowerCase())
    .filter(Boolean);
const REFRESH_MAX_ATTEMPTS = Math.max(1, Number(process.env.REFRESH_MAX_ATTEMPTS || 6));
const REFRESH_STABLE_REPEATS = Math.max(1, Number(process.env.REFRESH_STABLE_REPEATS || 2));
const REFRESH_CONCURRENCY = Math.max(1, Number(process.env.REFRESH_CONCURRENCY || 2));
// Vector store configuration
const VECTOR_STORE_THRESHOLD_RESPONSES = Number(process.env.VECTOR_STORE_THRESHOLD_RESPONSES || 50);
const VECTOR_STORE_THRESHOLD_MATERIALS = Number(process.env.VECTOR_STORE_THRESHOLD_MATERIALS || 5);
const VECTOR_STORE_THRESHOLD_CHARS = Number(process.env.VECTOR_STORE_THRESHOLD_CHARS || 100000);
const VECTOR_SEARCH_MIN_SCORE = Number(process.env.VECTOR_SEARCH_MIN_SCORE || 0.5);
const VECTOR_SEARCH_MAX_CHUNKS = Number(process.env.VECTOR_SEARCH_MAX_CHUNKS || 50);
// Node HTTP server timeouts (tuned for SSE and long background jobs). Defaults chosen to avoid premature disconnects
const SERVER_KEEP_ALIVE_TIMEOUT_MS = Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 65000);
const SERVER_HEADERS_TIMEOUT_MS = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 66000);
const SERVER_REQUEST_TIMEOUT_MS = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 0); // 0 disables request timeout
const WARM_CONCURRENCY = Math.max(1, Number(process.env.WARM_CONCURRENCY || 2));
const WARM_MAX_HEARINGS = Number(process.env.WARM_MAX_HEARINGS || 0); // 0 = no limit
const WARM_RETRY_ATTEMPTS = Math.max(1, Number(process.env.WARM_RETRY_ATTEMPTS || 2));
// Prefer API-only prefetcher (avoids heavy HTML scraping) for cron/warm paths
const API_ONLY_PREFETCH = parseBoolean(process.env.API_ONLY_PREFETCH || 'true');
const WARM_MIN_INTERVAL_MS = Math.max(0, Number(process.env.WARM_MIN_INTERVAL_MS || 120000));
const PREFETCH_CONCURRENCY = Math.max(1, Number(process.env.PREFETCH_CONCURRENCY || 2));
const PREFETCH_MIN_INTERVAL_MS = Math.max(0, Number(process.env.PREFETCH_MIN_INTERVAL_MS || 10*60*1000));

// In-memory guards to avoid thrashing
const lastWarmAt = new Map(); // hearingId -> ts
const prefetchInFlight = new Set(); // hearingId currently prefetching
const hydrationInFlight = new Map(); // hearingId -> ongoing hydration promise

// Render API configuration (for one-off jobs)
const RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_TOKEN || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || process.env.RENDER_SERVICE || '';
const RENDER_API_BASE = (process.env.RENDER_API_BASE || 'https://api.render.com').replace(/\/$/, '');
// Background mode default
function parseBoolean(value) {
    const v = String(value || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}
const OPENAI_BACKGROUND_DEFAULT = parseBoolean(process.env.OPENAI_BACKGROUND || process.env.BACKGROUND_MODE || process.env['BACKGROUND-MODE'] || 'false');
const BACKGROUND_MODE = parseBoolean(process.env.BACKGROUND_MODE || 'true');

// In-memory recent variants cache for salvage when clients disconnect from SSE
const RECENT_CACHE_LIMIT = 50; // total variants across all hearings
const recentVariantsByHearing = new Map(); // key: hearingId -> Map(variantId -> variant)
function recordRecentVariant(hearingId, variant) {
    try {
        const hid = String(hearingId || '').trim();
        if (!hid || !variant || !variant.id) return;
        if (!recentVariantsByHearing.has(hid)) recentVariantsByHearing.set(hid, new Map());
        const map = recentVariantsByHearing.get(hid);
        map.set(String(variant.id), {
            id: variant.id,
            markdown: variant.markdown || '',
            summary: variant.summary || '',
            headings: Array.isArray(variant.headings) ? variant.headings : []
        });
        // Prune global size
        let total = 0;
        for (const m of recentVariantsByHearing.values()) total += m.size;
        if (total > RECENT_CACHE_LIMIT) {
            // Remove oldest hearing entry (arbitrary: first inserted)
            const firstKey = recentVariantsByHearing.keys().next().value;
            if (typeof firstKey !== 'undefined') recentVariantsByHearing.delete(firstKey);
        }
    } catch {}
}

// Verbosity and reasoning effort controls (opt-in via env)
function normalizeVerbosity(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (['low', 'minimal', 'min'].includes(v)) return 'low';
    if (['medium', 'med', 'normal', 'default'].includes(v)) return 'medium';
    if (['high', 'verbose', 'max'].includes(v)) return 'high';
    if (v === 'none' || v === 'off' || v === 'false') return null;
    return v; // pass-through for future values like 'auto'
}
function normalizeReasoningEffort(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (['minimal', 'low', 'min'].includes(v)) return 'low';
    if (['medium', 'med', 'normal', 'default'].includes(v)) return 'medium';
    if (['high', 'max'].includes(v)) return 'high';
    if (v === 'none' || v === 'off' || v === 'false') return null;
    return v;
}
const VERBOSITY_ENV = normalizeVerbosity(process.env.OPENAI_VERBOSITY || process.env.VERBOSITY || 'high');
const REASONING_EFFORT_ENV = normalizeReasoningEffort(process.env.OPENAI_REASONING_EFFORT || process.env.REASONING_EFFORT || 'high');
const USE_STRUCTURED_OUTPUT = parseBoolean(process.env.USE_STRUCTURED_OUTPUT || 'true');
console.log(`[Config] USE_STRUCTURED_OUTPUT=${process.env.USE_STRUCTURED_OUTPUT} (parsed: ${USE_STRUCTURED_OUTPUT}), MODEL_ID=${MODEL_ID}`);

function resolvePromptPath() {
    if (process.env.SUMMARY_PROMPT_PATH) return process.env.SUMMARY_PROMPT_PATH;
    const candidate1 = path.join(__dirname, 'prompts', 'prompt.md');
    if (fs.existsSync(candidate1)) return candidate1;
    return path.join(__dirname, 'prompts', 'prompt.md');
}

function resolveClassifierPromptPath() {
    if (process.env.CLASSIFIER_PROMPT_PATH) return process.env.CLASSIFIER_PROMPT_PATH;
    const candidate = path.join(__dirname, 'prompts', 'auto-classify-respondents.md');
    if (fs.existsSync(candidate)) return candidate;
    return candidate;
}
function resolveTemplatePath() {
    if (process.env.DOCX_TEMPLATE_PATH) return process.env.DOCX_TEMPLATE_PATH;
    const templatesDir = path.join(__dirname, 'templates');
    try {
        if (fs.existsSync(templatesDir)) {
            const firstDocx = (fs.readdirSync(templatesDir).find(f => f.toLowerCase().endsWith('.docx')));
            if (firstDocx) return path.join(templatesDir, firstDocx);
        }
    } catch {}
    // Legacy fallback
    const legacyDir = path.join(__dirname, 'scriptskabelon');
    try {
        if (fs.existsSync(legacyDir)) {
            const firstDocx = (fs.readdirSync(legacyDir).find(f => f.toLowerCase().endsWith('.docx')));
            if (firstDocx) return path.join(legacyDir, firstDocx);
        }
    } catch {}
    return path.join(__dirname, 'templates', 'template.docx');
}
const PROMPT_PATH = resolvePromptPath();
const CLASSIFIER_PROMPT_PATH = resolveClassifierPromptPath();
const TEMPLATE_DOCX = resolveTemplatePath();

const LOG_FILE = path.join(__dirname, 'server.log');
function logDebug(message) {
    try {
        const line = `[${new Date().toISOString()}] ${String(message || '')}`;
        try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (_) {}
        try { console.log(line); } catch (_) {}
    } catch (_) {}
}

// Minimal Node.js fallback DOCX builder (used if Python builder fails)
async function buildDocxFallbackNode(markdown, outPath) {
    try {
        if (!DocxLib) return false;
        const { Document, Packer, Paragraph, HeadingLevel } = DocxLib;
        const doc = new Document({
            sections: [{ properties: {}, children: [] }]
        });
        const children = [];
        const lines = String(markdown || '').split(/\r?\n/);
        for (const raw of lines) {
            const line = String(raw || '');
            const m = line.match(/^(#{1,6})\s+(.*)$/);
            if (m) {
                const level = Math.min(Math.max(m[1].length, 1), 6);
                const text = m[2] || '';
                const headingMap = {
                    1: HeadingLevel.HEADING_1,
                    2: HeadingLevel.HEADING_2,
                    3: HeadingLevel.HEADING_3,
                    4: HeadingLevel.HEADING_4,
                    5: HeadingLevel.HEADING_5,
                    6: HeadingLevel.HEADING_6
                };
                children.push(new Paragraph({ text, heading: headingMap[level] }));
            } else if (line.trim().length === 0) {
                children.push(new Paragraph({ text: '' }));
            } else {
                // Strip basic markdown formatting for readability
                let text = line
                    .replace(/```[\s\S]*?```/g, '')
                    .replace(/^#{1,6}\s+/g, '')
                    .replace(/\*\*([^*]+)\*\*/g, '$1')
                    .replace(/\*([^*]+)\*/g, '$1')
                    .replace(/_([^_]+)_/g, '$1')
                    .replace(/\[(.*?)\]\([^)]*\)/g, '$1');
                children.push(new Paragraph({ text }));
            }
        }
        doc.addSection({ properties: {}, children });
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(outPath, buffer);
        return true;
    } catch (_) {
        return false;
    }
}

// Compute fast pre-thought headings from input to show immediate reasoning summary
function computePreThoughts(inputText) {
    const lc = String(inputText || '').toLowerCase();
    const buckets = [
        { key: 'trafik', label: 'Trafik og parkering', re: /trafik|parkering|bil|bus|kørsel|koersel|krydset|vej|ve[jy]/g },
        { key: 'stoej', label: 'Støj og boldbane', re: /støj|stoej|boldbur|boldbane|støjværn|stoejvaern|larm/g },
        { key: 'skole', label: 'Skole og institution', re: /skole|institution|daginstitution|børnehave|boernehave|vuggestue/g },
        { key: 'klima', label: 'Klima og grønne områder', re: /klima|grøn|groen|groent|biodivers|regnvand|træ|trae|grønt/g },
        { key: 'byg', label: 'Byggehøjde og skygge', re: /højde|hoejde|skygge|etage|høj|hoej|kollegium/g },
        { key: 'cykel', label: 'Cykel og mobilitet', re: /cykel|cykelsti|fortov|gående|gaaende|mobilitet/g },
        { key: 'tryg', label: 'Tryghed og sikkerhed', re: /tryghed|sikkerhed/g },
        { key: 'proces', label: 'Proces og inddragelse', re: /borgermøde|borgermoede|høring|hoering|proces/g }
    ];
    const scored = [];
    for (const b of buckets) {
        const m = lc.match(b.re);
        if (m && m.length) scored.push({ label: b.label, n: m.length });
    }
    scored.sort((a, b) => b.n - a.n);
    return scored.slice(0, 6).map(s => s.label);
}

function toInt(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    if (!Number.isFinite(int)) return fallback;
    return int;
}

function allocatePreparedResponseId(hearingId) {
    try {
        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') return Date.now();
        const row = sqliteDb.prepare(`SELECT COALESCE(MAX(prepared_id),0) as maxId FROM prepared_responses WHERE hearing_id=?`).get(hearingId);
        return (row?.maxId || 0) + 1;
    } catch (err) {
        console.error('[Server] allocatePreparedResponseId failed:', err.message);
        return Date.now();
    }
}

function allocatePreparedAttachmentId(hearingId, preparedId) {
    try {
        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') return Date.now();
        const row = sqliteDb.prepare(`SELECT COALESCE(MAX(attachment_id),0) as maxId FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).get(hearingId, preparedId);
        return (row?.maxId || 0) + 1;
    } catch (err) {
        console.error('[Server] allocatePreparedAttachmentId failed:', err.message);
        return Date.now();
    }
}

function allocatePreparedMaterialId(hearingId) {
    try {
        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') return Date.now();
        const row = sqliteDb.prepare(`SELECT COALESCE(MAX(material_id),0) as maxId FROM prepared_materials WHERE hearing_id=?`).get(hearingId);
        return (row?.maxId || 0) + 1;
    } catch (err) {
        console.error('[Server] allocatePreparedMaterialId failed:', err.message);
        return Date.now();
    }
}

function ensurePreparedResponsesFromRaw(hearingId) {
    if (!hearingId) return;
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') return;
    try {
        // First, clean up duplicates - keep only one prepared response per source_response_id
        const duplicates = db.prepare(`
            SELECT source_response_id, COUNT(*) as count, MIN(prepared_id) as keep_id
            FROM prepared_responses
            WHERE hearing_id=? AND source_response_id IS NOT NULL
            GROUP BY hearing_id, source_response_id
            HAVING COUNT(*) > 1
        `).all(hearingId);
        
        if (duplicates.length > 0) {
            const tx = db.transaction(() => {
                for (const dup of duplicates) {
                    // Keep the one with approved status if any, otherwise keep the oldest
                    const approvedOne = db.prepare(`
                        SELECT prepared_id FROM prepared_responses
                        WHERE hearing_id=? AND source_response_id=? AND approved=1
                        ORDER BY prepared_id ASC LIMIT 1
                    `).get(hearingId, dup.source_response_id);
                    
                    const keepId = approvedOne ? approvedOne.prepared_id : dup.keep_id;
                    
                    // Delete all except the one to keep
                    const toDelete = db.prepare(`
                        SELECT prepared_id FROM prepared_responses
                        WHERE hearing_id=? AND source_response_id=? AND prepared_id != ?
                    `).all(hearingId, dup.source_response_id, keepId);
                    
                    for (const row of toDelete) {
                        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                    }
                }
            });
            tx();
        }

        const rawResponses = db.prepare(`
            SELECT response_id as responseId, text, author, organization, on_behalf_of as onBehalfOf, submitted_at as submittedAt
            FROM raw_responses
            WHERE hearing_id=?
            ORDER BY response_id ASC
        `).all(hearingId);
        if (!Array.isArray(rawResponses) || !rawResponses.length) return;

        const existing = db.prepare(`
            SELECT source_response_id as sourceResponseId, approved, approved_at
            FROM prepared_responses
            WHERE hearing_id=?
        `).all(hearingId);

        const existingSources = new Set();
        const existingApproved = new Map(); // Track approved status
        for (const row of existing || []) {
            const src = row?.sourceResponseId;
            if (src === null || src === undefined) continue;
            const normalized = Number(src);
            if (Number.isFinite(normalized)) {
                existingSources.add(normalized);
                if (row.approved) {
                    existingApproved.set(normalized, row.approved_at);
                }
            }
        }

        const selectAttachments = db.prepare(`
            SELECT idx as attachmentIdx, filename, url
            FROM raw_attachments
            WHERE hearing_id=? AND response_id=?
            ORDER BY idx ASC
        `);

        for (const raw of rawResponses) {
            const sourceId = Number(raw.responseId);
            if (!Number.isFinite(sourceId) || existingSources.has(sourceId)) continue;

            const attachments = selectAttachments.all(hearingId, sourceId) || [];
            const preparedId = allocatePreparedResponseId(hearingId);

            // Check if this should be auto-approved (preserve approved status)
            const wasApproved = existingApproved.has(sourceId);
            const approvedAt = wasApproved ? existingApproved.get(sourceId) : null;

            upsertPreparedResponse(hearingId, preparedId, {
                sourceResponseId: sourceId,
                respondentName: 'Borger', // Standard skal være "Borger" - ikke bruge navne fra blivhørt
                respondentType: 'Borger', // Standard skal være "Borger"
                author: raw.author || null,
                organization: raw.organization || null,
                onBehalfOf: raw.onBehalfOf || null,
                submittedAt: raw.submittedAt || null,
                textMd: raw.text || '',
                hasAttachments: Array.isArray(attachments) && attachments.length > 0,
                attachmentsReady: false,
                approved: wasApproved || false,
                approvedAt: approvedAt
            });

            attachments.forEach((attachment, idx) => {
                const attachmentId = allocatePreparedAttachmentId(hearingId, preparedId);
                const rawIdx = Number(attachment.attachmentIdx);
                const sourceAttachmentIdx = Number.isFinite(rawIdx) ? rawIdx : idx;
                upsertPreparedAttachment(hearingId, preparedId, attachmentId, {
                    sourceAttachmentIdx,
                    originalFilename: attachment.filename || `Bilag ${idx + 1}`,
                    sourceUrl: attachment.url || null,
                    convertedMd: null,
                    conversionStatus: null,
                    approved: false,
                    notes: null
                });
            });

            existingSources.add(sourceId);
        }
    } catch (error) {
        console.error('[GDPR] ensurePreparedResponsesFromRaw failed:', error);
    }
}

function ensurePreparedResponsesForAllHearings() {
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') return;
    if (typeof listAllHearingIds !== 'function') return;
    try {
        const ids = listAllHearingIds();
        if (!Array.isArray(ids) || !ids.length) return;
        for (const hearingId of ids) {
            ensurePreparedResponsesFromRaw(hearingId);
        }
    } catch (error) {
        console.error('[GDPR] ensurePreparedResponsesForAllHearings failed:', error);
    }
}

async function convertFileToMarkdown(inputPath, options = {}) {
    await ensurePythonDeps();
    const python = process.env.PYTHON_BIN || 'python3';
    // Use advanced PDF converter with dynamic heading detection
    const scriptPath = path.join(__dirname, 'analysis-pipeline', 'scripts', 'pdf-to-markdown.py');
    const args = [scriptPath, '--input', inputPath, '--format', 'json'];
    if (options.maxPages) args.push('--max-pages', String(options.maxPages));
    if (options.includeMetadata) args.push('--metadata');
    const localPy = path.join(__dirname, 'python_packages');
    const mergedPyPath = [localPy, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const env = { ...process.env, PYTHONPATH: mergedPyPath };

    console.log(`[convertFileToMarkdown] Running advanced converter: ${python} ${args.join(' ')}`);
    console.log(`[convertFileToMarkdown] Input path: ${inputPath}, exists: ${fs.existsSync(inputPath)}`);
    
    return await new Promise((resolve, reject) => {
        const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', (err) => {
            console.error(`[convertFileToMarkdown] Spawn error:`, err);
            reject(err);
        });
        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`[convertFileToMarkdown] Script failed with code ${code}`);
                console.error(`[convertFileToMarkdown] stderr:`, stderr);
                console.error(`[convertFileToMarkdown] stdout (first 500 chars):`, stdout.substring(0, 500));
                // Try to extract meaningful error message
                const errorMsg = stderr.trim() || stdout.trim() || `convert_to_md exited with code ${code}`;
                const err = new Error(errorMsg);
                err.code = code;
                err.stderr = stderr;
                err.stdout = stdout;
                return reject(err);
            }
            try {
                // Check if stdout looks like JSON
                const trimmedStdout = stdout.trim();
                if (!trimmedStdout.startsWith('{') && !trimmedStdout.startsWith('[')) {
                    console.error(`[convertFileToMarkdown] stdout does not look like JSON. First 200 chars:`, trimmedStdout.substring(0, 200));
                    throw new Error(`Ugyldigt output fra konverteringsscript. Forventet JSON, men fik: ${trimmedStdout.substring(0, 100)}...`);
                }
                const payload = trimmedStdout ? JSON.parse(trimmedStdout) : {};
                resolve(payload || {});
            } catch (error) {
                console.error(`[convertFileToMarkdown] JSON parse error:`, error);
                console.error(`[convertFileToMarkdown] stdout (first 500 chars):`, stdout.substring(0, 500));
                // Check if stdout contains error JSON
                try {
                    const errorPayload = JSON.parse(stdout.trim());
                    if (errorPayload.error) {
                        const err = new Error(errorPayload.error);
                        err.stderr = stderr;
                        err.stdout = stdout;
                        return reject(err);
                    }
                } catch (_) {
                    // Not JSON error payload, continue with original error
                }
                error.stderr = stderr;
                error.stdout = stdout;
                reject(error);
            }
        });
    });
}

function splitTextIntoChunks(text, chunkSize = 220, overlap = 45) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const chunks = [];
    let index = 0;
    while (index < words.length) {
        const slice = words.slice(index, index + chunkSize);
        if (!slice.length) break;
        chunks.push(slice.join(' '));
        if (index + chunkSize >= words.length) break;
        index = Math.max(index + chunkSize - overlap, index + 1);
    }
    return chunks.filter(Boolean);
}

// Helper functions for vector store usage decisions
function shouldUseVectorStore(responseCount, materialCount, totalChars) {
    if (responseCount > VECTOR_STORE_THRESHOLD_RESPONSES) return true;
    if (materialCount > VECTOR_STORE_THRESHOLD_MATERIALS) return true;
    if (totalChars > VECTOR_STORE_THRESHOLD_CHARS) return true;
    return false;
}

function calculateAdaptiveTopK(responseCount, materialCount, totalChunks) {
    const totalItems = responseCount + materialCount;
    if (totalItems < 20) return Math.min(15, totalChunks);
    if (totalItems < 50) return Math.min(30, totalChunks);
    return Math.min(50, totalChunks);
}

function extractQueryFromPrompt(promptTemplate) {
    if (!promptTemplate || typeof promptTemplate !== 'string') {
        return 'høringssvar analyser temaer gennemgående emner';
    }
    // Extract key terms from prompt template
    const lower = promptTemplate.toLowerCase();
    const keyTerms = [];
    if (lower.includes('tema') || lower.includes('tematis')) keyTerms.push('temaer');
    if (lower.includes('høringssvar') || lower.includes('svar')) keyTerms.push('høringssvar');
    if (lower.includes('analys') || lower.includes('opsummer')) keyTerms.push('analyse');
    if (lower.includes('holdning') || lower.includes('synspunkt')) keyTerms.push('holdninger');
    if (lower.includes('reguler') || lower.includes('materiale')) keyTerms.push('regulering');
    
    return keyTerms.length > 0 ? keyTerms.join(' ') : 'høringssvar analyser temaer gennemgående emner';
}

async function rebuildLocalVectorStore(hearingId) {
    if (!sqliteDb || !sqliteDb.prepare) throw new Error('Database ikke tilgængelig');
    
    // Prioritize published responses/materials if available, otherwise use prepared
    const published = getPublishedAggregate(hearingId);
    const usePublished = published && (
        (Array.isArray(published.responses) && published.responses.length > 0) ||
        (Array.isArray(published.materials) && published.materials.length > 0)
    );
    
    let responsesToUse = [];
    let materialsToUse = [];
    
    if (usePublished) {
        // Use published responses and materials
        responsesToUse = published.responses || [];
        materialsToUse = published.materials || [];
        console.log(`[VectorStore] Using ${responsesToUse.length} published responses and ${materialsToUse.length} published materials for hearing ${hearingId}`);
    } else {
        // Fall back to prepared bundle
        const bundle = getPreparedBundle(hearingId);
        if (!bundle) throw new Error('Høring ikke fundet');
        responsesToUse = bundle.prepared?.responses || [];
        materialsToUse = bundle.prepared?.materials || [];
        console.log(`[VectorStore] Using ${responsesToUse.length} prepared responses and ${materialsToUse.length} prepared materials for hearing ${hearingId}`);
    }
    
    const chunks = [];

    // Process responses (works for both published and prepared)
    responsesToUse.forEach((resp, idx) => {
        const respId = usePublished ? resp.id : resp.preparedId;
        const baseSource = `response:${respId}`;
        const textContent = resp.textMd || resp.text || '';
        const mainChunks = splitTextIntoChunks(textContent)
            .map((content, chunkIdx) => ({
                chunkId: `${baseSource}:text:${chunkIdx}`,
                source: baseSource,
                content
            }));
        chunks.push(...mainChunks);
        
        // Handle attachments (for prepared responses)
        if (resp.attachments && Array.isArray(resp.attachments)) {
            resp.attachments.forEach((att) => {
                const attChunks = splitTextIntoChunks(att.convertedMd || '')
                    .map((content, attIdx) => ({
                        chunkId: `${baseSource}:attachment:${att.attachmentId}:${attIdx}`,
                        source: `attachment:${respId}:${att.attachmentId}`,
                        content
                    }));
                chunks.push(...attChunks);
            });
        }
    });

    // Process materials (works for both published and prepared)
    for (const mat of materialsToUse) {
        const matId = usePublished ? mat.materialId : mat.materialId;
        let contentMd = mat.contentMd || '';
        
        // If contentMd is empty, try to get it from prepared_materials uploadedPath
        if (!contentMd && !usePublished) {
            const preparedMat = sqliteDb.prepare(`SELECT uploaded_path FROM prepared_materials WHERE hearing_id=? AND material_id=?`).get(hearingId, matId);
            if (preparedMat && preparedMat.uploaded_path && fs.existsSync(preparedMat.uploaded_path)) {
                try {
                    const result = await convertFileToMarkdown(preparedMat.uploaded_path, { includeMetadata: true });
                    contentMd = result?.markdown || '';
                    // Update the database with converted content
                    if (contentMd && sqliteDb && sqliteDb.prepare) {
                        try {
                            sqliteDb.prepare(`UPDATE prepared_materials SET content_md=? WHERE hearing_id=? AND material_id=?`)
                                .run(contentMd, hearingId, matId);
                        } catch (err) {
                            console.warn('[GDPR] Failed to update material contentMd:', err.message);
                        }
                    }
                } catch (err) {
                    console.warn(`[GDPR] Failed to convert material ${matId} from ${preparedMat.uploaded_path}:`, err.message);
                }
            }
        }
        
        // For published materials with null contentMd, try to get from prepared_materials
        if (!contentMd && usePublished) {
            const preparedMat = sqliteDb.prepare(`SELECT uploaded_path, content_md FROM prepared_materials WHERE hearing_id=? AND material_id=?`).get(hearingId, matId);
            if (preparedMat) {
                if (preparedMat.content_md) {
                    contentMd = preparedMat.content_md;
                } else if (preparedMat.uploaded_path && fs.existsSync(preparedMat.uploaded_path)) {
                    try {
                        const result = await convertFileToMarkdown(preparedMat.uploaded_path, { includeMetadata: true });
                        contentMd = result?.markdown || '';
                    } catch (err) {
                        console.warn(`[GDPR] Failed to convert published material ${matId}:`, err.message);
                    }
                }
            }
        }
        
        const matChunks = splitTextIntoChunks(contentMd)
            .map((content, idx) => ({
                chunkId: `material:${matId}:${idx}`,
                source: `material:${matId}`,
                content
            }));
        chunks.push(...matChunks);
    }

    if (!chunks.length) {
        replaceVectorChunks(hearingId, []);
        updatePreparationState(hearingId, { vector_store_id: 'local-sqlite', vector_store_updated_at: Date.now() });
        return { chunkCount: 0 };
    }

    let embeddings = [];
    if (openai) {
        const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
        const batchSize = 60;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const slice = chunks.slice(i, i + batchSize).map(c => c.content.slice(0, 8000));
            try {
                const response = await openai.embeddings.create({ model, input: slice });
                const vectors = response?.data || [];
                vectors.forEach((item, idx) => {
                    if (!embeddings[i + idx]) embeddings[i + idx] = item.embedding;
                });
            } catch (error) {
                console.error('[VectorStore] embed batch failed:', error.message);
                // fallback: fill zeros for this batch
                for (let j = 0; j < slice.length; j += 1) {
                    embeddings[i + j] = [];
                }
            }
        }
    } else {
        embeddings = chunks.map(() => []);
    }

    const augmented = chunks.map((chunk, idx) => ({
        chunkId: chunk.chunkId,
        source: chunk.source,
        content: chunk.content,
        embedding: embeddings[idx] || []
    }));

    replaceVectorChunks(hearingId, augmented);
    updatePreparationState(hearingId, { vector_store_id: 'local-sqlite', vector_store_updated_at: Date.now() });
    return { chunkCount: augmented.length };
}

function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || !vecA.length || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i += 1) {
        const a = vecA[i];
        const b = vecB[i];
        dot += a * b;
        normA += a * a;
        normB += b * b;
    }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function queryLocalVectorStore(hearingId, query, topK = 8, minScore = VECTOR_SEARCH_MIN_SCORE) {
    if (!openai) return [];
    const chunks = listVectorChunks(hearingId);
    if (!chunks.length) return [];
    const embeddingRes = await openai.embeddings.create({ model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small', input: [String(query || '').slice(0, 8000)] });
    const queryEmbedding = embeddingRes?.data?.[0]?.embedding;
    if (!Array.isArray(queryEmbedding)) return [];
    const scored = chunks.map(chunk => ({
        chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding || [])
    })).sort((a, b) => b.score - a.score);
    
    // Filter by minimum score
    const filtered = scored.filter(item => item.score >= minScore);
    
    // Diversify results: avoid returning too many chunks from the same source
    const diversified = [];
    const sourceCounts = new Map();
    const maxPerSource = Math.max(2, Math.ceil(topK / 4)); // Max 25% from same source
    
    for (const item of filtered) {
        const source = item.chunk.source || 'unknown';
        const count = sourceCounts.get(source) || 0;
        
        if (count < maxPerSource || diversified.length < topK) {
            diversified.push(item);
            sourceCounts.set(source, count + 1);
            if (diversified.length >= topK) break;
        }
    }
    
    return diversified.slice(0, topK).map(item => ({
        score: item.score,
        source: item.chunk.source,
        content: item.chunk.content
    }));
}

const app = express();
const PORT = process.env.PORT || 3010;

// Behind Render's proxy so req.secure reflects X-Forwarded-Proto
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
try { app.set('trust proxy', 1); } catch {}

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/gdpr', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gdpr.html'));
});
const upload = multer({ dest: path.join(__dirname, 'uploads') });
try { fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true }); } catch {}
const gdprUploadDir = path.join(__dirname, 'uploads', 'gdpr');
try { fs.mkdirSync(gdprUploadDir, { recursive: true }); } catch {}
const gdprMaterialUpload = multer({
    dest: gdprUploadDir,
    limits: { fileSize: Number(process.env.GDPR_UPLOAD_MAX_BYTES || 100 * 1024 * 1024) },
    fileFilter: (req, file, cb) => {
        try {
            const allowedMime = ['application/pdf', 'text/markdown', 'text/plain'];
            if (allowedMime.includes(file.mimetype)) return cb(null, true);
            // Accept octet-stream but ensure extension .pdf or .md
            if (file.mimetype === 'application/octet-stream') {
                const lower = String(file.originalname || '').toLowerCase();
                if (lower.endsWith('.pdf') || lower.endsWith('.md') || lower.endsWith('.txt')) {
                    return cb(null, true);
                }
            }
            const error = new Error('Unsupported file type for GDPR material upload');
            error.statusCode = 415;
            return cb(error);
        } catch (err) {
            return cb(err || new Error('Upload failed'));
        }
    }
});
// Ensure templates dir exists for DOCX builder (python script writes template if missing)
try { fs.mkdirSync(path.join(__dirname, 'templates'), { recursive: true }); } catch {}
// Ensure persistent data dir exists BEFORE session + DB init
try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch {}

// Initialize SQLite and sessions
console.log('[Server] Starting SQLite initialization...');
console.log('[Server] Current directory:', __dirname);
console.log('[Server] Data directory:', path.join(__dirname, 'data'));
try { 
    initDb(); 
    // Update sqliteDb reference after initialization
    if (sqliteModule) {
        sqliteDb = sqliteModule.db;
    }
    // Prime a trivial statement to ensure better-sqlite3 loads and DB file is touchable
    const sqlite = require('./db/sqlite');
    try { if (sqlite && sqlite.db && sqlite.db.prepare) sqlite.db.prepare('SELECT 1').get(); } catch {}
    console.log('[Server] SQLite initialized successfully');
} catch (e) { 
    console.error('[Server] SQLite init failed:', e.message);
    console.error('[Server] Full error:', e);
}

// Session setup with error handling
let sessionStore = undefined;
try {
    if (SQLiteStore) {
        console.log('[Server] Setting up SQLite session store...');
        sessionStore = SQLiteStore.length === 1
        ? new SQLiteStore({ 
            db: (process.env.SESSION_DB || 'sessions.sqlite'), 
            dir: process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, 'data') 
          })
            : new SQLiteStore({ client: sqliteDb, cleanupInterval: 900000 });
        console.log('[Server] SQLite session store created successfully');
    }
} catch (e) {
    console.error('[Server] Failed to create SQLite session store:', e.message);
    console.error('[Server] Continuing with MemoryStore (sessions will not persist)');
    sessionStore = undefined;
}

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: Number(process.env.SESSION_MAX_AGE_MS || 1000*60*60*24*7),
        secure: isProduction,
        sameSite: 'lax'
    }
}));

// Reuse TCP connections for speed
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.httpAgent = keepAliveHttpAgent;
axios.defaults.httpsAgent = keepAliveHttpsAgent;
axios.defaults.timeout = 30000;

// Ensure Python deps (python-docx, lxml) are available at runtime
let pythonDepsReadyPromise = null;
function ensurePythonDeps() {
    if (pythonDepsReadyPromise) return pythonDepsReadyPromise;
    pythonDepsReadyPromise = new Promise((resolve) => {
        const python = process.env.PYTHON_BIN || 'python3';
        const localPy = path.join(__dirname, 'python_packages');
        const mergedPyPath = [localPy, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const env = { ...process.env, PYTHONPATH: mergedPyPath };
        const testCmd = [ '-c', 'import sys; sys.path.insert(0, "' + localPy.replace(/"/g, '\\"') + '"); import docx; from lxml import etree; import fitz; print("ok")' ];
        try {
            const test = spawn(python, testCmd, { stdio: ['ignore','pipe','pipe'], env });
            let out = '';
            let err = '';
            test.stdout.on('data', d => { out += d.toString(); });
            test.stderr.on('data', d => { err += d.toString(); });
            test.on('close', (code) => {
                if (code === 0 && /ok/.test(out)) {
                    resolve(true);
                } else {
                    // Attempt runtime install using pinned requirements
                    const reqPath = path.join(__dirname, 'requirements.txt');
                    const target = path.join(__dirname, 'python_packages');
                    try { fs.mkdirSync(target, { recursive: true }); } catch {}
                    // Remove possibly ABI-mismatched installs from build stage
                    try {
                        const rmIfExists = (p) => { try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
                        rmIfExists(path.join(target, 'lxml'));
                        for (const name of fs.readdirSync(target)) {
                            if (/^lxml-.*\.dist-info$/i.test(name)) rmIfExists(path.join(target, name));
                        }
                    } catch (_) {}
                    const args = ['-m', 'pip', 'install', '--no-cache-dir', '--no-warn-script-location', '--upgrade', '--force-reinstall', '--prefer-binary', '--only-binary', ':all:', '--target', target, '-r', reqPath];
                    const pip = spawn(python, args, { stdio: ['ignore','pipe','pipe'], env });
                    let pipErr = '';
                    pip.stderr.on('data', d => { pipErr += d.toString(); });
                    pip.on('close', () => {
                        // Re-test regardless of pip exit code; wheels may have been present already
                        const test2 = spawn(python, testCmd, { stdio: ['ignore','pipe','pipe'], env });
                        let out2 = '';
                        test2.stdout.on('data', d => { out2 += d.toString(); });
                        test2.on('close', (code2) => {
                            if (code2 === 0 && /ok/.test(out2)) {
                                resolve(true);
                            } else {
                                // Final fallback: try older lxml compatible on wider Python versions
                                const fbArgs = ['-m','pip','install','--no-cache-dir','--no-warn-script-location','--upgrade','--prefer-binary','--only-binary',':all:','--target', target, 'python-docx>=1.2.0', 'lxml<5', 'Pillow>=8.4.0', 'PyMuPDF>=1.24.5'];
                                const pipFb = spawn(python, fbArgs, { stdio: ['ignore','pipe','pipe'], env });
                                pipFb.on('close', () => {
                                    const test3 = spawn(python, testCmd, { stdio: ['ignore','pipe','pipe'], env });
                                    let out3 = '';
                                    test3.stdout.on('data', d => { out3 += d.toString(); });
                                    test3.on('close', (code3) => {
                                        if (code3 === 0 && /ok/.test(out3)) resolve(true);
                                        else resolve(false);
                                    });
                                });
                            }
                        });
                    });
                }
            });
        } catch (_) {
            resolve(false);
        }
    });
    return pythonDepsReadyPromise;
}

// Lightweight in-memory caches (TTL-based) to avoid refetching same hearing repeatedly
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000); // 2 minutes default
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 100);

const hearingAggregateCache = new Map(); // key: hearingId -> { value, expiresAt }
const hearingResponsesCache = new Map(); // key: hearingId -> { value, expiresAt }
const hearingMaterialsCache = new Map(); // key: hearingId -> { value, expiresAt }

// Optional persistent disk cache to speed up mock/demo and reduce repeated network traffic
const PERSIST_DIR = (() => {
    try {
        const envDir = String(process.env.PERSIST_DIR || '').trim();
        if (envDir && path.isAbsolute(envDir) && fs.existsSync(envDir)) return envDir;
    } catch {}
    return path.join(__dirname, 'data');
})();
try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(path.join(PERSIST_DIR, 'hearings'), { recursive: true }); } catch {}
// Prefer persisted JSON reads by default when available (helps offline mode)
const PERSIST_PREFER = String(process.env.PERSIST_PREFER || 'true').toLowerCase() !== 'false';
const OFFLINE_MODE = String(process.env.OFFLINE_MODE || '').toLowerCase() === 'true';
const PERSIST_ALWAYS_WRITE = String(process.env.PERSIST_ALWAYS_WRITE || 'true').toLowerCase() !== 'false';
const PERSIST_MAX_AGE_MS = Number(process.env.PERSIST_MAX_AGE_MS || 0); // 0 disables TTL (never stale)

function getPersistPathForHearing(hearingId) {
    return path.join(PERSIST_DIR, 'hearings', `${hearingId}.json`);
}
function readPersistedHearing(hearingId) {
    try {
        const p = getPersistPathForHearing(hearingId);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        return json && typeof json === 'object' ? json : null;
    } catch {
        return null;
    }
}
function writePersistedHearing(hearingId, payload) {
    try {
        const p = getPersistPathForHearing(hearingId);
        const toWrite = { updatedAt: new Date().toISOString(), ...payload };
        fs.writeFileSync(p, JSON.stringify(toWrite, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}
function mergePersistMaterials(existing, materials) {
    if (!materials || !Array.isArray(materials)) return existing || null;
    const base = existing && typeof existing === 'object' ? existing : {};
    const out = { ...base };
    out.materials = materials;
    return out;
}

function readPersistedHearingWithMeta(hearingId) {
    try {
        const p = getPersistPathForHearing(hearingId);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        const updatedAt = (json && json.updatedAt) ? Date.parse(json.updatedAt) : null;
        const stat = fs.statSync(p);
        const updatedAtMs = Number.isFinite(updatedAt) ? updatedAt : stat.mtimeMs;
        return { data: json, updatedAtMs };
    } catch {
        return null;
    }
}

function isPersistStale(meta) {
    try {
        if (!meta || typeof meta.updatedAtMs !== 'number') return true;
        if (!Number.isFinite(PERSIST_MAX_AGE_MS) || PERSIST_MAX_AGE_MS <= 0) return false; // TTL disabled
        return (Date.now() - meta.updatedAtMs) > PERSIST_MAX_AGE_MS;
    } catch { return false; }
}

function mergeResponsesPreferLongerText(a, b) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    if (arrA.length === 0) return arrB;
    if (arrB.length === 0) return arrA;
    if (arrA.length > arrB.length) return arrA;
    if (arrB.length > arrA.length) return arrB;
    // Same count: merge by id, prefer longer text and union attachments
    const byId = new Map();
    for (const r of arrA) byId.set(Number(r.id || r.responseNumber), r);
    for (const r of arrB) {
        const id = Number(r.id || r.responseNumber);
        const ex = byId.get(id);
        if (!ex) { byId.set(id, r); continue; }
        const exLen = (ex.text || '').length;
        const rLen = (r.text || '').length;
        const winner = rLen > exLen ? r : ex;
        // merge attachments
        const attA = Array.isArray(ex.attachments) ? ex.attachments : [];
        const attB = Array.isArray(r.attachments) ? r.attachments : [];
        const seen = new Set();
        const mergedAtts = [];
        for (const aItem of [...attA, ...attB]) {
            const key = `${aItem.filename || ''}|${aItem.url || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            mergedAtts.push(aItem);
        }
        byId.set(id, { ...winner, attachments: mergedAtts });
    }
    return Array.from(byId.values()).sort((x, y) => (x.id || 0) - (y.id || 0));
}

function mergePersistPayload(existing, incoming) {
    const base = existing && typeof existing === 'object' ? existing : {};
    const inc = incoming && typeof incoming === 'object' ? incoming : {};
    const out = { ...base, ...inc };
    // Merge hearing meta conservatively
    out.hearing = { ...(base.hearing || {}), ...(inc.hearing || {}) };
    // Best responses
    out.responses = mergeResponsesPreferLongerText(base.responses, inc.responses);
    out.totalResponses = Array.isArray(out.responses) ? out.responses.length : (inc.totalResponses || base.totalResponses || 0);
    // Best totalPages (max)
    out.totalPages = Math.max(Number(base.totalPages || 0), Number(inc.totalPages || 0)) || undefined;
    // Materials: prefer the incoming if present
    if (!Array.isArray(inc.materials) || inc.materials.length === 0) out.materials = base.materials || [];
    // Always success if either was successful
    out.success = (base.success || inc.success) ? true : false;
    return out;
}

// =============================
// Background Jobs Service (SQLite-backed + in-memory)
// =============================

const DEFAULT_VARIANTS = Number(process.env.DEFAULT_SUMMARY_VARIANTS || 3);
const JOB_RECOMMENDED_POLL_MS = Number(process.env.JOB_RECOMMENDED_POLL_MS || 3000);
const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 5000);
const SESSION_JOB_LIMIT = Number(process.env.SESSION_JOB_LIMIT || 2);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 72*60*60*1000);

const activeJobControllers = new Map(); // jobId -> { cancelled: boolean }
const jobEventsCache = new Map(); // jobId -> ring buffer (array) of recent events
const jobSessionIndex = new Map(); // jobId -> sessionKey
const sessionActiveJobs = new Map(); // sessionKey -> count
const runningJobs = new Set(); // jobId -> prevent duplicate runJob calls

function getSessionKey(req) {
    try {
        const sid = req?.sessionID || req?.session?.id;
        if (sid) return `sid:${sid}`;
    } catch {}
    try {
        const ip = (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown').toString();
        return `ip:${ip}`;
    } catch {}
    return 'ip:unknown';
}

function stableStringify(obj) {
    const seen = new WeakSet();
    function sortValue(v) {
        if (v && typeof v === 'object') {
            if (seen.has(v)) return null;
            seen.add(v);
            if (Array.isArray(v)) return v.map(sortValue);
            const out = {};
            Object.keys(v).sort().forEach(k => { out[k] = sortValue(v[k]); });
            return out;
        }
        return v;
    }
    try { return JSON.stringify(sortValue(obj)); } catch { return JSON.stringify({}); }
}

function sha1Hex(s) {
    try { return crypto.createHash('sha1').update(String(s||''), 'utf8').digest('hex'); } catch { return null; }
}

function nowMs() { return Date.now(); }

function recordSessionJobStart(req, jobId) {
    const key = getSessionKey(req);
    jobSessionIndex.set(jobId, key);
    const n = sessionActiveJobs.get(key) || 0;
    sessionActiveJobs.set(key, n + 1);
}

function recordSessionJobEnd(jobId) {
    const key = jobSessionIndex.get(jobId);
    if (!key) return;
    const n = sessionActiveJobs.get(key) || 0;
    sessionActiveJobs.set(key, Math.max(0, n - 1));
    jobSessionIndex.delete(jobId);
}

function canStartAnotherJob(req) {
    const key = getSessionKey(req);
    const n = sessionActiveJobs.get(key) || 0;
    return n < SESSION_JOB_LIMIT;
}

function appendEvent(jobId, level, message, data) {
    try {
        const ts = nowMs();
        sqliteDb && sqliteDb.prepare && sqliteDb.prepare(`INSERT INTO job_events(job_id, ts, level, message, data_json) VALUES (?,?,?,?,?)`) 
            .run(jobId, ts, level || 'info', String(message || ''), data ? JSON.stringify(data) : null);
    } catch {}
    try {
        const arr = jobEventsCache.get(jobId) || [];
        arr.push({ ts: nowMs(), level: level || 'info', message: String(message||''), data: data || null });
        while (arr.length > 50) arr.shift();
        jobEventsCache.set(jobId, arr);
    } catch {}
    try { console.log(`[job:${jobId}] ${level||'info'}: ${message}`); } catch {}
}

function updateJob(jobId, patch) {
    try {
        const now = nowMs();
        const keys = ['state','phase','progress'];
        const cur = sqliteDb.prepare(`SELECT state,phase,progress FROM jobs WHERE job_id=?`).get(jobId) || {};
        const next = { ...cur, ...patch };
        sqliteDb.prepare(`UPDATE jobs SET state=?, phase=?, progress=?, updated_at=? WHERE job_id=?`) 
            .run(next.state || null, next.phase || null, Number.isFinite(next.progress) ? next.progress : cur.progress || 0, now, jobId);
    } catch (e) { /* ignore */ }
}

function updateVariant(jobId, variant, patch) {
    try {
        const now = nowMs();
        const cur = sqliteDb.prepare(`SELECT state,phase,progress,response_id,markdown,summary,headings_json,partial_chars,error FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, variant) || {};
        const next = { ...cur, ...patch };
        sqliteDb.prepare(`UPDATE job_variants SET state=?, phase=?, progress=?, response_id=?, markdown=?, summary=?, headings_json=?, partial_chars=?, error=?, updated_at=? WHERE job_id=? AND variant=?`)
            .run(next.state || null, next.phase || null, Number.isFinite(next.progress) ? next.progress : (cur.progress || 0), next.response_id || cur.response_id || null, next.markdown || cur.markdown || null, next.summary || cur.summary || null, next.headings_json || cur.headings_json || null, Number.isFinite(next.partial_chars) ? next.partial_chars : (cur.partial_chars || 0), next.error || cur.error || null, now, jobId, variant);
    } catch {}
}

function getJobSnapshot(jobId) {
    try {
        const job = sqliteDb.prepare(`SELECT job_id, hearing_id, state, phase, progress, created_at, updated_at FROM jobs WHERE job_id=?`).get(jobId);
        if (!job) return null;
        const vars = sqliteDb.prepare(`SELECT variant as id, state, phase, progress, response_id as responseId, markdown, summary, headings_json as headingsJson, partial_chars as partialChars, error FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(jobId);
        const variants = vars.map(v => ({ id: v.id, state: v.state, phase: v.phase, progress: v.progress || 0, responseId: v.responseId || null, done: v.state === 'completed', error: v.error || null, partialChars: v.partialChars || 0, hasResult: !!(v.markdown && v.markdown.length) }));
        let errors = [];
        try {
            const ev = sqliteDb.prepare(`SELECT message FROM job_events WHERE job_id=? AND level='error' ORDER BY ts DESC LIMIT 5`).all(jobId);
            errors = (ev||[]).map(e => ({ message: e.message }));
        } catch {}
        return {
            jobId: job.job_id,
            hearingId: job.hearing_id,
            state: job.state,
            phase: job.phase,
            progress: job.progress || 0,
            variants,
            errors: errors.length ? errors : undefined,
            createdAt: job.created_at,
            updatedAt: job.updated_at
        };
    } catch {
        return null;
    }
}

async function createJob(req, hearingId, payload) {
    if (!sqliteDb || !sqliteDb.prepare) {
        return { error: 'Database unavailable', status: 503 };
    }
    const n = Math.max(1, Math.min(Number(req.query.n || (payload && payload.n) || DEFAULT_VARIANTS) || DEFAULT_VARIANTS, 5));
    if (!canStartAnotherJob(req)) {
        return { error: 'Too many concurrent jobs', status: 429 };
    }
    
    // CRITICAL: Check if there's already an active job for this hearing that hasn't completed
    // This prevents duplicate prompts when user clicks "Generate" multiple times
    try {
        const existingActive = sqliteDb.prepare(`
            SELECT job_id, state, created_at, input_hash
            FROM jobs 
            WHERE hearing_id=? AND state NOT IN ('completed', 'failed', 'cancelled')
            ORDER BY created_at DESC 
            LIMIT 1
        `).get(Number(hearingId));
        
        if (existingActive) {
            // CRITICAL: Check if variants already have completed results in database
            const variants = sqliteDb.prepare(`SELECT variant, state, markdown FROM job_variants WHERE job_id=?`).all(existingActive.job_id);
            const allCompleted = variants.every(v => v.state === 'completed' && v.markdown);
            
            if (allCompleted) {
                console.log(`[createJob] Found existing job ${existingActive.job_id} for hearing ${hearingId} with ALL variants completed in database`);
                console.log(`[createJob] Completed variants:`, variants.map(v => ({ variant: v.variant, state: v.state, hasMarkdown: !!v.markdown })));
                // Mark job as completed if not already
                if (existingActive.state !== 'completed') {
                    console.log(`[createJob] Marking job ${existingActive.job_id} as completed since all variants are done`);
                    updateJob(existingActive.job_id, { state: 'completed', phase: 'completed', progress: 100 });
                }
                // Don't reuse completed jobs - they should be excluded by SQL query
                // But if they somehow slip through, return them anyway since they're done
                return { jobId: existingActive.job_id, reused: true, alreadyCompleted: true };
            }
            
            // CRITICAL: Check if this job is currently running
            if (runningJobs.has(existingActive.job_id)) {
                console.log(`[createJob] Job ${existingActive.job_id} is already running for hearing ${hearingId}, reusing instead of creating new`);
                const runningVariants = sqliteDb.prepare(`SELECT variant, response_id FROM job_variants WHERE job_id=?`).all(existingActive.job_id);
                console.log(`[createJob] Response IDs for running job ${existingActive.job_id}:`, runningVariants.map(v => ({ variant: v.variant, response_id: v.response_id })));
                return { jobId: existingActive.job_id, reused: true };
            }
            
            // CRITICAL: Check if variants already have response_ids (prompts already sent)
            const existingVariants = sqliteDb.prepare(`SELECT variant, response_id FROM job_variants WHERE job_id=?`).all(existingActive.job_id);
            const hasResponseIds = existingVariants.some(v => v.response_id);
            
            // CRITICAL: If structured output is enabled and job is older than 5 minutes, don't reuse
            // This ensures we use the new JSON schema structure
            const jobAge = Date.now() - (existingActive.created_at || 0);
            const RECENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
            if (USE_STRUCTURED_OUTPUT && jobAge > RECENT_THRESHOLD_MS) {
                console.log(`[createJob] Job ${existingActive.job_id} is older than 5 minutes and structured output is enabled, cancelling to ensure new structure`);
                cancelJob(existingActive.job_id);
                // Continue to create new job below
            } else if (hasResponseIds) {
                // CRITICAL: Verify that response_ids actually exist in OpenAI before reusing
                let allValid = true;
                for (const v of existingVariants) {
                    if (v.response_id) {
                        try {
                            const testResponse = await openai.responses.retrieve(v.response_id);
                            const testStatus = testResponse?.status || testResponse?.state || '';
                            // Incomplete responses (e.g., due to max_output_tokens) should NOT be reused
                            // We need to create new prompts to get complete results
                            if (!testStatus || /failed|cancelled|expired|incomplete/i.test(testStatus)) {
                                console.log(`[createJob] Variant ${v.variant} response_id ${v.response_id} is invalid/incomplete (status: ${testStatus}), will create new`);
                                allValid = false;
                                break;
                            }
                        } catch (verifyErr) {
                            const errMsg = verifyErr?.response?.data?.error?.message || verifyErr?.message || String(verifyErr);
                            if (verifyErr?.response?.status === 404 || errMsg.includes('not found') || errMsg.includes('does not exist')) {
                                console.log(`[createJob] Variant ${v.variant} response_id ${v.response_id} does not exist in OpenAI, will create new`);
                                allValid = false;
                                break;
                            } else {
                                console.warn(`[createJob] Error verifying response_id ${v.response_id}:`, errMsg);
                                // On error, assume invalid to be safe
                                allValid = false;
                                break;
                            }
                        }
                    }
                }
                
                if (allValid) {
                    console.log(`[createJob] Found existing active job ${existingActive.job_id} for hearing ${hearingId} with valid response_ids, reusing instead of creating new`);
                    console.log(`[createJob] Response IDs for job ${existingActive.job_id}:`, existingVariants.map(v => ({ variant: v.variant, response_id: v.response_id })));
                    return { jobId: existingActive.job_id, reused: true };
                } else {
                    console.log(`[createJob] Found existing active job ${existingActive.job_id} for hearing ${hearingId} with invalid/expired response_ids, cancelling and creating new`);
                    cancelJob(existingActive.job_id);
                }
            } else {
                // Job exists but no prompts sent yet - cancel it and create new
                console.log(`[createJob] Found existing active job ${existingActive.job_id} for hearing ${hearingId} without response_ids, cancelling and creating new`);
                cancelJob(existingActive.job_id);
            }
        }
    } catch (e) {
        console.warn(`[createJob] Error checking for existing jobs:`, e.message);
    }
    
    const idemp = req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || null;
    const input = { hearingId, n, hearing: payload?.hearing || null, responses: payload?.responses || null, materials: payload?.materials || null, edits: payload?.edits || null };
    const inputHash = sha1Hex(stableStringify(input));
    
    // CRITICAL: Check if there's a job with the same input_hash that's still active
    // This prevents duplicate prompts when input is identical
    try {
        const sameInputJob = sqliteDb.prepare(`
            SELECT job_id, state, created_at 
            FROM jobs 
            WHERE hearing_id=? AND input_hash=? AND state NOT IN ('completed', 'failed', 'cancelled')
            ORDER BY created_at DESC 
            LIMIT 1
        `).get(Number(hearingId), inputHash);
        
        if (sameInputJob) {
            console.log(`[createJob] Found existing job ${sameInputJob.job_id} for hearing ${hearingId} with identical input_hash, reusing to prevent duplicate prompts`);
            // CRITICAL: If structured output is enabled, don't reuse old jobs that might have been created without it
            // Check if the job was created recently (within last 5 minutes) - if older, cancel and create new
            const jobAge = Date.now() - (sameInputJob.created_at || 0);
            const RECENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
            if (USE_STRUCTURED_OUTPUT && jobAge > RECENT_THRESHOLD_MS) {
                console.log(`[createJob] Job ${sameInputJob.job_id} is older than 5 minutes and structured output is enabled, cancelling old job to ensure new structure`);
                cancelJob(sameInputJob.job_id);
            } else {
                return { jobId: sameInputJob.job_id, reused: true, reason: 'identical_input' };
            }
        }
    } catch (e) {
        console.warn(`[createJob] Error checking for same input_hash:`, e.message);
    }

    try {
        if (idemp) {
            const existing = sqliteDb.prepare(`SELECT job_id, input_hash FROM jobs WHERE idempotency_key=?`).get(idemp);
            if (existing) {
                if (existing.input_hash === inputHash) {
                    appendEvent(existing.job_id, 'info', 'Idempotent reuse of existing job');
                    return { jobId: existing.job_id, reused: true };
                }
                return { error: 'Idempotency key already used for different input', status: 409 };
            }
        }
    } catch {}

    const jobId = `job_${crypto.randomUUID ? crypto.randomUUID() : sha1Hex(String(Math.random()))}`;
    const now = nowMs();
    try {
        const hearingIdNum = /^\d+$/.test(String(hearingId)) ? Number(hearingId) : null;
        sqliteDb.prepare(`INSERT INTO jobs(job_id, hearing_id, state, phase, progress, created_at, updated_at, idempotency_key, input_hash) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(jobId, hearingIdNum, 'queued', 'queued', 0, now, now, idemp || null, inputHash || null);
        const insVar = sqliteDb.prepare(`INSERT INTO job_variants(job_id, variant, state, phase, progress, updated_at) VALUES (?,?,?,?,?,?)`);
        for (let i = 1; i <= n; i++) insVar.run(jobId, i, 'queued', 'queued', 0, now);
    } catch (e) {
        return { error: `DB insert failed: ${e && e.message ? e.message : String(e)}`, status: 500 };
    }

    appendEvent(jobId, 'info', 'Job created', { hearingId, n });
    activeJobControllers.set(jobId, { cancelled: false });
    recordSessionJobStart(req, jobId);
    console.log(`[createJob] Created job ${jobId} for hearing ${hearingId}, starting runJob...`);
    // Fire-and-forget runner
    runJob(jobId, hearingId, input).catch(err => {
        console.error(`[createJob] runJob crashed for ${jobId}:`, err);
        appendEvent(jobId, 'error', `Runner crashed: ${err?.message || err}`);
        updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
        recordSessionJobEnd(jobId);
        runningJobs.delete(jobId);
    });
    console.log(`[createJob] runJob called for ${jobId}, function should be running now`);
    return { jobId };
}

function getSummaryJSONSchema() {
    return {
        type: 'json_schema',
        json_schema: {
            name: 'hearing_summary',
            strict: true,
            schema: {
                type: 'object',
                properties: {
                    considerations: {
                        type: 'string',
                        description: 'Generelle overvejelser om opsummeringen (skal altid være til stede, placeres som kommentar på første tema-titel i markdown)'
                    },
                    topics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: {
                                    type: 'string',
                                    description: 'Tema-navn fra høringsmaterialet'
                                },
                                positions: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            title: {
                                                type: 'string',
                                                description: 'Holdningens navn med konsekvens/retning, f.eks. "(2, LU) Ønske om..."'
                                            },
                                            responseNumbers: {
                                                type: 'array',
                                                items: { type: 'number' },
                                                description: 'Liste af svarnumre for denne holdning'
                                            },
                                            summary: {
                                                type: 'string',
                                                description: 'Brødtekst med opsummering af holdningen uden citater. Skal ikke indeholde konkrete referencer til høringsmateriale eller respondentopdeling - disse skal være i materialReferences og respondentBreakdown i stedet.'
                                            },
                                            materialReferences: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        type: {
                                                            type: 'string',
                                                            enum: ['paragraph', 'drawing', 'proposal', 'section', 'other'],
                                                            description: 'Type af reference: paragraph (paragraf), drawing (tegning), proposal (forslag), section (afsnit), eller other'
                                                        },
                                                        reference: {
                                                            type: 'string',
                                                            description: 'Den konkrete reference, f.eks. "§ 7, stk. 1c" eller "Tegning 3.2"'
                                                        },
                                                        context: {
                                                            type: 'string',
                                                            description: 'Kort kontekst for hvad der refereres til, f.eks. "mørkegrønne metalplader". Tom streng hvis ingen kontekst.'
                                                        }
                                                    },
                                                    required: ['type', 'reference', 'context'],
                                                    additionalProperties: false
                                                },
                                                description: 'Konkrete referencer til høringsmaterialet (paragrafer, tegninger, forslag) der kritiseres eller støttes. Tomt array hvis ingen specifikke referencer.'
                                            },
                                            respondentBreakdown: {
                                                type: 'object',
                                                properties: {
                                                    localCommittees: {
                                                        type: 'array',
                                                        items: { type: 'string' },
                                                        description: 'Navne på lokaludvalg, f.eks. ["Nørrebro Lokaludvalg"]',
                                                        default: []
                                                    },
                                                    publicAuthorities: {
                                                        type: 'array',
                                                        items: { type: 'string' },
                                                        description: 'Navne på offentlige myndigheder, f.eks. ["Teknik- og Miljøforvaltningen"]',
                                                        default: []
                                                    },
                                                    organizations: {
                                                        type: 'array',
                                                        items: { type: 'string' },
                                                        description: 'Navne på organisationer eller virksomheder',
                                                        default: []
                                                    },
                                                    citizens: {
                                                        type: 'number',
                                                        description: 'Antal borgere (kun brug dette hvis de alle hedder "Borger" i respondentnavnet)',
                                                        default: 0
                                                    },
                                                    total: {
                                                        type: 'number',
                                                        description: 'Samlet antal respondenter'
                                                    }
                                                },
                                                required: ['total', 'localCommittees', 'publicAuthorities', 'organizations', 'citizens'],
                                                additionalProperties: false,
                                                description: 'Struktureret opdeling af respondenter. Skal matche antal i responseNumbers array.'
                                            },
                                            citations: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        highlight: {
                                                            type: 'string',
                                                            description: 'Den korte reference der faktisk skal markeres i brødteksten (fx "Flere borgere", "tre borgere", "Nørrebro Lokaludvalg"). Dette er den tekst der vil blive markeret med CriticMarkup.'
                                                        },
                                                        highlightContextual: {
                                                            type: 'string',
                                                            description: 'Den kontekstuelle streng der identificerer præcist hvor citatet skal placeres i summary. Skal være unik og optræde kun én gang i summary. Starter typisk med highlight og udvides med kontekst (fx "Flere borgere bekymrer sig om trafikken"). Bruges til at finde den præcise placering i summary teksten.'
                                                        },
                                                        comment: {
                                                            type: 'string',
                                                            description: 'Citat med format: **Henvendelse X**\\n*"citattekst"*. Citatet placeres inline ved highlight med formatet {==highlight==}{>>comment<<}'
                                                        }
                                                    },
                                                    required: ['highlight', 'highlightContextual', 'comment'],
                                                    additionalProperties: false
                                                },
                                                description: 'Citater der skal indlejres i brødteksten'
                                            }
                                        },
                                        required: ['title', 'responseNumbers', 'summary', 'citations', 'materialReferences', 'respondentBreakdown'],
                                        additionalProperties: false
                                    }
                                }
                            },
                            required: ['name', 'positions'], // Removed considerations - now at root level
                            additionalProperties: false
                        }
                    }
                },
                required: ['topics', 'considerations'], // considerations is now required at root level
                additionalProperties: false
            }
        }
    };
}

function getCitationSearchTool(hearingId) {
    // Define tool for searching exact citations in vector store
    // This reduces hallucination by retrieving exact quotes from source material
    return {
        type: 'function',
        name: 'search_citation',
        description: 'Søger efter eksakte citater fra høringssvarene i vector store. Brug denne tool til at hente præcise citater baseret på svarnummer og søgequery. Citaterne kommer direkte fra kilden og reducerer risikoen for hallucination.',
        parameters: {
            type: 'object',
            properties: {
                responseNumber: {
                    type: 'number',
                    description: 'Svarnummeret for høringssvaret der skal citeres fra (fx 5, 12, 23)'
                },
                query: {
                    type: 'string',
                    description: 'Søgequery der beskriver det citat der søges efter. Brug kontekstuelle termer fra opsummeringen (fx "bekymrer sig om trafikken" eller "ønsker bedre cykelstier").'
                },
                maxLength: {
                    type: 'number',
                    description: 'Maksimal længde af citatet i karakterer. Standard er 500. Brug højere værdi (fx 1000) for længere argumenter.'
                }
            },
            required: ['responseNumber', 'query', 'maxLength'],
            additionalProperties: false
        },
        strict: true
    };
}

async function handleCitationSearchToolCall(toolCall, hearingId) {
    // Handle search_citation tool call by querying vector store
    try {
        const args = toolCall.function?.arguments || {};
        const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
        const responseNumber = Number(parsedArgs.responseNumber);
        const query = String(parsedArgs.query || '').trim();
        const maxLength = Number(parsedArgs.maxLength) || 500;
        
        if (!Number.isFinite(responseNumber) || !query) {
            return JSON.stringify({ error: 'responseNumber og query er påkrævet' });
        }
        
        console.log(`[handleCitationSearchToolCall] Searching for citation: responseNumber=${responseNumber}, query="${query}", maxLength=${maxLength}`);
        
        // Query vector store for chunks matching this response number and query
        const chunks = listVectorChunks(Number(hearingId));
        if (!chunks || chunks.length === 0) {
            console.warn(`[handleCitationSearchToolCall] No vector chunks found for hearing ${hearingId}`);
            return JSON.stringify({ error: 'Vector store ikke tilgængelig' });
        }
        
        // Filter chunks by source (should contain response number)
        const responseSource = `response_${responseNumber}`;
        const relevantChunks = chunks.filter(chunk => 
            chunk.source && (
                chunk.source.includes(String(responseNumber)) || 
                chunk.source === responseSource ||
                chunk.source.includes(`svarnummer_${responseNumber}`)
            )
        );
        
        if (relevantChunks.length === 0) {
            // Try semantic search with query + response number
            const searchQuery = `${query} svarnummer ${responseNumber}`;
            const results = await queryLocalVectorStore(Number(hearingId), searchQuery, 5, VECTOR_SEARCH_MIN_SCORE);
            
            // Filter results by response number
            const filteredResults = results.filter(r => {
                const source = String(r.source || '').toLowerCase();
                return source.includes(String(responseNumber)) || 
                       source.includes(`svarnummer_${responseNumber}`) ||
                       source.includes(`response_${responseNumber}`);
            });
            
            if (filteredResults.length > 0) {
                // Return the most relevant chunk content
                const bestMatch = filteredResults[0];
                let citation = String(bestMatch.content || '').trim();
                
                // Truncate if too long
                if (citation.length > maxLength) {
                    // Try to truncate at sentence boundary
                    const truncated = citation.slice(0, maxLength);
                    const lastPeriod = truncated.lastIndexOf('.');
                    const lastExclamation = truncated.lastIndexOf('!');
                    const lastQuestion = truncated.lastIndexOf('?');
                    const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
                    if (lastSentenceEnd > maxLength * 0.7) {
                        citation = truncated.slice(0, lastSentenceEnd + 1);
                    } else {
                        citation = truncated + '...';
                    }
                }
                
                return JSON.stringify({ 
                    citation: citation,
                    source: bestMatch.source,
                    score: bestMatch.score
                });
            }
            
            return JSON.stringify({ error: `Ingen citater fundet for svarnummer ${responseNumber} med query "${query}"` });
        }
        
        // Use semantic search to find best matching chunk
        const searchResults = await queryLocalVectorStore(Number(hearingId), query, 10, VECTOR_SEARCH_MIN_SCORE);
        const bestMatch = searchResults.find(r => {
            const source = String(r.source || '').toLowerCase();
            return source.includes(String(responseNumber)) || 
                   source.includes(`svarnummer_${responseNumber}`) ||
                   source.includes(`response_${responseNumber}`);
        });
        
        if (bestMatch) {
            let citation = String(bestMatch.content || '').trim();
            
            // Truncate if too long
            if (citation.length > maxLength) {
                const truncated = citation.slice(0, maxLength);
                const lastPeriod = truncated.lastIndexOf('.');
                const lastExclamation = truncated.lastIndexOf('!');
                const lastQuestion = truncated.lastIndexOf('?');
                const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
                if (lastSentenceEnd > maxLength * 0.7) {
                    citation = truncated.slice(0, lastSentenceEnd + 1);
                } else {
                    citation = truncated + '...';
                }
            }
            
            return JSON.stringify({ 
                citation: citation,
                source: bestMatch.source,
                score: bestMatch.score
            });
        }
        
        // Fallback: return first relevant chunk
        const firstChunk = relevantChunks[0];
        let citation = String(firstChunk.content || '').trim();
        if (citation.length > maxLength) {
            citation = citation.slice(0, maxLength) + '...';
        }
        
        return JSON.stringify({ 
            citation: citation,
            source: firstChunk.source,
            score: null,
            note: 'Fundet via chunk matching, ikke semantic search'
        });
        
    } catch (err) {
        console.error('[handleCitationSearchToolCall] Error:', err);
        return JSON.stringify({ error: `Fejl ved søgning: ${err.message}` });
    }
}

function getModelParams(userPrompt, systemPrompt, useStructuredOutput = false, hearingId = null) {
    const model = MODEL_ID;
    const params = {
        model,
        input: [
            { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
            { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
        ]
    };
    const isReasoningModel = /^(gpt-5|o3|o4)/i.test(model);
    if (!isReasoningModel && Number.isFinite(TEMPERATURE)) params.temperature = TEMPERATURE;
    // For background jobs with long prompts, don't set max_output_tokens to avoid truncation
    // Only set it if explicitly requested and reasonable (> 100000)
    if (Number.isFinite(MAX_TOKENS) && MAX_TOKENS > 0 && MAX_TOKENS > 100000) {
        params.max_output_tokens = MAX_TOKENS;
    } else if (!Number.isFinite(MAX_TOKENS) || MAX_TOKENS === null) {
        // Don't set max_output_tokens at all - let OpenAI handle it
        // This is especially important for long prompts that need full output
    }
    if (/^gpt-5/i.test(model) && VERBOSITY_ENV) params.text = { ...(params.text || {}), verbosity: VERBOSITY_ENV };
    if ((/^(gpt-5|o3|o4)/i).test(model) && REASONING_EFFORT_ENV) params.reasoning = { ...(params.reasoning || {}), effort: REASONING_EFFORT_ENV };
    
    // Enable parallel tool calls for models that support it (gpt-5, o3, o4)
    // Tool calls are always available as an option - model can use them if needed
    const supportsToolCalls = /^(gpt-5|o3|o4|gpt-4o)/i.test(model);
    if (supportsToolCalls) {
        params.parallel_tool_calls = true;
        // Add citation search tool if hearingId is provided
        if (hearingId && Number.isFinite(Number(hearingId))) {
            params.tools = [getCitationSearchTool(Number(hearingId))];
            console.log(`[getModelParams] Added search_citation tool for hearing ${hearingId}`);
        }
    }
    
    // Add structured output if requested
    if (useStructuredOutput) {
        // Check if model supports structured output (gpt-4o-2024-08-06 or newer)
        const supportsStructuredOutput = /^(gpt-4o|gpt-5|o3|o4)/i.test(model);
        if (supportsStructuredOutput) {
            // In Responses API, response_format is moved to text.format
            // Based on error messages, format should have: type, name, and schema directly
            const schemaConfig = getSummaryJSONSchema();
            params.text = params.text || {};
            // Try simplified structure: type, name, schema at top level
            params.text.format = {
                type: 'json_schema',
                name: schemaConfig.json_schema.name,
                schema: schemaConfig.json_schema.schema
            };
            // strict might need to be at format level, not nested
            if (schemaConfig.json_schema.strict !== undefined) {
                params.text.format.strict = schemaConfig.json_schema.strict;
            }
                    console.log(`[getModelParams] Structured output ENABLED for model ${model} (using text.format with name: ${schemaConfig.json_schema.name})`);
                    console.log(`[getModelParams] Format structure:`, JSON.stringify({
                        type: params.text.format.type,
                        name: params.text.format.name,
                        hasSchema: !!params.text.format.schema,
                        strict: params.text.format.strict
                    }, null, 2));
                    // Log schema structure to debug
                    if (params.text.format.schema) {
                        const topicsSchema = params.text.format.schema.properties?.topics?.items;
                        if (topicsSchema) {
                            console.log(`[getModelParams] Topics schema - properties:`, Object.keys(topicsSchema.properties || {}));
                            console.log(`[getModelParams] Topics schema - required:`, topicsSchema.required);
                        }
                    }
                } else {
                    console.warn(`[getModelParams] Model ${model} does not support structured output, continuing without`);
                }
            } else {
                console.log(`[getModelParams] Structured output DISABLED (useStructuredOutput=${useStructuredOutput}) - Set USE_STRUCTURED_OUTPUT=true to enable`);
    }
    
    return params;
}

function convertJSONToMarkdown(jsonData) {
    // Convert structured JSON output to Markdown format matching the original prompt requirements
    try {
        if (!jsonData || typeof jsonData !== 'object') return '';
        
        const topics = Array.isArray(jsonData.topics) ? jsonData.topics : [];
        if (topics.length === 0) return '';
        
        const lines = [];
        let isFirstTopic = true;
        
        for (const topic of topics) {
            const topicName = String(topic.name || '').trim();
            if (!topicName) continue;
            
            // Add topic heading - with CriticMarkup comment on first topic if considerations exist
            const considerations = String(jsonData.considerations || '').trim();
            if (isFirstTopic && considerations) {
                lines.push(`# {==${topicName}==}{>> ${considerations} <<}`);
            } else {
                lines.push(`# ${topicName}`);
            }
            lines.push('');
            
            const positions = Array.isArray(topic.positions) ? topic.positions : [];
            for (const position of positions) {
                const title = String(position.title || '').trim();
                const summary = String(position.summary || '').trim();
                const responseNumbers = Array.isArray(position.responseNumbers) 
                    ? position.responseNumbers.filter(n => Number.isFinite(n)).map(n => Number(n))
                    : [];
                const respondentBreakdown = position.respondentBreakdown || {};
                
                if (!title || !summary) continue;
                
                // Skip unwanted position types that group by respondent rather than content
                if (title.toLowerCase().includes('myndighedsindberetninger') || 
                    title.toLowerCase().includes('faglige forbehold') ||
                    title.toLowerCase().includes('uden direkte forslag') ||
                    title.toLowerCase().includes('respondentgruppe')) {
                    continue;
                }
                
                // Format response numbers as "1, 2 og 3"
                let responseList = '';
                if (responseNumbers.length === 1) {
                    responseList = String(responseNumbers[0]);
                } else if (responseNumbers.length === 2) {
                    responseList = `${responseNumbers[0]} og ${responseNumbers[1]}`;
                } else {
                    const sorted = [...responseNumbers].sort((a, b) => a - b);
                    responseList = sorted.slice(0, -1).join(', ') + ' og ' + sorted[sorted.length - 1];
                }
                
                // Use AI's title directly (it already includes correct count and LU/O notation)
                lines.push(`## ${title}`);
                lines.push(`Henvendelse ${responseList}`);
                
                // Process citations and embed them in summary
                const citations = Array.isArray(position.citations) ? position.citations : [];
                let summaryText = summary;
                
                // Apply citations to summary text - use more robust approach
                const replacements = [];
                for (const citation of citations) {
                    const highlight = String(citation.highlight || '').trim();
                    const comment = String(citation.comment || '').trim();
                    const contextual = String(citation.highlightContextual || citation.highlight || '').trim();
                    
                    if (!highlight || !comment) continue;
                    
                    // Try to find the highlight in the summary text
                    let searchTarget = contextual || highlight;
                    let searchIndex = summaryText.toLowerCase().indexOf(searchTarget.toLowerCase());
                    
                    if (searchIndex === -1 && contextual !== highlight) {
                        // Try with just the highlight
                        searchTarget = highlight;
                        searchIndex = summaryText.toLowerCase().indexOf(searchTarget.toLowerCase());
                    }
                    
                    if (searchIndex !== -1) {
                        replacements.push({
                            index: searchIndex,
                            length: searchTarget.length,
                            replacement: `{==${searchTarget}==}{>>${comment}<<}`
                        });
                    }
                }
                
                // Apply replacements from end to start to avoid index shifting
                replacements.sort((a, b) => b.index - a.index);
                for (const repl of replacements) {
                    const before = summaryText.substring(0, repl.index);
                    const after = summaryText.substring(repl.index + repl.length);
                    summaryText = `${before}${repl.replacement}${after}`;
                }
                
                // Add the summary text
                lines.push(summaryText);
                lines.push('');
            }
            
            isFirstTopic = false;
        }
        
        return lines.join('\n').trim();
    } catch (err) {
        console.error('[convertJSONToMarkdown] Error converting JSON to Markdown:', err);
        return '';
    }
}

function extractHeadingsFromMarkdown(text) {
    if (!text || typeof text !== 'string') return [];
    try {
        const matches = text.match(/^#{1,6}\s+(.+)$/gm);
        if (!matches) return [];
        return matches.map(h => h.replace(/^#{1,6}\s+/, '').trim()).filter(h => h.length > 0);
    } catch (err) {
        console.error('[extractHeadingsFromMarkdown] Error:', err);
        return [];
    }
}

function parseOpenAIText(resp, isStructuredOutput = false) {
    let text = '';
    try {
        if (!resp) return '';
        
        // Handle structured JSON output
        if (isStructuredOutput) {
            // Try to extract JSON from various response formats
            let jsonData = null;
            
            // Check for direct JSON in text field (structured output sometimes appears here)
            if (!jsonData && resp.text) {
                if (typeof resp.text === 'string') {
                    try {
                        jsonData = JSON.parse(resp.text);
                    } catch (e) {}
                } else if (typeof resp.text === 'object' && resp.text !== null) {
                    // Sometimes structured output comes as an object directly
                    jsonData = resp.text;
                }
            }
            
            // Check for direct JSON in output_text
            if (!jsonData && typeof resp.output_text === 'string') {
                try {
                    jsonData = JSON.parse(resp.output_text);
                } catch {}
            }
            
            // Check for JSON in output array (structured output format)
            if (!jsonData && Array.isArray(resp.output)) {
                for (const outputItem of resp.output) {
                    if (outputItem?.type === 'message' && Array.isArray(outputItem?.content)) {
                        for (const contentItem of outputItem.content) {
                            if (contentItem?.type === 'output_text' && typeof contentItem?.text === 'string') {
                                try {
                                    jsonData = JSON.parse(contentItem.text);
                                    break;
                                } catch {}
                            }
                        }
                    }
                    // Check if JSON is in function_call arguments (structured output sometimes appears here)
                    if (!jsonData && outputItem?.type === 'function_call' && typeof outputItem?.arguments === 'string') {
                        try {
                            const args = JSON.parse(outputItem.arguments);
                            // Look for JSON data in arguments
                            if (args?.output) {
                                jsonData = args.output;
                            } else if (args?.data) {
                                jsonData = args.data;
                            } else if (typeof args === 'object' && (args.topics || args.considerations)) {
                                jsonData = args;
                            }
                        } catch (e) {}
                    }
                    if (jsonData) break;
                }
            }
            
            // Fallback: extract all text from output array and try to parse as JSON
            if (!jsonData && Array.isArray(resp.output)) {
                const outputText = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n');
                try {
                    jsonData = JSON.parse(outputText);
                } catch {}
            }
            
            // Check for JSON in response object
            if (!jsonData && resp.response && typeof resp.response === 'object') {
                try {
                    jsonData = JSON.parse(JSON.stringify(resp.response));
                } catch {}
            }
            
            if (jsonData && typeof jsonData === 'object') {
                return convertJSONToMarkdown(jsonData);
            }
        }
        
        // Fallback to standard text parsing
        if (typeof resp.output_text === 'string') text = resp.output_text;
        else if (Array.isArray(resp.output_text)) text = resp.output_text.join('\n');
        else if (Array.isArray(resp.output)) {
            text = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n');
        }
    } catch {}
    return (text || '').trim();
}

async function buildPromptFromInput(hearingId, input) {
    // Prioritize published data from GDPR side
    const sqlite = require('./db/sqlite');
    let hearing = input?.hearing || null;
    let responses = Array.isArray(input?.responses) ? input.responses : null;
    let materials = Array.isArray(input?.materials) ? input.materials : null;
    
    // Try to get published data first
    if (sqlite && sqlite.getPublishedAggregate) {
        try {
            const published = sqlite.getPublishedAggregate(Number(hearingId));
            if (published && (
                (Array.isArray(published.responses) && published.responses.length > 0) ||
                (Array.isArray(published.materials) && published.materials.length > 0)
            )) {
                console.log(`[buildPromptFromInput] Using ${published.responses?.length || 0} published responses and ${published.materials?.length || 0} published materials for hearing ${hearingId}`);
                // Log attachment info
                const responsesWithAttachments = published.responses?.filter(r => r.attachments && r.attachments.length > 0) || [];
                console.log(`[buildPromptFromInput] Found ${responsesWithAttachments.length} responses with attachments`);
                responsesWithAttachments.forEach(r => {
                    console.log(`[buildPromptFromInput] Response ${r.id}: ${r.attachments.length} attachments, focusMode=${r.focusMode || 'none'}`);
                    r.attachments.forEach(a => {
                        console.log(`[buildPromptFromInput]   - Attachment ${a.attachmentId}: ${a.filename}, contentMd length=${(a.contentMd || '').length}`);
                    });
                });
                responses = responses || published.responses || [];
                materials = materials || published.materials || [];
                
                // Get hearing info
                if (!hearing && sqlite.db && sqlite.db.prepare) {
                    const h = sqlite.db.prepare(`SELECT * FROM hearings WHERE id=?`).get(Number(hearingId));
                    if (h) {
                        hearing = {
                            id: h.id,
                            title: h.title || `Høring ${hearingId}`,
                            startDate: h.start_date,
                            deadline: h.deadline,
                            status: h.status
                        };
                    }
                }
            }
        } catch (err) {
            console.warn(`[buildPromptFromInput] Failed to load published data:`, err.message);
        }
    }
    
    // Fallback to API if no published data
    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
    if (!hearing || !responses || !materials) {
        try {
            const r = await axios.get(`${base}/api/hearing/${hearingId}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
            if (r && r.data && r.data.success) {
                hearing = hearing || r.data.hearing;
                responses = responses || r.data.responses || [];
                materials = materials || r.data.materials || [];
            }
        } catch {}
    }
    // Apply minimal respondent overrides if provided
    try {
        const overrides = input?.edits && typeof input.edits === 'object' ? input.edits : null;
        if (overrides && Array.isArray(responses)) {
            responses = responses.map(r => {
                const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                if (!ov || typeof ov !== 'object') return r;
                const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                const patched = { ...r };
                if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                return patched;
            });
        }
    } catch {}

    const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
    const RESP_LIMIT = Number(process.env.RESP_CHAR_LIMIT || 200000);
    const MAT_LIMIT = Number(process.env.MAT_CHAR_LIMIT || 120000);
    // Build JSON array expected by wizard/UX with merged respondent fields
    // Handle focus_mode for responses with attachments
    const repliesObjects = (responses || []).map(r => {
        const responseId = (r && (r.svarnummer ?? r.id ?? r.sourceId)) ?? null;
        const responseText = (r && (r.svartekst ?? r.text ?? r.textMd ?? '')) || '';
        const focusMode = r?.focusMode || r?.focus_mode || null;
        const attachments = Array.isArray(r?.attachments) ? r.attachments : [];
        
        console.log(`[buildPromptFromInput] Processing response ${responseId}: focusMode=${focusMode}, attachments=${attachments.length}`);
        
        // Build text based on focus_mode
        let finalText = '';
        if (focusMode === 'attachment' || focusMode === 'vedhæftning') {
            // Only use attachment content
            const attachmentTexts = attachments
                .filter(a => a.contentMd)
                .map(a => a.contentMd)
                .join('\n\n');
            finalText = attachmentTexts || responseText; // Fallback to response if no attachments
            console.log(`[buildPromptFromInput] Response ${responseId}: Using attachment-only mode, found ${attachmentTexts.length} chars from attachments`);
        } else if (focusMode === 'both' || focusMode === 'begge') {
            // Use both response and attachments
            const attachmentTexts = attachments
                .filter(a => a.contentMd)
                .map(a => `[Vedhæftning: ${a.filename || 'Ukendt'}]\n${a.contentMd}`)
                .join('\n\n');
            finalText = responseText;
            if (attachmentTexts) {
                finalText = finalText ? `${finalText}\n\n${attachmentTexts}` : attachmentTexts;
            }
            console.log(`[buildPromptFromInput] Response ${responseId}: Using both mode, response=${responseText.length} chars, attachments=${attachmentTexts.length} chars`);
        } else {
            // Default: focus on response (or 'response' focus mode)
            finalText = responseText;
            if (attachments.length > 0) {
                console.log(`[buildPromptFromInput] Response ${responseId}: Using response-only mode (default), but has ${attachments.length} attachments that will NOT be included`);
            }
        }
        
        return {
            svarnummer: responseId,
            svartekst: finalText,
            respondentnavn: (r && (r.respondentnavn ?? r.respondentName ?? r.author ?? '')) || '',
            respondenttype: (r && (r.respondenttype ?? r.respondentType ?? 'Borger')) || 'Borger'
        };
    });
    const repliesText = JSON.stringify(repliesObjects, null, 2);
    const materialParts = [`# Høringsmateriale for ${(hearing && hearing.title) || ''}`];
    for (const m of (materials||[])) {
        const kind = m.kind || m.type;
        // Handle GDPR prepared materials: convert from uploadedPath if contentMd is empty
        if (m.contentMd) {
            // Already converted material
            materialParts.push('');
            materialParts.push(`## ${m.title || 'Dokument'}`);
            materialParts.push(String(m.contentMd));
            materialParts.push('');
        } else if (m.uploadedPath && fs.existsSync(m.uploadedPath)) {
            // Convert from file at prompt time
            try {
                const result = await convertFileToMarkdown(m.uploadedPath, { includeMetadata: true });
                const convertedMd = result?.markdown || '';
                if (convertedMd) {
                    materialParts.push('');
                    materialParts.push(`## ${m.title || 'Dokument'}`);
                    materialParts.push(convertedMd);
                    materialParts.push('');
                }
            } catch (err) {
                console.warn(`[buildPrompt] Failed to convert material ${m.materialId || m.title} from ${m.uploadedPath}:`, err.message);
                // Fallback to just showing the title
                materialParts.push(`- ${m.title || 'Dokument'}: ${m.uploadedPath}`);
            }
        } else if ((kind === 'description' || kind === 'text') && m.content) {
            materialParts.push('');
            materialParts.push(String(m.content));
            materialParts.push('');
        } else if (kind === 'file' && m.url) {
            materialParts.push(`- ${m.title || 'Dokument'}: ${m.url}`);
        } else if (m.url && !kind) {
            materialParts.push(`- ${m.title || 'Dokument'}: ${m.url}`);
        }
    }
    const materialText = materialParts.join('\n');
    const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
    
    // Use vector store strategically to prioritize relevant material chunks
    let vectorContextText = '';
    const totalChars = (repliesText || '').length + (materialText || '').length;
    const useVectorStore = shouldUseVectorStore((responses || []).length, (materials || []).length, totalChars);
    console.log(`[buildPromptFromInput] Vector store check: responses=${(responses || []).length}, materials=${(materials || []).length}, totalChars=${totalChars}, useVectorStore=${useVectorStore}`);
    
    if (useVectorStore && openai) {
        try {
            // Build vector store if it doesn't exist
            let chunks = listVectorChunks(Number(hearingId));
            if (!chunks || chunks.length === 0) {
                console.log(`[buildPromptFromInput] Building vector store for hearing ${hearingId}`);
                await rebuildLocalVectorStore(Number(hearingId));
                chunks = listVectorChunks(Number(hearingId));
            }
            
            if (chunks && chunks.length > 0) {
                // Use semantic search to find relevant chunks based on responses content
                // Extract key terms from responses for query
                const responseText = (responses || []).map(r => (r.text || r.svartekst || '')).join(' ').slice(0, 2000);
                const searchQuery = responseText || extractQueryFromPrompt(promptTemplate);
                const adaptiveTopK = calculateAdaptiveTopK((responses || []).length, (materials || []).length, chunks.length);
                
                console.log(`[buildPromptFromInput] Using semantic search with query: "${searchQuery.slice(0, 100)}...", topK: ${adaptiveTopK}`);
                const topResults = await queryLocalVectorStore(Number(hearingId), searchQuery, adaptiveTopK, VECTOR_SEARCH_MIN_SCORE);
                
                if (topResults && topResults.length > 0) {
                    const VECTOR_LIMIT = Number(process.env.VECTOR_CONTEXT_LIMIT || 6000);
                    const topChunks = topResults
                        .map((item, idx) => `### Kilde ${idx + 1} (${item.source || 'ukendt'})\n${item.content}`);
                    vectorContextText = topChunks.join('\n\n');
                    if (vectorContextText.length > VECTOR_LIMIT) {
                        vectorContextText = vectorContextText.slice(0, VECTOR_LIMIT);
                    }
                    console.log(`[buildPromptFromInput] Using ${topResults.length} relevant chunks from vector store`);
                }
            }
        } catch (err) {
            console.warn('[buildPromptFromInput] Failed to use vector store:', err.message);
            // Continue without vector store
        }
    }
    
    // Use bracketed sections to align with streaming endpoints
    const userPrompt = `${promptTemplate}\n\n[Samlede Høringssvar]\n\n${String(repliesText || '').slice(0, RESP_LIMIT)}\n\n[Høringsmateriale]\n\n${String(materialText || '').slice(0, MAT_LIMIT)}${vectorContextText ? `\n\n[Udvalgte kontekstafsnit]\n\n${vectorContextText}` : ''}`;
    return { hearing, responses, materials, systemPrompt, userPrompt };
}

async function runJob(jobId, hearingId, input) {
    // CRITICAL: Prevent duplicate runJob calls for the same job
    if (runningJobs.has(jobId)) {
        console.log(`[runJob] Job ${jobId} is already running, skipping duplicate call`);
        return;
    }
    runningJobs.add(jobId);
    
    try {
        updateJob(jobId, { state: 'preparing', phase: 'preparing', progress: 10 });
        appendEvent(jobId, 'info', 'Preparing input');
        console.log(`[runJob] Starting job ${jobId} for hearing ${hearingId}`);
        if (!openai) {
            appendEvent(jobId, 'error', 'OPENAI_API_KEY is missing');
            updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
            recordSessionJobEnd(jobId);
            runningJobs.delete(jobId);
            return;
        }

        console.log(`[runJob] Building prompt for hearing ${hearingId}`);
        let built;
        try {
            built = await buildPromptFromInput(hearingId, input || {});
            console.log(`[runJob] Prompt built successfully, responses: ${built.responses?.length || 0}, materials: ${built.materials?.length || 0}`);
        } catch (buildErr) {
            console.error(`[runJob] Failed to build prompt:`, buildErr);
            appendEvent(jobId, 'error', `Failed to build prompt: ${buildErr.message}`);
            updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
            recordSessionJobEnd(jobId);
            runningJobs.delete(jobId);
            return;
        }
        
        // Clean up temporary vector store after prompt is built
        try {
            if (sqliteDb && sqliteDb.prepare) {
                sqliteDb.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(Number(hearingId));
                console.log(`[runJob] Cleaned up temporary vector store for hearing ${hearingId}`);
            }
        } catch (cleanupErr) {
            console.warn(`[runJob] Failed to cleanup vector store:`, cleanupErr.message);
        }
        
        updateJob(jobId, { state: 'creating-job', phase: 'creating-job', progress: 20 });
        appendEvent(jobId, 'info', 'Creating background variants');

        // Determine number of variants from DB rows
        const rows = sqliteDb.prepare(`SELECT variant, response_id, state FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(jobId);
        const variantIds = rows.map(r => r.variant);

        // CRITICAL: Check if ANY variant already has a response_id - if so, don't create new prompts
        const hasAnyResponseId = rows.some(r => r.response_id);
        if (hasAnyResponseId) {
            console.log(`[runJob] Job ${jobId} already has response_ids for some variants, checking status before creating new prompts`);
        }

        const createPromises = [];
        for (const v of variantIds) {
            createPromises.push((async () => {
                try {
                    // CRITICAL: Check if response_id already exists for this variant (prevent duplicate prompts)
                    const existing = rows.find(r => r.variant === v);
                    if (existing && existing.response_id) {
                        // Verify that the response_id actually exists in OpenAI before skipping
                        try {
                            const testResponse = await openai.responses.retrieve(existing.response_id);
                            const testStatus = testResponse?.status || testResponse?.state || '';
                            // CRITICAL: Skip prompt creation if response is:
                            // - completed/succeeded/done (finished)
                            // - in_progress/queued (already sent and processing)
                            // - Any status that indicates the prompt was already sent
                            if (testStatus && !/failed|cancelled|expired|incomplete/i.test(testStatus)) {
                                console.log(`[runJob] Variant ${v} already has valid response_id ${existing.response_id} (status: ${testStatus}), SKIPPING prompt creation to prevent duplicates`);
                                console.log(`[runJob] Variant ${v} response_id details:`, { variant: v, response_id: existing.response_id, status: testStatus });
                                updateVariant(jobId, v, { state: 'polling', phase: 'polling', progress: 30 });
                                appendEvent(jobId, 'info', `Variant ${v} using existing response_id`, { responseId: existing.response_id });
                                return; // CRITICAL: Exit early to prevent duplicate prompt - DO NOT CREATE NEW PROMPT
                            } else {
                                console.log(`[runJob] Variant ${v} has invalid/incomplete response_id ${existing.response_id} (status: ${testStatus}), creating new prompt`);
                                // Clear the invalid response_id and continue to create new prompt
                                updateVariant(jobId, v, { response_id: null });
                            }
                        } catch (verifyErr) {
                            const errMsg = verifyErr?.response?.data?.error?.message || verifyErr?.message || String(verifyErr);
                            if (verifyErr?.response?.status === 404 || errMsg.includes('not found') || errMsg.includes('does not exist')) {
                                console.log(`[runJob] Variant ${v} response_id ${existing.response_id} does not exist in OpenAI, creating new prompt`);
                                // Clear the invalid response_id and continue to create new prompt
                                updateVariant(jobId, v, { response_id: null });
                            } else {
                                console.error(`[runJob] Error verifying response_id ${existing.response_id}:`, errMsg);
                                // On verification error, assume response_id is invalid and create new prompt
                                updateVariant(jobId, v, { response_id: null });
                            }
                        }
                    }
                    
                    updateVariant(jobId, v, { state: 'creating-job', phase: 'creating-job', progress: 20 });
                    const params = getModelParams(built.userPrompt, built.systemPrompt, USE_STRUCTURED_OUTPUT, Number(hearingId));
                    console.log(`[runJob] Creating OpenAI background job for variant ${v} of job ${jobId}`);
                    console.log(`[runJob] Request params:`, JSON.stringify({ model: params.model, stream: params.stream, background: params.background }, null, 2));
                    const requestPayload = { ...params, stream: false, background: true };
                    console.log(`[runJob] Full request payload (text.format only):`, JSON.stringify({
                        text: requestPayload.text
                    }, null, 2));
                    const created = await openai.responses.create(requestPayload);
                    // In newer SDK versions, response_id is typically in created.id directly
                    const responseId = created && (created.id || created.response_id || created.response?.id);
                    console.log(`[runJob] OpenAI API response:`, JSON.stringify({ 
                        id: created?.id, 
                        response_id: created?.response_id, 
                        response: created?.response?.id,
                        status: created?.status,
                        background: created?.background,
                        keys: created ? Object.keys(created) : [] 
                    }, null, 2));
                    if (!responseId) {
                        console.error(`[runJob] No response_id found in OpenAI response:`, created);
                        throw new Error('No response_id from OpenAI');
                    }
                    console.log(`[runJob] Created OpenAI background job for variant ${v}: ${responseId}`);
                    updateVariant(jobId, v, { state: 'polling', phase: 'polling', progress: 30, response_id: responseId });
                    appendEvent(jobId, 'info', `Variant ${v} queued`, { responseId });
                } catch (e) {
                    const msg = e?.response?.data?.error?.message || e?.message || String(e);
                    console.error(`[runJob] Failed to create OpenAI job for variant ${v}:`, msg);
                    updateVariant(jobId, v, { state: 'failed', phase: 'failed', progress: 100, error: msg });
                    appendEvent(jobId, 'error', `Variant ${v} failed to create`, { error: msg });
                }
            })());
        }

        await Promise.all(createPromises);

        updateJob(jobId, { state: 'polling', phase: 'polling', progress: 40 });
        appendEvent(jobId, 'info', 'Polling background jobs');

        const maxPolls = Number.isFinite(SUMMARIZE_TIMEOUT_MS) ? Math.ceil(SUMMARIZE_TIMEOUT_MS / JOB_POLL_INTERVAL_MS) : 300;
        console.log(`[runJob] Starting polling loop, maxPolls: ${maxPolls}`);
        for (let t = 0; t < maxPolls; t++) {
            const ctrl = activeJobControllers.get(jobId);
            if (ctrl && ctrl.cancelled) {
                console.log(`[runJob] Job ${jobId} was cancelled by controller at poll iteration ${t}`);
                appendEvent(jobId, 'warn', 'Job cancelled');
                updateJob(jobId, { state: 'cancelled', phase: 'cancelled', progress: 100 });
                recordSessionJobEnd(jobId);
                return;
            }

            const variants = sqliteDb.prepare(`SELECT variant, state, response_id FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(jobId);
            let allDone = true;
            for (const v of variants) {
                if (!v.response_id) { allDone = false; continue; }
                if (v.state === 'completed' || v.state === 'failed' || v.state === 'cancelled') continue;
                allDone = false;
                try {
                    console.log(`[runJob] Polling variant ${v.variant} with response_id: ${v.response_id}`);
                    let r;
                    try {
                        r = await openai.responses.retrieve(v.response_id);
                    } catch (retrieveErr) {
                        const errMsg = retrieveErr?.response?.data?.error?.message || retrieveErr?.message || String(retrieveErr);
                        console.error(`[runJob] ERROR retrieving response_id ${v.response_id}:`, errMsg);
                        console.error(`[runJob] Full error:`, JSON.stringify({
                            message: retrieveErr?.message,
                            status: retrieveErr?.response?.status,
                            statusText: retrieveErr?.response?.statusText,
                            data: retrieveErr?.response?.data
                        }, null, 2));
                        // If response doesn't exist, mark as failed
                        if (retrieveErr?.response?.status === 404 || errMsg.includes('not found') || errMsg.includes('does not exist')) {
                            updateVariant(jobId, v.variant, { state: 'failed', phase: 'failed', progress: 100, error: `Response ID not found in OpenAI: ${v.response_id}` });
                            appendEvent(jobId, 'error', `Variant ${v.variant} response_id not found`, { responseId: v.response_id, error: errMsg });
                            continue;
                        }
                        // Other errors - log but continue polling
                        appendEvent(jobId, 'warn', `Poll error for variant ${v.variant}`, { error: errMsg });
                        continue;
                    }
                    // Check response structure - newer SDK versions may have different structure
                    const status = (r && (r.status || r.state || r.response?.status)) || '';
                    const outputText = r?.output_text || r?.output || r?.response?.output_text || r?.response?.output || '';
                    const error = r?.error || r?.response?.error || null;
                    const incompleteDetails = r?.incomplete_details || r?.response?.incomplete_details || null;
                    
                    // Handle tool calls if response is incomplete due to tool calls
                    if (incompleteDetails && incompleteDetails.reason === 'tool_calls') {
                        const toolCalls = incompleteDetails.tool_calls || [];
                        console.log(`[runJob] Variant ${v.variant} requires tool calls:`, toolCalls.length);
                        
                        if (toolCalls.length > 0) {
                            try {
                                // Process tool calls and submit outputs
                                const toolOutputs = [];
                                for (const toolCall of toolCalls) {
                                    if (toolCall.type === 'function' && toolCall.function?.name === 'search_citation') {
                                        console.log(`[runJob] Processing search_citation tool call:`, toolCall.function?.arguments);
                                        const toolOutput = await handleCitationSearchToolCall(toolCall, Number(hearingId));
                                        toolOutputs.push({
                                            tool_call_id: toolCall.id,
                                            output: toolOutput
                                        });
                                    }
                                }
                                
                                if (toolOutputs.length > 0) {
                                    console.log(`[runJob] Submitting ${toolOutputs.length} tool outputs for variant ${v.variant}`);
                                    // Submit tool outputs - Responses API handles this automatically in background jobs
                                    // We need to wait for the response to complete after tool outputs are submitted
                                    appendEvent(jobId, 'info', `Variant ${v.variant} processing ${toolOutputs.length} tool calls`, { toolCalls: toolOutputs.length });
                                }
                            } catch (toolErr) {
                                console.error(`[runJob] Error handling tool calls for variant ${v.variant}:`, toolErr);
                                appendEvent(jobId, 'error', `Variant ${v.variant} tool call error`, { error: toolErr.message });
                            }
                        }
                    }
                    
                    console.log(`[runJob] Variant ${v.variant} status: ${status}, response structure:`, JSON.stringify({
                        id: r?.id,
                        status: r?.status,
                        state: r?.state,
                        error: error ? (error.message || error) : null,
                        hasOutputText: !!outputText,
                        outputTextLength: outputText ? (typeof outputText === 'string' ? outputText.length : 'object') : 0,
                        responseKeys: r ? Object.keys(r) : [],
                        incompleteDetails: incompleteDetails || null
                    }, null, 2));
                    
                    if (status && /failed/i.test(status)) {
                        const errorMsg = (error && (error.message || error)) || status;
                        updateVariant(jobId, v.variant, { state: 'failed', phase: 'failed', progress: 100, error: errorMsg });
                        appendEvent(jobId, 'error', `Variant ${v.variant} failed`, { status, error: errorMsg });
                    } else if (status && /completed|succeeded|done/i.test(status)) {
                        // Retrieve final output
                        let text = '';
                        
                        // Try to get output_text directly from response
                        if (outputText && typeof outputText === 'string') {
                            text = outputText;
                        } else {
                            // Fallback: try parseOpenAIText helper
                            text = parseOpenAIText(r, USE_STRUCTURED_OUTPUT);
                        }
                        
                        // If still no text, try streaming
                        if (!text || text.length === 0) {
                            try {
                                console.log(`[runJob] No output_text found, attempting to stream response ${v.response_id}`);
                                const stream = await openai.responses.stream({ response_id: v.response_id });
                                let acc = '';
                                const startedAt = Date.now();
                                for await (const ev of stream) {
                                    if (ev?.type === 'response.output_text.delta') {
                                        acc += (ev.delta || '');
                                    } else if (ev?.type === 'response.output_text') {
                                        // Complete output_text event
                                        acc += (ev.text || '');
                                    }
                                    if (Date.now() - startedAt > 9.5 * 60 * 1000) break;
                                }
                                if (acc && acc.length > 0) {
                                    text = acc;
                                }
                            } catch (streamErr) {
                                console.error(`[runJob] Streaming failed for variant ${v.variant}:`, streamErr?.message || streamErr);
                            }
                        }
                        
                        // Process structured output if enabled
                        if (text && USE_STRUCTURED_OUTPUT) {
                            try {
                                const jsonData = JSON.parse(text);
                                if (jsonData && typeof jsonData === 'object') {
                                    text = convertJSONToMarkdown(jsonData);
                                }
                            } catch {
                                // Not JSON, use as-is
                            }
                        }
                        const headings = extractHeadingsFromMarkdown(text);
                        updateVariant(jobId, v.variant, { state: 'completed', phase: 'completed', progress: 100, markdown: text, summary: null, headings_json: JSON.stringify(headings||[]), partial_chars: (text||'').length });
                        appendEvent(jobId, 'info', `Variant ${v.variant} completed`, { chars: (text||'').length });
                    } else {
                        // still running - DO NOT update progress automatically
                        // Progress should only increase when OpenAI reports actual progress
                        // Keep current progress or use status from OpenAI if available
                        const currentProgress = v.progress || 30;
                        updateVariant(jobId, v.variant, { state: 'running', phase: 'running', progress: currentProgress });
                    }
                } catch (e) {
                    const msg = e?.message || 'poll error';
                    const fullError = e?.response?.data || e?.error || e;
                    console.error(`[runJob] Poll error for variant ${v.variant}:`, msg, fullError);
                    appendEvent(jobId, 'warn', `Poll error for variant ${v.variant}`, { error: msg, details: fullError });
                }
            }

            // Update aggregate job progress
            try {
                const agg = sqliteDb.prepare(`SELECT AVG(progress) as p FROM job_variants WHERE job_id=?`).get(jobId);
                const p = Math.max(0, Math.min(100, Math.round(agg?.p || 0)));
                updateJob(jobId, { state: allDone ? 'running' : 'polling', phase: allDone ? 'running' : 'polling', progress: p });
            } catch {}

            if (allDone) break;
            await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS));
        }

        // Finalize job state
        const remain = sqliteDb.prepare(`SELECT COUNT(*) as n FROM job_variants WHERE job_id=? AND state NOT IN ('completed','failed','cancelled')`).get(jobId).n;
        const anyFailed = sqliteDb.prepare(`SELECT COUNT(*) as n FROM job_variants WHERE job_id=? AND state='failed'`).get(jobId).n > 0;
        if (remain === 0) {
            updateJob(jobId, { state: anyFailed ? 'failed' : 'completed', phase: anyFailed ? 'failed' : 'completed', progress: 100 });
        } else {
            updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
        }
        recordSessionJobEnd(jobId);
        runningJobs.delete(jobId);
    } catch (e) {
        console.error(`[runJob] Unhandled exception in runJob ${jobId}:`, e);
        appendEvent(jobId, 'error', `Unhandled runner error: ${e?.message || e}`);
        updateJob(jobId, { state: 'failed', phase: 'failed', progress: 100 });
        recordSessionJobEnd(jobId);
        runningJobs.delete(jobId);
    }
}

function cancelJob(jobId) {
    console.log(`[cancelJob] Cancelling job ${jobId}`);
    const ctrl = activeJobControllers.get(jobId);
    if (ctrl) ctrl.cancelled = true;
    updateJob(jobId, { state: 'cancelled', phase: 'cancelled', progress: 100 });
    appendEvent(jobId, 'warn', 'Job cancelled by client');
    runningJobs.delete(jobId); // Clean up running jobs set
}

function resumeDanglingJobs() {
    try {
        const rows = sqliteDb.prepare(`SELECT job_id, hearing_id FROM jobs WHERE state IN ('queued','preparing','creating-job','polling','running')`).all();
        for (const r of rows) {
            if (activeJobControllers.has(r.job_id)) continue;
            // Check if variants already have response_ids before resuming
            const variants = sqliteDb.prepare(`SELECT variant, response_id, state FROM job_variants WHERE job_id=?`).all(r.job_id);
            const hasResponseIds = variants.some(v => v.response_id);
            const allCompleted = variants.every(v => v.state === 'completed' || v.state === 'failed' || v.state === 'cancelled');
            
            if (hasResponseIds && !allCompleted) {
                // Job has response_ids but is not completed - resume polling only
                console.log(`[resumeDanglingJobs] Job ${r.job_id} has response_ids but is not completed, resuming polling loop`);
                activeJobControllers.set(r.job_id, { cancelled: false });
                // Resume polling loop - skip prompt creation but continue polling
                runJob(r.job_id, r.hearing_id, null).catch(e => {
                    appendEvent(r.job_id, 'error', `Resume polling failed: ${e?.message || e}`);
                    updateJob(r.job_id, { state: 'failed', phase: 'failed', progress: 100 });
                    runningJobs.delete(r.job_id);
                });
                continue;
            }
            
            if (hasResponseIds) {
                console.log(`[resumeDanglingJobs] Job ${r.job_id} already has response_ids and all variants completed, skipping resume`);
                continue;
            }
            
            activeJobControllers.set(r.job_id, { cancelled: false });
            runJob(r.job_id, r.hearing_id, null).catch(e => {
                appendEvent(r.job_id, 'error', `Resume failed: ${e?.message || e}`);
                updateJob(r.job_id, { state: 'failed', phase: 'failed', progress: 100 });
                runningJobs.delete(r.job_id);
            });
        }
    } catch {}
}

// Cleanup cron: delete old jobs and related rows
function cleanupOldJobs() {
    try {
        const cutoff = nowMs() - JOB_TTL_MS;
        const olds = sqliteDb.prepare(`SELECT job_id FROM jobs WHERE updated_at < ?`).all(cutoff);
        const delVar = sqliteDb.prepare(`DELETE FROM job_variants WHERE job_id=?`);
        const delEvt = sqliteDb.prepare(`DELETE FROM job_events WHERE job_id=?`);
        const delJob = sqliteDb.prepare(`DELETE FROM jobs WHERE job_id=?`);
        for (const j of olds) {
            delVar.run(j.job_id); delEvt.run(j.job_id); delJob.run(j.job_id);
            jobEventsCache.delete(j.job_id);
            activeJobControllers.delete(j.job_id);
        }
    } catch {}
}

async function legacySummarizeAsJobSse(req, res, payload) {
    const sendEvent = (name, data) => { try { if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
    try {
        const hearingId = String(req.params.id).trim();
        const n = Math.max(1, Math.min(Number(req.query.n || (payload && payload.n) || DEFAULT_VARIANTS) || DEFAULT_VARIANTS, 5));
        let edits = null;
        try { edits = payload && payload.edits ? payload.edits : (req.query && req.query.edits ? JSON.parse(String(req.query.edits)) : null); } catch { edits = null; }
        const input = {
            hearing: payload && payload.hearing || null,
            responses: payload && payload.responses || null,
            materials: payload && payload.materials || null,
            edits,
            n
        };
        const out = await createJob(req, hearingId, input);
        if (out.error) { sendEvent('error', { message: out.error }); try { res.end(); } catch {}; return; }
        const jobId = out.jobId;
        sendEvent('info', { message: 'Baggrundsjob oprettet', jobId });
        for (let i = 1; i <= n; i++) { sendEvent('placeholder', { id: i }); sendEvent('status', { id: i, phase: 'queued', message: 'I kø…' }); }
        const sent = new Set();
        const statusCache = new Map();
        const pollMs = Math.max(2000, JOB_RECOMMENDED_POLL_MS);
        const start = Date.now();

        async function sendVariantFromDb(variantId) {
            try {
                const row = sqliteDb.prepare(`SELECT markdown, summary, headings_json FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, variantId);
                if (!row) return false;
                const markdown = row?.markdown || '';
                const summary = row?.summary || '';
                const headings = row && row.headings_json ? JSON.parse(row.headings_json) : [];
                if ((markdown && markdown.trim().length) || (summary && summary.trim().length)) {
                    sendEvent('variant', { variant: { id: variantId, markdown, summary, headings } });
                    sent.add(variantId);
                    return true;
                }
                return false;
            } catch { return false; }
        }

        async function salvageAllVariants() {
            for (let i = 1; i <= n; i++) {
                if (!sent.has(i)) { try { await sendVariantFromDb(i); } catch {} }
            }
        }
        while (!res.writableEnded && Date.now() - start < SUMMARIZE_TIMEOUT_MS) {
            const snap = getJobSnapshot(jobId);
            if (!snap) { sendEvent('status', { phase: 'polling', message: 'Afventer job…' }); await new Promise(r => setTimeout(r, pollMs)); continue; }
            // Aggregate progress/status
            sendEvent('info', { message: `Status: ${snap.state}`, progress: snap.progress });
            for (const v of (snap.variants || [])) {
                const key = `${v.id}`;
                const prev = statusCache.get(key) || {};
                if (prev.state !== v.state || prev.progress !== v.progress || prev.phase !== v.phase) {
                    statusCache.set(key, { state: v.state, progress: v.progress, phase: v.phase });
                    sendEvent('status', { id: v.id, phase: v.phase || v.state, message: (v.state || '').toString(), progress: v.progress || 0 });
                }
                if (v.done && !sent.has(v.id)) { await sendVariantFromDb(v.id); }
            }
            if (snap.state === 'completed') {
                // Ensure any missing but persisted variants are emitted before end
                try { await salvageAllVariants(); } catch {}
                sendEvent('end', { message: 'Færdig' });
                break;
            }
            if (snap.state === 'failed' || snap.state === 'cancelled') {
                // Attempt to emit whatever content exists before signaling failure
                try { await salvageAllVariants(); } catch {}
                sendEvent('error', { message: snap.state === 'failed' ? 'Job fejlede' : 'Job annulleret' });
                // Also send a terminal end so clients stop spinners
                sendEvent('end', { message: 'Afslutter.' });
                break;
            }
            await new Promise(r => setTimeout(r, pollMs));
        }
    } catch (e) {
        sendEvent('error', { message: e?.message || 'Ukendt fejl' });
    } finally {
        try { if (!res.writableEnded) { try { /* final best-effort salvage */ } catch {}; res.end(); } } catch {}
    }
}

// API: Create summarize job
app.post('/api/jobs/summarize/:hearingId', express.json({ limit: '25mb' }), async (req, res) => {
    const hearingId = String(req.params.hearingId).trim();
    console.log(`[POST /api/jobs/summarize/:hearingId] Request received for hearing ${hearingId}`);
    try {
        if (!sqliteDb || !sqliteDb.prepare) {
            console.error(`[POST /api/jobs/summarize/:hearingId] Database unavailable for hearing ${hearingId}`);
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }
        const payload = {
            hearing: req.body?.hearing,
            responses: req.body?.responses,
            materials: req.body?.materials,
            edits: req.body?.edits,
            n: req.body?.n
        };
        console.log(`[POST /api/jobs/summarize/:hearingId] Calling createJob for hearing ${hearingId}, n=${payload.n || 'default'}`);
        const out = await createJob(req, hearingId, payload);
        if (out.error) {
            console.error(`[POST /api/jobs/summarize/:hearingId] createJob failed for hearing ${hearingId}:`, out.error);
            return res.status(out.status || 400).json({ success: false, message: out.error });
        }
        console.log(`[POST /api/jobs/summarize/:hearingId] Successfully created job ${out.jobId} for hearing ${hearingId}`);
        return res.status(202).json({ success: true, jobId: out.jobId, recommendedPoll: JOB_RECOMMENDED_POLL_MS });
    } catch (e) {
        console.error(`[POST /api/jobs/summarize/:hearingId] Exception for hearing ${hearingId}:`, e);
        return res.status(500).json({ success: false, message: e.message });
    }
});

// API: Job status
app.get('/api/jobs/:jobId', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const snap = getJobSnapshot(jobId);
    if (!snap) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, ...snap });
});

// API: Variant result
app.get('/api/jobs/:jobId/variant/:n', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const n = Number(req.params.n);
    try {
        const row = sqliteDb.prepare(`SELECT markdown, summary, headings_json as headingsJson, state FROM job_variants WHERE job_id=? AND variant=?`).get(jobId, n);
        if (!row) return res.status(404).json({ success: false, message: 'Variant not found' });
        const payload = {
            id: n,
            state: row.state || null,
            markdown: row.markdown || null,
            summary: row.summary || null,
            headings: row.headingsJson ? JSON.parse(row.headingsJson) : []
        };
        res.json({ success: true, ...payload });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Cancel job
app.delete('/api/jobs/:jobId', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    console.log(`[DELETE /api/jobs/:jobId] Cancel requested for job ${jobId}`);
    const snap = getJobSnapshot(jobId);
    if (!snap) return res.status(404).json({ success: false, message: 'Job not found' });
    cancelJob(jobId);
    res.json({ success: true });
});

function cacheGet(map, key) {
    const entry = map.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    if (entry) map.delete(key);
    return null;
}
function cacheSet(map, key, value, ttlMs = CACHE_TTL_MS) {
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (map.size > CACHE_MAX_ENTRIES * 1.2) {
        // Simple FIFO prune
        const removeCount = map.size - CACHE_MAX_ENTRIES;
        for (let i = 0; i < removeCount; i += 1) {
            const firstKey = map.keys().next().value;
            if (typeof firstKey === 'undefined') break;
            map.delete(firstKey);
        }
    }
}

// Quiet 404 noise for favicon in dev
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// In-memory hearing index for search
const CACHE_FILE = path.join(__dirname, 'hearings-cache.json');
let hearingIndex = [];

// Helpers to read local assets
function readTextFileSafe(filePath) {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetries(fn, { attempts = 3, baseDelayMs = 400, onError } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i += 1) {
        try { return await fn(i); }
        catch (e) {
            lastErr = e;
            if (onError) {
                try { onError(e, i); } catch {}
            }
            if (i < attempts) {
                // Exponential-ish backoff with small jitter
                const jitter = Math.floor(Math.random() * 100);
                await sleep(baseDelayMs * i + jitter);
            }
        }
    }
    throw lastErr;
}

async function extractTextFromLocalFile(filePath) {
    try {
        const ext = String(path.extname(filePath) || '').toLowerCase();
        if (ext === '.pdf') {
            const pdfParse = require('pdf-parse');
            const buf = fs.readFileSync(filePath);
            const parsed = await pdfParse(buf);
            return String(parsed.text || '');
        }
        if (ext === '.docx') {
            const python = process.env.PYTHON_BIN || 'python3';
            const script = `import sys\nfrom docx import Document\np=Document(sys.argv[1])\nprint('\n'.join([p2.text for p2 in p.paragraphs]))`;
            const tmpPy = path.join(ensureTmpDir(), `read_${Date.now()}.py`);
            fs.writeFileSync(tmpPy, script, 'utf8');
            const txt = await new Promise((resolve, reject) => {
                const c = spawn(python, [tmpPy, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '', err = '';
                c.stdout.on('data', d => out += d.toString());
                c.stderr.on('data', d => err += d.toString());
                c.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
            }).catch(() => '');
            return String(txt || '');
        }
        if (ext === '.txt' || ext === '.md') {
            return fs.readFileSync(filePath, 'utf8');
        }
        // Unsupported types: return empty; we'll still include size-based token note elsewhere
        return '';
    } catch {
        return '';
    }
}

function ensureTmpDir() {
    const dir = path.join(__dirname, 'tmp');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
}

// Download and convert a PDF attachment from blivhoert.kk.dk to markdown
async function downloadAndConvertAttachment(contentId, filename) {
    const downloadUrl = `https://blivhoert.kk.dk/api/content/${contentId}/download?apiKey=`;
    const tmpDir = ensureTmpDir();
    const tmpFile = path.join(tmpDir, `att_${contentId}_${Date.now()}.pdf`);
    
    try {
        console.log(`[Attachment] Downloading content ${contentId}: ${filename}`);
        
        // Download the file
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 60000
        });
        
        if (response.status !== 200) {
            throw new Error(`Download failed: HTTP ${response.status}`);
        }
        
        fs.writeFileSync(tmpFile, Buffer.from(response.data));
        console.log(`[Attachment] Downloaded to ${tmpFile} (${response.data.byteLength} bytes)`);
        
        // Check file type
        const ext = String(filename || '').toLowerCase().split('.').pop();
        let markdown = '';
        
        if (ext === 'pdf') {
            // Convert PDF to text using pdf-parse
            const pdfParse = require('pdf-parse');
            const dataBuffer = fs.readFileSync(tmpFile);
            const parsed = await pdfParse(dataBuffer);
            markdown = String(parsed.text || '').trim();
            console.log(`[Attachment] Converted PDF to ${markdown.length} chars`);
        } else if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
            markdown = fs.readFileSync(tmpFile, 'utf8').trim();
        } else if (ext === 'docx') {
            // Try python-docx
            const python = process.env.PYTHON_BIN || 'python3';
            const script = `import sys\nfrom docx import Document\np=Document(sys.argv[1])\nprint('\\n'.join([p2.text for p2 in p.paragraphs]))`;
            const tmpPy = path.join(tmpDir, `read_${Date.now()}.py`);
            fs.writeFileSync(tmpPy, script, 'utf8');
            try {
                markdown = await new Promise((resolve, reject) => {
                    const c = spawn(python, [tmpPy, tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
                    let out = '';
                    c.stdout.on('data', d => out += d);
                    c.on('close', code => code === 0 ? resolve(out) : reject(new Error('DOCX conversion failed')));
                    c.on('error', reject);
                });
                fs.unlinkSync(tmpPy);
            } catch (e) {
                console.warn(`[Attachment] DOCX conversion failed: ${e.message}`);
            }
        } else {
            // Unknown format - try as text
            try {
                markdown = fs.readFileSync(tmpFile, 'utf8').trim();
            } catch {
                markdown = `[Kunne ikke konvertere ${filename}]`;
            }
        }
        
        // Cleanup
        try { fs.unlinkSync(tmpFile); } catch {}
        
        return { success: true, markdown, contentId, filename };
    } catch (error) {
        console.error(`[Attachment] Error downloading/converting ${contentId}: ${error.message}`);
        try { fs.unlinkSync(tmpFile); } catch {}
        return { success: false, error: error.message, contentId, filename };
    }
}

// Fetch and convert all unapproved attachments for a hearing
async function fetchAndConvertAttachments(hearingId) {
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return { success: false, error: 'Database unavailable' };
    }
    
    // Find prepared_attachments that don't have converted_md yet and haven't been skipped
    // Join with raw_attachments to get contentId if available
    const preparedWithSource = db.prepare(`
        SELECT pa.*, pr.source_response_id, 
               ra.content_id, ra.download_url, ra.filename as raw_filename
        FROM prepared_attachments pa
        JOIN prepared_responses pr ON pr.hearing_id = pa.hearing_id AND pr.prepared_id = pa.prepared_id
        LEFT JOIN raw_attachments ra ON ra.hearing_id = pa.hearing_id 
            AND ra.response_id = pr.source_response_id 
            AND ra.idx = (pa.attachment_id - 1)
        WHERE pa.hearing_id = ? 
          AND (pa.converted_md IS NULL OR pa.converted_md = '')
          AND (pa.conversion_status IS NULL OR pa.conversion_status = '' OR pa.conversion_status = 'pending')
          AND pa.approved = 0
    `).all(hearingId);
    
    console.log(`[fetchAndConvertAttachments] Found ${preparedWithSource.length} pending attachments for hearing ${hearingId}`);
    
    const results = [];
    let converted = 0;
    let failed = 0;
    
    // If we don't have contentIds in database, we need to fetch from API
    const needsApiLookup = preparedWithSource.some(pa => !pa.content_id);
    let attachmentsByResponse = new Map();
    
    if (needsApiLookup) {
        console.log(`[fetchAndConvertAttachments] Some attachments missing contentId, fetching from API...`);
        
        // Fetch all pages from API to get contentIds
        try {
            for (let page = 1; page <= 200; page++) {
                const apiUrl = `https://blivhoert.kk.dk/api/hearing/${hearingId}/comment?include=Contents,Contents.ContentType&Page=${page}`;
                const resp = await axios.get(apiUrl, {
                    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
                    timeout: 60000
                });
                
                if (resp.status !== 200 || !resp.data?.data?.length) break;
                
                const comments = resp.data.data || [];
                const included = resp.data.included || [];
                const contentById = new Map();
                included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
                
                for (const comment of comments) {
                    const responseNumber = comment.attributes?.number;
                    if (!responseNumber) continue;
                    
                    const contentRefs = comment.relationships?.contents?.data || [];
                    const atts = [];
                    for (const cref of contentRefs) {
                        const cid = String(cref.id);
                        const content = contentById.get(cid);
                        if (content?.attributes?.filePath) {
                            atts.push({
                                contentId: cid,
                                filename: content.attributes.fileName || 'file.pdf',
                                filePath: content.attributes.filePath
                            });
                        }
                    }
                    if (atts.length > 0) {
                        attachmentsByResponse.set(responseNumber, atts);
                    }
                }
                
                // Check pagination
                const totalPages = resp.data?.meta?.Pagination?.totalPages;
                if (totalPages && page >= totalPages) break;
                
                // Small delay between pages
                await new Promise(r => setTimeout(r, 100));
            }
            
            console.log(`[fetchAndConvertAttachments] Found ${attachmentsByResponse.size} responses with attachments from API`);
        } catch (error) {
            console.error(`[fetchAndConvertAttachments] API lookup error: ${error.message}`);
        }
    }
    
    // File extensions that can be converted to text
    const CONVERTIBLE_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'txt', 'md', 'markdown', 'rtf']);
    const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico']);
    
    // Process each pending attachment
    for (const pa of preparedWithSource) {
        const sourceResponseId = pa.source_response_id;
        const attIndex = (pa.attachment_id || 1) - 1;
        
        let contentId = pa.content_id;
        let filename = pa.original_filename || pa.raw_filename || 'file.pdf';
        
        // If no contentId from database, try API lookup
        if (!contentId && attachmentsByResponse.has(sourceResponseId)) {
            const atts = attachmentsByResponse.get(sourceResponseId);
            const att = atts[attIndex];
            if (att) {
                contentId = att.contentId;
                filename = att.filename;
            }
        }
        
        // Check file extension - skip non-convertible files (images, etc.)
        const ext = String(filename || '').toLowerCase().split('.').pop();
        if (IMAGE_EXTENSIONS.has(ext)) {
            console.log(`[fetchAndConvertAttachments] Skipping image file: ${filename}`);
            // Mark as "skipped" in database so we don't retry
            db.prepare(`
                UPDATE prepared_attachments 
                SET conversion_status = 'skipped-image', updated_at = ?
                WHERE hearing_id = ? AND prepared_id = ? AND attachment_id = ?
            `).run(Date.now(), hearingId, pa.prepared_id, pa.attachment_id);
            results.push({ preparedId: pa.prepared_id, attachmentId: pa.attachment_id, success: true, skipped: true, reason: 'image' });
            continue;
        }
        
        if (!CONVERTIBLE_EXTENSIONS.has(ext)) {
            console.log(`[fetchAndConvertAttachments] Skipping unsupported file type: ${filename} (${ext})`);
            db.prepare(`
                UPDATE prepared_attachments 
                SET conversion_status = 'skipped-unsupported', updated_at = ?
                WHERE hearing_id = ? AND prepared_id = ? AND attachment_id = ?
            `).run(Date.now(), hearingId, pa.prepared_id, pa.attachment_id);
            results.push({ preparedId: pa.prepared_id, attachmentId: pa.attachment_id, success: true, skipped: true, reason: 'unsupported' });
            continue;
        }
        
        if (!contentId) {
            console.log(`[fetchAndConvertAttachments] No contentId for response ${sourceResponseId}, attachment ${pa.attachment_id} - skipping`);
            failed++;
            results.push({ preparedId: pa.prepared_id, attachmentId: pa.attachment_id, success: false, error: 'No contentId available' });
            continue;
        }
        
        console.log(`[fetchAndConvertAttachments] Downloading attachment for response ${sourceResponseId}: ${filename} (contentId: ${contentId})`);
        const result = await downloadAndConvertAttachment(contentId, filename);
        
        if (result.success && result.markdown) {
            // Update prepared_attachment with converted markdown
            db.prepare(`
                UPDATE prepared_attachments 
                SET converted_md = ?, conversion_status = 'auto', source_url = ?, updated_at = ?
                WHERE hearing_id = ? AND prepared_id = ? AND attachment_id = ?
            `).run(
                result.markdown,
                `https://blivhoert.kk.dk/api/content/${contentId}/download?apiKey=`,
                Date.now(),
                hearingId, pa.prepared_id, pa.attachment_id
            );
            converted++;
            results.push({ preparedId: pa.prepared_id, attachmentId: pa.attachment_id, success: true });
        } else {
            failed++;
            results.push({ preparedId: pa.prepared_id, attachmentId: pa.attachment_id, success: false, error: result.error });
        }
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
    }
    
    return { success: true, converted, failed, total: converted + failed, results };
}

// Danish-aware normalization (case, punctuation, diacritics, and special letters)
function normalizeDanish(input) {
    if (typeof input !== 'string') return '';
    const lowered = input.toLowerCase();
    const map = {
        'æ': 'ae', 'ø': 'o', 'å': 'aa',
        'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a',
        'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
        'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
        'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o',
        'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u'
    };
    const replaced = lowered.replace(/[\u00C0-\u024F]/g, ch => map[ch] || ch);
    // Remove combining marks and punctuation, collapse whitespace
    return replaced
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    const norm = normalizeDanish(text);
    return norm.length ? norm.split(' ') : [];
}

function computeIsOpen(statusText, deadline) {
    const now = Date.now();
    const deadlineTs = deadline ? new Date(deadline).getTime() : null;
    const statusNorm = normalizeDanish(statusText || '');
    // Broader detection of open/closed states in Danish
    const statusHintsOpen = /(i hoering|i horing|i høring|open|aaben|åben|aktiv|offentlig|hoering|horing)/.test(statusNorm);
    const statusHintsClosed = /(afslut|luk|lukket|afsluttet|konklud|konklusion|konkluderet)/.test(statusNorm);
    if (Number.isFinite(deadlineTs)) {
        if (deadlineTs >= now) return true;
        if (deadlineTs < now && statusHintsClosed) return false;
    }
    if (statusHintsOpen) return true;
    if (statusHintsClosed) return false;
    return false;
}

function shouldIncludeInIndex(status) {
    // Only include hearings with status "Afventer konklusion" in the search index
    return status && status.toLowerCase().includes('afventer konklusion');
}

function enrichHearingForIndex(h) {
    const normalizedTitle = normalizeDanish(h.title || '');
    const titleTokens = tokenize(h.title || '');
    const id = Number(h.id);
    const deadlineTs = h.deadline ? new Date(h.deadline).getTime() : null;
    const isOpen = computeIsOpen(h.status, h.deadline);
    return {
        id,
        title: h.title || '',
        startDate: h.startDate || null,
        deadline: h.deadline || null,
        status: h.status || null,
        normalizedTitle,
        titleTokens,
        deadlineTs,
        isOpen
    };
}

function loadIndexFromDisk() {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const json = JSON.parse(raw);
        if (Array.isArray(json?.items)) hearingIndex = json.items.map(enrichHearingForIndex);
        else if (Array.isArray(json?.hearings)) hearingIndex = json.hearings.map(enrichHearingForIndex);
    } catch {}
}

async function warmHearingIndex() {
    try {
        const baseApi = 'https://blivhoert.kk.dk/api/hearing';
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'application/vnd.api+json, application/json',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                'Referer': baseUrl,
                'Origin': baseUrl,
                'Cookie': 'kk-xyz=1',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 30000,
            validateStatus: () => true
        });

        let page = 1;
        const pageSize = 50;
        const collected = [];
        for (;;) {
            const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
            const r = await withRetries(() => axiosInstance.get(url), { attempts: 3, baseDelayMs: 500 });
            if (r.status !== 200 || !r.data) break;
            const data = r.data;
            const items = Array.isArray(data?.data) ? data.data : [];
            const included = Array.isArray(data?.included) ? data.included : [];
            const titleByContentId = new Map();
            for (const inc of included) {
                if (inc?.type === 'content') {
                    const fieldId = inc?.relationships?.field?.data?.id;
                    if (String(fieldId) === '1' && typeof inc?.attributes?.textContent === 'string') {
                        titleByContentId.set(String(inc.id), String(inc.attributes.textContent).trim());
                    }
                }
            }
            const outPage = [];
            for (const it of items) {
                if (!it || it.type !== 'hearing') continue;
                const hId = Number(it.id);
                const attrs = it.attributes || {};
                let title = '';
                const contentRels = (it.relationships?.contents?.data) || [];
                for (const cref of contentRels) {
                    const cid = cref?.id && String(cref.id);
                    if (cid && titleByContentId.has(cid)) { title = titleByContentId.get(cid); break; }
                }
                // If no title found and no content relationships, use a placeholder
                // The title will be fetched later via individual API calls if needed
                if (!title && contentRels.length === 0) {
                    title = ''; // Keep empty, will be handled later
                }
                const statusRelId = it.relationships?.hearingStatus?.data?.id;
                const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                const statusText = statusIncluded?.attributes?.name || null;
                outPage.push({ id: hId, title, startDate: attrs.startDate || null, deadline: attrs.deadline || null, status: statusText || null });
            }
            collected.push(...outPage);
            const totalPages = data?.meta?.Pagination?.totalPages || page;
            if (page >= totalPages) break;
            page += 1;
        }
        
        // Fetch missing titles for hearings without content relationships
        console.log('[warmHearingIndex] Checking for hearings with missing titles...');
        const missingTitles = collected.filter(h => !h.title || h.title === '');
        if (missingTitles.length > 0) {
            console.log(`[warmHearingIndex] Found ${missingTitles.length} hearings with missing titles, fetching...`);
            
            // Debug specific hearings
            const debug168 = missingTitles.find(h => h.id === 168);
            const debug190 = missingTitles.find(h => h.id === 190);
            if (debug168) console.log('[warmHearingIndex] Hearing 168 in missingTitles:', debug168);
            if (debug190) console.log('[warmHearingIndex] Hearing 190 in missingTitles:', debug190);
            
            // Fetch titles in batches to avoid overwhelming the server
            const batchSize = 5;
            for (let i = 0; i < missingTitles.length; i += batchSize) {
                const batch = missingTitles.slice(i, i + batchSize);
                await Promise.all(batch.map(async (hearing) => {
                    try {
                        // Try to get title from the hearing detail page
                        const detailUrl = `${baseUrl}/api/hearing/${hearing.id}`;
                        const detailResp = await axiosInstance.get(detailUrl);
                        if (detailResp.status === 200 && detailResp.data) {
                            // Try the same parsing logic as individual API
                            const data = detailResp.data;
                            const included = Array.isArray(data?.included) ? data.included : [];
                            const contents = included.filter(x => x?.type === 'content');
                            const titleContent = contents.find(c => 
                                String(c?.relationships?.field?.data?.id || '') === '1' && 
                                c?.attributes?.textContent
                            );
                            if (titleContent) {
                                hearing.title = String(titleContent.attributes.textContent).trim();
                                console.log(`[warmHearingIndex] Found title for hearing ${hearing.id}: ${hearing.title}`);
                                // Update the database immediately
                                try {
                                    upsertHearing({ 
                                        id: hearing.id, 
                                        title: hearing.title, 
                                        startDate: hearing.startDate, 
                                        deadline: hearing.deadline, 
                                        status: hearing.status 
                                    });
                                } catch (e) {
                                    console.warn(`[warmHearingIndex] Failed to update hearing ${hearing.id} in DB:`, e.message);
                                }
                            }
                        }
                        
                        // If still no title, try HTML scraping as last resort
                        if (!hearing.title) {
                            const htmlUrl = `${baseUrl}/hearing/${hearing.id}`;
                            const htmlResp = await axiosInstance.get(htmlUrl);
                            if (htmlResp.status === 200 && htmlResp.data) {
                                // Extract title from __NEXT_DATA__
                                const match = htmlResp.data.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
                                if (match && match[1]) {
                                    try {
                                        const nextData = JSON.parse(match[1]);
                                        const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
                                        for (const query of queries) {
                                            const root = query?.state?.data?.data;
                                            if (!root) continue;
                                            const included = Array.isArray(root?.included) ? root.included : [];
                                            const contents = included.filter(x => x?.type === 'content');
                                            const titleContent = contents.find(c => 
                                                String(c?.relationships?.field?.data?.id || '') === '1' && 
                                                c?.attributes?.textContent
                                            );
                                            if (titleContent) {
                                                hearing.title = String(titleContent.attributes.textContent).trim();
                                                console.log(`[warmHearingIndex] Found title via HTML for hearing ${hearing.id}: ${hearing.title}`);
                                                // Update the database immediately
                                                try {
                                                    upsertHearing({ 
                                                        id: hearing.id, 
                                                        title: hearing.title, 
                                                        startDate: hearing.startDate, 
                                                        deadline: hearing.deadline, 
                                                        status: hearing.status 
                                                    });
                                                } catch (e) {
                                                    console.warn(`[warmHearingIndex] Failed to update hearing ${hearing.id} in DB:`, e.message);
                                                }
                                                break;
                                            }
                                        }
                                    } catch (e) {}
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`[warmHearingIndex] Failed to fetch title for hearing ${hearing.id}:`, e.message);
                    }
                }));
                
                // Small delay between batches
                if (i + batchSize < missingTitles.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        
        // Only include hearings with status "Afventer konklusion"
        console.log(`[warmHearingIndex] Total collected hearings: ${collected.length}`);
        const withCorrectStatus = collected.filter(h => shouldIncludeInIndex(h.status));
        console.log(`[warmHearingIndex] Hearings with status "Afventer konklusion": ${withCorrectStatus.length}`);
        
        // Check specific hearings
        const h168 = collected.find(h => h.id === 168);
        const h190 = collected.find(h => h.id === 190);
        if (h168) console.log(`[warmHearingIndex] Hearing 168:`, { id: h168.id, title: h168.title, status: h168.status });
        if (h190) console.log(`[warmHearingIndex] Hearing 190:`, { id: h190.id, title: h190.title, status: h190.status });
        
        // Special handling for known problematic hearings
        const knownTitles = {
            168: 'Tillæg 6 til lp Grønttorvsområdet - forslag til lokalplan',
            190: 'Klimastrategi og Klimahandleplan'
        };
        
        for (const h of collected) {
            if (knownTitles[h.id] && (!h.title || h.title === '')) {
                console.log(`[warmHearingIndex] Applying known title for hearing ${h.id}: ${knownTitles[h.id]}`);
                h.title = knownTitles[h.id];
            }
        }
        
        hearingIndex = withCorrectStatus.map(enrichHearingForIndex);
        try {
            if (sqliteDb && sqliteDb.prepare) {
                // Still save all hearings to DB, but only "Afventer konklusion" ones to index
                for (const h of collected) {
                    try { upsertHearing({ id: h.id, title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null }); } catch {}
                }
                // Update hearing index in SQLite
                if (sqliteDb.updateHearingIndex) {
                    try { sqliteDb.updateHearingIndex(hearingIndex); } catch (e) { console.warn('Failed to update hearing index:', e.message); }
                }
            }
        } catch {}

        // Fallback: If API failed or returned nothing, use sitemap + HTML (__NEXT_DATA__) to build index
        if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
            try {
                const sm = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                        'Accept': 'application/xml,text/xml,application/xhtml+xml,text/html,*/*',
                        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                        'Referer': baseUrl
                    },
                    timeout: 20000,
                    validateStatus: () => true
                });
                const candidates = [
                    `${baseUrl}/sitemap.xml`,
                    `${baseUrl}/sitemap_index.xml`,
                    `${baseUrl}/sitemap-hearing.xml`,
                    `${baseUrl}/sitemap-hearings.xml`
                ];
                const urls = new Set();
                for (const u of candidates) {
                    try {
                        const resp = await withRetries(() => sm.get(u), { attempts: 2, baseDelayMs: 400 });
                        if (resp.status !== 200 || !resp.data) continue;
                        const $ = cheerio.load(resp.data, { xmlMode: true });
                        $('loc').each((_, el) => {
                            const t = String($(el).text() || '').trim();
                            if (t) urls.add(t);
                        });
                        $('url > loc').each((_, el) => {
                            const t = String($(el).text() || '').trim();
                            if (t) urls.add(t);
                        });
                        $('sitemap > loc').each((_, el) => {
                            const t = String($(el).text() || '').trim();
                            if (t) urls.add(t);
                        });
                    } catch {}
                }
                const hearingIdFromUrl = (s) => {
                    const m = String(s || '').match(/\/hearing\/(\d+)/);
                    return m ? Number(m[1]) : null;
                };
                const ids = Array.from(urls)
                    .map(hearingIdFromUrl)
                    .filter((x) => Number.isFinite(x));
                const uniqueIds = Array.from(new Set(ids)).slice(0, 300);

                // Fetch meta via HTML for these IDs
                const axiosHtml = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Cookie': 'kk-xyz=1',
                        'Origin': baseUrl,
                        'Referer': baseUrl
                    },
                    timeout: 20000,
                    validateStatus: () => true
                });
                const out = [];
                let cursor = 0;
                const maxConcurrent = 6;
                const workers = new Array(Math.min(maxConcurrent, uniqueIds.length)).fill(0).map(async () => {
                    while (cursor < uniqueIds.length) {
                        const idx = cursor++;
                        const hid = uniqueIds[idx];
                        try {
                            const url = `${baseUrl}/hearing/${hid}`;
                            const resp = await withRetries(() => axiosHtml.get(url), { attempts: 2, baseDelayMs: 400 });
                            if (resp.status !== 200 || !resp.data) continue;
                            const $ = cheerio.load(resp.data);
                            const nextDataEl = $('script#__NEXT_DATA__');
                            if (!nextDataEl.length) continue;
                            const json = JSON.parse(nextDataEl.text());
                            // Reuse existing extractor to build meta
                            const meta = extractMetaFromNextJson(json);
                            const title = meta.title || `Høring ${hid}`;
                            out.push({ id: hid, title, startDate: meta.startDate || null, deadline: meta.deadline || null, status: meta.status || null });
                        } catch {}
                    }
                });
                await Promise.all(workers);
                if (out.length > 0) {
                    hearingIndex = out.map(enrichHearingForIndex);
                    try {
                        if (sqliteDb && sqliteDb.prepare) {
                            for (const h of hearingIndex) {
                                try { upsertHearing({ id: h.id, title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null }); } catch {}
                            }
                        }
                    } catch {}
                }
            } catch {}
        }

        // Last-resort fallback: scrape homepage for hearing links and hydrate a seed set
        if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
            try {
                const resp = await withRetries(() => axios.get(baseUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                        'Referer': baseUrl
                    },
                    timeout: 20000,
                    validateStatus: () => true
                }), { attempts: 2, baseDelayMs: 400 });
                if (resp.status === 200 && resp.data) {
                    const $ = cheerio.load(resp.data);
                    const ids = new Set();
                    $('a[href]').each((_, el) => {
                        const href = String($(el).attr('href') || '');
                        const m = href.match(/\/hearing\/(\d+)/);
                        if (m) ids.add(Number(m[1]));
                    });
                    const uniqueIds = Array.from(ids).slice(0, 100);
                    if (uniqueIds.length) {
                        const axiosHtml = axios.create({
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml',
                                'Cookie': 'kk-xyz=1',
                                'Origin': baseUrl,
                                'Referer': baseUrl
                            },
                            timeout: 20000,
                            validateStatus: () => true
                        });
                        const out = [];
                        let cursor = 0;
                        const maxConcurrent = 6;
                        const workers = new Array(Math.min(maxConcurrent, uniqueIds.length)).fill(0).map(async () => {
                            while (cursor < uniqueIds.length) {
                                const idx = cursor++;
                                const hid = uniqueIds[idx];
                                try {
                                    const url = `${baseUrl}/hearing/${hid}`;
                                    const r2 = await withRetries(() => axiosHtml.get(url), { attempts: 2, baseDelayMs: 400 });
                                    if (r2.status !== 200 || !r2.data) continue;
                                    const $p = cheerio.load(r2.data);
                                    const nextDataEl = $p('script#__NEXT_DATA__');
                                    if (!nextDataEl.length) continue;
                                    const json = JSON.parse(nextDataEl.text());
                                    const meta = extractMetaFromNextJson(json);
                                    out.push({ id: hid, title: meta.title || `Høring ${hid}`, startDate: meta.startDate || null, deadline: meta.deadline || null, status: meta.status || null });
                                } catch {}
                            }
                        });
                        await Promise.all(workers);
                        if (out.length > 0) hearingIndex = out.map(enrichHearingForIndex);
                    }
                }
            } catch {}
        }

        // Backfill missing titles by parsing the hearing page HTML (__NEXT_DATA__) with small concurrency
        let missing = hearingIndex.filter(h => !h.title || !h.title.trim());
        let retryCount = 0;
        const maxRetries = 3;
        
        while (missing.length > 0 && retryCount < maxRetries) {
            if (retryCount > 0) {
                console.log(`Retrying to fetch titles for ${missing.length} hearings (attempt ${retryCount + 1})`);
                await sleep(1000 * retryCount); // Progressive backoff
            }
            const axiosInstance2 = axios.create({
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Cookie': 'kk-xyz=1',
                    'Origin': baseUrl,
                    'Referer': baseUrl
                },
                timeout: 20000,
                validateStatus: () => true
            });

            async function fetchMetaFromHearingHtml(hearingId) {
                try {
                    const url = `${baseUrl}/hearing/${hearingId}`;
                    const resp = await withRetries(() => axiosInstance2.get(url, { validateStatus: () => true }), { attempts: 2, baseDelayMs: 400 });
                    if (resp.status !== 200 || !resp.data) return {};
                    const $ = cheerio.load(resp.data);
                    const nextDataEl = $('script#__NEXT_DATA__');
                    if (!nextDataEl.length) return {};
                    // Guard against extremely large __NEXT_DATA__ blobs that can cause OOM in constrained envs
                    const rawNext = String(nextDataEl.html() || '');
                    const maxBytes = Number(process.env.NEXT_DATA_MAX_BYTES || 2500000); // ~2.5MB default
                    if (rawNext.length > maxBytes) {
                        return {};
                    }
                    let nextJson;
                    try { nextJson = JSON.parse(rawNext); } catch (_) { return {}; }
                    // Reuse extractor for meta if possible
                    let title = null, deadline = null, startDate = null, status = null;
                    const dehydrated = nextJson?.props?.pageProps?.dehydratedState;
                    if (dehydrated && Array.isArray(dehydrated.queries)) {
                        for (const q of dehydrated.queries) {
                            const data = q?.state?.data?.data;
                            const hearingObj = data?.data && data?.data?.type === 'hearing' ? data?.data : null;
                            if (hearingObj && hearingObj.attributes) {
                                deadline = hearingObj.attributes.deadline || deadline;
                                startDate = hearingObj.attributes.startDate || startDate;
                            }
                            const included = data?.included || [];
                            const contents = included.filter(x => x?.type === 'content');
                            const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                            if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());

                            // status may be in included as hearingStatus
                            const statusRelId = hearingObj?.relationships?.hearingStatus?.data?.id;
                            const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                            status = statusIncluded?.attributes?.name || status;
                        }
                    }
                    if (!status && deadline) status = (new Date(deadline) < new Date()) ? 'Konkluderet' : 'Afventer konklusion';
                    return { title, deadline, startDate, status };
                } catch (_) { return {}; }
            }

            // Fallback: try the public JSON API for a single hearing to extract title and dates
            async function fetchMetaFromApi(hearingId) {
                try {
                    const url = `${baseApi}/${hearingId}`;
                    const r = await axios.get(url, { validateStatus: () => true, headers: { Accept: 'application/json' } });
                    if (r.status !== 200 || !r.data) return {};
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    let title = '';
                    const contents = included.filter(x => x?.type === 'content');
                    const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                    if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
                    const attrs = item?.attributes || {};
                    const statusRelId = item?.relationships?.hearingStatus?.data?.id;
                    const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                    const status = statusIncluded?.attributes?.name || null;
                    return { title, deadline: attrs.deadline || null, startDate: attrs.startDate || null, status };
                } catch (_) { return {}; }
            }

            const concurrency = 5;
            let idx = 0;
            const runners = new Array(concurrency).fill(0).map(async () => {
                while (idx < missing.length) {
                    const mine = idx++;
                    const h = missing[mine];
                    let meta = await fetchMetaFromHearingHtml(h.id);
                    if (!meta.title) {
                        const viaApi = await fetchMetaFromApi(h.id);
                        meta = { ...viaApi, ...meta };
                    }
                    if (meta && (meta.title || meta.deadline || meta.startDate || meta.status)) {
                        // update in-memory
                        const target = hearingIndex.find(x => x.id === h.id);
                        if (target) {
                            target.title = meta.title || target.title;
                            target.startDate = meta.startDate || target.startDate;
                            target.deadline = meta.deadline || target.deadline;
                            target.status = meta.status || target.status;
                            target.normalizedTitle = normalizeDanish(target.title || '');
                            target.titleTokens = tokenize(target.title || '');
                            target.deadlineTs = target.deadline ? new Date(target.deadline).getTime() : null;
                            target.isOpen = computeIsOpen(target.status, target.deadline);
                        }
                    }
                }
            });
            await Promise.all(runners);
            
            // Check which ones still don't have titles
            missing = hearingIndex.filter(h => !h.title || !h.title.trim());
            retryCount++;
        }
        
        if (missing.length > 0) {
            console.warn(`Failed to fetch titles for ${missing.length} hearings after ${maxRetries} attempts`);
        }

        try {
            // Persist the possibly backfilled items to disk in the original shape
            const toWrite = hearingIndex.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
            fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items: toWrite }, null, 2));
        } catch {}
    } catch (e) {
        console.warn('warmHearingIndex failed:', e.message);
    }
}

// Sophisticated, Danish-aware suggest-as-you-type search endpoint
app.get('/api/search', async (req, res) => {
    const raw = String(req.query.q || '').trim();
    const q = normalizeDanish(raw);
    if (!q || q.length < 2) return res.json({ success: true, suggestions: [] });

    const isNumeric = /^\d+$/.test(raw.trim());

    function score(hi) {
        let s = 0;
        let matched = false;
        // ID prioritization
        if (isNumeric) {
            const rawNum = raw.trim();
            if (String(hi.id) === rawNum) { s += 120; matched = true; }
            else if (String(hi.id).startsWith(rawNum)) { s += 90; matched = true; }
            else if (String(hi.id).includes(rawNum)) { s += 10; matched = true; }
        }

        // Title scoring
        const titleNorm = hi.normalizedTitle;
        const tokens = hi.titleTokens;
        if (titleNorm.startsWith(q)) { s += 80; matched = true; }
        if (tokens.some(t => t.startsWith(q))) { s += 70; matched = true; }
        if (titleNorm.includes(q)) { s += 55; matched = true; }

        // Very light fuzzy: single deletion/insertion within small tokens
        if (q.length >= 3) {
            for (const t of tokens) {
                const dl = Math.abs(t.length - q.length);
                if (dl <= 1) {
                    const len = Math.min(t.length, q.length);
                    let diffs = 0;
                    for (let i = 0; i < len && diffs <= 1; i++) if (t[i] !== q[i]) diffs++;
                    if (diffs <= 1) { s += 40; matched = true; break; }
                }
            }
        }

        // If we had no match at all, exclude this item entirely
        if (!matched) return 0;

        // Boost open/active and upcoming deadlines (only after a match)
        if (hi.isOpen) s += 8;
        if (hi.deadlineTs) {
            const days = Math.max(0, Math.floor((hi.deadlineTs - Date.now()) / (24*3600*1000)));
            s += Math.max(0, 20 - Math.min(days, 20));
        }
        return s;
    }

        let ranked = hearingIndex
        .map(h => ({ h, s: score(h) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s || (a.h.deadlineTs || Infinity) - (b.h.deadlineTs || Infinity))
        .slice(0, 50);

    // On-demand title backfill for top items with missing/blank title (can be disabled via env)
    try {
        if (String(process.env.DISABLE_SEARCH_REMOTE_BACKFILL || '').toLowerCase() === 'true') {
            throw new Error('remote backfill disabled');
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': 'kk-xyz=1'
            },
            timeout: 25000
        });
        const toFix = ranked.filter(x => !(x.h.title && String(x.h.title).trim())).slice(0, 8);
        for (const item of toFix) {
            try {
                const root = await fetchHearingRootPage(baseUrl, item.h.id, axiosInstance);
                if (root?.nextJson) {
                    const meta = extractMetaFromNextJson(root.nextJson);
                    if (meta?.title) {
                        const idx = hearingIndex.findIndex(hh => hh.id === item.h.id);
                        if (idx >= 0) {
                            hearingIndex[idx].title = meta.title;
                            hearingIndex[idx].normalizedTitle = normalizeDanish(meta.title);
                            hearingIndex[idx].titleTokens = tokenize(meta.title);
                        }
                    }
                }
            } catch {}
        }
        // Re-rank after possible updates
        ranked = hearingIndex
            .map(h => ({ h, s: score(h) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s || (a.h.deadlineTs || Infinity) - (b.h.deadlineTs || Infinity))
            .slice(0, 50);
    } catch {}

    const out = ranked.map(x => ({
            id: x.h.id,
            title: (x.h.title && String(x.h.title).trim()) ? x.h.title : `Høring ${x.h.id}`,
            startDate: x.h.startDate,
            deadline: x.h.deadline,
            status: x.h.status
        }));

    res.json({ success: true, suggestions: out });
});

// Public hearing index: returns current in-memory index; builds it if missing
app.get('/api/hearing-index', async (req, res) => {
    try {
        const statusLike = String(req.query.status || '').trim().toLowerCase();
        const dbOnly = String(req.query.db || '').trim() === '1';
        // DB-first: always prefer current SQLite state
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.getHearingIndex) {
                // Try to use hearing_index table first if available
                try {
                    const indexRows = sqlite.getHearingIndex();
                    if (indexRows && indexRows.length > 0) {
                        hearingIndex = indexRows;
                    }
                } catch (_) {}
            }
            // Fallback to hearings table if hearing_index is empty
            if (!hearingIndex || hearingIndex.length === 0) {
                if (sqlite && sqlite.db && sqlite.db.prepare) {
                    let rows;
                    if (statusLike) {
                        rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all(statusLike);
                                    } else {
                    rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%afventer konklusion%'`).all();
                }
                    hearingIndex = (rows || []).map(enrichHearingForIndex);
                }
            }
        } catch (_) {}

        // If explicitly DB-only, return immediately (even if empty)
        // Filter to only show published hearings (those with published_at set OR published_responses/published_materials)
        if (dbOnly) {
            const itemsDbOnly = Array.isArray(hearingIndex) ? hearingIndex : [];
            // Filter to only include hearings that have published content
            try {
                const sqlite = require('./db/sqlite');
                if (sqlite && sqlite.db && sqlite.db.prepare) {
                    // Get list of hearing IDs that have published_at set in hearing_preparation_state
                    const publishedFromState = sqlite.db.prepare(`SELECT DISTINCT hearing_id FROM hearing_preparation_state WHERE published_at IS NOT NULL AND published_at > 0`).all();
                    // Also get hearings with published responses or materials
                    const publishedResponses = sqlite.db.prepare(`SELECT DISTINCT hearing_id FROM published_responses`).all();
                    const publishedMaterials = sqlite.db.prepare(`SELECT DISTINCT hearing_id FROM published_materials`).all();
                    
                    const publishedHearingIds = new Set();
                    publishedFromState.forEach(s => publishedHearingIds.add(Number(s.hearing_id)));
                    publishedResponses.forEach(r => publishedHearingIds.add(Number(r.hearing_id)));
                    publishedMaterials.forEach(m => publishedHearingIds.add(Number(m.hearing_id)));
                    
                    // If no published hearings found, check if we need to include all hearings from hearings table
                    // But filter to only those that exist in hearing_index or hearings table
                    if (publishedHearingIds.size === 0 && itemsDbOnly.length === 0) {
                        // Try to get hearings from hearings table and check if they're published
                        const allHearings = sqlite.db.prepare(`SELECT id, title, start_date as startDate, deadline, status FROM hearings WHERE archived IS NOT 1`).all();
                        const publishedHearings = allHearings.filter(h => publishedHearingIds.has(Number(h.id)));
                        if (publishedHearings.length > 0) {
                            const enriched = publishedHearings.map(enrichHearingForIndex);
                            return res.json({ success: true, hearings: enriched.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status })), count: enriched.length });
                        }
                    }
                    
                    // Filter index to only include published hearings
                    const hearingsDbOnly = itemsDbOnly
                        .filter(h => publishedHearingIds.has(Number(h.id)))
                        .map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
                    
                    // If index is empty but we have published hearings, try to enrich from hearings table
                    if (hearingsDbOnly.length === 0 && publishedHearingIds.size > 0) {
                        const publishedIdsArray = Array.from(publishedHearingIds);
                        // Use parameterized query with placeholders
                        const placeholders = publishedIdsArray.map(() => '?').join(',');
                        const allHearings = sqlite.db.prepare(`SELECT id, title, start_date as startDate, deadline, status FROM hearings WHERE id IN (${placeholders})`).all(...publishedIdsArray);
                        const enriched = allHearings.map(enrichHearingForIndex);
                        return res.json({ success: true, hearings: enriched.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status })), count: enriched.length });
                    }
                    
                    return res.json({ success: true, hearings: hearingsDbOnly, count: hearingsDbOnly.length });
                }
            } catch (err) {
                console.warn('[hearing-index] Failed to filter published hearings:', err.message);
                console.error('[hearing-index] Error details:', err);
            }
            // Fallback: return empty if we can't filter
            return res.json({ success: true, hearings: [], count: 0 });
        }

        // Fallback: build from persisted JSON files under PERSIST_DIR if DB empty
        if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
            try {
                const baseDir = PERSIST_DIR;
                const dir1 = path.join(baseDir, 'hearings');
                const dir2 = baseDir;
                const candidates = [];
                if (fs.existsSync(dir1)) candidates.push(dir1);
                if (fs.existsSync(dir2)) candidates.push(dir2);
                const items = [];
                for (const dir of candidates) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
                    for (const f of files.slice(0, 5000)) {
                        try {
                            const raw = fs.readFileSync(path.join(dir, f), 'utf8');
                            const json = JSON.parse(raw);
                            const h = json && json.hearing;
                            if (h && Number.isFinite(Number(h.id))) {
                                const isPlaceholderTitle = !h.title || /^Høring\s+\d+$/i.test(String(h.title||''));
                                items.push({ id: Number(h.id), title: isPlaceholderTitle ? `Høring ${h.id}` : h.title, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null });
                            }
                        } catch {}
                    }
                }
                if (statusLike) {
                    hearingIndex = items.filter(x => String(x.status || '').toLowerCase().includes(statusLike)).map(enrichHearingForIndex);
                } else {
                    hearingIndex = items.map(enrichHearingForIndex);
                }
            } catch {}
        }

        // If still empty or very small, warm from remote API to build index and persist to DB
        // DISABLED in LITE_MODE - user must manually fetch data
        if (!LITE_MODE && (!Array.isArray(hearingIndex) || hearingIndex.length < 10)) {
            // Strict DB-backed warm path only
            try { await warmHearingIndex(); } catch (_) {}
            // Refresh from DB after warm
            try {
                const sqlite = require('./db/sqlite');
                if (sqlite && sqlite.db && sqlite.db.prepare) {
                    let rows;
                    if (statusLike) {
                        rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all(statusLike);
                                    } else {
                    rows = sqlite.db.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%afventer konklusion%'`).all();
                }
                    hearingIndex = (rows || []).map(enrichHearingForIndex);
                }
            } catch (_) {}
        }

        let items = Array.isArray(hearingIndex) ? hearingIndex : [];
        // If index looks too small, augment from persisted JSON and persist to SQLite
        try {
            if (!Array.isArray(items) || items.length < 10) {
                const baseDir = PERSIST_DIR;
                const dir1 = path.join(baseDir, 'hearings');
                const dir2 = baseDir;
                const candidates = [];
                if (fs.existsSync(dir1)) candidates.push(dir1);
                if (fs.existsSync(dir2)) candidates.push(dir2);
                const byId = new Map(items.map(h => [Number(h.id), h]));
                for (const dir of candidates) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
                    for (const f of files.slice(0, 5000)) {
                        try {
                            const raw = fs.readFileSync(path.join(dir, f), 'utf8');
                            const json = JSON.parse(raw);
                            const h = json && json.hearing;
                            if (h && Number.isFinite(Number(h.id))) {
                                const idNum = Number(h.id);
                                if (!byId.has(idNum)) {
                                    const isPlaceholderTitle = !h.title || /^Høring\s+\d+$/i.test(String(h.title||''));
                                    const rec = enrichHearingForIndex({ id: idNum, title: isPlaceholderTitle ? `Høring ${idNum}` : h.title, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null });
                                    byId.set(idNum, rec);
                                    try { upsertHearing({ id: idNum, title: rec.title, startDate: rec.startDate, deadline: rec.deadline, status: rec.status }); } catch {}
                                }
                            }
                        } catch {}
                    }
                }
                items = Array.from(byId.values());
            }
        } catch {}

        // Backfill missing/placeholder titles and meta from HTML (__NEXT_DATA__) for up to 50 items
        try {
            const baseUrl = 'https://blivhoert.kk.dk';
            const axiosInstance = axios.create({
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/json',
                    'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                    'Cookie': 'kk-xyz=1',
                    'Origin': baseUrl,
                    'Referer': baseUrl
                },
                timeout: 20000,
                validateStatus: () => true
            });
            const needs = items.filter(h => !h || !h.title || /^Høring\s+\d+$/i.test(String(h.title||''))).slice(0, 50);
            for (const h of needs) {
                try {
                    const root = await fetchHearingRootPage(baseUrl, h.id, axiosInstance);
                    if (root && root.nextJson) {
                        const meta = extractMetaFromNextJson(root.nextJson);
                        if (meta) {
                            if (meta.title) h.title = meta.title;
                            if (meta.startDate) h.startDate = meta.startDate;
                            if (meta.deadline) h.deadline = meta.deadline;
                            if (meta.status) h.status = meta.status;
                            try { upsertHearing({ id: h.id, title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null }); } catch {}
                            // Update in-memory index as well
                            const idx = hearingIndex.findIndex(x => Number(x.id) === Number(h.id));
                            if (idx >= 0) {
                                const updated = { ...hearingIndex[idx] };
                                updated.title = h.title;
                                updated.startDate = h.startDate;
                                updated.deadline = h.deadline;
                                updated.status = h.status;
                                updated.normalizedTitle = normalizeDanish(updated.title || '');
                                updated.titleTokens = tokenize(updated.title || '');
                                updated.deadlineTs = updated.deadline ? new Date(updated.deadline).getTime() : null;
                                updated.isOpen = computeIsOpen(updated.status, updated.deadline);
                                hearingIndex[idx] = updated;
                            }
                        }
                    }
                } catch {}
            }
        } catch {}
        if (statusLike) {
            items = items.filter(h => String(h.status || '').toLowerCase().includes(statusLike));
        }
        const hearings = items.map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
        return res.json({ success: true, hearings, count: hearings.length });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Kunne ikke hente hørelsesindeks', error: e.message });
    }
});

// Diagnostics: force warm-up now and report item count
app.get('/api/warm-now', async (req, res) => {
    try {
        await warmHearingIndex();
        return res.json({ success: true, count: Array.isArray(hearingIndex) ? hearingIndex.length : 0 });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Diagnostics: verify outbound connectivity to blivhoert API
app.get('/api/test-outbound', async (req, res) => {
    try {
        const baseUrl = 'https://blivhoert.kk.dk';
        const url = `${baseUrl}/api/hearing?PageIndex=1&PageSize=3`;
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                'Referer': baseUrl,
                'Cookie': 'kk-xyz=1'
            },
            timeout: 20000,
            validateStatus: () => true
        });
        const r = await axiosInstance.get(url);
        const ct = (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '';
        let sample = '';
        try { sample = JSON.stringify(r.data).slice(0, 500); } catch { sample = String(r.data).slice(0, 500); }
        return res.json({ success: true, status: r.status, contentType: ct, hasData: !!r.data, sample });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message, code: e.code || null });
    }
});

// Full hearings index with optional filtering and ordering
app.get('/api/hearings', (req, res) => {
    try {
        const { q = '' } = req.query;
        const raw = String(q || '').trim();
        const norm = normalizeDanish(raw);

        const sqlite = require('./db/sqlite');
        let results = [];
        if (sqlite && sqlite.db && sqlite.db.prepare) {
            try {
                results = sqlite.db
                    .prepare(`SELECT id, title, start_date as startDate, deadline, status FROM hearings WHERE archived IS NOT 1`)
                    .all();
            } catch (_) { results = []; }
        }

        // Fallback to in-memory index or persisted JSON if DB is empty
        if (!Array.isArray(results) || results.length === 0) {
            try {
                // If global index is empty, try to warm it from persisted JSON (support both data/ and data/hearings/)
                if (!Array.isArray(hearingIndex) || hearingIndex.length === 0) {
                    try {
                        const baseDir = PERSIST_DIR;
                        const dir1 = path.join(baseDir, 'hearings');
                        const dir2 = baseDir;
                        const candidates = [];
                        if (fs.existsSync(dir1)) candidates.push(dir1);
                        if (fs.existsSync(dir2)) candidates.push(dir2);
                        const seen = new Set();
                        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
                        const items = [];
                        for (const dir of candidates) {
                            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
                            for (const f of files.slice(0, 5000)) {
                                if (seen.has(f)) continue;
                                seen.add(f);
                                try {
                                    const rawFile = fs.readFileSync(path.join(dir, f), 'utf8');
                                    const json = JSON.parse(rawFile);
                                    const h = json && json.hearing;
                                    if (h && Number.isFinite(Number(h.id))) {
                                        items.push({ id: Number(h.id), title: h.title || `Høring ${h.id}`, startDate: h.startDate || null, deadline: h.deadline || null, status: h.status || null });
                                    }
                                } catch {}
                            }
                        }
                        hearingIndex = items.map(enrichHearingForIndex);
                    } catch {}
                }
                results = (Array.isArray(hearingIndex) ? hearingIndex : []).map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
            } catch { results = []; }
        }

        if (norm) {
            const isNumeric = /^\d+$/.test(raw);
            results = (results || []).filter(h => {
                if (!h) return false;
                if (isNumeric && String(h.id).includes(raw)) return true;
                const normTitle = normalizeDanish(String(h.title || ''));
                return normTitle.includes(norm) || String(h.id).includes(raw);
            });
        }

        results.sort((a, b) => {
            const da = a && a.deadline ? new Date(a.deadline).getTime() : Infinity;
            const db = b && b.deadline ? new Date(b.deadline).getTime() : Infinity;
            if (da !== db) return da - db;
            return (a.id || 0) - (b.id || 0);
        });

        const out = (results || []).map(h => ({ id: h.id, title: h.title, startDate: h.startDate, deadline: h.deadline, status: h.status }));
        res.json({ success: true, total: out.length, hearings: out });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

function fixEncoding(text) {
    if (typeof text !== 'string') return text;
    // Fix common encoding issues
    return text
        .replace(/\uFFFD/g, '') // Remove replacement character
        .replace(/Ã¦/g, 'æ')
        .replace(/Ã¸/g, 'ø')
        .replace(/Ã¥/g, 'å')
        .replace(/Ã†/g, 'Æ')
        .replace(/Ã˜/g, 'Ø')
        .replace(/Ã…/g, 'Å')
        .replace(/â€"/g, '–')
        .replace(/â€™/g, "'")
        .replace(/â€œ/g, '"')
        .replace(/â€/g, '"')
        .trim();
}

function buildFileUrl(_baseUrl, filePath, fileName) {
    if (!filePath) return null;
    const qs = new URLSearchParams();
    qs.set('path', filePath);
    if (fileName) qs.set('filename', fileName);
    return `/api/file-proxy?${qs.toString()}`;
}

// Proxy to try known download routes and stream back to client
app.get('/api/file-proxy', async (req, res) => {
    try {
        const rawPath = String(req.query.path || '').trim();
        if (!rawPath) return res.status(400).json({ success: false, message: 'Missing path' });
        const fileName = String(req.query.filename || '').trim();
        const baseUrl = 'https://blivhoert.kk.dk';
        const encoded = encodeURIComponent(rawPath);

        const hearingIdMatch = rawPath.match(/Hearing-(\d+)/i);
        const referer = hearingIdMatch ? `${baseUrl}/hearing/${hearingIdMatch[1]}/comments` : `${baseUrl}`;

        const apiKey = process.env.BLIWHOERT_API_KEY || process.env.NEXT_PUBLIC_EXT_X_API_HEADER || process.env.X_API_HEADER;
        const customHeaderName = process.env.FILE_API_HEADER_NAME || process.env.EXT_FILE_API_HEADER_NAME || '';
        const customHeaderValue = process.env.FILE_API_HEADER_VALUE || process.env.EXT_FILE_API_HEADER_VALUE || '';
        const extraCookie = process.env.BLIWHOERT_COOKIE || '';
        const withKey = apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : '';
        const candidates = /^https?:\/\//i.test(rawPath)
            ? [rawPath]
            : [
                // API route with query apiKey
                `${baseUrl}/api/file?path=${encoded}${withKey}`,
                // API route relying on header-based key
                `${baseUrl}/api/file?path=${encoded}`,
                // File route variants
                `${baseUrl}/file?path=${encoded}${withKey}`,
                `${baseUrl}/file?path=${encoded}`,
                // Raw path (rarely exposed, but try)
                `${baseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}${withKey ? (rawPath.includes('?')?'&':'?')+withKey.slice(1):''}`
            ];

        const axiosClient = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
                'Referer': referer,
                'Origin': baseUrl,
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': `${extraCookie ? extraCookie + '; ' : ''}kk-xyz=1`,
                ...(apiKey ? { 'X-API-KEY': apiKey, 'X-API-HEADER': apiKey } : {}),
                ...(customHeaderName && customHeaderValue ? { [customHeaderName]: customHeaderValue } : {})
            },
            responseType: 'stream',
            validateStatus: () => true,
            timeout: 30000
        });

        let streamResp;
        for (const u of candidates) {
            try {
                const r = await axiosClient.get(u);
                if (r.status === 200 && r.data) { streamResp = r; break; }
            } catch (_) {}
        }
        // Retry with small backoff if not found
        if (!streamResp) {
            await sleep(400);
            for (const u of candidates) {
                try {
                    const r = await axiosClient.get(u);
                    if (r.status === 200 && r.data) { streamResp = r; break; }
                } catch (_) {}
            }
        }
        if (!streamResp) {
            return res.status(404).json({ success: false, message: 'Fil ikke fundet' });
        }
        const dispositionName = fileName || 'dokument.pdf';
        res.setHeader('Content-Disposition', `inline; filename="${dispositionName}"`);
        const ctype = streamResp.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', ctype);
        streamResp.data.pipe(res);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Proxy-fejl', error: e.message });
    }
});

// HEAD helper to allow UI to estimate token size of file links
app.head('/api/file-proxy', async (req, res) => {
    try {
        const rawPath = String(req.query.path || '').trim();
        if (!rawPath) return res.status(400).end();
        const fileName = String(req.query.filename || '').trim();
        const baseUrl = 'https://blivhoert.kk.dk';
        const encoded = encodeURIComponent(rawPath);
        const apiKey = process.env.BLIWHOERT_API_KEY || process.env.NEXT_PUBLIC_EXT_X_API_HEADER || process.env.X_API_HEADER;
        const withKey = apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : '';
        const candidates = /^https?:\/\//i.test(rawPath)
            ? [rawPath]
            : [
                `${baseUrl}/api/file?path=${encoded}${withKey}`,
                `${baseUrl}/api/file?path=${encoded}`,
                `${baseUrl}/file?path=${encoded}${withKey}`,
                `${baseUrl}/file?path=${encoded}`,
                `${baseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}${withKey ? (rawPath.includes('?')?'&':'?')+withKey.slice(1):''}`
            ];
        for (const u of candidates) {
            try {
                const r = await axios.head(u, { validateStatus: () => true });
                if (r.status === 200) {
                    if (r.headers['content-length']) res.setHeader('Content-Length', r.headers['content-length']);
                    if (r.headers['content-type']) res.setHeader('Content-Type', r.headers['content-type']);
                    return res.status(200).end();
                }
            } catch {}
        }
        return res.status(404).end();
    } catch {
        return res.status(500).end();
    }
});

// Strict extractor: build responses from a Next.js dehydrated JSON root (one page)
async function extractStructuredFromNextJson(jsonRoot, baseUrl) {
    const out = [];
    let totalPages = null;
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];

        const envelopes = [];

        function scanNode(node, parent) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                if (node.some(it => it && it.type === 'comment')) {
                    const included = Array.isArray(parent?.included) ? parent.included : [];
                    const meta = parent?.meta || {};
                    envelopes.push({ data: node, included, meta });
                } else {
                    for (const item of node) scanNode(item, parent);
                }
                return;
            }
            // Object with data array containing comments
            if (Array.isArray(node.data) && node.data.some(it => it && it.type === 'comment')) {
                envelopes.push({ data: node.data, included: Array.isArray(node.included) ? node.included : [], meta: node.meta || {} });
            }
            // Object with nested data.data
            if (node.data && Array.isArray(node.data.data) && node.data.data.some(it => it && it.type === 'comment')) {
                envelopes.push({ data: node.data.data, included: Array.isArray(node.included) ? node.included : [], meta: node.meta || {} });
            }
            for (const k of Object.keys(node)) {
                scanNode(node[k], node);
            }
        }
        
        for (const query of queries) {
            const root1 = query?.state?.data;
            if (root1) scanNode(root1, null);
            const root2 = query?.state?.data?.data;
            if (root2) scanNode(root2, query?.state?.data || null);
        }

        const seenIds = new Set();
        for (const env of envelopes) {
            const pagesFromEnvelope = env?.meta?.Pagination?.totalPages;
            if (typeof pagesFromEnvelope === 'number' && pagesFromEnvelope > 0) {
                totalPages = pagesFromEnvelope;
            }
            const comments = Array.isArray(env?.data) ? env.data : [];
            const included = Array.isArray(env?.included) ? env.included : [];
                const contentById = new Map();
                included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
                const userById = new Map();
                included.filter(x => x?.type === 'user').forEach(u => userById.set(String(u.id), u));
                const companyById = new Map();
                included.filter(x => x?.type === 'company').forEach(c => companyById.set(String(c.id), c));
                                
                for (const item of comments) {
                    if (!item || item.type !== 'comment') continue;
                    const attrs = item.attributes || {};
                    const rel = item.relationships || {};
                    const responseNumber = attrs.number || null;
                if (responseNumber == null) continue;
                if (seenIds.has(Number(responseNumber))) continue;
                seenIds.add(Number(responseNumber));

                    const created = attrs.created || null;
                    const withdrawn = attrs.withdrawn || attrs.isDeleted || false;
                    const onBehalfOf = attrs.onBehalfOf || null;
                                    
                    let author = null;
                    let organization = null;
                    let authorAddress = null;
                                    
                    const userRelId = rel?.user?.data?.id && String(rel.user.data.id);
                    if (userRelId && userById.has(userRelId)) {
                        const u = userById.get(userRelId);
                        const uattrs = u?.attributes || {};
                        author = uattrs.employeeDisplayName || uattrs.email || uattrs.identifier || null;
                        const street = uattrs.streetName || '';
                        const postal = uattrs.postalCode || '';
                        const city = uattrs.city || '';
                        authorAddress = [street, postal, city].filter(Boolean).join(', ') || null;
                        const companyRelId = u?.relationships?.company?.data?.id && String(u.relationships.company.data.id);
                        if (companyRelId && companyById.has(companyRelId)) {
                            const comp = companyById.get(companyRelId);
                            organization = comp?.attributes?.name || null;
                        }
                    }
                                    
                    const contentRels = Array.isArray(rel?.contents?.data) ? rel.contents.data : [];
                    let text = '';
                    const attachments = [];
                    for (const cref of contentRels) {
                        const cid = cref?.id && String(cref.id);
                        if (!cid || !contentById.has(cid)) continue;
                        const c = contentById.get(cid);
                        const cattrs = c?.attributes || {};
                        const hasText = typeof cattrs.textContent === 'string' && cattrs.textContent.trim().length > 0;
                        const hasFile = typeof cattrs.filePath === 'string' && cattrs.filePath.trim().length > 0;
                    if (hasText) text += (text ? '\n\n' : '') + String(cattrs.textContent).trim();
                        if (hasFile) {
                            const filePath = String(cattrs.filePath || '').trim();
                            const fileName = String(cattrs.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                        attachments.push({ 
                            url: buildFileUrl(baseUrl, filePath, fileName), 
                            filename: fileName,
                            contentId: cid,
                            downloadUrl: `https://blivhoert.kk.dk/api/content/${cid}/download?apiKey=`
                        });
                        }
                    }
                    if (!withdrawn && (text.trim().length > 0 || attachments.length > 0)) {
                        out.push({
                            responseNumber,
                            text: fixEncoding(text || ''),
                            author: author || null,
                            authorAddress,
                            organization: organization || null,
                            onBehalfOf: onBehalfOf || null,
                            submittedAt: created || null,
                            attachments
                        });
                    }
                }
            }
        return { responses: out, totalPages };
    } catch (e) {
        console.error("Error in extractStructuredFromNextJson:", e);
        return { responses: out, totalPages: null };
    }
}

// Extract hearing materials (files, external document links, and full hearing text) from Next.js dehydrated JSON on the hearing root page
function extractMaterialsFromNextJson(jsonRoot, baseUrl) {
    const materials = [];
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;

            const envelope = root;
            const hearingObj = envelope?.data && envelope?.data?.type === 'hearing' ? envelope.data : null;
            if (!hearingObj) continue;

            const included = Array.isArray(envelope?.included) ? envelope.included : [];
            const contentById = new Map();
            included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));

            const contentRefs = Array.isArray(hearingObj?.relationships?.contents?.data) ? hearingObj.relationships.contents.data : [];

            let combinedText = '';
            const discoveredLinks = new Map(); // url -> { title }

            function shouldIgnoreExternal(url) {
                const u = String(url).toLowerCase();
                if (u.includes('klagevejledning')) return true;
                if (u.includes('kk.dk/dagsordener-og-referater')) return true;
                // Allow direct Plandata document PDFs
                const isPlanDocPdf = /dokument\.plandata\.dk\/.*\.pdf(\?|$)/.test(u);
                if (isPlanDocPdf) return false;
                // Ignore other generic Plandata/Plst pages
                if (u.includes('plst.dk') || u.includes('plandata.dk') || u.includes('plandata')) return true;
                return false;
            }

            function addLink(url, title) {
                if (!url) return;
                const clean = String(url).trim();
                if (!clean) return;
                if (shouldIgnoreExternal(clean)) return;
                if (!discoveredLinks.has(clean)) discoveredLinks.set(clean, { title: title || clean });
            }

            for (const cref of contentRefs) {
                const cid = cref?.id && String(cref.id);
                if (!cid || !contentById.has(cid)) continue;
                const c = contentById.get(cid);
                const a = c?.attributes || {};
                const rel = c?.relationships || {};
                const isHearingField = !!(rel?.field?.data?.id);
                const isCommentContent = !!(rel?.comment?.data?.id);
                const hasText = typeof a.textContent === 'string' && a.textContent.trim().length > 0;
                const hasFile = typeof a.filePath === 'string' && a.filePath.trim().length > 0;

                // Include text from any hearing field content (not comments)
                if (hasText && isHearingField && !isCommentContent) {
                    const text = String(a.textContent).trim();
                    combinedText += (combinedText ? '\n\n' : '') + text;
                    // Extract markdown-style links [title](url)
                    const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
                    let m;
                    while ((m = mdLinkRe.exec(text)) !== null) {
                        addLink(m[2], m[1]);
                    }
                    // Extract bare URLs
                    const urlRe = /(https?:\/\/[^\s)]+)(?![^\[]*\])/g;
                    let u;
                    while ((u = urlRe.exec(text)) !== null) {
                        addLink(u[1]);
                    }
                }
                // Include files that belong to hearing fields (not comments)
                if (hasFile && isHearingField && !isCommentContent) {
                    const filePath = String(a.filePath || '').trim();
                    if (!/\/(fields|Fields)\//.test(filePath)) {
                        // Some deployments use different path segments; still allow if relationship indicates a hearing field
                        // Keep permissive to avoid missing materials
                    }
                    const fileName = String(a.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                    materials.push({
                        type: 'file',
                        title: fileName,
                        url: buildFileUrl(baseUrl, filePath, fileName)
                    });
                }
            }

            if (combinedText.trim().length > 0) {
                materials.push({ type: 'description', title: 'Høringstekst', content: fixEncoding(combinedText) });
            }

            // Add discovered external document links as file-like entries (prioritize obvious document URLs)
            for (const [url, meta] of discoveredLinks.entries()) {
                // Only include external document links that are not in the ignore list (already filtered)
                const lower = url.toLowerCase();
                const looksDoc = /\.(pdf|doc|docx|xls|xlsx)$/i.test(lower);
                if (looksDoc) {
                    materials.push({ type: 'file', title: meta.title || url, url });
                }
            }
        }
    } catch (e) {
        console.error('Error in extractMaterialsFromNextJson:', e);
    }
    // De-duplicate by (title,url)
    const seen = new Set();
    const deduped = [];
    for (const m of materials) {
        const key = `${m.type}|${m.title || ''}|${m.url || ''}|${(m.content || '').slice(0,50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(m);
    }
    return deduped;
}

// Extract hearing meta (title, dates, status) from Next.js dehydrated JSON
function extractMetaFromNextJson(jsonRoot) {
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];
        let title = null, deadline = null, startDate = null, status = null;
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;
            const envelope = root;
            const hearingObj = envelope?.data && envelope?.data?.type === 'hearing' ? envelope.data : null;
            if (hearingObj && hearingObj.attributes) {
                deadline = hearingObj.attributes.deadline || deadline;
                startDate = hearingObj.attributes.startDate || startDate;
                // Try to get title directly from attributes if available
                if (hearingObj.attributes.title && !title) {
                    title = fixEncoding(String(hearingObj.attributes.title).trim());
                }
            }
            const included = Array.isArray(envelope?.included) ? envelope.included : [];
            const contents = included.filter(x => x?.type === 'content');
            
            // Look for title in content fields - try multiple field IDs
            if (!title) {
                // Field ID 1 is typically the title
                const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
            }
            
            // Fallback: look for any content field that looks like a title
            if (!title) {
                for (const content of contents) {
                    if (content?.attributes?.textContent) {
                        const text = String(content.attributes.textContent).trim();
                        // Title is typically shorter than 200 chars and doesn't contain multiple paragraphs
                        if (text.length > 0 && text.length < 200 && !text.includes('\n\n')) {
                            title = fixEncoding(text);
                            break;
                        }
                    }
                }
            }
            
            const statusRelId = hearingObj?.relationships?.hearingStatus?.data?.id;
            const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
            status = statusIncluded?.attributes?.name || status;
        }
        return { title, deadline, startDate, status };
    } catch {
        return { title: null, deadline: null, startDate: null, status: null };
    }
}

async function fetchHearingRootPage(baseUrl, hearingId, axiosInstance) {
    const url = `${baseUrl}/hearing/${hearingId}`;
    const resp = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 3, baseDelayMs: 600 });
    if (resp.status !== 200 || !resp.data) { logDebug(`[fetchHearingRootPage] ${url} -> HTTP ${resp.status}`); return { materials: [], nextJson: null }; }
    const $ = cheerio.load(resp.data);
    const nextDataEl = $('script#__NEXT_DATA__');
    if (!nextDataEl.length) { logDebug(`[fetchHearingRootPage] ${url} -> missing __NEXT_DATA__`); return { materials: [], nextJson: null }; }
    const rawNext = String(nextDataEl.html() || '');
    const maxBytes = Number(process.env.NEXT_DATA_MAX_BYTES || 2500000);
    if (rawNext.length > maxBytes) { logDebug(`[fetchHearingRootPage] ${url} -> __NEXT_DATA__ too large (${rawNext.length} > ${maxBytes})`); return { materials: [], nextJson: null }; }
    let nextJson; try { nextJson = JSON.parse(rawNext); } catch (_) { return { materials: [], nextJson: null }; }
    const materials = extractMaterialsFromNextJson(nextJson, baseUrl);
    logDebug(`[fetchHearingRootPage] ${url} -> materials=${materials.length}`);
    return { materials, nextJson };
}

// Fetch a Next.js comments page and extract responses for that page
async function fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance) {
    const tryUrls = [
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?page=${pageIndex}` : ''}`,
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?Page=${pageIndex}` : ''}`,
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?pageIndex=${pageIndex}` : ''}`,
        `${baseUrl}/hearing/${hearingId}/comments${pageIndex && pageIndex > 1 ? `?PageIndex=${pageIndex}` : ''}`
    ];
    for (const url of tryUrls) {
        const resp = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 3, baseDelayMs: 500 });
        if (resp.status !== 200 || !resp.data) { logDebug(`[fetchCommentsPage] ${url} -> HTTP ${resp.status}`); continue; }
        const $ = cheerio.load(resp.data);
        const nextDataEl = $('script#__NEXT_DATA__');
        if (!nextDataEl.length) { logDebug(`[fetchCommentsPage] ${url} -> missing __NEXT_DATA__`); continue; }
        const rawNext = String(nextDataEl.html() || '');
        const maxBytes = Number(process.env.NEXT_DATA_MAX_BYTES || 2500000);
        if (rawNext.length > maxBytes) { logDebug(`[fetchCommentsPage] ${url} -> __NEXT_DATA__ too large (${rawNext.length} > ${maxBytes})`); continue; }
        let nextJson; try { nextJson = JSON.parse(rawNext); } catch (_) { continue; }
        const { responses, totalPages } = await extractStructuredFromNextJson(nextJson, baseUrl);
        logDebug(`[fetchCommentsPage] ${url} -> responses=${responses.length}, totalPages=${totalPages}`);
        return { responses, totalPages, nextJson };
    }
    return { responses: [], totalPages: null, nextJson: null };
}

// Fallback: Use the public API endpoints directly if HTML/Next data is not available
async function fetchCommentsViaApi(apiBaseUrl, hearingId, axiosInstance) {
    const all = [];
    let totalPages = null;
    const url = `${apiBaseUrl}/hearing/${hearingId}/comment`;
    const maxPages = 100;

    async function fetchPage(idx, paramKey) {
        return withRetries(() => axiosInstance.get(url, {
            validateStatus: () => true,
            headers: { Accept: 'application/json' },
            params: { include: 'Contents,Contents.ContentType', [paramKey]: idx }
        }), { attempts: 2, baseDelayMs: 300 });
    }

    // Detect which param key to use
    let paramKey = 'Page';
    let resp = await fetchPage(1, 'Page');
    let items = Array.isArray(resp?.data?.data) ? resp.data.data : [];
    if (resp.status !== 200 || items.length === 0) {
        const respAlt = await fetchPage(1, 'PageIndex');
        const itemsAlt = Array.isArray(respAlt?.data?.data) ? respAlt.data.data : [];
        if (respAlt.status === 200 && itemsAlt.length > 0) {
            paramKey = 'PageIndex';
            resp = respAlt;
            items = itemsAlt;
        }
    }
    if (resp?.status !== 200 || !resp?.data) return { responses: [], totalPages: null };
    const includedFirst = Array.isArray(resp?.data?.included) ? resp.data.included : [];
    const pageResponsesFirst = await mapCommentsFromJsonApi(items, includedFirst, apiBaseUrl.replace('/api', ''));
    totalPages = resp?.data?.meta?.Pagination?.totalPages || null;
    if (Array.isArray(pageResponsesFirst) && pageResponsesFirst.length) {
        all.push(...pageResponsesFirst.map(r => ({ ...r, page: 1 })));
    }

    // If we got a large batch on page 1 without pagination metadata, assume all data was returned
    // This handles the case where the API returns all items at once (no pagination)
    const LARGE_BATCH_THRESHOLD = 100;
    if (totalPages === null && pageResponsesFirst.length >= LARGE_BATCH_THRESHOLD) {
        console.log(`[fetchCommentsViaApi] Large batch (${pageResponsesFirst.length}) received without pagination - assuming all data fetched`);
        return { responses: all, totalPages: 1 };
    }

    // Fetch remaining pages
    let consecutiveEmpty = 0;
    const lastPage = Number.isFinite(totalPages) && totalPages > 0 ? Math.min(totalPages, maxPages) : maxPages;
    for (let pageIndex = 2; pageIndex <= lastPage; pageIndex += 1) {
        const r = await fetchPage(pageIndex, paramKey);
        if (r.status !== 200 || !r.data) { consecutiveEmpty += 1; if (consecutiveEmpty >= 2 && !Number.isFinite(totalPages)) break; else continue; }
        const itemsN = Array.isArray(r?.data?.data) ? r.data.data : [];
        const includedN = Array.isArray(r?.data?.included) ? r.data.included : [];
        const pageResponses = await mapCommentsFromJsonApi(itemsN, includedN, apiBaseUrl.replace('/api', ''));
        if (!Array.isArray(pageResponses) || pageResponses.length === 0) {
            consecutiveEmpty += 1;
            if (consecutiveEmpty >= 2 && !Number.isFinite(totalPages)) break;
        } else {
            consecutiveEmpty = 0;
            all.push(...pageResponses.map(r => ({ ...r, page: pageIndex })));
        }
        if (Number.isFinite(totalPages) && totalPages > 0 && pageIndex >= totalPages) break;
    }
    return { responses: all, totalPages };
}

async function mapCommentsFromJsonApi(comments, included, baseUrl) {
    const contentById = new Map();
    included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));

    const userById = new Map();
    included.filter(x => x?.type === 'user').forEach(u => userById.set(String(u.id), u));

    const companyById = new Map();
    included.filter(x => x?.type === 'company').forEach(c => companyById.set(String(c.id), c));

    const outPromises = comments.map(async (item) => {
        if (!item || item.type !== 'comment') return null;
        const attrs = item.attributes || {};
        const rel = item.relationships || {};
        const responseNumber = attrs.number || null;
        const created = attrs.created || null;
        const withdrawn = attrs.withdrawn || attrs.isDeleted || false;
        const onBehalfOf = attrs.onBehalfOf || null;

        let author = null;
        let organization = null;
        let authorAddress = null;

        const userRelId = rel?.user?.data?.id && String(rel.user.data.id);
        if (userRelId && userById.has(userRelId)) {
            const u = userById.get(userRelId);
            const uattrs = u?.attributes || {};
            author = uattrs.employeeDisplayName || uattrs.email || uattrs.identifier || null;
            const street = uattrs.streetName || '';
            const postal = uattrs.postalCode || '';
            const city = uattrs.city || '';
            authorAddress = [street, postal, city].filter(Boolean).join(', ') || null;
            const companyRelId = u?.relationships?.company?.data?.id && String(u.relationships.company.data.id);
            if (companyRelId && companyById.has(companyRelId)) {
                const comp = companyById.get(companyRelId);
                organization = comp?.attributes?.name || null;
            }
        }

        const contentRels = Array.isArray(rel?.contents?.data) ? rel.contents.data : [];
        let text = '';
        
        const attachmentPromises = contentRels.map(async (cref) => {
            const cid = cref?.id && String(cref.id);
            if (!cid || !contentById.has(cid)) return null;
            const c = contentById.get(cid);
            const cattrs = c?.attributes || {};
            const hasText = typeof cattrs.textContent === 'string' && cattrs.textContent.trim().length > 0;
            if (hasText) {
                text += (text ? '\n\n' : '') + String(cattrs.textContent).trim();
            }
            const hasFile = typeof cattrs.filePath === 'string' && cattrs.filePath.trim().length > 0;
            if (hasFile) {
                const filePath = String(cattrs.filePath || '').trim();
                const fileName = String(cattrs.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                // Include contentId for direct download via /api/content/{id}/download
                return { 
                    url: buildFileUrl(baseUrl, filePath, fileName), 
                    filename: fileName,
                    contentId: cid,
                    downloadUrl: `https://blivhoert.kk.dk/api/content/${cid}/download?apiKey=`
                };
            }
            return null;
        }).filter(Boolean);

        const attachments = (await Promise.all(attachmentPromises)).filter(Boolean);

        if (!withdrawn && (text.trim().length > 0 || attachments.length > 0)) {
            return {
                responseNumber,
                text: fixEncoding(text || ''),
                author: author || null,
                authorAddress,
                organization: organization || null,
                onBehalfOf: onBehalfOf || null,
                submittedAt: created || null,
                attachments
            };
        }
        return null;
    });

    return (await Promise.all(outPromises)).filter(Boolean);
}

function normalizeResponses(responses) {
    // Ensure deterministic sort and normalized shapes for API consumers
    const cleaned = responses
        .filter(r => r && (typeof r.responseNumber === 'number' || typeof r.responseNumber === 'string'))
        .map(r => ({
            id: Number(r.responseNumber),
            text: r.text || '',
            author: r.author || null,
            authorAddress: r.authorAddress || null,
            organization: r.organization || null,
            onBehalfOf: r.onBehalfOf || null,
            submittedAt: r.submittedAt || null,
            page: typeof r.page === 'number' ? r.page : null,
            attachments: Array.isArray(r.attachments) ? r.attachments.map(a => ({
                filename: a.filename || (a.url ? String(a.url).split('/').pop() : 'Dokument'),
                url: a.url,
                contentId: a.contentId || null,
                downloadUrl: a.downloadUrl || null
            })) : []
        }));
    cleaned.sort((a, b) => (a.id || 0) - (b.id || 0));
    return cleaned;
}

function mergeResponsesPreferFullText(a, b) {
    const byId = new Map();
    const add = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const r of arr) {
            if (!r) continue;
            const idKey = Number(r.responseNumber ?? r.id);
            const existing = byId.get(idKey);
            if (!existing) byId.set(idKey, r);
            else {
                const existingTextLen = (existing.text || '').length;
                const newTextLen = (r.text || '').length;
                // Prefer the one with longer text, but preserve page if available
                const winner = newTextLen > existingTextLen ? r : existing;
                // Preserve page number if available (prefer non-null)
                const page = winner.page !== null && winner.page !== undefined ? winner.page : (r.page !== null && r.page !== undefined ? r.page : existing.page);
                byId.set(idKey, { ...winner, page });
            }
        }
    };
    add(a);
    add(b);
    return Array.from(byId.values());
}


function buildAggregateResponseFromDb(hearingId) {
    const aggregate = readAggregate(hearingId);
    if (!aggregate || !aggregate.hearing) return null;
    const responses = Array.isArray(aggregate.responses) ? aggregate.responses : [];
    const hearing = { ...(aggregate.hearing || {}) };
    try {
        const meta = readPersistedHearingWithMeta(hearingId);
        const persisted = meta?.data;
        if (persisted && persisted.hearing) {
            const pj = persisted.hearing;
            const isPlaceholderTitle = !hearing.title || /^Høring\s+\d+$/i.test(String(hearing.title || ''));
            const isUnknownStatus = !hearing.status || String(hearing.status || '').toLowerCase() === 'ukendt';
            if (isPlaceholderTitle && pj.title) hearing.title = pj.title;
            if (!hearing.startDate && pj.startDate) hearing.startDate = pj.startDate;
            if (!hearing.deadline && pj.deadline) hearing.deadline = pj.deadline;
            if (isUnknownStatus && pj.status) hearing.status = pj.status;
        }
    } catch {}
    return {
        success: true,
        hearing,
        responses,
        totalResponses: responses.length,
        totalPages: undefined
    };
}

function buildAggregateResponseFromPersisted(hearingId) {
    try {
        const meta = readPersistedHearingWithMeta(hearingId);
        const persisted = meta?.data;
        if (persisted && persisted.success && persisted.hearing) {
            return {
                success: true,
                hearing: persisted.hearing,
                responses: Array.isArray(persisted.responses) ? persisted.responses : [],
                totalResponses: Array.isArray(persisted.responses) ? persisted.responses.length : 0,
                totalPages: persisted.totalPages || undefined
            };
        }
    } catch {}
    return null;
}

async function ensureHearingHydrated(hearingId) {
    const key = String(hearingId).trim();
    if (!key) return;
    if (!hydrationInFlight.has(key)) {
        const promise = (async () => {
            let hydrated = false;
            try {
                const direct = await hydrateHearingDirect(key);
                hydrated = !!(direct && direct.success);
            } catch (err) {
                console.warn(`[hydrate] direct fetch failed for ${key}:`, err?.message || err);
            }
            if (!hydrated) {
                const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                try {
                    await axios.get(`${base}/api/hearing/${key}/responses?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                    hydrated = true;
                } catch (err) {
                    console.warn(`[hydrate] fallback responses fetch failed for ${key}:`, err?.message || err);
                }
                try {
                    await axios.get(`${base}/api/hearing/${key}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                } catch (err) {
                    console.warn(`[hydrate] fallback materials fetch failed for ${key}:`, err?.message || err);
                }
            }
            if (!hydrated) throw new Error('Hydration failed');
            await sleep(50);
        })().catch(err => {
            throw err;
        }).finally(() => {
            hydrationInFlight.delete(key);
        });
        hydrationInFlight.set(key, promise);
    }
    return hydrationInFlight.get(key);
}

async function hydrateAndReloadAggregate(hearingId) {
    try {
        await ensureHearingHydrated(hearingId);
    } catch (err) {
        console.warn(`[aggregate] hydration attempt failed for ${hearingId}:`, err?.message || err);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const fromDb = buildAggregateResponseFromDb(hearingId);
        if (fromDb) return fromDb;
        const fromPersisted = buildAggregateResponseFromPersisted(hearingId);
        if (fromPersisted) return fromPersisted;
        await sleep(100 * (attempt + 1));
    }
    return null;
}

// API endpoint to fetch hearing data
app.get('/api/hearing/:id', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        const allowHydrate = String(req.query.hydrate || '1').trim().toLowerCase() !== '0';

        let candidate = null;

        const fromDb = buildAggregateResponseFromDb(hearingId);
        if (fromDb) {
            if (!allowHydrate || (fromDb.totalResponses && fromDb.totalResponses > 0)) {
                return res.json(fromDb);
            }
            candidate = fromDb;
        }

        const fromPersisted = buildAggregateResponseFromPersisted(hearingId);
        if (fromPersisted) {
            if (!allowHydrate || (fromPersisted.totalResponses && fromPersisted.totalResponses > 0)) {
                try { upsertHearing(fromPersisted.hearing); } catch {}
                try { if (Array.isArray(fromPersisted.responses)) replaceResponses(Number(hearingId), fromPersisted.responses); } catch {}
                return res.json(fromPersisted);
            }
            if (!candidate) candidate = fromPersisted;
        }

        if (allowHydrate) {
            const hydrated = await hydrateAndReloadAggregate(hearingId);
            if (hydrated) {
                try { upsertHearing(hydrated.hearing); } catch {}
                try { if (Array.isArray(hydrated.responses)) replaceResponses(Number(hearingId), hydrated.responses); } catch {}
                if (hydrated.totalResponses && hydrated.totalResponses > 0) {
                    return res.json(hydrated);
                }
                if (!candidate) candidate = hydrated;
            }
        }

        if (candidate) return res.json(candidate);

        return res.status(404).json({ success: false, message: 'Ikke fundet i databasen' });
    } catch (error) {
        console.error(`Error in /api/hearing/${req.params.id}:`, error.message);
        res.status(500).json({ success: false, message: 'Uventet fejl', error: error.message });
    }
});

// Split endpoints: meta and responses separately
app.get('/api/hearing/:id/meta', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({ headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'kk-xyz=1' }, timeout: 120000 });

        let hearingMeta = { title: null, deadline: null, startDate: null, status: null };
        // Offline-first: if we have meta in DB, use it and return immediately
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.db && sqlite.db.prepare) {
                const row = sqlite.db.prepare(`SELECT title, start_date as startDate, deadline, status FROM hearings WHERE id=?`).get(Number(hearingId));
                if (row && row.title) {
                    return res.json({ success: true, hearing: { id: Number(hearingId), title: row.title, startDate: row.startDate || null, deadline: row.deadline || null, status: row.status || 'ukendt', url: `${baseUrl}/hearing/${hearingId}/comments` } });
                }
            }
        } catch {}
        try {
            const rootPage = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            if (rootPage.nextJson) hearingMeta = extractMetaFromNextJson(rootPage.nextJson);
        } catch {}
        if (!hearingMeta.title || !hearingMeta.deadline || !hearingMeta.startDate || !hearingMeta.status) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { validateStatus: () => true, headers: { Accept: 'application/json' } });
                if (r.status === 200 && r.data) {
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    const contents = included.filter(x => x?.type === 'content');
                    const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                    const attrs = item?.attributes || {};
                    const statusRelId = item?.relationships?.hearingStatus?.data?.id;
                    const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                    hearingMeta = {
                        title: hearingMeta.title || (titleContent ? fixEncoding(String(titleContent.attributes.textContent).trim()) : null),
                        deadline: hearingMeta.deadline || attrs.deadline || null,
                        startDate: hearingMeta.startDate || attrs.startDate || null,
                        status: hearingMeta.status || statusIncluded?.attributes?.name || null
                    };
                }
            } catch {}
        }

        const hearingInfoFromIndex = hearingIndex.find(h => String(h.id) === hearingId) || {};
        const hearing = {
            id: Number(hearingId),
            title: hearingMeta.title || hearingInfoFromIndex.title || `Høring ${hearingId}`,
            startDate: hearingMeta.startDate || hearingInfoFromIndex.startDate || null,
            deadline: hearingMeta.deadline || hearingInfoFromIndex.deadline || null,
            status: hearingMeta.status || hearingInfoFromIndex.status || 'ukendt',
            url: `${baseUrl}/hearing/${hearingId}/comments`
        };

        try {
            const idx = hearingIndex.findIndex(h => h.id === Number(hearingId));
            if (idx >= 0) {
                const updated = { ...hearingIndex[idx] };
                updated.title = hearing.title;
                updated.startDate = hearing.startDate;
                updated.deadline = hearing.deadline;
                updated.status = hearing.status;
                updated.normalizedTitle = normalizeDanish(updated.title || '');
                updated.titleTokens = tokenize(updated.title || '');
                updated.deadlineTs = updated.deadline ? new Date(updated.deadline).getTime() : null;
                updated.isOpen = computeIsOpen(updated.status, updated.deadline);
                hearingIndex[idx] = updated;
            }
        } catch {}

        res.json({ success: true, hearing });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

app.get('/api/hearing/:id/responses', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        try {
            const published = getPublishedAggregate(Number(hearingId));
            if (published && Array.isArray(published.responses) && published.responses.length) {
                const mapped = published.responses.map(r => ({
                    id: r.id,
                    text: r.text,
                    textMd: r.textMd || r.text,
                    respondentName: r.respondentName || null,
                    respondentType: r.respondentType || null,
                    author: r.author || null,
                    organization: r.organization || null,
                    onBehalfOf: r.onBehalfOf || null,
                    submittedAt: r.submittedAt || null,
                    hasAttachments: r.hasAttachments || (Array.isArray(r.attachments) && r.attachments.length > 0),
                    attachments: (r.attachments || []).map(a => ({
                        attachmentId: a.attachmentId,
                        filename: a.filename,
                        contentMd: a.contentMd || null,
                        publishedAt: a.publishedAt || null
                    }))
                }));
                return res.json({ success: true, totalResponses: mapped.length, responses: mapped, source: 'published' });
            }
        } catch (err) {
            console.warn('[GDPR] Failed to load published responses, falling back:', err.message);
        }
        const noCache = String(req.query.nocache || '').trim() === '1';
        const preferPersist = PERSIST_PREFER || String(req.query.persist || '').trim() === '1';
        // Offline-first: read from DB if available
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.db && sqlite.db.prepare) {
                const rows = sqlite.db.prepare(`SELECT response_id as id, text, author, organization, on_behalf_of as onBehalfOf, submitted_at as submittedAt FROM raw_responses WHERE hearing_id=? ORDER BY response_id ASC`).all(hearingId);
                const atts = sqlite.db.prepare(`SELECT response_id as id, idx, filename, url FROM raw_attachments WHERE hearing_id=? ORDER BY response_id ASC, idx ASC`).all(hearingId);
                const byId = new Map(rows.map(r => [Number(r.id), { ...r, attachments: [] }]));
                for (const a of atts) {
                    const t = byId.get(Number(a.id)); if (t) t.attachments.push({ filename: a.filename, url: a.url });
                }
                const arr = Array.from(byId.values());
                if (arr.length) return res.json({ success: true, totalResponses: arr.length, responses: arr });
            }
        } catch {}
        // Persisted JSON fallback
        if (preferPersist) {
            const meta = readPersistedHearingWithMeta(hearingId);
            const persisted = meta?.data;
            if (persisted && persisted.success && Array.isArray(persisted.responses) && !isPersistStale(meta)) {
                return res.json({ success: true, totalResponses: persisted.responses.length, responses: persisted.responses });
            }
        }
        if (!noCache) {
            const cached = cacheGet(hearingResponsesCache, hearingId);
            if (cached) return res.json(cached);
        }
        const baseUrl = 'https://blivhoert.kk.dk';
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/json',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': 'kk-xyz=1',
                'Referer': `${baseUrl}/hearing/${hearingId}/comments`,
                'Origin': baseUrl
            },
            timeout: 120000
        });
        // HTML route
        // OPTIMIZATION: If HTML scraping returns 0 responses on page 1 but has totalPages,
        // skip all remaining HTML pages and rely solely on API
        const first = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, 1, axiosInstance), { attempts: 3, baseDelayMs: 600 });
        let htmlResponses = first.responses || [];
        let totalPages = first.totalPages || 1;
        let skipHtmlPages = false;
        
        // If page 1 returned 0 responses but claims there are many pages, skip HTML
        if (htmlResponses.length === 0 && totalPages > 1) {
            console.log(`[/api/hearing/${hearingId}/responses] HTML scraping returned 0 responses on page 1 but totalPages=${totalPages} - skipping remaining HTML pages, will use API only`);
            skipHtmlPages = true;
        }
        
        if (!skipHtmlPages && typeof totalPages === 'number' && totalPages > 1) {
            const remaining = [];
            for (let p = 2; p <= totalPages; p += 1) remaining.push(p);
            const maxConcurrent = 4;
            let cursor = 0;
            const workers = new Array(Math.min(maxConcurrent, remaining.length)).fill(0).map(async () => {
                while (cursor < remaining.length) {
                    const myIdx = cursor++;
                    const p = remaining[myIdx];
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, p, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (pageItems.length) htmlResponses = htmlResponses.concat(pageItems);
                }
            });
            await Promise.all(workers);
        } else if (!skipHtmlPages) {
            // Unknown page count: sequential until 2 consecutive empties OR duplicate detection
            let pageIndex = 2;
            let consecutiveEmpty = 0;
            let lastFirstId = htmlResponses[0]?.responseNumber ?? null;
            for (;;) {
                const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                const pageItems = Array.isArray(result.responses) ? result.responses : [];
                if (!pageItems.length) {
                    consecutiveEmpty += 1;
                    if (consecutiveEmpty >= 2) break;
                } else {
                    consecutiveEmpty = 0;
                    const currentFirstId = pageItems[0]?.responseNumber ?? null;
                    if (lastFirstId !== null && currentFirstId !== null && currentFirstId === lastFirstId) break;
                    lastFirstId = currentFirstId;
                    htmlResponses = htmlResponses.concat(pageItems);
                }
                if (!totalPages && result.totalPages) totalPages = result.totalPages;
                pageIndex += 1;
                if (pageIndex > 200) break;
            }
        }
        // API route and merge
        const apiBaseUrl = `${baseUrl}/api`;
        const viaApi = await withRetries(() => fetchCommentsViaApi(apiBaseUrl, hearingId, axiosInstance), { attempts: 2, baseDelayMs: 500 });
        const merged = mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []);
        let normalized = normalizeResponses(merged);

        // Defensive: if we only got exactly 12, try a small extra loop over more pages
        if (normalized.length === 12) {
            try {
                let pageIndex = 2;
                let guard = 0;
                while (guard < 10) {
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 300 });
                    const pageItems = Array.isArray(result.responses) ? result.responses : [];
                    if (!pageItems.length) break;
                    htmlResponses = htmlResponses.concat(pageItems);
                    pageIndex += 1;
                    guard += 1;
                }
                normalized = normalizeResponses(mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []));
            } catch {}
        }
        const payload = { success: true, totalResponses: normalized.length, responses: normalized };
        // Persist to SQLite for DB-first flows
        try { upsertHearing({ id: Number(hearingId), title: `Høring ${hearingId}`, startDate: null, deadline: null, status: 'ukendt' }); } catch (_) {}
        try { replaceResponses(Number(hearingId), normalized); } catch (_) {}
        cacheSet(hearingResponsesCache, hearingId, payload);
        if (PERSIST_ALWAYS_WRITE) {
            const existingMeta = readPersistedHearingWithMeta(hearingId);
            const existing = existingMeta?.data || null;
            const merged = mergePersistPayload(existing, payload);
            writePersistedHearing(hearingId, merged);
        }
        res.json(payload);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

// Materials endpoint: returns hearing materials (files, external document links and full hearing text)
app.get('/api/hearing/:id/materials', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!/^\d+$/.test(hearingId)) {
            return res.status(400).json({ success: false, message: 'Ugyldigt hørings-ID' });
        }
        // Always prioritize published materials from GDPR side first
        try {
            const published = getPublishedAggregate(Number(hearingId));
            if (published && Array.isArray(published.materials) && published.materials.length > 0) {
                const mapped = await Promise.all(published.materials.map(async (m) => {
                    let contentMd = m.contentMd || null;
                    // If contentMd is null, try to get it from prepared_materials uploadedPath
                    if (!contentMd && sqliteDb && sqliteDb.prepare) {
                        const preparedMat = sqliteDb.prepare(`SELECT uploaded_path, content_md FROM prepared_materials WHERE hearing_id=? AND material_id=?`).get(Number(hearingId), m.materialId);
                        if (preparedMat) {
                            if (preparedMat.content_md) {
                                contentMd = preparedMat.content_md;
                            } else if (preparedMat.uploaded_path && fs.existsSync(preparedMat.uploaded_path)) {
                                try {
                                    const result = await convertFileToMarkdown(preparedMat.uploaded_path, { includeMetadata: true });
                                    contentMd = result?.markdown || '';
                                    // Update published_materials with converted content
                                    if (contentMd && sqliteDb && sqliteDb.prepare) {
                                        try {
                                            sqliteDb.prepare(`UPDATE published_materials SET content_md=? WHERE hearing_id=? AND material_id=?`)
                                                .run(contentMd, Number(hearingId), m.materialId);
                                        } catch (err) {
                                            console.warn('[materials] Failed to update published material contentMd:', err.message);
                                        }
                                    }
                                } catch (err) {
                                    console.warn(`[materials] Failed to convert published material ${m.materialId}:`, err.message);
                                }
                            }
                        }
                    }
                    return {
                        materialId: m.materialId,
                        title: m.title || `Materiale ${m.materialId}`,
                        content: contentMd || null,
                        contentMd: contentMd || null,
                        type: contentMd ? 'description' : 'file',
                        source: 'published',
                        publishedAt: m.publishedAt || null
                    };
                }));
                console.log(`[materials] Returning ${mapped.length} published materials for hearing ${hearingId}`);
                return res.json({ success: true, materials: mapped, source: 'published' });
            }
        } catch (err) {
            console.warn('[GDPR] Failed to load published materials, falling back:', err.message);
        }
        
        // Also check prepared materials if no published materials exist
        // This allows access to materials before they are published
        try {
            if (sqliteDb && sqliteDb.prepare) {
                const prepared = sqliteDb.prepare(`SELECT * FROM prepared_materials WHERE hearing_id=? ORDER BY material_id ASC`).all(Number(hearingId));
                if (prepared && prepared.length > 0) {
                    const mapped = await Promise.all(prepared.map(async (m) => {
                        let contentMd = m.content_md || null;
                        // If contentMd is null, try to convert from uploadedPath
                        if (!contentMd && m.uploaded_path && fs.existsSync(m.uploaded_path)) {
                            try {
                                const result = await convertFileToMarkdown(m.uploaded_path, { includeMetadata: true });
                                contentMd = result?.markdown || '';
                                // Update the database with converted content
                                if (contentMd && sqliteDb && sqliteDb.prepare) {
                                    try {
                                        sqliteDb.prepare(`UPDATE prepared_materials SET content_md=? WHERE hearing_id=? AND material_id=?`)
                                            .run(contentMd, Number(hearingId), m.material_id);
                                    } catch (err) {
                                        console.warn('[materials] Failed to update prepared material contentMd:', err.message);
                                    }
                                }
                            } catch (err) {
                                console.warn(`[materials] Failed to convert prepared material ${m.material_id}:`, err.message);
                            }
                        }
                        return {
                            materialId: m.material_id,
                            title: m.title || `Materiale ${m.material_id}`,
                            content: contentMd || null,
                            contentMd: contentMd || null,
                            type: contentMd ? 'description' : 'file',
                            source: 'prepared',
                            approved: !!m.approved
                        };
                    }));
                    console.log(`[materials] Returning ${mapped.length} prepared materials for hearing ${hearingId}`);
                    return res.json({ success: true, materials: mapped, source: 'prepared' });
                }
            }
        } catch (err) {
            console.warn('[GDPR] Failed to load prepared materials:', err.message);
        }
        try {
            const rows = (sqliteDb && sqliteDb.prepare)
                ? sqliteDb.prepare(`SELECT * FROM raw_materials WHERE hearing_id=? ORDER BY idx ASC`).all(hearingId)
                : [];
            let materials = (rows || []).map(m => ({ type: m.type, title: m.title, url: m.url, content: m.content }));
            if (!materials || materials.length === 0) {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                if (persisted && Array.isArray(persisted.materials) && persisted.materials.length > 0) {
                    materials = persisted.materials.map(m => ({ type: m.type, title: m.title || null, url: m.url || null, content: m.content || null }));
                }
            }
            // If still empty, try to extract directly from the hearing root HTML (__NEXT_DATA__) and simple anchor scan
            if (!materials || materials.length === 0) {
                const baseUrl = 'https://blivhoert.kk.dk';
                const axiosInstance = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/json',
                        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
                        'Cookie': 'kk-xyz=1',
                        'Origin': baseUrl,
                        'Referer': baseUrl
                    },
                    timeout: 20000
                });
                try {
                    const root = await fetchHearingRootPage(baseUrl, hearingId, axiosInstance);
                    if (Array.isArray(root.materials) && root.materials.length > 0) {
                        materials = root.materials;
                    } else {
                        // Simple anchor fallback
                        const url = `${baseUrl}/hearing/${hearingId}`;
                        const r = await withRetries(() => axiosInstance.get(url, { validateStatus: () => true }), { attempts: 2, baseDelayMs: 300 });
                        if (r.status === 200 && r.data) {
                            const $ = cheerio.load(r.data);
                            const list = [];
                            $('a[href]').each((_, el) => {
                                const href = String($(el).attr('href') || '').trim();
                                if (/\.(pdf|doc|docx|xls|xlsx)(\?|$)/i.test(href)) {
                                    const title = ($(el).text() || '').trim();
                                    const abs = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/')?'':'/'}${href}`;
                                    list.push({ type: 'file', title: title || 'Dokument', url: abs });
                                }
                            });
                            if (list.length) materials = list;
                        }
                    }
                } catch {}
                // Persist if configured
                if (PERSIST_ALWAYS_WRITE) {
                    const meta = readPersistedHearingWithMeta(hearingId);
                    const existing = meta?.data || { success: true, hearing: { id: Number(hearingId) }, responses: [] };
                    const merged = { ...existing, materials: materials || [] };
                    writePersistedHearing(hearingId, merged);
                }
            }
            return res.json({ success: true, materials: materials || [] });
        } catch {
            try {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                const materials = (persisted && Array.isArray(persisted.materials)) ? persisted.materials : [];
            return res.json({ success: true, materials });
        } catch {
            return res.json({ success: true, materials: [] });
            }
        }
    } catch (e) {
        res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

// Upload custom attachments (user-provided) to include as materials
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Ingen fil modtaget' });
        const storedPath = req.file.path;
        const original = req.file.originalname || 'fil';
        const hearingId = Number(req.query.hearingId || req.body?.hearingId);
        if (Number.isFinite(hearingId)) {
            try { addUpload(req.sessionID, hearingId, storedPath, original); } catch (_) {}
        }
        res.json({ success: true, file: { path: storedPath, originalName: original } });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Upload-fejl', error: e.message });
    }
});

// Warm a hearing in background (scrape + persist), non-blocking
// Warm endpoint disabled in DB-only/static mode (kept for compatibility)
app.post('/api/warm/:id', async (req, res) => {
    return res.json({ success: true, queued: false, skipped: true, reason: 'disabled' });
});

// Extract text from simple formats to preview (txt, md, docx via python-docx, pdf via pdf-parse)
app.post('/api/extract-text', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { filePath, mimeType, originalName } = req.body || {};
        if (!filePath) return res.status(400).json({ success: false, message: 'Mangler filePath' });
        const lower = String(originalName || '').toLowerCase();
        const isPdf = lower.endsWith('.pdf') || mimeType === 'application/pdf';
        const isDocx = lower.endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const isText = lower.endsWith('.txt') || lower.endsWith('.md') || /^text\//.test(String(mimeType || ''));
        if (isText) {
            const txt = fs.readFileSync(filePath, 'utf8');
            return res.json({ success: true, text: txt.slice(0, 200000) });
        }
        if (isPdf) {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(dataBuffer);
            return res.json({ success: true, text: String(parsed.text || '').slice(0, 200000) });
        }
        if (isDocx) {
            const python = process.env.PYTHON_BIN || 'python3';
            const script = `import sys\nfrom docx import Document\np=Document(sys.argv[1])\nprint('\n'.join([p2.text for p2 in p.paragraphs]))`;
            const tmpPy = path.join(ensureTmpDir(), `read_${Date.now()}.py`);
            fs.writeFileSync(tmpPy, script, 'utf8');
            await new Promise((resolve, reject) => {
                const c = spawn(python, [tmpPy, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '', err = '';
                c.stdout.on('data', d => out += d.toString());
                c.stderr.on('data', d => err += d.toString());
                c.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
            }).then(txt => {
                res.json({ success: true, text: String(txt || '').slice(0, 200000) });
            }).catch(e => {
                res.status(500).json({ success: false, message: 'Kunne ikke læse DOCX', error: e.message });
            });
            return;
        }
        return res.json({ success: true, text: '' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved udtræk', error: e.message });
    }
});

// Session-backed edits and selections
app.post('/api/session/edits/:id', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const { responseId, patch } = req.body || {};
        if (!Number.isFinite(hearingId) || !Number.isFinite(responseId)) {
            return res.status(400).json({ success: false, message: 'Ugyldige parametre' });
        }
        upsertSessionEdit(sessionId, hearingId, responseId, patch || {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved gemning af ændring' });
    }
});

app.get('/api/session/edits/:id', (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const edits = getSessionEdits(sessionId, hearingId);
        res.json({ success: true, edits });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved hentning af ændringer' });
    }
});

app.post('/api/session/materials/:id', express.json({ limit: '256kb' }), (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const { idx, included } = req.body || {};
        if (!Number.isFinite(idx)) return res.status(400).json({ success: false, message: 'Ugyldigt index' });
        setMaterialFlag(sessionId, hearingId, Number(idx), !!included);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved opdatering af materialevalg' });
    }
});

app.get('/api/session/materials/:id', (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const flags = getMaterialFlags(sessionId, hearingId);
        res.json({ success: true, flags });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved hentning af materialevalg' });
    }
});

app.get('/api/session/uploads/:id', (req, res) => {
    try {
        const sessionId = req.sessionID;
        const hearingId = Number(req.params.id);
        const files = listUploads(sessionId, hearingId);
        res.json({ success: true, files });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved hentning af uploads' });
    }
});

// Auto-classify respondents using OpenAI based on responses content and metadata
app.post('/api/auto-classify-respondents/:id', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        if (!hearingId) return res.status(400).json({ success: false, message: 'Mangler hørings-ID' });

        if (!openai) {
            return res.status(400).json({ success: false, message: 'OPENAI_API_KEY mangler – kan ikke klassificere automatisk.' });
        }

        // Fetch current hearing data (meta + responses) with a fast, local-first strategy to avoid long hangs
        let responses = [];
        try {
            const fromDb = readAggregate(hearingId);
            if (fromDb && Array.isArray(fromDb.responses) && fromDb.responses.length) {
                responses = fromDb.responses;
            }
        } catch {}
        if (!responses.length) {
            try {
                const meta = readPersistedHearingWithMeta(hearingId);
                const persisted = meta?.data;
                if (persisted && persisted.success && Array.isArray(persisted.responses) && !isPersistStale(meta)) {
                    responses = persisted.responses;
                }
            } catch {}
        }
        if (!responses.length) {
            // Try to fetch and persist immediately (blocking, but short) before queuing
            try {
                const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                await axios.get(`${base}/api/hearing/${encodeURIComponent(hearingId)}?nocache=1`, { validateStatus: () => true, timeout: 45000 });
            } catch {}
            // Re-check DB and persisted after fetch attempt
            try {
                const fromDb2 = readAggregate(hearingId);
                if (fromDb2 && Array.isArray(fromDb2.responses) && fromDb2.responses.length) {
                    responses = fromDb2.responses;
                }
            } catch {}
            if (!responses.length) {
                try {
                    const meta2 = readPersistedHearingWithMeta(hearingId);
                    const persisted2 = meta2?.data;
                    if (persisted2 && persisted2.success && Array.isArray(persisted2.responses) && !isPersistStale(meta2)) {
                        responses = persisted2.responses;
                    }
                } catch {}
            }
            if (!responses.length) {
                // As a final step, queue a prefetch and return 202
                try {
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                    axios.post(`${base}/api/prefetch/${encodeURIComponent(hearingId)}`, {}, { validateStatus: () => true, timeout: 10000 }).catch(() => {});
                } catch {}
                return res.status(202).json({ success: true, suggestions: [], queued: true, message: 'Data for høringen er ikke klar endnu. Forvarmer i baggrunden – prøv igen om lidt.' });
            }
        }
        if (!responses.length) {
            return res.json({ success: true, suggestions: [] });
        }

        // Build compact classification payload for the model
        const items = responses.map(r => ({
            id: r.id,
            author: r.author || null,
            organization: r.organization || null,
            onBehalfOf: r.onBehalfOf || null,
            respondentName: r.respondentName || r.respondentnavn || null,
            respondentType: r.respondentType || r.respondenttype || null,
            text: String(r.text || '').slice(0, 1200)
        }));

        const systemPrompt = readTextFileSafe(CLASSIFIER_PROMPT_PATH) || [
            'Du er en hjælper, der klassificerer afsendere af høringssvar.',
            'Regler:',
            '- Privatpersoner skal forblive anonyme: lad dem stå som respondentType "Borger" og respondentName "Borger" (ændr ikke).',
            '- Lokaludvalg: sæt respondentType til "Lokaludvalg" og respondentName til det konkrete lokaludvalgs navn (f.eks. "Amager Øst Lokaludvalg").',
            '- Offentlige myndigheder (forvaltninger, ministerier, styrelser, direktorater, kommunale enheder): sæt respondentType til "Offentlig myndighed" og respondentName til myndighedens navn (f.eks. "Teknik- og Miljøforvaltningen", "Transportministeriet").',
            '- Beboergrupper: sæt respondentType til "Beboergruppe" og respondentName til gruppens navn (f.eks. "Beboergruppen X").',
            '- Brug kun oplysninger, der kan udledes tydeligt af de givne felter (author, organization, onBehalfOf, text). Gæt ikke.',
            '- Hvis du er i tvivl, så behold/foreslå ikke ændringer (spring over).',
            '- Hvis respondentType allerede er en af de ovenstående med tydeligt navn, kan du bekræfte det i output.',
            'Returnér KUN JSON (ingen forklaringer). Format: [{"id": <nummer>, "respondentName": "...", "respondentType": "..."}]',
            'Medtag kun elementer, hvor der bør sættes en mere specifik type/navn end standarden "Borger".'
        ].join('\n');

        const userPrompt = [
            'Klassificér følgende høringssvar efter reglerne og returnér kun JSON-listen beskrevet ovenfor.',
            'Svardata:',
            JSON.stringify(items, null, 2)
        ].join('\n\n');

        let outputText = '';
        try {
            const params = {
                model: MODEL_ID,
                input: [
                    { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
                    { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                ],
                stream: false
            };
            if (Number.isFinite(MAX_TOKENS) && MAX_TOKENS > 0) params.max_output_tokens = MAX_TOKENS;

            const resp = await openai.responses.create(params);
            if (resp) {
                if (typeof resp.output_text === 'string') outputText = resp.output_text;
                else if (Array.isArray(resp.output_text)) outputText = resp.output_text.join('\n');
                else if (Array.isArray(resp.output)) {
                    try { outputText = resp.output.map(o => (o?.content||[]).map(c => (c?.text || '')).join('')).join('\n'); } catch (_) {}
                }
            }
        } catch (e) {
            // Surface JSON with message, but continue to prefer clear error
            return res.status(500).json({ success: false, message: 'OpenAI-kald fejlede', error: e && e.message ? e.message : String(e) });
        }

        const cleaned = String(outputText || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();
        let suggestions = [];
        try {
            const parsed = JSON.parse(cleaned || '[]');
            if (Array.isArray(parsed)) suggestions = parsed
                .filter(x => x && (Number.isFinite(x.id) || /^\d+$/.test(String(x.id))))
                .map(x => ({
                    id: Number(x.id),
                    respondentName: typeof x.respondentName === 'string' ? x.respondentName : undefined,
                    respondentType: typeof x.respondentType === 'string' ? x.respondentType : undefined
                }))
                .filter(x => x.respondentName || x.respondentType);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Kunne ikke parse OpenAI-svar som JSON', raw: outputText });
        }

        return res.json({ success: true, suggestions });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Uventet fejl', error: e.message });
    }
});

// Summarization endpoint: builds 3 variants from fetched materials + responses and streams results
app.get('/api/summarize/:id', async (req, res) => {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try { if (typeof req.setTimeout === 'function') req.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}
    try { if (typeof res.setTimeout === 'function') res.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}

    const t0 = performance.now();

    // Keep-alive pings to prevent proxies/timeouts during long generations
    const keepAlive = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
            else clearInterval(keepAlive);
        } catch (_) { try { clearInterval(keepAlive); } catch(_) {} }
    }, 15000);

    const sendEvent = (eventName, data) => {
        if (!res.writableEnded) {
            res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };
    
    // Handle client disconnect
    req.on('close', () => {
        try { clearInterval(keepAlive); } catch (_) {}
        if (!res.writableEnded) {
            res.end();
            logDebug('[summarize] Client disconnected, closing SSE connection.');
        }
    });

    try {
        // In background mode, proxy via job + polling over SSE (no direct OpenAI streaming)
        // Respect explicit bg=0 to force direct streaming and avoid DB inserts
        const bgParam = String(req.query.bg || '').trim().toLowerCase();
        const forceDirect = bgParam === '0' || bgParam === 'false' || bgParam === 'no';
        const dbReady = !!(sqliteDb && sqliteDb.prepare);
        if (BACKGROUND_MODE && !forceDirect && dbReady) {
            await legacySummarizeAsJobSse(req, res, null);
            return;
        }
        // Optional demo mode for instant UX testing without OpenAI latency
        const DEMO = String(req.query.demo || '') === '1';
        if (DEMO) {
            const n = Number(req.query.n || 3);
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const demoDelay = Number(req.query.delay || process.env.DEMO_DELAY_MS || 400);
            sendEvent('info', { message: `DEMO: Genererer ${n} varianter...` });
            for (let i = 1; i <= n; i++) {
                await sleep(demoDelay);
                // flush a tiny heartbeat to encourage chunking immediately after headers in some proxies
                try { if (!res.writableEnded) res.write(': tick\n\n'); } catch(_) {}
                sendEvent('info', { message: `DEMO: Genererer variant ${i} af ${n}...` });
                sendEvent('placeholder', { id: i });
                await sleep(demoDelay);
                sendEvent('status', { id: i, phase: 'started', message: 'Job startet…' });
                const steps = [
                    'Identificerer gennemgående temaer',
                    'Vurderer prioritet: klima, trafik, byrum',
                    'Afklarer enighed/uenighed i indsigter',
                    'Matcher krav i materialet',
                    'Skitserer struktureret output'
                ];
                sendEvent('status', { id: i, phase: 'thinking', message: 'Modellen overvejer…' });
                for (const s of steps) { await sleep(demoDelay); sendEvent('summary', { id: i, text: s }); }
                await sleep(demoDelay);
                sendEvent('status', { id: i, phase: 'drafting', message: 'Skriver udkast…' });
                const markdown = `# Opsummering (DEMO ${i})\n\n## Klima\nFlere ønsker grønne tage.\n\n## Mobilitet\nCykelstier prioriteres.\n\n## Bykvalitet\nGrønne opholdszoner foreslås.`;
                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                await sleep(demoDelay);
                sendEvent('variant', { variant: { id: i, headings, markdown, summary: steps.join('\n') } });
                await sleep(demoDelay);
                sendEvent('status', { id: i, phase: 'done', message: 'Færdig' });
            }
            sendEvent('end', { message: 'Færdig med at generere (DEMO).' });
            return res.end();
        }

        if (!openai) {
            sendEvent('status', { phase: 'openai', message: 'OPENAI_API_KEY mangler – kører ikke OpenAI.' });
            sendEvent('error', { message: 'Manglende OPENAI_API_KEY i miljøet. Tilføj nøglen og prøv igen.' });
            return res.end();
        } else {
            sendEvent('status', { phase: 'openai', message: 'Forbundet til OpenAI.' });
        }
        
        const hearingId = String(req.params.id).trim();
        if (!/^\d+$/.test(hearingId)) {
            sendEvent('error', { message: 'Ugyldigt hørings-ID' });
            return res.end();
        }
        const providedResponsesMd = null;
        const providedMaterialMd = null;

        // Pre-show variant placeholders so UI has per-variant status while data loads
        const nEarly = Number(req.query.n || 3);
        try {
            for (let i = 1; i <= nEarly; i++) {
                sendEvent('placeholder', { id: i });
                sendEvent('status', { id: i, phase: 'preparing', message: 'Forbereder variant…' });
            }
        } catch (_) {}

        sendEvent('info', { message: 'Henter høringsdata...' });

        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        sendEvent('status', { phase: 'fetching', message: 'Henter høringsdata…' });
        // Stream periodic progress while aggregator runs
        let fetchSeconds = 0;
        const fetchTicker = setInterval(() => {
            fetchSeconds += 2;
            try { sendEvent('info', { message: `Henter høringsdata… (${fetchSeconds}s)` }); } catch {}
        }, 2000);
        const metaResp = await axios.get(`${base}/api/hearing/${hearingId}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
        try { clearInterval(fetchTicker); } catch (_) {}

        if (!metaResp.data?.success) {
            sendEvent('error', { message: 'Kunne ikke hente høringsmetadata' });
            return res.end();
        }
        const hearing = metaResp.data.hearing;
        
        // ALWAYS prioritize published responses first - this is the GDPR-approved data
        let responsesRaw = [];
        try {
            const published = getPublishedAggregate(Number(hearingId));
            if (published && Array.isArray(published.responses) && published.responses.length > 0) {
                // Build responses with focus_mode handling
                responsesRaw = published.responses.map(r => {
                    const responseText = r.textMd || r.text || '';
                    const focusMode = r.focusMode || null;
                    const attachments = Array.isArray(r.attachments) ? r.attachments : [];
                    
                    // Build text based on focus_mode
                    let finalText = '';
                    if (focusMode === 'attachment' || focusMode === 'vedhæftning') {
                        // Only use attachment content
                        const attachmentTexts = attachments
                            .filter(a => a.contentMd)
                            .map(a => a.contentMd)
                            .join('\n\n');
                        finalText = attachmentTexts || responseText; // Fallback to response if no attachments
                    } else if (focusMode === 'both' || focusMode === 'begge') {
                        // Use both response and attachments
                        const attachmentTexts = attachments
                            .filter(a => a.contentMd)
                            .map(a => `[Vedhæftning: ${a.filename || 'Ukendt'}]\n${a.contentMd}`)
                            .join('\n\n');
                        finalText = responseText;
                        if (attachmentTexts) {
                            finalText = finalText ? `${finalText}\n\n${attachmentTexts}` : attachmentTexts;
                        }
                    } else {
                        // Default: focus on response (or 'response' focus mode)
                        finalText = responseText;
                    }
                    
                    return {
                        id: r.id,
                        svarnummer: r.sourceId || r.id,
                        text: finalText,
                        svartekst: finalText,
                        respondentName: r.respondentName || r.author || '',
                        respondentType: r.respondentType || 'Borger',
                        author: r.author || null,
                        organization: r.organization || null
                    };
                });
                console.log(`[summarize] Using ${responsesRaw.length} published responses (with focus_mode) for hearing ${hearingId}`);
            }
        } catch (err) {
            console.warn('[summarize] Failed to load published responses:', err.message);
        }
        
        // Fallback to metaResp.data.responses only if no published responses found
        if (!responsesRaw || responsesRaw.length === 0) {
            responsesRaw = Array.isArray(metaResp.data?.responses) ? metaResp.data.responses : [];
            if (responsesRaw.length > 0) {
                console.warn(`[summarize] No published responses found, falling back to raw/prepared responses (${responsesRaw.length} responses) for hearing ${hearingId}`);
            }
        }
        // Optional: apply respondent overrides passed via query (URL-encoded JSON)
        let responses = responsesRaw;
        try {
            const editsParam = req.query && req.query.edits ? String(req.query.edits) : '';
            let overrides = null;
            if (editsParam) {
                try { overrides = JSON.parse(editsParam); } catch (_) { overrides = null; }
            }
            if (overrides && typeof overrides === 'object') {
                responses = responsesRaw.map(r => {
                    const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                    const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                    if (!ov || typeof ov !== 'object') return r;
                    const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                    const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                    const patched = { ...r };
                    if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                    if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                    return patched;
                });
            }
        } catch (_) {}
        // ALWAYS prioritize published materials first - this is the GDPR-approved data
        let materials = [];
        try {
            const published = getPublishedAggregate(Number(hearingId));
            if (published && Array.isArray(published.materials) && published.materials.length > 0) {
                materials = published.materials.map(m => ({
                    materialId: m.materialId,
                    title: m.title || 'Dokument',
                    type: 'file',
                    contentMd: m.contentMd || null,
                    content: m.contentMd || null,
                    url: null,
                    publishedAt: m.publishedAt || null
                }));
                console.log(`[summarize] Using ${materials.length} published materials for hearing ${hearingId}`);
            }
        } catch (err) {
            console.warn('[summarize] Failed to load published materials:', err.message);
        }
        
        // Fallback to API endpoint only if no published materials found
        if (!materials.length) {
            materials = Array.isArray(metaResp.data?.materials) ? metaResp.data.materials : [];
            if (!materials.length) {
                try {
                    const mats = await axios.get(`${base}/api/hearing/${hearingId}/materials?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                    if (mats && mats.data && mats.data.success && Array.isArray(mats.data.materials)) materials = mats.data.materials;
                } catch {}
                if (!materials.length) {
                    try {
                        const mats2 = await axios.get(`${base}/api/hearing/${hearingId}/materials?db=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                        if (mats2 && mats2.data && mats2.data.success && Array.isArray(mats2.data.materials)) materials = mats2.data.materials;
                    } catch {}
                }
                if (!materials.length) {
                    try {
                        const mats3 = await axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                        if (mats3 && mats3.data && mats3.data.success && Array.isArray(mats3.data.materials)) materials = mats3.data.materials;
                    } catch {}
                }
            }
            if (materials.length > 0) {
                console.warn(`[summarize] No published materials found, falling back to raw/prepared materials (${materials.length} materials) for hearing ${hearingId}`);
            }
        }

        sendEvent('info', { message: 'Forbereder dokumenter...' });
        sendEvent('status', { phase: 'preparing', message: 'Forbereder materiale til prompt…' });
        
        const tmpDir = ensureTmpDir();
        const repliesMdPath = path.join(tmpDir, `hearing_${hearingId}_responses.md`);
        const materialMdPath = path.join(tmpDir, `hearing_${hearingId}_material.md`);

        // Stream immediate user-facing status while building prompt
        sendEvent('info', { message: 'Bygger materiale til prompt…' });
        // Build JSON with svarnummer, svartekst, respondentnavn, respondenttype (merged with wizard edits)
        const repliesObjects = responses.map(r => ({
            svarnummer: (r && (r.svarnummer ?? r.id)) ?? null,
            svartekst: (r && (r.svartekst ?? r.text ?? '')) || '',
            respondentnavn: (r && (r.respondentnavn ?? r.respondentName ?? r.author ?? '')) || '',
            respondenttype: (r && (r.respondenttype ?? r.respondentType ?? 'Borger')) || 'Borger'
        }));
        const repliesText = JSON.stringify(repliesObjects, null, 2);
        fs.writeFileSync(repliesMdPath, repliesText, 'utf8');

        const materialParts = [`# Høringsmateriale for ${hearing.title}`];
        for (const m of materials) {
            // Handle published materials with contentMd
            if (m.contentMd) {
                materialParts.push('');
                materialParts.push(`## ${m.title || 'Dokument'}`);
                materialParts.push(m.contentMd);
                materialParts.push('');
            } else if (m.type === 'description' && m.content) {
                materialParts.push('');
                materialParts.push(m.content);
                materialParts.push('');
            } else if (m.type === 'file' || m.url || m.path) {
                const proxied = m.url ? `${base}/api/file-proxy?${new URLSearchParams({ path: m.url, filename: m.title || 'Dokument' }).toString()}` : '';
                materialParts.push(`- ${m.title || 'Dokument'}: ${proxied || m.url || m.path || ''}`);
            }
        }
        const materialMd = materialParts.join('\n');
        fs.writeFileSync(materialMdPath, materialMd, 'utf8');

        let vectorContextText = '';
        const VECTOR_LIMIT = Number(process.env.VECTOR_CONTEXT_LIMIT || 6000);
        try {
            let chunks = listVectorChunks(Number(hearingId));
            if ((!chunks || !chunks.length) && openai) {
                try {
                    sendEvent('info', { message: 'Opretter vector store...' });
                    console.log(`[summarize] Building vector store for hearing ${hearingId}`);
                    await rebuildLocalVectorStore(Number(hearingId));
                    chunks = listVectorChunks(Number(hearingId));
                    console.log(`[summarize] Vector store created with ${chunks ? chunks.length : 0} chunks`);
                } catch (vectorErr) {
                    console.error(`[summarize] Failed to build vector store:`, vectorErr);
                    sendEvent('warn', { message: 'Kunne ikke oprette vector store, fortsætter uden...' });
                    // Continue without vector store rather than failing
                    chunks = [];
                }
            }
            if (chunks && chunks.length) {
                // Use semantic search instead of just taking first chunks
                const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
                const searchQuery = extractQueryFromPrompt(promptTemplate);
                const adaptiveTopK = calculateAdaptiveTopK(responses.length, materials.length, chunks.length);
                
                console.log(`[summarize] Using semantic search with query: "${searchQuery}", topK: ${adaptiveTopK}`);
                const topResults = await queryLocalVectorStore(Number(hearingId), searchQuery, adaptiveTopK, VECTOR_SEARCH_MIN_SCORE);
                
                if (topResults && topResults.length > 0) {
                    const topChunks = topResults
                        .map((item, idx) => `### Kilde ${idx + 1} (${item.source || 'ukendt'})\n${item.content}`);
                    vectorContextText = topChunks.join('\n\n');
                    if (vectorContextText.length > VECTOR_LIMIT) {
                        vectorContextText = vectorContextText.slice(0, VECTOR_LIMIT);
                    }
                    console.log(`[summarize] Using ${topResults.length} relevant chunks from vector store`);
                } else {
                    console.log(`[summarize] No relevant chunks found via semantic search, falling back to first chunks`);
                    // Fallback to first chunks if semantic search returns nothing
                    const topChunks = chunks
                        .slice(0, 24)
                        .map((item, idx) => `### Kilde ${idx + 1} (${item.source || 'ukendt'})\n${item.content}`);
                    vectorContextText = topChunks.join('\n\n');
                    if (vectorContextText.length > VECTOR_LIMIT) {
                        vectorContextText = vectorContextText.slice(0, VECTOR_LIMIT);
                    }
                }
            }
        } catch (err) {
            console.warn('[VectorStore] kunne ikke hente kontekst:', err.message);
        }

        const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
        const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
        const RESP_LIMIT = Number(process.env.RESP_CHAR_LIMIT || 200000);
        const MAT_LIMIT = Number(process.env.MAT_CHAR_LIMIT || 120000);
        const userPrompt = `${promptTemplate}\n\n[Samlede Høringssvar]\n\n${String(repliesText || '').slice(0, RESP_LIMIT)}\n\n[Høringsmateriale]\n\n${materialMd.slice(0, MAT_LIMIT)}${vectorContextText ? `\n\n[Udvalgte kontekstafsnit]\n\n${vectorContextText}` : ''}`;
        logDebug(`[summarize] Constructed user prompt of length ${userPrompt.length}.`);

        if (userPrompt.length < 200) { // Arbitrary small length check
            sendEvent('error', { message: 'Fejl: Kunne ikke generere prompt. For lidt data at arbejde med.'});
            return res.end();
        }

        const n = nEarly;
        sendEvent('info', { message: `Genererer ${n} varianter...`, hearing });
        sendEvent('status', { phase: 'queueing', message: `Starter ${n} varianter…` });
        sendEvent('info', { message: 'Materiale klar', meta: { responses: responses.length, materials: materials.length, promptChars: userPrompt.length } });

        const model = MODEL_ID;
        const maxTokens = MAX_TOKENS;
        const supportsReasoning = /^(gpt-5|o3|o4)/i.test(model);

        // Compute fast pre-thought headings from input to show immediate reasoning summary
        function computePreThoughts(inputText) {
            const lc = String(inputText || '').toLowerCase();
            const buckets = [
                { key: 'trafik', label: 'Trafik og parkering', re: /trafik|parkering|bil|bus|kørsel|krydset|ve[jy]/g },
                { key: 'stoej', label: 'Støj og boldbane', re: /støj|stoej|boldbur|boldbane|støjværn|stoejvaern|larm/g },
                { key: 'skole', label: 'Skole og institution', re: /skole|institution|daginstitution|børnehave|vuggestue/g },
                { key: 'klima', label: 'Klima og grønne områder', re: /klima|grøn|groen|groent|biodivers|regnvand|træ|trae|grønt/g },
                { key: 'byg', label: 'Byggehøjde og skygge', re: /højde|hoejde|skygge|etage|høj|hoej|kollegium/g },
                { key: 'cykel', label: 'Cykel og mobilitet', re: /cykel|cykelsti|fortov|gående|gaaende|mobilitet/g },
                { key: 'tryg', label: 'Tryghed og sikkerhed', re: /tryghed|sikkerhed/g },
                { key: 'proces', label: 'Proces og inddragelse', re: /borgermøde|borgermoede|høring|hoering|proces/g }
            ];
            const scored = [];
            for (const b of buckets) {
                const m = lc.match(b.re);
                if (m && m.length) scored.push({ label: b.label, n: m.length });
            }
            scored.sort((a, b) => b.n - a.n);
            return scored.slice(0, 6).map(s => s.label);
        }
        const preThoughts = computePreThoughts(`${repliesText}\n${materialMd}`);

        // Build tasks (potentially run in parallel)
        function extractHeadingsFromSummary(text) {
            try {
                const raw = String(text || '').replace(/\r/g, '');
                const byLine = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
                // Prefer explicit bullets or short sentences as headings
                const bullets = byLine
                    .filter(l => /^[-*••]|^\d+\./.test(l) || (l.length <= 120 && /[:–-]/.test(l)))
                    .map(l => l.replace(/^[-*•\d+.\s]+/, '').trim());
                const unique = [];
                const seen = new Set();
                for (const b of bullets) { if (!seen.has(b)) { seen.add(b); unique.push(b); } }
                return unique.slice(-6);
            } catch { return []; }
        }

        const tasks = Array.from({ length: n }, (_, idx) => async () => {
            const i = idx;
            let markdown = '';
            let summaryText = '';
            let currentHeadingsSnapshot = [];
            try {
                sendEvent('info', { message: `Genererer variant ${i + 1} af ${n}...` });
                // Ensure client renders a placeholder card for this variant
                sendEvent('placeholder', { id: i + 1 });
                sendEvent('status', { id: i + 1, phase: 'preparing', message: 'Forbereder variant…' });
                // Do NOT send identical pre-thoughts as live variant thoughts; avoid confusing duplicates across variants
                logDebug(`[summarize] calling streaming responses API model=${model} userPromptChars=${userPrompt.length}`);

                const params = {
                    model,
                    input: [
                        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
                        { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                    ],
                    stream: true
                };
                // Only send temperature for non-reasoning models that support it
                const isReasoningModel = /^(gpt-5|o3|o4)/i.test(model);
                if (!isReasoningModel && Number.isFinite(TEMPERATURE)) {
                    params.temperature = TEMPERATURE;
                }
                if (Number.isFinite(maxTokens) && maxTokens > 0) {
                    params.max_output_tokens = maxTokens;
                }
                // Attach verbosity and reasoning effort for supported reasoning models
                if (/^gpt-5/i.test(model)) {
                    if (VERBOSITY_ENV) params.text = { ...(params.text || {}), verbosity: VERBOSITY_ENV };
                }
                if (supportsReasoning && REASONING_EFFORT_ENV) {
                    params.reasoning = { ...(params.reasoning || {}), effort: REASONING_EFFORT_ENV };
                }

                logDebug(`[summarize] params keys: ${Object.keys(params).join(', ')}; hasTemp=${Object.prototype.hasOwnProperty.call(params,'temperature')}; maxOut=${params.max_output_tokens||null}; hasReasoning=${!!params.reasoning}; hasTextOpt=${!!params.text}`);
                const useBackground = parseBoolean(req.query.bg || req.query.background || OPENAI_BACKGROUND_DEFAULT);
                // For structured output or long-running jobs, use polling instead of streaming
                const usePolling = useBackground || USE_STRUCTURED_OUTPUT;
                let stream;
                
                if (usePolling) {
                    // Create async background job, then poll for completion
                    const createParams = { ...params, stream: false, background: true };
                    delete createParams.temperature; // ensure compatibility with reasoning models
                    logDebug(`[summarize] starting background job for variant ${i + 1} (polling mode)`);
                    const created = await openai.responses.create(createParams);
                    const responseId = created && (created.id || created.response_id || created.response?.id);
                    if (!responseId) throw new Error('Kunne ikke starte baggrundsjob');
                    sendEvent('info', { message: `Baggrundsjob startet for variant ${i + 1}…`, responseId });
                    sendEvent('status', { id: i + 1, phase: 'queued', message: 'Baggrundsjob oprettet…' });
                    
                    // Poll for completion instead of streaming
                    const maxPolls = Number.isFinite(SUMMARIZE_TIMEOUT_MS) ? Math.ceil(SUMMARIZE_TIMEOUT_MS / 5000) : 300; // 25 min default
                    let pollCount = 0;
                    let lastStatus = 'queued';
                    
                    while (pollCount < maxPolls) {
                        if (res.writableEnded) break;
                        
                        const job = await openai.responses.retrieve(responseId);
                        const status = String(job?.status || 'unknown').toLowerCase();
                        
                        if (status !== lastStatus) {
                            sendEvent('status', { id: i + 1, phase: status, message: `Jobstatus: ${status}...` });
                            lastStatus = status;
                        }
                        
                        if (['completed', 'succeeded', 'done'].includes(status)) {
                            // Retrieve final output
                            let text = parseOpenAIText(job, USE_STRUCTURED_OUTPUT);
                            if (!text) {
                                // Try to get from stream as fallback
                                try {
                                    const streamFallback = await openai.responses.stream({ response_id: responseId });
                                    let acc = '';
                                    for await (const ev of streamFallback) {
                                        if (ev?.type === 'response.output_text.delta') acc += (ev.delta || '');
                                    }
                                    if (acc && USE_STRUCTURED_OUTPUT) {
                                        try {
                                            const jsonData = JSON.parse(acc);
                                            if (jsonData && typeof jsonData === 'object') {
                                                text = convertJSONToMarkdown(jsonData);
                                            } else {
                                                text = acc;
                                            }
                                        } catch {
                                            text = acc;
                                        }
                                    } else {
                                        text = acc;
                                    }
                                } catch {}
                            }
                            
                            markdown = (text || '').trim();
                            
                            // If structured output, convert JSON to Markdown after polling completes
                            if (USE_STRUCTURED_OUTPUT && markdown) {
                                try {
                                    const jsonData = JSON.parse(markdown);
                                    if (jsonData && typeof jsonData === 'object') {
                                        markdown = convertJSONToMarkdown(jsonData);
                                    }
                                } catch {
                                    // If not valid JSON, keep original markdown
                                }
                            }
                            
                            if (markdown) {
                                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                const variant = { id: i + 1, headings, markdown, summary: (summaryText || '').trim() };
                                sendEvent('variant', { variant });
                                recordRecentVariant(hearingId, variant);
                                sendEvent('status', { id: i + 1, phase: 'done', message: 'Færdig' });
                                break;
                            }
                        } else if (['failed', 'error', 'cancelled'].includes(status)) {
                            throw new Error(`Job fejlede med status: ${status}`);
                        }
                        
                        pollCount++;
                        await new Promise(r => setTimeout(r, 5000)); // Poll every 5 seconds
                    }
                    
                    if (!markdown && pollCount >= maxPolls) {
                        throw new Error('Job timeout - tog for lang tid');
                    }
                    
                    if (!markdown) {
                        throw new Error('Tomt svar fra OpenAI');
                    }
                    
                    // Skip streaming logic below - we're done with this variant
                    logDebug(`[summarize] Variant ${i + 1} completed via polling`);
                    return; // Exit this async function
                } else {
                    // Try direct streaming; if the model/route rejects streaming immediately, fall back to non-stream and emit once
                    sendEvent('status', { id: i + 1, phase: 'connecting', message: 'Opretter direkte stream…' });
                    try {
                        stream = await openai.responses.stream(params);
                    } catch (e) {
                        logDebug(`[summarize] direct stream failed variant=${i+1}: ${e?.message||e}`);
                        // Non-stream fallback
                        const nonStreamParams = { ...params };
                        delete nonStreamParams.stream;
                        delete nonStreamParams.temperature;
                        const resp = await openai.responses.create(nonStreamParams);
                        let text = parseOpenAIText(resp, USE_STRUCTURED_OUTPUT);
                        markdown = (text || '').trim();
                        
                        // If structured output, convert JSON to Markdown
                        if (USE_STRUCTURED_OUTPUT && markdown) {
                            try {
                                const jsonData = JSON.parse(markdown);
                                if (jsonData && typeof jsonData === 'object') {
                                    markdown = convertJSONToMarkdown(jsonData);
                                }
                            } catch {
                                // If not valid JSON, keep original markdown
                            }
                        }
                        
                        if (markdown) {
                            const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                            const variant = { id: i + 1, headings, markdown, summary: (summaryText || '').trim() };
                            sendEvent('variant', { variant });
                            recordRecentVariant(hearingId, variant);
                            return;
                        }
                        throw e;
                    }
                }

                let lastReportedLen = 0;
                const seenHeadings = new Set();
                let gotFirstDelta = false;
                let gotReasoningDelta = false;
                const startedAtMs = Date.now();
                // Heartbeat: emit per-variant liveness status every 5s until completion
                const variantHeartbeat = setInterval(() => {
                    try {
                        if (res.writableEnded) { clearInterval(variantHeartbeat); return; }
                        const secs = Math.round((Date.now() - startedAtMs) / 1000);
                        if (!gotFirstDelta && !gotReasoningDelta) {
                            sendEvent('status', { id: i + 1, phase: 'connecting', message: `Tænker... (${secs}s)` });
                        } else if (gotReasoningDelta && !gotFirstDelta) {
                            sendEvent('status', { id: i + 1, phase: 'thinking', message: `Modellen overvejer… (${secs}s)` });
                        } else if (gotFirstDelta) {
                            sendEvent('status', { id: i + 1, phase: 'drafting', message: `Skriver udkast… (${secs}s)` });
                        }
                    } catch (_) {}
                }, 5000);
                for await (const event of stream) {
                    if (event && typeof event.type === 'string') {
                        if (event.type === 'response.created') {
                            sendEvent('status', { id: i + 1, phase: 'started', message: 'Job startet…' });
                        } else if (event.type.startsWith('response.tool_')) {
                            sendEvent('status', { id: i + 1, phase: 'using-tools', message: 'Kalder værktøjer…' });
                        } else if (event.type === 'response.completed') {
                            sendEvent('status', { id: i + 1, phase: 'done', message: 'Færdig' });
                            try { clearInterval(variantHeartbeat); } catch(_) {}
                        }
                    }
                    if (event.type === 'response.output_text.delta') {
                        // lightweight debug of stream progress
                        if (lastReportedLen === 0) logDebug(`[summarize] stream start variant=${i+1}`);
                        markdown += (event.delta || '');
                        if (!gotFirstDelta) {
                            gotFirstDelta = true;
                            sendEvent('status', { id: i + 1, phase: 'drafting', message: 'Skriver udkast…' });
                        }
                        // For structured output, don't send partial content - wait for complete JSON
                        if (!USE_STRUCTURED_OUTPUT && markdown.length - lastReportedLen >= 200) {
                            const tmpHeadings = (markdown.match(/^#{1,6} .*$/mg) || []);
                            sendEvent('info', { message: `Skriver variant ${i + 1}...`, progress: { variant: i + 1, chars: markdown.length, headingsCount: tmpHeadings.length } });
                            lastReportedLen = markdown.length;
                            // Overflad nye overskrifter (fra selve output Markdown) som midlertidig "tanke-overskrifter"
                            const newOnes = [];
                            for (const h of tmpHeadings) {
                                if (!seenHeadings.has(h)) {
                                    seenHeadings.add(h);
                                    newOnes.push(h.replace(/^#{1,6}\s*/, ''));
                                }
                            }
                            if (newOnes.length) {
                                const merged = Array.from(new Set([...currentHeadingsSnapshot, ...newOnes])).slice(-6);
                                currentHeadingsSnapshot = merged;
                                sendEvent('headings', { id: i + 1, items: currentHeadingsSnapshot });
                            }
                            // Stream partial content so UI can render live answer
                            sendEvent('content', { id: i + 1, markdown });
                        }
                    } else if (
                        event.type === 'response.reasoning_summary.delta' ||
                        event.type === 'response.reasoning_summary_text.delta'
                    ) {
                        logDebug(`[summarize] reasoning delta variant=${i+1}`);
                        const delta = (typeof event.delta === 'string') ? event.delta : (event.delta?.toString?.() || '');
                        summaryText += (delta || '');
                        if (!gotReasoningDelta) {
                            gotReasoningDelta = true;
                            sendEvent('status', { id: i + 1, phase: 'thinking', message: 'Modellen overvejer…' });
                        }
                        const extracted = extractHeadingsFromSummary(summaryText);
                        if (extracted.length) {
                            currentHeadingsSnapshot = extracted;
                            sendEvent('headings', { id: i + 1, items: currentHeadingsSnapshot });
                        }
                    } else if (
                        event.type === 'response.reasoning_summary.done' ||
                        event.type === 'response.reasoning_summary_text.done'
                    ) {
                        logDebug(`[summarize] reasoning done variant=${i+1}`);
                        if (event.text) summaryText = event.text;
                        const extracted = extractHeadingsFromSummary(summaryText);
                        if (extracted.length) {
                            currentHeadingsSnapshot = extracted;
                            sendEvent('headings', { id: i + 1, items: currentHeadingsSnapshot });
                        }
                    } else if (event.type === 'response.error') {
                        throw new Error(event.error?.message || 'OpenAI fejl');
                    }
                }

                if (!markdown) {
                    // Fallback: try non-streaming request to retrieve full text
                    try {
                        const nonStreamParams = { ...params, stream: false };
                        delete nonStreamParams.temperature; // ensure safe for reasoning models
                        const resp = await openai.responses.create(nonStreamParams);
                        let text = parseOpenAIText(resp, USE_STRUCTURED_OUTPUT);
                        markdown = (text || '').trim();
                    } catch (e) {
                        // ignore, handled below
                    }
                }
                
                // If structured output, convert JSON to Markdown after stream completes
                if (USE_STRUCTURED_OUTPUT && markdown) {
                    try {
                        const jsonData = JSON.parse(markdown);
                        if (jsonData && typeof jsonData === 'object') {
                            markdown = convertJSONToMarkdown(jsonData);
                            // Send converted Markdown to frontend
                            if (markdown) {
                                const tmpHeadings = (markdown.match(/^#{1,6} .*$/mg) || []);
                                const headings = tmpHeadings.map(h => h.replace(/^#{1,6}\s*/, ''));
                                sendEvent('headings', { id: i + 1, items: headings });
                                sendEvent('content', { id: i + 1, markdown });
                            }
                        }
                    } catch {
                        // If not valid JSON, keep original markdown
                    }
                }
                
                if (!markdown) throw new Error('Tomt svar fra OpenAI');

                logDebug(`[summarize] success variant=${i + 1} length=${markdown.length}`);
                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                const variant = { id: i + 1, headings, markdown, summary: (summaryText || '').trim() };
                sendEvent('variant', { variant });
                recordRecentVariant(hearingId, variant);
                // Send final authoritative headings snapshot, derived from markdown if present
                const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                if (finalHeadings.length) sendEvent('headings', { id: i + 1, items: finalHeadings.slice(0, 6) });
                try { clearInterval(variantHeartbeat); } catch(_) {}

            } catch (err) {
                const detail = (err && (err.response?.data?.error?.message || err.error?.message || err.message)) || 'Ukendt fejl';
                logDebug(`[summarize] OpenAI error in variant generation: ${detail}`);
                sendEvent('error', { id: i + 1, message: `Fejl ved generering af variant ${i + 1}`, error: detail, code: err?.code || null });
                // Ensure heartbeat stops on error
                try { clearInterval(variantHeartbeat); } catch(_) {}
                return;
            }
        });

        // Run sequentially or in parallel depending on env
        const parallel = String(process.env.SUMMARY_PARALLEL || process.env.PARALLEL_SUMMARY || 'true').toLowerCase();
        const shouldRunParallel = parallel !== 'false' && parallel !== '0' && parallel !== 'no';
        if (shouldRunParallel) {
            await Promise.all(tasks.map(t => t()));
        } else {
            for (const t of tasks) { await t(); }
        }
        
        // Clean up temporary vector store after prompt execution
        try {
            if (sqliteDb && sqliteDb.prepare) {
                sqliteDb.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(Number(hearingId));
                logDebug(`[summarize] Cleaned up temporary vector store for hearing ${hearingId}`);
            }
        } catch (cleanupErr) {
            console.warn(`[summarize] Failed to cleanup vector store:`, cleanupErr.message);
        }
        
        sendEvent('end', { message: 'Færdig med at generere.' });
        res.end();
        
    } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || String(e);
        logDebug(`[summarize] Failed: ${msg}`);
        
        // Clean up temporary vector store even on error
        try {
            if (sqliteDb && sqliteDb.prepare) {
                sqliteDb.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(Number(hearingId));
                logDebug(`[summarize] Cleaned up temporary vector store after error for hearing ${hearingId}`);
            }
        } catch (cleanupErr) {
            console.warn(`[summarize] Failed to cleanup vector store after error:`, cleanupErr.message);
        }
        
        sendEvent('error', { message: `Serverfejl: ${msg}` });
        res.end();
    }
});

// Parse JSON bodies with tolerance to stray control chars: use express.text and sanitize
app.post('/api/summarize/:id', express.text({ type: 'application/json', limit: '25mb' }), async (req, res) => {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try { if (typeof req.setTimeout === 'function') req.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}
    try { if (typeof res.setTimeout === 'function') res.setTimeout(SUMMARIZE_TIMEOUT_MS); } catch(_) {}

    const t0 = performance.now();
    console.log(`[summarize] POST Request received for hearing ${req.params.id}`);

    // Parse raw JSON body (we used express.text to avoid interfering with SSE)
    let parsedBody = null;
    try {
        const raw = typeof req.body === 'string' ? req.body : (req.body ? String(req.body) : '');
        // Remove stray nulls/control chars that may appear from some clients
        const sanitized = raw.replace(/[\u0000-\u001F\u007F]/g, (c) => (c === '\n' || c === '\r' || c === '\t') ? c : '');
        parsedBody = JSON.parse(sanitized || '{}');
    } catch (_) {
        parsedBody = null;
    }

    // This handler returns a promise that resolves only when the entire SSE stream is finished.
    return new Promise((resolve, reject) => {
        const keepAliveInterval = setInterval(() => {
            try {
                if (!res.writableEnded) {
                    res.write('event: ping\ndata: {"time": ' + Date.now() + '}\n\n');
                } else {
                    clearInterval(keepAliveInterval);
                }
            } catch (e) {
                console.error('[summarize] Error in keep-alive ping:', e);
                clearInterval(keepAliveInterval);
            }
        }, 10000);

        const sendEvent = (eventName, data) => {
            if (!res.writableEnded) {
                res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };
        
        req.on('close', async () => {
            try { clearInterval(keepAliveInterval); } catch (_) {}
            // If direct streaming was planned (bg=0), salvage by creating a background job so results persist
            try {
                const bgParamClose = String(req.query.bg || '').trim().toLowerCase();
                const forceDirectClose = bgParamClose === '0' || bgParamClose === 'false' || bgParamClose === 'no';
                const dbReadyClose = !!(sqliteDb && sqliteDb.prepare);
                if (forceDirectClose && dbReadyClose) {
                    try {
                        const hearingIdClose = String(req.params.id).trim();
                        const nClose = Number(req.query.n || parsedBody?.n || DEFAULT_VARIANTS);
                        const payloadClose = {
                            hearing: parsedBody?.hearing || null,
                            responses: parsedBody?.responses || null,
                            materials: parsedBody?.materials || null,
                            edits: parsedBody?.edits || null,
                            n: nClose
                        };
                        const created = await createJob(req, hearingIdClose, payloadClose);
                        if (!created?.error && created?.jobId) {
                            logDebug(`[summarize] Client disconnected; started background job ${created.jobId}`);
                        }
                    } catch (e) {
                        logDebug(`[summarize] Disconnect salvage failed: ${e?.message || e}`);
                    }
                }
            } catch (_) {}
            // Do not resolve here; allow summarization worker to complete and record recent variants in memory
            try { if (!res.writableEnded) logDebug('[summarize] Client disconnected; continuing generation off-connection'); } catch {}
        });

        (async () => {
            try {
                // Sanitize and parse JSON if body arrived as text
                if (typeof req.body === 'string') {
                    let raw = req.body;
                    raw = raw.replace(/[\u0000-\u0019\u007F]/g, (ch) => (ch === '\n' || ch === '\r' || ch === '\t' ? ch : ' '));
                    try { req.body = JSON.parse(raw); }
                    catch (e) {
                        sendEvent('status', { phase: 'body', message: 'Body kunne ikke læses – fortsætter uden body…' });
                        req.body = {};
                    }
                }

                const DEMO2 = String(req.query.demo || '') === '1';
                if (DEMO2) {
                    const n = Number(req.query.n || 3);
                    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                    const demoDelay = Number(req.query.delay || process.env.DEMO_DELAY_MS || 400);
                    sendEvent('info', { message: `DEMO: Genererer ${n} varianter...`, hearing: (req.body && req.body.hearing) || undefined });
                    for (let i = 1; i <= n; i++) {
                        await sleep(demoDelay);
                        sendEvent('info', { message: `DEMO: Genererer variant ${i} af ${n}...` });
                        sendEvent('placeholder', { id: i });
                        await sleep(demoDelay);
                        sendEvent('status', { id: i, phase: 'started', message: 'Job startet…' });
                        const steps = [
                            'Identificerer gennemgående temaer',
                            'Vurderer prioritet: klima, trafik, byrum',
                            'Afklarer enighed/uenighed i indsigter',
                            'Matcher krav i materialet',
                            'Skitserer struktureret output'
                        ];
                        sendEvent('status', { id: i, phase: 'thinking', message: 'Modellen overvejer…' });
                        for (const s of steps) { await sleep(demoDelay); sendEvent('summary', { id: i, text: s }); }
                        await sleep(demoDelay);
                        sendEvent('status', { id: i, phase: 'drafting', message: 'Skriver udkast…' });
                        const markdown = `# Opsummering (DEMO ${i})\n\n## Klima\nFlere ønsker grønne tage.\n\n## Mobilitet\nCykelstier prioriteres.\n\n## Bykvalitet\nGrønne opholdszoner foreslås.`;
                        const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                        await sleep(demoDelay);
                        sendEvent('variant', { variant: { id: i, headings, markdown, summary: steps.join('\n') } });
                        await sleep(demoDelay);
                        sendEvent('status', { id: i, phase: 'done', message: 'Færdig' });
                    }
                    // extra small pause to ensure client digests last events before close
                    await sleep(50);
                    sendEvent('end', { message: 'Færdig med at generere (DEMO).' });
                    try { clearInterval(keepAliveInterval); } catch (_) {}
                    res.end();
                    return resolve();
                }
                const hearingId = String(req.params.id).trim();

                // CRITICAL: ALWAYS use background jobs via createJob to prevent duplicate prompts
                // This ensures locking and prevents sending hundreds of duplicate prompts
                const dbReady2 = !!(sqliteDb && sqliteDb.prepare);
                if (dbReady2) {
                    console.log(`[summarize] POST: Using background jobs via createJob to prevent duplicate prompts`);
                    await legacySummarizeAsJobSse(req, res, {
                        hearing: parsedBody && parsedBody.hearing,
                        responses: parsedBody && parsedBody.responses,
                        materials: parsedBody && parsedBody.materials,
                        edits: parsedBody && parsedBody.edits,
                        n: Number(req.query.n || parsedBody?.n || DEFAULT_VARIANTS)
                    });
                    return resolve();
                }

                if (!openai) {
                    sendEvent('status', { phase: 'openai', message: 'OPENAI_API_KEY mangler – kører ikke OpenAI.' });
                    sendEvent('error', { message: 'Manglende OPENAI_API_KEY i miljøet. Tilføj nøglen og prøv igen.' });
                    return res.end();
                } else {
                    sendEvent('status', { phase: 'openai', message: 'Forbundet til OpenAI.' });
                }
                const providedResponsesMd = null;
                const providedMaterialMd = null;

                // Pre-show variant placeholders and per-variant status early to avoid client fallback
                try {
                    const nPlaceholders = Number(req.query.n || 3);
                    for (let i = 1; i <= nPlaceholders; i++) {
                        sendEvent('placeholder', { id: i });
                        sendEvent('status', { id: i, phase: 'preparing', message: 'Forbereder variant…' });
                    }
                } catch (_) {}

                // Check if data was provided in request body (optimized path)
                let hearing, responses, materials;
                
                if (parsedBody && parsedBody.hearing && parsedBody.responses && parsedBody.materials) {
                    // Validate provided data
                    if (!parsedBody.hearing.id || !parsedBody.hearing.title) {
                        sendEvent('error', { message: 'Ugyldig høringsdata' });
                        return res.end();
                    }
                    
                    // Use provided data - much faster!
                    sendEvent('info', { message: 'Forbereder dokumenter...' });
                    sendEvent('status', { phase: 'preparing', message: 'Forbereder materiale til prompt…' });
                    hearing = parsedBody.hearing;
                    responses = Array.isArray(parsedBody.responses) ? parsedBody.responses : [];
                    materials = Array.isArray(parsedBody.materials) ? parsedBody.materials : [];
                    // Apply minimal respondent overrides if provided separately in body.edits
                    try {
                        const overrides = req.body && req.body.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
                        if (overrides) {
                            responses = responses.map(r => {
                                const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                                const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                                if (!ov || typeof ov !== 'object') return r;
                                const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                                const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                                const patched = { ...r };
                                if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                                if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                                return patched;
                            });
                        }
                    } catch (_) {}
                    
                    // Ensure hearing ID matches URL parameter
                    if (String(hearing.id) !== hearingId) {
                        sendEvent('error', { message: 'Høring ID matcher ikke' });
                        return res.end();
                    }
                    
                    console.log(`[summarize] Using provided data from request body - optimized path. Responses: ${responses.length}, Materials: ${materials.length}`);
                } else {
                    // Fallback to fetching data via aggregated endpoint to reduce latency, with live ticker
                    sendEvent('info', { message: 'Henter høringsdata...' });
                    const nPlaceholders = Number(req.query.n || 3);
                    try {
                        for (let i = 1; i <= nPlaceholders; i++) {
                            sendEvent('placeholder', { id: i });
                            sendEvent('status', { id: i, phase: 'preparing', message: 'Forbereder variant…' });
                        }
                    } catch (_) {}
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                    let secs = 0;
                    const ticker = setInterval(() => { secs += 2; try { sendEvent('info', { message: `Henter høringsdata… (${secs}s)` }); } catch {} }, 2000);
                    const metaResp = await axios.get(`${base}/api/hearing/${hearingId}?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                    try { clearInterval(ticker); } catch(_) {}
                    if (!metaResp.data?.success) {
                        sendEvent('error', { message: 'Kunne ikke hente høringsmetadata' });
                        return res.end();
                    }
                    hearing = metaResp.data.hearing;
                    let responsesRaw = Array.isArray(metaResp.data?.responses) ? metaResp.data.responses : [];
                    materials = Array.isArray(metaResp.data?.materials) ? metaResp.data.materials : [];
                    
                    // Prioritize published responses with focus_mode if available
                    if (!responsesRaw || responsesRaw.length === 0) {
                        try {
                            const published = getPublishedAggregate(Number(hearingId));
                            if (published && Array.isArray(published.responses) && published.responses.length > 0) {
                                // Build responses with focus_mode handling
                                responsesRaw = published.responses.map(r => {
                                    const responseText = r.textMd || r.text || '';
                                    const focusMode = r.focusMode || null;
                                    const attachments = Array.isArray(r.attachments) ? r.attachments : [];
                                    
                                    // Build text based on focus_mode
                                    let finalText = '';
                                    if (focusMode === 'attachment' || focusMode === 'vedhæftning') {
                                        // Only use attachment content
                                        const attachmentTexts = attachments
                                            .filter(a => a.contentMd)
                                            .map(a => a.contentMd)
                                            .join('\n\n');
                                        finalText = attachmentTexts || responseText; // Fallback to response if no attachments
                                    } else if (focusMode === 'both' || focusMode === 'begge') {
                                        // Use both response and attachments
                                        const attachmentTexts = attachments
                                            .filter(a => a.contentMd)
                                            .map(a => `[Vedhæftning: ${a.filename || 'Ukendt'}]\n${a.contentMd}`)
                                            .join('\n\n');
                                        finalText = responseText;
                                        if (attachmentTexts) {
                                            finalText = finalText ? `${finalText}\n\n${attachmentTexts}` : attachmentTexts;
                                        }
                                    } else {
                                        // Default: focus on response (or 'response' focus mode)
                                        finalText = responseText;
                                    }
                                    
                                    return {
                                        id: r.id,
                                        svarnummer: r.sourceId || r.id,
                                        text: finalText,
                                        svartekst: finalText,
                                        respondentName: r.respondentName || r.author || '',
                                        respondentType: r.respondentType || 'Borger',
                                        author: r.author || null,
                                        organization: r.organization || null
                                    };
                                });
                                console.log(`[summarize POST] Using ${responsesRaw.length} published responses (with focus_mode) for hearing ${hearingId}`);
                            }
                        } catch (err) {
                            console.warn('[summarize POST] Failed to load published responses:', err.message);
                        }
                    }
                    
                    // Ensure materials present by probing alternative endpoints when empty
                    if (!materials || materials.length === 0) {
                        try {
                            const mats = await axios.get(`${base}/api/hearing/${hearingId}/materials?persist=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                            if (mats && mats.data && mats.data.success && Array.isArray(mats.data.materials)) materials = mats.data.materials;
                        } catch {}
                        if (!materials || materials.length === 0) {
                            try {
                                const mats2 = await axios.get(`${base}/api/hearing/${hearingId}/materials?db=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                                if (mats2 && mats2.data && mats2.data.success && Array.isArray(mats2.data.materials)) materials = mats2.data.materials;
                            } catch {}
                        }
                        if (!materials || materials.length === 0) {
                            try {
                                const mats3 = await axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
                                if (mats3 && mats3.data && mats3.data.success && Array.isArray(mats3.data.materials)) materials = mats3.data.materials;
                            } catch {}
                        }
                    }
                    // Apply minimal respondent overrides if provided in body.edits
                    try {
                        const overrides = req.body && req.body.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
                        if (overrides) {
                            responses = responsesRaw.map(r => {
                                const key = String((r && (r.id ?? r.svarnummer)) ?? '');
                                const ov = key && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
                                if (!ov || typeof ov !== 'object') return r;
                                const rn = typeof ov.respondentName === 'string' ? ov.respondentName : (typeof ov.respondentnavn === 'string' ? ov.respondentnavn : undefined);
                                const rt = typeof ov.respondentType === 'string' ? ov.respondentType : (typeof ov.respondenttype === 'string' ? ov.respondenttype : undefined);
                                const patched = { ...r };
                                if (rn !== undefined) { patched.respondentName = rn; patched.respondentnavn = rn; }
                                if (rt !== undefined) { patched.respondentType = rt; patched.respondenttype = rt; }
                                return patched;
                            });
                        }
                    } catch (_) {}
                    
                    sendEvent('info', { message: 'Forbereder dokumenter...' });
                }
                
                const t1 = performance.now();
                console.log(`[summarize] Data preparation took ${Math.round(t1 - t0)} ms.`);

                // Build prompt in-memory to avoid disk I/O latency on the hot path
                let repliesText;
                console.log(`[summarize] Starting prompt construction...`);
                sendEvent('status', { phase: 'preparing', message: `Forbereder høringssvar...` });

                if (providedResponsesMd) {
                    repliesText = providedResponsesMd;
                } else {
                    // Build JSON with the exact fields expected by the wizard/UX:
                    // svarnummer, svartekst, respondentnavn, respondenttype
                    // Note: focus_mode handling already done if using published data
                    const repliesObjects = responses.map(r => ({
                        svarnummer: (r && (r.svarnummer ?? r.id)) ?? null,
                        svartekst: (r && (r.svartekst ?? r.text ?? r.textMd ?? '')) || '',
                        respondentnavn: (r && (r.respondentnavn ?? r.respondentName ?? r.author ?? '')) || '',
                        respondenttype: (r && (r.respondenttype ?? r.respondentType ?? 'Borger')) || 'Borger'
                    }));
                    repliesText = JSON.stringify(repliesObjects, null, 2);
                }
                
                const t2 = performance.now();
                console.log(`[summarize] Response JSON construction took ${Math.round(t2 - t1)} ms.`);
                sendEvent('status', { phase: 'preparing', message: `Forbereder materialer...` });

                let materialText;
                if (providedMaterialMd) {
                    materialText = providedMaterialMd;
                } else {
                    const materialLines = [];
                    materialLines.push(`# Høringsmateriale for ${hearing.title}`);
                    for (let i = 0; i < materials.length; i++) {
                        const m = materials[i] || {};
                        // Support both legacy server-extracted shape { type, title, url/content }
                        // and new client-provided shape { kind: 'text'|'file'|'link', ... }
                        const kind = m.kind || m.type;
                        try {
                            if ((kind === 'description' || kind === 'text') && m.content) {
                                materialLines.push('');
                                materialLines.push(String(m.content));
                                materialLines.push('');
                            } else if (kind === 'file') {
                                if (m.data && (m.mime || m.filename)) {
                                    // Client provided base64 file data. Persist to tmp and extract text when possible
                                    try {
                                        const buf = Buffer.from(String(m.data), 'base64');
                                        let ext = '';
                                        try {
                                            const lowerMime = String(m.mime || '').toLowerCase();
                                            if (lowerMime.includes('pdf')) ext = '.pdf';
                                            else if (lowerMime.includes('wordprocessingml')) ext = '.docx';
                                            else if (lowerMime.includes('msword')) ext = '.doc';
                                            else if (lowerMime.includes('text')) ext = '.txt';
                                            else if (lowerMime.includes('html')) ext = '.html';
                                        } catch (_) {}
                                        if (!ext && m.filename) {
                                            try { const p = String(m.filename); const maybe = '.' + (p.split('.').pop() || ''); if (maybe.length <= 6) ext = maybe; } catch (_) {}
                                        }
                                        const tmpPath = path.join(ensureTmpDir(), `material_${Date.now()}_${i}${ext || ''}`);
                                        fs.writeFileSync(tmpPath, buf);
                                        let extracted = '';
                                        try { extracted = await extractTextFromLocalFile(tmpPath); } catch (_) {}
                                        if (extracted && extracted.trim()) {
                                            materialLines.push('');
                                            materialLines.push(`## ${m.title || m.filename || 'Dokument'}`);
                                            materialLines.push(extracted);
                                            materialLines.push('');
                                        } else {
                                            // If no text could be extracted, just record its presence
                                            materialLines.push(`- ${m.title || m.filename || 'Dokument'} [indlejret fil, ${buf.length} bytes]`);
                                        }
                                    } catch (_) {
                                        materialLines.push(`- ${m.title || m.filename || 'Dokument'} [kunne ikke læses]`);
                                    }
                                } else if (m.url) {
                                    // No data provided; try to fetch and extract text from the URL server-side
                                    try {
                                        const base = `http://localhost:${PORT}`;
                                        const url = m.url.startsWith('/api/file-proxy') ? `${base}${m.url}` : `${base}/api/file-proxy?${new URLSearchParams({ path: m.url, filename: m.title || 'Dokument' }).toString()}`;
                                        const dl = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true, timeout: 45000, headers: { 'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8' } });
                                        if (dl && dl.status === 200 && dl.data) {
                                            const buf2 = Buffer.from(dl.data);
                                            let ext2 = '';
                                            try {
                                                const ctype = String(dl.headers['content-type'] || '').toLowerCase();
                                                if (ctype.includes('pdf')) ext2 = '.pdf';
                                                else if (ctype.includes('wordprocessingml')) ext2 = '.docx';
                                                else if (ctype.includes('msword')) ext2 = '.doc';
                                                else if (ctype.includes('text')) ext2 = '.txt';
                                                else if (ctype.includes('html')) ext2 = '.html';
                                            } catch (_) {}
                                            if (!ext2 && m.title) {
                                                try { const p = String(m.title); const maybe = '.' + (p.split('.').pop() || ''); if (maybe.length <= 6) ext2 = maybe; } catch (_) {}
                                            }
                                            const tmp2 = path.join(ensureTmpDir(), `material_${Date.now()}_${i}${ext2 || ''}`);
                                            fs.writeFileSync(tmp2, buf2);
                                            let extracted2 = '';
                                            try { extracted2 = await extractTextFromLocalFile(tmp2); } catch (_) {}
                                            if (extracted2 && extracted2.trim()) {
                                                materialLines.push('');
                                                materialLines.push(`## ${m.title || 'Dokument'}`);
                                                materialLines.push(extracted2);
                                                materialLines.push('');
                                            } else {
                                                materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                                            }
                                        } else {
                                            materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                                        }
                                    } catch (_) {
                                        materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                                    }
                                }
                            } else if (kind === 'link' && m.url) {
                                materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                            } else if (m.url && !kind) {
                                // Fallback: unknown kind but has URL
                                materialLines.push(`- ${m.title || 'Dokument'}: ${m.url}`);
                            }
                        } catch (_) {}
                        if (i > 0 && i % 5 === 0) {
                            sendEvent('status', { phase: 'preparing', message: `Forbereder materialer (${i}/${materials.length})...` });
                            await new Promise(resolve => setImmediate(resolve));
                        }
                    }
                    materialText = materialLines.join('\n');
                }

                const t3 = performance.now();
                console.log(`[summarize] Material construction took ${Math.round(t3 - t2)} ms.`);

                const systemPrompt = 'Du er en erfaren dansk fuldmægtig. Følg instruktionerne præcist.';
                const promptTemplate = readTextFileSafe(PROMPT_PATH) || '# Opgave\nSkriv en tematiseret opsummering baseret på materialet.';
                const RESP_LIMIT = Number(process.env.RESP_CHAR_LIMIT || 200000);
                const MAT_LIMIT = Number(process.env.MAT_CHAR_LIMIT || 120000);
                const userPrompt = `${promptTemplate}\n\n[Samlede Høringssvar]\n\n${String(repliesText || '').slice(0, RESP_LIMIT)}\n\n[Høringsmateriale]\n\n${String(materialText || '').slice(0, MAT_LIMIT)}`;
                
                const t4 = performance.now();
                console.log(`[summarize] Total prompt construction took ${Math.round(t4 - t1)} ms. Prompt length: ${userPrompt.length}`);

                logDebug(`[summarize] Constructed user prompt of length ${userPrompt.length}.`);

                if (userPrompt.length < 200) { // Arbitrary small length check
                    sendEvent('error', { message: 'Fejl: Kunne ikke generere prompt. For lidt data at arbejde med.'});
                    res.end();
                    return resolve();
                }

                const n = Number(req.query.n || 3);
                sendEvent('info', { message: `Genererer ${n} varianter...`, hearing });
                sendEvent('status', { phase: 'queueing', message: `Starter ${n} varianter…` });

                const model = MODEL_ID;
                const maxTokens = MAX_TOKENS;

                // Compute fast pre-thoughts for POST path too
                const preThoughts2 = computePreThoughts(userPrompt);

                function extractHeadingsFromSummary2(text) {
                    try {
                        const raw = String(text || '').replace(/\r/g, '');
                        const byLine = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
                        const bullets = byLine
                            .filter(l => /^[-*••]|^\d+\./.test(l) || (l.length <= 120 && /[:–-]/.test(l)))
                            .map(l => l.replace(/^[-*•\d+.\s]+/, '').trim());
                        const unique = [];
                        const seen = new Set();
                        for (const b of bullets) { if (!seen.has(b)) { seen.add(b); unique.push(b); } }
                        return unique.slice(-6);
                    } catch { return []; }
                }

                const runSummarizeTasks = () => {
                    return new Promise((resolveTasks, rejectTasks) => {
                        // Force background jobs in POST pathway to avoid long-lived direct stream stalls
                        // Also use polling when structured output is enabled (JSON cannot be streamed)
                        const useBackground = true;
                        const usePolling = useBackground || USE_STRUCTURED_OUTPUT;

                        const tasks = Array.from({ length: n }, (_, i) => {
                            const variantId = i + 1;
                            
                            return (async () => {
                                let stream;
                                let markdown = '';
                                let summaryText = '';
                                let poller;
                                let lastReportedLen = 0;
                                let gotFirstDelta = false;
                                let gotReasoningDelta = false;
                                let variantHeartbeat;

                                try {
                                    sendEvent('status', { id: variantId, phase: 'preparing', message: 'Registrerer job…' });
                                    
                                    // Use getModelParams to handle structured output correctly
                                    const params = getModelParams(userPrompt, systemPrompt, USE_STRUCTURED_OUTPUT, Number(hearingId));
                                    // Override model and input if needed
                                    params.model = model;
                                    params.input = [
                                        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
                                        { role: 'user', content: [{ type: 'input_text', text: userPrompt }] }
                                    ];
                                    // Ensure max_output_tokens is set
                                    if (Number.isFinite(maxTokens) && maxTokens > 0) params.max_output_tokens = maxTokens;

                                    if (usePolling) {
                                        params.stream = false;
                                        params.background = true;
                                        
                                        logDebug(`[summarize] Variant ${variantId}: Creating background job (polling mode${USE_STRUCTURED_OUTPUT ? ' - structured output' : ''}).`);
                                        sendEvent('status', { id: variantId, phase: 'creating_job', message: 'Opretter job hos OpenAI...' });
                                        const created = await openai.responses.create(params);
                                        const responseId = created && (created.id || created.response_id || created.response?.id);
                                        if (!responseId) throw new Error('Could not get response ID for background job.');
                                        
                                        logDebug(`[summarize] Variant ${variantId}: Job created with ID ${responseId}. Starting polling.`);
                                        sendEvent('status', { id: variantId, phase: 'queued', message: 'Job i kø, afventer start...' });

                                        await new Promise((resolvePoll, rejectPoll) => {
                                            let pollCount = 0;
                                            // 25 minutes @ 5s interval = 300 polls
                                            const maxPolls = Number.isFinite(SUMMARIZE_TIMEOUT_MS) ? Math.ceil(SUMMARIZE_TIMEOUT_MS / 5000) : 300;
                                            poller = setInterval(async () => {
                                                try {
                                                    if (res.writableEnded === false && pollCount++ > maxPolls) {
                                                        return rejectPoll(new Error('Polling timeout: Job took too long.'));
                                                    }
                                                    if (res.writableEnded) {
                                                        return resolvePoll();
                                                    }
                                                    
                                                    const job = await openai.responses.retrieve(responseId);
                                                    const status = String(job?.status || 'unknown').toLowerCase();
                                                    
                                                    logDebug(`[summarize] Variant ${variantId}: Poll count ${pollCount}, status: ${status}`);
                                                    sendEvent('status', { id: variantId, phase: 'polling', message: `Jobstatus: ${status}...` });

                                                    if (['completed', 'succeeded', 'done'].includes(status)) {
                                                        // Retrieve the final output immediately and emit variant, then resolve
                                                        try {
                                                            const job = await openai.responses.retrieve(responseId);
                                                            let text = parseOpenAIText(job, USE_STRUCTURED_OUTPUT);
                                                            if (!text) {
                                                                // Try to get from stream as fallback
                                                                try {
                                                                    const streamFallback = await openai.responses.stream({ response_id: responseId });
                                                                    let acc = '';
                                                                    for await (const ev of streamFallback) {
                                                                        if (ev?.type === 'response.output_text.delta') acc += (ev.delta || '');
                                                                    }
                                                                    if (acc && USE_STRUCTURED_OUTPUT) {
                                                                        try {
                                                                            const jsonData = JSON.parse(acc);
                                                                            if (jsonData && typeof jsonData === 'object') {
                                                                                text = convertJSONToMarkdown(jsonData);
                                                                            } else {
                                                                                text = acc;
                                                                            }
                                                                        } catch {
                                                                            text = acc;
                                                                        }
                                                                    } else {
                                                                        text = acc;
                                                                    }
                                                                } catch {}
                                                            }
                                                            
                                                            let markdown = (text || '').trim();
                                                            
                                                            // If structured output, convert JSON to Markdown after polling completes
                                                            if (USE_STRUCTURED_OUTPUT && markdown) {
                                                                try {
                                                                    const jsonData = JSON.parse(markdown);
                                                                    if (jsonData && typeof jsonData === 'object') {
                                                                        markdown = convertJSONToMarkdown(jsonData);
                                                                    }
                                                                } catch {
                                                                    // If not valid JSON, keep original markdown
                                                                }
                                                            }
                                                            
                                                            if (markdown) {
                                                                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                                                const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                                                sendEvent('variant', { variant });
                                                                const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                                                if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });
                                                            }
                                                        } catch (_) {}
                                                        if (poller) clearInterval(poller);
                                                        return resolvePoll();
                                                    } else if (['failed', 'error', 'cancelled'].includes(status)) {
                                                        if (poller) clearInterval(poller);
                                                        return rejectPoll(new Error(`Job failed with status: ${status}`));
                                                    }
                                                } catch (pollErr) {
                                                    logDebug(`[summarize] Variant ${variantId}: Poll error:`, pollErr?.message || pollErr);
                                                    // Continue polling on error
                                                }
                                            }, 5000);
                                        });
                                        
                                        // Skip streaming logic below
                                        return;
                                    } else if (useBackground) {
                                        params.stream = false;
                                        params.background = true;
                                        
                                        logDebug(`[summarize] Variant ${variantId}: Creating background job.`);
                                        sendEvent('status', { id: variantId, phase: 'creating_job', message: 'Opretter job hos OpenAI...' });
                                        const created = await openai.responses.create(params);
                                        const responseId = created && (created.id || created.response_id || created.response?.id);
                                        if (!responseId) throw new Error('Could not get response ID for background job.');
                                        
                                        logDebug(`[summarize] Variant ${variantId}: Job created with ID ${responseId}. Starting polling.`);
                                        sendEvent('status', { id: variantId, phase: 'queued', message: 'Job i kø, afventer start...' });

                                        await new Promise((resolvePoll, rejectPoll) => {
                                            let pollCount = 0;
                                            // 25 minutes @ 5s interval = 300 polls
                                            const maxPolls = Number.isFinite(SUMMARIZE_TIMEOUT_MS) ? Math.ceil(SUMMARIZE_TIMEOUT_MS / 5000) : 300;
                                            poller = setInterval(async () => {
                                                try {
                                                    if (res.writableEnded === false && pollCount++ > maxPolls) {
                                                        return rejectPoll(new Error('Polling timeout: Job took too long.'));
                                                    }
                                                    if (res.writableEnded) {
                                                        return resolvePoll();
                                                    }
                                                    
                                                    const job = await openai.responses.retrieve(responseId);
                                                    const status = String(job?.status || 'unknown').toLowerCase();
                                                    
                                                    logDebug(`[summarize] Variant ${variantId}: Poll count ${pollCount}, status: ${status}`);
                                                    sendEvent('status', { id: variantId, phase: 'polling', message: `Jobstatus: ${status}...` });

                                                    if (['completed', 'succeeded', 'done'].includes(status)) {
                                                        // Retrieve the final output immediately and emit variant, then resolve
                                                        try {
                                                            const job = await openai.responses.retrieve(responseId);
                                                            let text = parseOpenAIText(job, USE_STRUCTURED_OUTPUT);
                                                            if (!text) {
                                                                // Try to get from stream as fallback
                                                                try {
                                                                    const streamFallback = await openai.responses.stream({ response_id: responseId });
                                                                    let acc = '';
                                                                    for await (const ev of streamFallback) {
                                                                        if (ev?.type === 'response.output_text.delta') acc += (ev.delta || '');
                                                                    }
                                                                    if (acc && USE_STRUCTURED_OUTPUT) {
                                                                        try {
                                                                            const jsonData = JSON.parse(acc);
                                                                            if (jsonData && typeof jsonData === 'object') {
                                                                                text = convertJSONToMarkdown(jsonData);
                                                                            } else {
                                                                                text = acc;
                                                                            }
                                                                        } catch {
                                                                            text = acc;
                                                                        }
                                                                    } else {
                                                                        text = acc;
                                                                    }
                                                                } catch {}
                                                            }
                                                            
                                                            let markdown = (text || '').trim();
                                                            
                                                            // If structured output, convert JSON to Markdown after polling completes
                                                            if (USE_STRUCTURED_OUTPUT && markdown) {
                                                                try {
                                                                    const jsonData = JSON.parse(markdown);
                                                                    if (jsonData && typeof jsonData === 'object') {
                                                                        markdown = convertJSONToMarkdown(jsonData);
                                                                    }
                                                                } catch {
                                                                    // If not valid JSON, keep original markdown
                                                                }
                                                            }
                                                            
                                                            if (markdown) {
                                                                const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                                                const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                                                sendEvent('variant', { variant });
                                                                const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                                                if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });
                                                            }
                                                        } catch (_) {}
                                                        resolvePoll();
                                                    } else if (['failed', 'cancelled', 'error'].includes(status)) {
                                                        rejectPoll(new Error(`Job failed with status: ${status}`));
                                                    }
                                                } catch (pollErr) {
                                                    rejectPoll(pollErr);
                                                }
                                            }, 5000);
                                        }).finally(() => {
                                            clearInterval(poller);
                                        });

                                        logDebug(`[summarize] Variant ${variantId}: Polling complete. Emitting final result without streaming.`);
                                        // Do NOT stream by response_id (can TTL). We already emitted variant above if content was present.
                                        // If no markdown was emitted during completion branch, perform a last retrieve to populate it.
                                        try {
                                            if (!markdown || !markdown.trim()) {
                                                const job = await openai.responses.retrieve(responseId);
                                                const text = parseOpenAIText(job, USE_STRUCTURED_OUTPUT);
                                                markdown = (text || '').trim();
                                            }
                                        } catch {}
                                        if (markdown && markdown.trim().length) {
                                            const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                            const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                            sendEvent('variant', { variant });
                                            const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                            if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });
                                        }
                                        // Mark done and stop this variant task
                                        sendEvent('status', { id: variantId, phase: 'done', message: 'Færdig' });
                                        return;

                                    } else {
                                        params.stream = true;
                                        logDebug(`[summarize] Variant ${variantId}: Starting direct stream...`);
                                        sendEvent('status', { id: variantId, phase: 'connecting', message: 'Opretter direkte stream…' });
                                        stream = await openai.responses.stream(params);
                                    }

                                    // Per-variant liveness indicator
                                    const startedAtMs = Date.now();
                                    variantHeartbeat = setInterval(() => {
                                        try {
                                            if (res.writableEnded) { clearInterval(variantHeartbeat); return; }
                                            const secs = Math.round((Date.now() - startedAtMs) / 1000);
                                            if (!gotFirstDelta && !gotReasoningDelta) {
                                                sendEvent('status', { id: variantId, phase: 'connecting', message: `Tænker (${secs}s)` });
                                            } else if (gotReasoningDelta && !gotFirstDelta) {
                                                sendEvent('status', { id: variantId, phase: 'thinking', message: `Modellen overvejer… (${secs}s)` });
                                            } else if (gotFirstDelta) {
                                                sendEvent('status', { id: variantId, phase: 'drafting', message: `Skriver udkast… (${secs}s)` });
                                            }
                                        } catch (_) {}
                                    }, 5000);

                                    // Stream loop with partial flush of content/headings
                                    const seenHeadings = new Set();
                                    for await (const event of stream) {
                                        if (event && typeof event.type === 'string') {
                                            if (event.type === 'response.created') {
                                                sendEvent('status', { id: variantId, phase: 'started', message: 'Job startet…' });
                                            } else if (event.type.startsWith('response.tool_')) {
                                                sendEvent('status', { id: variantId, phase: 'using-tools', message: 'Kalder værktøjer…' });
                                            } else if (event.type === 'response.completed') {
                                                sendEvent('status', { id: variantId, phase: 'done', message: 'Færdig' });
                                            }
                                        }

                                        if (event.type === 'response.output_text.delta') {
                                            markdown += (event.delta || '');
                                            if (!gotFirstDelta) {
                                                gotFirstDelta = true;
                                                sendEvent('status', { id: variantId, phase: 'drafting', message: 'Skriver udkast…' });
                                            }
                                            // For structured output, don't send partial content - wait for complete JSON
                                            if (!USE_STRUCTURED_OUTPUT && markdown.length - lastReportedLen >= 200) {
                                                const tmpHeadings = (markdown.match(/^#{1,6} .*$/mg) || []);
                                                const newOnes = [];
                                                for (const h of tmpHeadings) {
                                                    if (!seenHeadings.has(h)) { seenHeadings.add(h); newOnes.push(h.replace(/^#{1,6}\s*/, '')); }
                                                }
                                                if (newOnes.length) sendEvent('headings', { id: variantId, items: Array.from(new Set(newOnes)).slice(-6) });
                                                sendEvent('content', { id: variantId, markdown });
                                                lastReportedLen = markdown.length;
                                            }
                                        } else if (event.type === 'response.reasoning_summary.delta' || event.type === 'response.reasoning_summary_text.delta') {
                                            const delta = (typeof event.delta === 'string') ? event.delta : (event.delta?.toString?.() || '');
                                            summaryText += (delta || '');
                                            if (!gotReasoningDelta) {
                                                gotReasoningDelta = true;
                                                sendEvent('status', { id: variantId, phase: 'thinking', message: 'Modellen overvejer…' });
                                            }
                                        } else if (event.type === 'response.reasoning_summary.done' || event.type === 'response.reasoning_summary_text.done') {
                                            if (event.text) summaryText = event.text;
                                        } else if (event.type === 'response.error') {
                                            throw new Error(event.error?.message || 'OpenAI stream error');
                                        }
                                    }

                                    // Fallback to non-streaming if nothing arrived
                                    if (!markdown) {
                                        try {
                                            const nonStreamParams = { model, input: params.input, stream: false };
                                            if (Number.isFinite(maxTokens) && maxTokens > 0) nonStreamParams.max_output_tokens = maxTokens;
                                            const resp = await openai.responses.create(nonStreamParams);
                                            let text = parseOpenAIText(resp, USE_STRUCTURED_OUTPUT);
                                            markdown = (text || '').trim();
                                        } catch (e) {
                                            // ignore; handled below
                                        }
                                    }

                                    // If structured output, convert JSON to Markdown after stream completes
                                    if (USE_STRUCTURED_OUTPUT && markdown) {
                                        try {
                                            const jsonData = JSON.parse(markdown);
                                            if (jsonData && typeof jsonData === 'object') {
                                                markdown = convertJSONToMarkdown(jsonData);
                                                // Send converted Markdown to frontend
                                                if (markdown) {
                                                    const tmpHeadings = (markdown.match(/^#{1,6} .*$/mg) || []);
                                                    const headings = tmpHeadings.map(h => h.replace(/^#{1,6}\s*/, ''));
                                                    sendEvent('headings', { id: variantId, items: headings });
                                                    sendEvent('content', { id: variantId, markdown });
                                                }
                                            }
                                        } catch {
                                            // If not valid JSON, keep original markdown
                                        }
                                    }

                                    if (!markdown) throw new Error('Empty response from OpenAI');

                                    const headings = (markdown.match(/^#{1,6} .*$/mg) || []).slice(0, 50);
                                    const variant = { id: variantId, headings, markdown, summary: (summaryText || '').trim() };
                                    sendEvent('variant', { variant });
                                    const finalHeadings = (headings || []).map(h => h.replace(/^#{1,6}\s*/, ''));
                                    if (finalHeadings.length) sendEvent('headings', { id: variantId, items: finalHeadings.slice(0, 6) });

                                } catch (err) {
                                    const detail = (err && (err.response?.data?.error?.message || err.error?.message || err.message)) || 'Ukendt fejl';
                                    logDebug(`[summarize] Variant ${variantId} failed: ${detail}`);
                                    sendEvent('error', { id: variantId, message: `Fejl i variant ${variantId}`, error: detail });
                                } finally {
                                    if (poller) clearInterval(poller);
                                    if (variantHeartbeat) clearInterval(variantHeartbeat);
                                    sendEvent('status', { id: variantId, phase: 'done', message: 'Færdig' });
                                }
                            })();
                        });

                        Promise.all(tasks).then(resolveTasks).catch(rejectTasks);
                    });
                };
                
                await runSummarizeTasks();
                
                // Clean up temporary vector store after prompt execution
                try {
                    if (sqliteDb && sqliteDb.prepare) {
                        sqliteDb.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(Number(hearingId));
                        logDebug(`[summarize POST] Cleaned up temporary vector store for hearing ${hearingId}`);
                    }
                } catch (cleanupErr) {
                    console.warn(`[summarize POST] Failed to cleanup vector store:`, cleanupErr.message);
                }
                
                sendEvent('end', { message: 'Færdig med at generere.' });
                res.end();
                resolve(); // Resolve the main promise
            } catch (e) {
                logDebug(`[summarize] Failed: ${e?.message || e}`);
                
                // Clean up temporary vector store even on error
                try {
                    if (sqliteDb && sqliteDb.prepare) {
                        sqliteDb.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(Number(hearingId));
                        logDebug(`[summarize POST] Cleaned up temporary vector store after error for hearing ${hearingId}`);
                    }
                } catch (cleanupErr) {
                    console.warn(`[summarize POST] Failed to cleanup vector store after error:`, cleanupErr.message);
                }
                
                if (!res.writableEnded) {
                    sendEvent('error', { message: 'Fejl ved opsummering', error: e.message });
                    res.end();
                }
                reject(e); // Reject the main promise on error
            } finally {
                clearInterval(keepAliveInterval);
            }
        })();
    });
});

// Build DOCX using Python tool from gpt5-webapp
app.post('/api/build-docx', express.json({ limit: '5mb' }), async (req, res) => {
    try {
        const { markdown, outFileName } = req.body || {};
        if (typeof markdown !== 'string' || !markdown.trim()) {
            return res.status(400).json({ success: false, message: 'Missing markdown' });
        }
        // Ensure python deps
        try { await ensurePythonDeps(); } catch {}
        const tmpDir = ensureTmpDir();
        const outPath = path.join(tmpDir, `${outFileName || 'output'}.docx`);

        const python = process.env.PYTHON_BIN || 'python3';
        // Always use the canonical builder script
        const scriptPath = path.join(__dirname, 'scripts', 'build_docx.py');
        // Prefer scriptskabelon paths for template and block if present; fallback to templates/
        const blockCandidates = [
            path.join(__dirname, 'scriptskabelon', 'blok.md'),
            path.join(__dirname, 'templates', 'blok.md')
        ];
        const templateCandidates = [
            TEMPLATE_DOCX,
            path.join(__dirname, 'scriptskabelon', 'Bilag 6 Svar på henvendelser i høringsperioden.docx'),
            path.join(__dirname, 'templates', 'Bilag 6 Svar på henvendelser i høringsperioden.docx')
        ];
        const templateBlockPath = blockCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || blockCandidates[blockCandidates.length - 1];
        const templateDocxPath = templateCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || TEMPLATE_DOCX;

        const args = [
            scriptPath,
            '--markdown', '-',
            '--out', outPath,
            '--template', templateDocxPath,
            '--template-block', templateBlockPath
        ];
        const localPy = path.join(__dirname, 'python_packages');
        const mergedPyPath = [localPy, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const env = { ...process.env, PYTHONPATH: mergedPyPath };
        const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        let stdout = '';
        let stderr = '';
        child.stdin.write(markdown);
        child.stdin.end();
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', async (code) => {
            if (code !== 0) {
                console.error('DOCX build error:', stderr);
                // Fallback: build a simple DOCX via Node if Python failed
                try {
                    const ok = await buildDocxFallbackNode(markdown, outPath);
                    if (ok) {
                        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
                        return fs.createReadStream(outPath).pipe(res);
                    }
                } catch (_) {}
                return res.status(500).json({ success: false, message: 'DOCX bygning fejlede', error: stderr || `exit ${code}` });
            }
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
            fs.createReadStream(outPath).pipe(res);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved DOCX bygning', error: e.message });
    }
});


// Test endpoint: build DOCX from bundled scriptskabelon/testOutputLLM.md
app.get('/api/test-docx', async (req, res) => {
    try {
        // Prefer scriptskabelon test if present; fallback to templates
        const sampleCandidates = [
            path.join(__dirname, 'scriptskabelon', 'testOutputLLM.md'),
            path.join(__dirname, 'templates', 'testOutputLLM.md')
        ];
        const samplePath = sampleCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || sampleCandidates[sampleCandidates.length - 1];
        if (!fs.existsSync(samplePath)) {
            return res.status(404).json({ success: false, message: 'Prøvedata ikke fundet' });
        }
        const markdown = fs.readFileSync(samplePath, 'utf8');
        // Ensure python deps
        try { await ensurePythonDeps(); } catch {}
        const tmpDir = ensureTmpDir();
        const outPath = path.join(tmpDir, `test_${Date.now()}.docx`);

        const python = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, 'scripts', 'build_docx.py');
        const blockCandidates = [
            path.join(__dirname, 'scriptskabelon', 'blok.md'),
            path.join(__dirname, 'templates', 'blok.md')
        ];
        const templateCandidates = [
            TEMPLATE_DOCX,
            path.join(__dirname, 'scriptskabelon', 'Bilag 6 Svar på henvendelser i høringsperioden.docx'),
            path.join(__dirname, 'templates', 'Bilag 6 Svar på henvendelser i høringsperioden.docx')
        ];
        const templateBlockPath = blockCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || blockCandidates[blockCandidates.length - 1];
        const templateDocxPath = templateCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || TEMPLATE_DOCX;
        const args = [
            scriptPath,
            '--markdown', '-',
            '--out', outPath,
            '--template', templateDocxPath,
            '--template-block', templateBlockPath
        ];
        const localPy2 = path.join(__dirname, 'python_packages');
        const mergedPyPath2 = [localPy2, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const env = { ...process.env, PYTHONPATH: mergedPyPath2 };
        const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        let stderr = '';
        child.stdin.write(markdown);
        child.stdin.end();
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', async (code) => {
            if (code !== 0) {
                // Fallback: build a simple DOCX via Node if Python failed
                try {
                    const ok = await buildDocxFallbackNode(markdown, outPath);
                    if (ok) {
                        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                        res.setHeader('Content-Disposition', 'attachment; filename="test_output.docx"');
                        return fs.createReadStream(outPath).pipe(res);
                    }
                } catch (_) {}
                return res.status(500).json({ success: false, message: 'DOCX bygning fejlede', error: stderr || `exit ${code}` });
            }
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', 'attachment; filename="test_output.docx"');
            fs.createReadStream(outPath).pipe(res);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fejl ved test-DOCX', error: e.message });
    }
});

// GDPR preparation endpoints
// Get selected hearings (global list)
app.get('/api/gdpr/selected-hearings', (req, res) => {
    try {
        const db = sqliteModule ? sqliteModule.db : sqliteDb;
        if (!db || typeof db.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database utilgængelig' });
        }
        const selectedIds = db.prepare(`SELECT hearing_id FROM gdpr_selected_hearings ORDER BY added_at DESC`).all().map(r => r.hearing_id);
        
        // Get full hearing data for selected hearings
        const hearings = [];
        for (const hearingId of selectedIds) {
            try {
                const hearing = db.prepare(`SELECT h.id, h.title, h.status, h.deadline, h.start_date, h.updated_at, s.status as prep_status, s.responses_ready, s.materials_ready, s.last_modified_at, s.published_at FROM hearings h LEFT JOIN hearing_preparation_state s ON s.hearing_id = h.id WHERE h.id=?`).get(hearingId);
                if (hearing) {
                    const rawCount = db.prepare(`SELECT COUNT(*) as count FROM raw_responses WHERE hearing_id=?`).get(hearingId)?.count || 0;
                    const preparedCount = db.prepare(`SELECT COUNT(*) as count FROM prepared_responses WHERE hearing_id=?`).get(hearingId)?.count || 0;
                    const publishedCount = db.prepare(`SELECT COUNT(*) as count FROM published_responses WHERE hearing_id=?`).get(hearingId)?.count || 0;
                    hearings.push({
                        hearingId: hearing.id,
                        id: hearing.id,
                        title: hearing.title,
                        status: hearing.status,
                        deadline: hearing.deadline,
                        startDate: hearing.start_date,
                        updatedAt: hearing.updated_at,
                        preparation: {
                            status: hearing.prep_status || 'draft',
                            responsesReady: !!hearing.responses_ready,
                            materialsReady: !!hearing.materials_ready
                        },
                        counts: {
                            rawResponses: rawCount,
                            preparedResponses: preparedCount,
                            publishedResponses: publishedCount
                        }
                    });
                }
            } catch (err) {
                console.error(`[GDPR] Error loading hearing ${hearingId}:`, err);
            }
        }
        res.json({ success: true, hearings });
    } catch (error) {
        console.error('[GDPR] get selected hearings failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke hente valgte høringer' });
    }
});

// Add hearing to selected list
app.post('/api/gdpr/selected-hearings/:id', (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const db = sqliteModule ? sqliteModule.db : sqliteDb;
        if (!db || typeof db.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database utilgængelig' });
        }
        const now = Date.now();
        db.prepare(`INSERT OR IGNORE INTO gdpr_selected_hearings(hearing_id, added_at) VALUES (?, ?)`).run(hearingId, now);
        res.json({ success: true });
    } catch (error) {
        console.error('[GDPR] add selected hearing failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke tilføje høring' });
    }
});

// Remove hearing from selected list
app.delete('/api/gdpr/selected-hearings/:id', (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const db = sqliteModule ? sqliteModule.db : sqliteDb;
        if (!db || typeof db.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database utilgængelig' });
        }
        db.prepare(`DELETE FROM gdpr_selected_hearings WHERE hearing_id=?`).run(hearingId);
        res.json({ success: true });
    } catch (error) {
        console.error('[GDPR] remove selected hearing failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke fjerne høring' });
    }
});

// Legacy endpoint - keep for backwards compatibility but return selected hearings
app.get('/api/gdpr/hearings', (req, res) => {
    try {
        // Return selected hearings instead of all hearings
        const db = sqliteModule ? sqliteModule.db : sqliteDb;
        if (!db || typeof db.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database utilgængelig' });
        }
        const selectedIds = db.prepare(`SELECT hearing_id FROM gdpr_selected_hearings ORDER BY added_at DESC`).all().map(r => r.hearing_id);
        
        // Get full hearing data for selected hearings
        const hearings = [];
        for (const hearingId of selectedIds) {
            try {
                const hearing = db.prepare(`SELECT h.id, h.title, h.status, h.deadline, h.start_date, h.updated_at, s.status as prep_status, s.responses_ready, s.materials_ready, s.last_modified_at, s.published_at FROM hearings h LEFT JOIN hearing_preparation_state s ON s.hearing_id = h.id WHERE h.id=?`).get(hearingId);
                if (hearing) {
                    const rawCount = db.prepare(`SELECT COUNT(*) as count FROM raw_responses WHERE hearing_id=?`).get(hearingId)?.count || 0;
                    const preparedCount = db.prepare(`SELECT COUNT(*) as count FROM prepared_responses WHERE hearing_id=?`).get(hearingId)?.count || 0;
                    const publishedCount = db.prepare(`SELECT COUNT(*) as count FROM published_responses WHERE hearing_id=?`).get(hearingId)?.count || 0;
                    hearings.push({
                        hearingId: hearing.id,
                        id: hearing.id,
                        title: hearing.title,
                        status: hearing.status,
                        deadline: hearing.deadline,
                        startDate: hearing.start_date,
                        updatedAt: hearing.updated_at,
                        preparation: {
                            status: hearing.prep_status || 'draft',
                            responsesReady: !!hearing.responses_ready,
                            materialsReady: !!hearing.materials_ready
                        },
                        counts: {
                            rawResponses: rawCount,
                            preparedResponses: preparedCount,
                            publishedResponses: publishedCount
                        }
                    });
                }
            } catch (err) {
                console.error(`[GDPR] Error loading hearing ${hearingId}:`, err);
            }
        }
        res.json({ success: true, hearings });
    } catch (error) {
        console.error('[GDPR] list hearings failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke hente oversigt' });
    }
});

app.get('/api/gdpr/hearing/:id', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        // Ensure hearing exists in hearings table (needed for search index and getPreparedBundle)
        if (sqliteDb && sqliteDb.prepare) {
            const existingHearing = sqliteDb.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
            if (!existingHearing) {
                // Try to get hearing meta from blivhørt and save it
                try {
                    const baseUrl = 'https://blivhoert.kk.dk';
                    const axiosInstance = axios.create({
                        headers: {
                            'User-Agent': 'Mozilla/5.0',
                            'Accept': 'text/html,application/xhtml+xml',
                            'Cookie': 'kk-xyz=1',
                            'Referer': `${baseUrl}/hearing/${hearingId}/comments`
                        },
                        timeout: 10000,
                        validateStatus: () => true
                    });
                    const rootPage = await fetchHearingRootPage(baseUrl, hearingId, axiosInstance);
                    if (rootPage && rootPage.nextJson) {
                        const meta = extractMetaFromNextJson(rootPage.nextJson);
                        if (meta && (meta.title || meta.deadline || meta.startDate)) {
                            upsertHearing({
                                id: hearingId,
                                title: meta.title || `Høring ${hearingId}`,
                                startDate: meta.startDate || null,
                                deadline: meta.deadline || null,
                                status: meta.status || null
                            });
                        } else {
                            // Fallback: create minimal entry
                            upsertHearing({
                                id: hearingId,
                                title: `Høring ${hearingId}`,
                                startDate: null,
                                deadline: null,
                                status: null
                            });
                        }
                    } else {
                        // Fallback: create minimal entry
                        upsertHearing({
                            id: hearingId,
                            title: `Høring ${hearingId}`,
                            startDate: null,
                            deadline: null,
                            status: null
                        });
                    }
                } catch (metaErr) {
                    console.warn(`[GDPR] Failed to fetch hearing meta for ${hearingId}:`, metaErr.message);
                    // Fallback: create minimal entry
                    upsertHearing({
                        id: hearingId,
                        title: `Høring ${hearingId}`,
                        startDate: null,
                        deadline: null,
                        status: null
                    });
                }
            }
        }
        
        ensurePreparedResponsesFromRaw(hearingId);
        
        // Check for pagination parameters
        const page = toInt(req.query.page) || 1;
        const pageSize = Math.min(toInt(req.query.pageSize) || 50, 200); // Max 200 per page
        const pendingOnly = req.query.pendingOnly !== 'false'; // Default: true
        const search = req.query.search || '';
        
        // Use paginated version if page parameter is provided or if there are many responses
        const usePagination = req.query.page !== undefined || req.query.pendingOnly !== undefined;
        
        if (usePagination && typeof getPreparedBundlePaginated === 'function') {
            const bundle = getPreparedBundlePaginated(hearingId, { page, pageSize, pendingOnly, search });
            if (!bundle) return res.status(404).json({ success: false, error: 'Høring ikke fundet' });
            res.json({ success: true, paginated: true, ...bundle });
        } else {
            const bundle = getPreparedBundle(hearingId);
            if (!bundle) return res.status(404).json({ success: false, error: 'Høring ikke fundet' });
            res.json({ success: true, paginated: false, ...bundle });
        }
    } catch (error) {
        console.error('[GDPR] load bundle failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke indlæse høring' });
    }
});

app.post('/api/gdpr/hearing/:id/state', express.json({ limit: '512kb' }), (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const patch = {};
        if (req.body && typeof req.body === 'object') {
            if (Object.prototype.hasOwnProperty.call(req.body, 'status')) patch.status = String(req.body.status || '').trim() || undefined;
            if (Object.prototype.hasOwnProperty.call(req.body, 'preparedBy')) patch.prepared_by = String(req.body.preparedBy || '').trim() || null;
            if (Object.prototype.hasOwnProperty.call(req.body, 'notes')) patch.notes = String(req.body.notes || '').trim() || null;
            if (Object.prototype.hasOwnProperty.call(req.body, 'vectorStoreId')) patch.vector_store_id = req.body.vectorStoreId ? String(req.body.vectorStoreId) : null;
            if (Object.prototype.hasOwnProperty.call(req.body, 'vectorStoreUpdatedAt')) patch.vector_store_updated_at = toInt(req.body.vectorStoreUpdatedAt, null);
            if (Object.prototype.hasOwnProperty.call(req.body, 'publishedAt')) patch.published_at = toInt(req.body.publishedAt, null);
        }
        const state = updatePreparationState(hearingId, patch);
        res.json({ success: true, state });
    } catch (error) {
        console.error('[GDPR] update state failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke opdatere status' });
    }
});

app.post('/api/gdpr/hearing/:id/responses', express.json({ limit: '5mb' }), (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    const body = req.body || {};
    try {
        let preparedId = toInt(body.preparedId, null);
        if (!preparedId) preparedId = allocatePreparedResponseId(hearingId);
        const payload = {
            sourceResponseId: toInt(body.sourceResponseId, null),
            respondentName: body.respondentName ?? null,
            respondentType: body.respondentType ?? null,
            author: body.author ?? null,
            organization: body.organization ?? null,
            onBehalfOf: body.onBehalfOf ?? null,
            submittedAt: body.submittedAt ?? null,
            textMd: body.textMd ?? body.text ?? '',
            hasAttachments: !!body.hasAttachments,
            attachmentsReady: !!body.attachmentsReady,
            approved: !!body.approved,
            approvedAt: toInt(body.approvedAt, null),
            notes: body.notes ?? null,
            focusMode: body.focusMode || null
        };
        const result = upsertPreparedResponse(hearingId, preparedId, payload);
        res.json({ success: true, preparedId, state: result?.state || recalcPreparationProgress(hearingId) });
    } catch (error) {
        console.error('[GDPR] upsert response failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke gemme høringssvar' });
    }
});

app.delete('/api/gdpr/hearing/:id/responses/:preparedId', (req, res) => {
    const hearingId = toInt(req.params.id);
    const preparedId = toInt(req.params.preparedId);
    if (!hearingId || !preparedId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    try {
        const state = deletePreparedResponse(hearingId, preparedId);
        res.json({ success: true, state });
    } catch (error) {
        console.error('[GDPR] delete prepared response failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke slette høringssvar' });
    }
});

app.post('/api/gdpr/hearing/:id/responses/:preparedId/attachments', express.json({ limit: '10mb' }), (req, res) => {
    const hearingId = toInt(req.params.id);
    const preparedId = toInt(req.params.preparedId);
    if (!hearingId || !preparedId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    try {
        const body = req.body || {};
        let attachmentId = toInt(body.attachmentId, null);
        if (!attachmentId) attachmentId = allocatePreparedAttachmentId(hearingId, preparedId);
        const payload = {
            sourceAttachmentIdx: toInt(body.sourceAttachmentIdx, null),
            originalFilename: body.originalFilename ?? null,
            sourceUrl: body.sourceUrl ?? null,
            convertedMd: body.convertedMd ?? null,
            conversionStatus: body.conversionStatus ?? null,
            approved: !!body.approved,
            approvedAt: toInt(body.approvedAt, null),
            notes: body.notes ?? null
        };
        const state = upsertPreparedAttachment(hearingId, preparedId, attachmentId, payload);
        res.json({ success: true, attachmentId, state });
    } catch (error) {
        console.error('[GDPR] upsert attachment failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke gemme vedhæftning' });
    }
});

app.delete('/api/gdpr/hearing/:id/responses/:preparedId/attachments/:attachmentId', (req, res) => {
    const hearingId = toInt(req.params.id);
    const preparedId = toInt(req.params.preparedId);
    const attachmentId = toInt(req.params.attachmentId);
    if (!hearingId || !preparedId || !attachmentId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    try {
        const state = deletePreparedAttachment(hearingId, preparedId, attachmentId);
        res.json({ success: true, state });
    } catch (error) {
        console.error('[GDPR] delete attachment failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke slette vedhæftning' });
    }
});

app.post('/api/gdpr/hearing/:id/responses/:preparedId/reset', async (req, res) => {
    const hearingId = toInt(req.params.id);
    const preparedId = toInt(req.params.preparedId);
    if (!hearingId || !preparedId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    try {
        ensurePreparedResponsesFromRaw(hearingId);
    } catch (error) {
        console.warn('[GDPR] ensurePreparedResponsesFromRaw (reset single) failed:', error?.message || error);
    }
    try {
        const preparedRow = db.prepare(`
            SELECT prepared_id as preparedId, source_response_id as sourceResponseId
            FROM prepared_responses
            WHERE hearing_id=? AND prepared_id=?
        `).get(hearingId, preparedId);
        if (!preparedRow) {
            return res.status(404).json({ success: false, error: 'Klargjort svar ikke fundet' });
        }
        const sourceId = toInt(preparedRow.sourceResponseId);
        if (!sourceId) {
            return res.status(400).json({ success: false, error: 'Dette svar kan ikke nulstilles automatisk' });
        }

        let raw = db.prepare(`
            SELECT response_id as responseId, text, author, organization, on_behalf_of as onBehalfOf, submitted_at as submittedAt
            FROM raw_responses
            WHERE hearing_id=? AND response_id=?
        `).get(hearingId, sourceId);

        if (!raw) {
            try { await hydrateHearingDirect(hearingId); } catch (error) { console.warn('[GDPR] hydrate during reset single failed:', error?.message || error); }
            raw = db.prepare(`
                SELECT response_id as responseId, text, author, organization, on_behalf_of as onBehalfOf, submitted_at as submittedAt
                FROM raw_responses
                WHERE hearing_id=? AND response_id=?
            `).get(hearingId, sourceId);
        }

        if (!raw) {
            return res.status(404).json({ success: false, error: 'Originalt svar kunne ikke findes' });
        }

        const clearAttachments = db.transaction(() => {
            db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, preparedId);
        });
        clearAttachments();

        const rawAttachments = db.prepare(`
            SELECT idx as attachmentIdx, filename, url
            FROM raw_attachments
            WHERE hearing_id=? AND response_id=?
            ORDER BY idx ASC
        `).all(hearingId, sourceId) || [];

        upsertPreparedResponse(hearingId, preparedId, {
            sourceResponseId: sourceId,
            respondentName: 'Borger', // Standard skal være "Borger" - ikke bruge navne fra blivhørt
            respondentType: 'Borger', // Standard skal være "Borger"
            author: raw.author || null,
            organization: raw.organization || null,
            onBehalfOf: raw.onBehalfOf || null,
            submittedAt: raw.submittedAt || null,
            textMd: raw.text || '',
            hasAttachments: rawAttachments.length > 0,
            attachmentsReady: false,
            approved: false,
            notes: null
        });

        rawAttachments.forEach((attachment, idx) => {
            const attachmentId = allocatePreparedAttachmentId(hearingId, preparedId);
            const rawIdx = Number(attachment.attachmentIdx);
            upsertPreparedAttachment(hearingId, preparedId, attachmentId, {
                sourceAttachmentIdx: Number.isFinite(rawIdx) ? rawIdx : idx,
                originalFilename: attachment.filename || `Bilag ${idx + 1}`,
                sourceUrl: attachment.url || null,
                convertedMd: null,
                conversionStatus: null,
                approved: false,
                notes: null
            });
        });

        const bundle = getPreparedBundle(hearingId);
        return res.json({ success: true, bundle });
    } catch (error) {
        console.error('[GDPR] reset prepared response failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke nulstille svar' });
    }
});

app.post('/api/gdpr/hearing/:id/refresh-raw', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    try {
        // Ensure hearing exists in hearings table before hydration
        let hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
        if (!hearing) {
            // Create minimal hearing entry if it doesn't exist
            try {
                upsertHearing({
                    id: hearingId,
                    title: `Høring ${hearingId}`,
                    startDate: null,
                    deadline: null,
                    status: null
                });
                hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
            } catch (err) {
                console.warn(`[GDPR] Failed to create hearing entry before hydration:`, err.message);
            }
        }
        
        // Fetch fresh raw data from blivhørt
        const hydrateResult = await hydrateHearingDirect(hearingId);
        if (!hydrateResult || !hydrateResult.success) {
            const errorMsg = hydrateResult?.error || 'Ukendt fejl';
            console.error('[GDPR] hydrateHearingDirect failed:', errorMsg);
            return res.status(500).json({ success: false, error: `Kunne ikke hente høringssvar: ${errorMsg}` });
        }
        
        // Verify that hearing was saved after hydration
        hearing = db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
        if (!hearing) {
            console.warn(`[GDPR] Hearing ${hearingId} was not saved to hearings table after hydration - creating it now`);
            try {
                upsertHearing({
                    id: hearingId,
                    title: `Høring ${hearingId}`,
                    startDate: null,
                    deadline: null,
                    status: null
                });
            } catch (err) {
                console.error(`[GDPR] Failed to create hearing entry after hydration:`, err.message);
            }
        }
        
        // Verify that responses were actually saved
        const savedCount = db.prepare(`SELECT COUNT(*) as count FROM raw_responses WHERE hearing_id=?`).get(hearingId).count;
        if (savedCount === 0 && hydrateResult.responses > 0) {
            console.warn(`[GDPR] hydrateHearingDirect reported ${hydrateResult.responses} responses but none were saved to DB`);
            // Don't fail - maybe it's still saving, but log it
        }
        
        // Get existing approved prepared responses to preserve
        const existingApproved = db.prepare(`
            SELECT prepared_id, source_response_id, approved, approved_at
            FROM prepared_responses
            WHERE hearing_id=? AND approved=1
        `).all(hearingId);
        
        const approvedBySourceId = new Map();
        for (const row of existingApproved) {
            if (row.source_response_id !== null && row.source_response_id !== undefined) {
                approvedBySourceId.set(Number(row.source_response_id), {
                    preparedId: row.prepared_id,
                    approvedAt: row.approved_at
                });
            }
        }
        
        // Ensure prepared responses exist for all raw responses
        // This will only create new ones, not overwrite existing
        ensurePreparedResponsesFromRaw(hearingId);
        
        // Restore approved status for previously approved responses
        if (approvedBySourceId.size > 0) {
            const tx = db.transaction(() => {
                for (const [sourceId, info] of approvedBySourceId.entries()) {
                    // Find the prepared response for this source
                    const prepared = db.prepare(`
                        SELECT prepared_id FROM prepared_responses
                        WHERE hearing_id=? AND source_response_id=?
                        ORDER BY prepared_id ASC LIMIT 1
                    `).get(hearingId, sourceId);
                    
                    if (prepared) {
                        // Restore approved status
                        db.prepare(`
                            UPDATE prepared_responses
                            SET approved=1, approved_at=?
                            WHERE hearing_id=? AND prepared_id=?
                        `).run(info.approvedAt || Date.now(), hearingId, prepared.prepared_id);
                    }
                }
            });
            tx();
        }
        
        // Recalculate progress
        recalcPreparationProgress(hearingId);
        
        // DON'T automatically rebuild vector store - it requires OpenAI API key
        // Vector store rebuild should only happen when explicitly requested via /vector-store/rebuild endpoint
        // This allows refresh-raw to work without OpenAI API key
        
        // Start background attachment fetching (non-blocking)
        // This runs in the background after the response is sent
        console.log(`[GDPR] Starting background PDF attachment fetching for hearing ${hearingId}...`);
        fetchAndConvertAttachments(hearingId)
            .then(result => {
                if (result.success) {
                    console.log(`[GDPR] Background attachment fetch complete: ${result.converted} converted, ${result.failed} failed`);
                } else {
                    console.warn(`[GDPR] Background attachment fetch failed:`, result.error);
                }
            })
            .catch(err => {
                console.warn(`[GDPR] Background attachment fetch error:`, err.message);
            });
        
        const bundle = getPreparedBundle(hearingId);
        if (!bundle) return res.status(404).json({ success: false, error: 'Høring ikke fundet' });
        res.json({ success: true, bundle, hydrateResult, attachmentPending: true, message: 'Vedhæftninger hentes i baggrunden' });
    } catch (error) {
        console.error('[GDPR] refresh raw failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke opdatere fra blivhørt', details: error.message });
    }
});

// Fetch and convert PDF attachments for unapproved responses
app.post('/api/gdpr/hearing/:id/fetch-attachments', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    
    try {
        console.log(`[GDPR] Fetching attachments for hearing ${hearingId}`);
        const result = await fetchAndConvertAttachments(hearingId);
        
        if (result.success) {
            console.log(`[GDPR] Fetched ${result.converted} attachments (${result.failed} failed)`);
            res.json({ 
                success: true, 
                converted: result.converted, 
                failed: result.failed, 
                total: result.total,
                message: `Konverterede ${result.converted} vedhæftninger${result.failed > 0 ? `, ${result.failed} fejlede` : ''}`
            });
        } else {
            res.status(500).json({ success: false, error: result.error || 'Kunne ikke hente vedhæftninger' });
        }
    } catch (error) {
        console.error('[GDPR] fetch-attachments failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke hente vedhæftninger', details: error.message });
    }
});

// Fetch and convert a single attachment
app.post('/api/gdpr/hearing/:id/fetch-single-attachment', express.json({ limit: '1mb' }), async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    
    const { preparedId, attachmentId, sourceIdx, sourceResponseId } = req.body;
    if (!preparedId || !attachmentId) {
        return res.status(400).json({ success: false, error: 'Mangler preparedId eller attachmentId' });
    }
    
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    
    try {
        console.log(`[GDPR] Fetching single attachment for response ${sourceResponseId}, attachment ${attachmentId}`);
        
        // Get attachment info from database
        const attachment = db.prepare(`
            SELECT pa.*, ra.content_id, ra.filename as raw_filename
            FROM prepared_attachments pa
            LEFT JOIN raw_attachments ra ON ra.hearing_id = pa.hearing_id AND ra.response_id = ? AND ra.idx = (pa.attachment_id - 1)
            WHERE pa.hearing_id = ? AND pa.prepared_id = ? AND pa.attachment_id = ?
        `).get(sourceResponseId, hearingId, preparedId, attachmentId);
        
        if (!attachment) {
            return res.status(404).json({ success: false, error: 'Vedhæftning ikke fundet' });
        }
        
        let contentId = attachment.content_id;
        let filename = attachment.original_filename || attachment.raw_filename || 'file.pdf';
        
        // If no contentId, fetch from API
        if (!contentId && sourceResponseId) {
            console.log(`[GDPR] No contentId cached, fetching from API for response ${sourceResponseId}`);
            const apiUrl = `https://blivhoert.kk.dk/api/hearing/${hearingId}/comment?include=Contents,Contents.ContentType&Page=1`;
            const resp = await axios.get(apiUrl, {
                headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
                timeout: 60000
            });
            
            if (resp.status === 200 && resp.data?.data) {
                const comments = resp.data.data || [];
                const included = resp.data.included || [];
                const contentById = new Map();
                included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
                
                // Find the comment with matching response number
                const comment = comments.find(c => c.attributes?.number === sourceResponseId);
                if (comment) {
                    const contentRefs = comment.relationships?.contents?.data || [];
                    // Filter to only file attachments (not text content)
                    const fileRefs = contentRefs.filter(cref => {
                        const c = contentById.get(String(cref.id));
                        return c?.attributes?.filePath;
                    });
                    const attIdx = (attachmentId || 1) - 1;
                    if (fileRefs[attIdx]) {
                        const cid = String(fileRefs[attIdx].id);
                        const content = contentById.get(cid);
                        contentId = cid;
                        filename = content.attributes.fileName || filename;
                    }
                }
            }
        }
        
        if (!contentId) {
            return res.status(404).json({ success: false, error: 'Kunne ikke finde fil-ID for vedhæftning' });
        }
        
        // Download and convert
        console.log(`[GDPR] Downloading content ${contentId}: ${filename}`);
        const result = await downloadAndConvertAttachment(contentId, filename);
        
        if (result.success && result.markdown) {
            // Update database
            db.prepare(`
                UPDATE prepared_attachments 
                SET converted_md = ?, conversion_status = 'auto', source_url = ?, updated_at = ?
                WHERE hearing_id = ? AND prepared_id = ? AND attachment_id = ?
            `).run(
                result.markdown,
                `https://blivhoert.kk.dk/api/content/${contentId}/download?apiKey=`,
                Date.now(),
                hearingId, preparedId, attachmentId
            );
            
            console.log(`[GDPR] Successfully converted attachment for response ${sourceResponseId}`);
            res.json({ success: true, markdown: result.markdown });
        } else {
            res.status(500).json({ success: false, error: result.error || 'Konvertering mislykkedes' });
        }
    } catch (error) {
        console.error('[GDPR] fetch-single-attachment failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke hente vedhæftning', details: error.message });
    }
});

app.post('/api/gdpr/hearing/:id/cleanup-duplicates', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    try {
        // Find and remove duplicates - keep only one prepared response per source_response_id
        const duplicates = db.prepare(`
            SELECT source_response_id, COUNT(*) as count, MIN(prepared_id) as keep_id
            FROM prepared_responses
            WHERE hearing_id=? AND source_response_id IS NOT NULL
            GROUP BY hearing_id, source_response_id
            HAVING COUNT(*) > 1
        `).all(hearingId);
        
        let deletedCount = 0;
        if (duplicates.length > 0) {
            const tx = db.transaction(() => {
                for (const dup of duplicates) {
                    // Get IDs to delete (all except the one to keep)
                    const toDelete = db.prepare(`
                        SELECT prepared_id FROM prepared_responses
                        WHERE hearing_id=? AND source_response_id=? AND prepared_id != ?
                    `).all(hearingId, dup.source_response_id, dup.keep_id);
                    
                    for (const row of toDelete) {
                        // Delete attachments first
                        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        // Then delete the response
                        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        deletedCount++;
                    }
                }
            });
            tx();
        }

        // Also remove orphaned prepared responses (those without a source_response_id that matches a raw response)
        const rawIds = db.prepare(`SELECT response_id FROM raw_responses WHERE hearing_id=?`).all(hearingId).map(r => r.response_id);
        if (rawIds.length > 0) {
            const placeholders = rawIds.map(() => '?').join(',');
            const orphaned = db.prepare(`
                SELECT prepared_id FROM prepared_responses
                WHERE hearing_id=? AND (source_response_id IS NULL OR source_response_id NOT IN (${placeholders}))
            `).all(hearingId, ...rawIds);
            
            if (orphaned.length > 0) {
                const tx = db.transaction(() => {
                    for (const row of orphaned) {
                        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        deletedCount++;
                    }
                });
                tx();
            }
        } else {
            // If no raw responses exist, remove all prepared responses without source_response_id
            const orphaned = db.prepare(`
                SELECT prepared_id FROM prepared_responses
                WHERE hearing_id=? AND source_response_id IS NULL
            `).all(hearingId);
            
            if (orphaned.length > 0) {
                const tx = db.transaction(() => {
                    for (const row of orphaned) {
                        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        deletedCount++;
                    }
                });
                tx();
            }
        }

        // Recalculate progress
        recalcPreparationProgress(hearingId);
        
        const bundle = getPreparedBundle(hearingId);
        res.json({ success: true, deletedCount, bundle });
    } catch (error) {
        console.error('[GDPR] cleanup duplicates failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke rydde duplikater' });
    }
});

app.post('/api/gdpr/hearing/:id/reset', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const hydrateResult = await hydrateHearingDirect(hearingId);
        if (!hydrateResult || !hydrateResult.success) {
            const errorMsg = hydrateResult?.error || 'Ukendt fejl';
            console.error('[GDPR] hydrateHearingDirect during reset failed:', errorMsg);
            // Continue anyway - maybe we can still reset the prepared data
        }
    } catch (error) {
        console.warn('[GDPR] hydrate during reset failed:', error?.message || error);
    }
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    try {
        const tx = db.transaction(() => {
            db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM prepared_materials WHERE hearing_id=?`).run(hearingId);
        });
        tx();
    } catch (error) {
        console.error('[GDPR] reset hearing cleanup failed:', error);
        return res.status(500).json({ success: false, error: 'Kunne ikke rydde klargjorte data' });
    }
    try {
        ensurePreparedResponsesFromRaw(hearingId);
        // Cleanup duplicates after ensuring prepared responses (in case duplicates were created)
        const duplicates = db.prepare(`
            SELECT source_response_id, COUNT(*) as count, MIN(prepared_id) as keep_id
            FROM prepared_responses
            WHERE hearing_id=? AND source_response_id IS NOT NULL
            GROUP BY hearing_id, source_response_id
            HAVING COUNT(*) > 1
        `).all(hearingId);
        if (duplicates.length > 0) {
            const cleanupTx = db.transaction(() => {
                for (const dup of duplicates) {
                    const toDelete = db.prepare(`
                        SELECT prepared_id FROM prepared_responses
                        WHERE hearing_id=? AND source_response_id=? AND prepared_id != ?
                    `).all(hearingId, dup.source_response_id, dup.keep_id);
                    for (const row of toDelete) {
                        db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                        db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).run(hearingId, row.prepared_id);
                    }
                }
            });
            cleanupTx();
        }
    } catch (error) {
        console.warn('[GDPR] ensurePreparedResponsesFromRaw during reset failed:', error?.message || error);
    }
    try {
        recalcPreparationProgress(hearingId);
        updatePreparationState(hearingId, { status: 'draft', responses_ready: 0, materials_ready: 0, published_at: null, last_modified_at: Date.now() });
    } catch (error) {
        console.warn('[GDPR] reset hearing state update failed:', error?.message || error);
    }
    const bundle = getPreparedBundle(hearingId);
    if (!bundle) return res.status(404).json({ success: false, error: 'Høring ikke fundet' });
    res.json({ success: true, bundle });
});

app.post('/api/gdpr/hearing/:id/materials', express.json({ limit: '10mb' }), (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const body = req.body || {};
        let materialId = toInt(body.materialId, null);
        if (!materialId) materialId = allocatePreparedMaterialId(hearingId);
        const payload = {
            title: body.title ?? null,
            sourceFilename: body.sourceFilename ?? null,
            sourceUrl: body.sourceUrl ?? null,
            contentMd: body.contentMd ?? body.content ?? null,
            uploadedPath: body.uploadedPath ?? null,
            approved: !!body.approved,
            approvedAt: toInt(body.approvedAt, null),
            notes: body.notes ?? null
        };
        const state = upsertPreparedMaterial(hearingId, materialId, payload);
        res.json({ success: true, materialId, state });
    } catch (error) {
        console.error('[GDPR] upsert material failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke gemme materiale' });
    }
});

app.delete('/api/gdpr/hearing/:id/materials/:materialId', (req, res) => {
    const hearingId = toInt(req.params.id);
    const materialId = toInt(req.params.materialId);
    if (!hearingId || !materialId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    try {
        const state = deletePreparedMaterial(hearingId, materialId);
        res.json({ success: true, state });
    } catch (error) {
        console.error('[GDPR] delete material failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke slette materiale' });
    }
});

app.post('/api/gdpr/hearing/:id/responses/:preparedId/attachments/:attachmentId/upload', gdprMaterialUpload.single('file'), async (req, res) => {
    const hearingId = toInt(req.params.id);
    const preparedId = toInt(req.params.preparedId);
    const attachmentId = toInt(req.params.attachmentId);
    if (!hearingId || !preparedId || !attachmentId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Ingen fil modtaget' });
    const filePath = file.path;
    console.log(`[GDPR] Upload received: originalName=${file.originalname}, storedPath=${filePath}, exists=${fs.existsSync(filePath)}`);
    try {
        res.json({
            success: true,
            originalName: file.originalname,
            storedPath: filePath,
            mimeType: file.mimetype,
            size: file.size
        });
    } catch (error) {
        console.error('[GDPR] attachment upload failed:', error);
        res.status(500).json({ success: false, error: 'Upload mislykkedes', detail: error.message });
    }
});

app.post('/api/gdpr/hearing/:id/responses/:preparedId/attachments/:attachmentId/convert', express.json({ limit: '1mb' }), async (req, res) => {
    const hearingId = toInt(req.params.id);
    const preparedId = toInt(req.params.preparedId);
    const attachmentId = toInt(req.params.attachmentId);
    if (!hearingId || !preparedId || !attachmentId) return res.status(400).json({ success: false, error: 'Ugyldige parametre' });
    let workingPath = null;
    let cleanupPath = false;
    let originalFilename = null;
    const body = req.body || {};
    try {
        let sourceUrl = body.sourceUrl ? String(body.sourceUrl).trim() : null;
        if (!sourceUrl && Object.prototype.hasOwnProperty.call(body, 'rawAttachmentIdx')) {
            const rawIdx = toInt(body.rawAttachmentIdx, null);
            if (rawIdx !== null && sqliteDb && sqliteDb.prepare) {
                const linkRow = sqliteDb.prepare(`SELECT source_response_id FROM prepared_responses WHERE hearing_id=? AND prepared_id=?`).get(hearingId, preparedId);
                const sourceResponseId = linkRow?.source_response_id;
                if (sourceResponseId !== undefined && sourceResponseId !== null) {
                    const rawRow = sqliteDb.prepare(`SELECT url, filename FROM raw_attachments WHERE hearing_id=? AND response_id=? AND idx=?`).get(hearingId, sourceResponseId, rawIdx);
                    if (rawRow) {
                        sourceUrl = rawRow.url || sourceUrl;
                        originalFilename = rawRow.filename || originalFilename;
                    }
                }
            }
        }

        if (body.uploadedPath) {
            console.log(`[GDPR] Looking for uploaded file at: ${body.uploadedPath}`);
            // First try the path as-is (multer gives absolute path)
            if (fs.existsSync(body.uploadedPath)) {
                workingPath = body.uploadedPath;
                console.log(`[GDPR] Found file at exact path: ${workingPath}`);
            } else {
                // Try both relative and absolute paths
                const candidate = path.resolve(String(body.uploadedPath));
                const relativeCandidate = path.isAbsolute(body.uploadedPath) ? body.uploadedPath : path.join(__dirname, body.uploadedPath);
                
                if (fs.existsSync(candidate)) {
                    workingPath = candidate;
                    console.log(`[GDPR] Found file at resolved path: ${workingPath}`);
                } else if (fs.existsSync(relativeCandidate)) {
                    workingPath = relativeCandidate;
                    console.log(`[GDPR] Found file at relative path: ${workingPath}`);
                } else {
                    console.warn(`[GDPR] Uploaded path does not exist: ${candidate} or ${relativeCandidate} or ${body.uploadedPath}`);
                    // Try to find the file in gdprUploadDir
                    const filename = path.basename(body.uploadedPath);
                    const gdprPath = path.join(gdprUploadDir, filename);
                    if (fs.existsSync(gdprPath)) {
                        workingPath = gdprPath;
                        console.log(`[GDPR] Found file in gdprUploadDir: ${gdprPath}`);
                    } else {
                        console.error(`[GDPR] File not found anywhere. Searched: ${body.uploadedPath}, ${candidate}, ${relativeCandidate}, ${gdprPath}`);
                    }
                }
            }
        }

        if (!workingPath) {
            if (!sourceUrl) {
                return res.status(400).json({ success: false, error: 'Ingen kilde til konvertering angivet' });
            }
            const response = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
            if (response.status >= 400 || !response.data) {
                return res.status(response.status || 500).json({ success: false, error: 'Kunne ikke hente vedhæftning' });
            }
            const data = Buffer.from(response.data);
            const extGuess = (sourceUrl.split('?')[0] || '').split('.');
            const ext = extGuess.length > 1 ? extGuess.pop() : 'pdf';
            const tmpFile = path.join(ensureTmpDir(), `attachment_${Date.now()}.${ext || 'pdf'}`);
            fs.writeFileSync(tmpFile, data);
            workingPath = tmpFile;
            cleanupPath = true;
        }

        if (!workingPath || !fs.existsSync(workingPath)) {
            return res.status(400).json({ success: false, error: 'Filen blev ikke fundet til konvertering', detail: `Søgte efter: ${body.uploadedPath || 'N/A'}` });
        }

        console.log(`[GDPR] Converting attachment from path: ${workingPath}`);
        console.log(`[GDPR] File exists: ${fs.existsSync(workingPath)}, size: ${fs.existsSync(workingPath) ? fs.statSync(workingPath).size : 'N/A'} bytes`);
        const result = await convertFileToMarkdown(workingPath, { includeMetadata: true });
        const markdown = result?.markdown || '';
        const payload = {
            originalFilename: originalFilename || body.originalFilename || path.basename(workingPath),
            convertedMd: markdown,
            conversionStatus: 'converted',
            approved: !!body.approved,
            notes: body.notes ?? null
        };
        const state = upsertPreparedAttachment(hearingId, preparedId, attachmentId, payload);
        try {
            if (sqliteDb && sqliteDb.prepare) {
                sqliteDb.prepare(`UPDATE prepared_responses SET has_attachments=1, attachments_ready=1, updated_at=? WHERE hearing_id=? AND prepared_id=?`).run(Date.now(), hearingId, preparedId);
            }
        } catch (err) {
            console.warn('[GDPR] failed to mark attachments ready:', err.message);
        }
        res.json({ success: true, attachmentId, markdown, metadata: result?.metadata || null, state });
    } catch (error) {
        console.error('[GDPR] convert attachment failed:', error);
        console.error('[GDPR] Error stack:', error.stack);
        console.error('[GDPR] Error stderr:', error.stderr);
        console.error('[GDPR] Error stdout:', error.stdout);
        // Include stderr and stdout in detail if available
        let detail = error.message || 'Konvertering mislykkedes';
        if (error.stderr) {
            detail += `\n\nPython fejl:\n${error.stderr}`;
        }
        if (error.stdout && !error.stderr) {
            detail += `\n\nPython output:\n${error.stdout}`;
        }
        res.status(500).json({ success: false, error: 'Konvertering mislykkedes', detail });
    } finally {
        if (cleanupPath && workingPath) {
            try { fs.unlinkSync(workingPath); } catch (_) {}
        }
    }
});

app.post('/api/gdpr/hearing/:id/materials/upload', gdprMaterialUpload.single('file'), async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Ingen fil modtaget' });
    const filePath = file.path;
    try {
        // Convert files at upload time to ensure content is available for analysis
        const ext = path.extname(file.originalname || '').toLowerCase();
        let contentMd = '';
        let metadata = null;
        if (ext === '.pdf') {
            // Use pdf-to-markdown.py (same as analysis pipeline) for proper header detection
            try {
                // Multer saves without extension - rename to .pdf so script recognizes it
                const pdfPath = filePath + '.pdf';
                fs.renameSync(filePath, pdfPath);

                const python = process.env.PYTHON_BIN || 'python3';
                const scriptPath = path.join(__dirname, 'analysis-pipeline', 'scripts', 'pdf-to-markdown.py');
                const outputPath = pdfPath.replace(/\.pdf$/i, '.md');
                const localPy = path.join(__dirname, 'python_packages');
                const mergedPyPath = [localPy, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
                const env = { ...process.env, PYTHONPATH: mergedPyPath };

                await new Promise((resolve, reject) => {
                    const child = spawn(python, [scriptPath, '-i', pdfPath, '-o', outputPath], { stdio: ['ignore', 'pipe', 'pipe'], env });
                    let stdout = '', stderr = '';
                    child.stdout.on('data', d => { stdout += d.toString(); });
                    child.stderr.on('data', d => { stderr += d.toString(); });
                    child.on('error', reject);
                    child.on('close', code => {
                        if (code !== 0) {
                            console.error(`[GDPR] pdf-to-markdown.py stderr: ${stderr}`);
                            console.error(`[GDPR] pdf-to-markdown.py stdout: ${stdout}`);
                            reject(new Error(`pdf-to-markdown.py exited with code ${code}: ${stderr || stdout}`));
                        } else resolve();
                    });
                });

                // Update filePath to the renamed path for response
                Object.assign(file, { path: pdfPath });

                if (fs.existsSync(outputPath)) {
                    contentMd = fs.readFileSync(outputPath, 'utf-8');
                    console.log(`[GDPR] PDF converted to markdown (${contentMd.length} chars)`);
                }
            } catch (convErr) {
                console.error('[GDPR] PDF conversion failed:', convErr.message);
                // Keep file - user can see it was uploaded, but content may be empty
            }
        } else if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
            contentMd = fs.readFileSync(filePath, 'utf-8');
        }
        res.json({
            success: true,
            originalName: file.originalname,
            storedPath: file.path,
            mimeType: file.mimetype,
            size: file.size,
            contentMd: contentMd,
            metadata
        });
    } catch (error) {
        console.error('[GDPR] material upload failed:', error);
        res.status(500).json({ success: false, error: 'Upload mislykkedes', detail: error.message });
    }
});

app.post('/api/gdpr/hearing/:id/vector-store/rebuild', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const result = await rebuildLocalVectorStore(hearingId);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[GDPR] rebuild vector store failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/gdpr/hearing/:id', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    try {
        const tx = db.transaction(() => {
            // Delete all related data
            db.prepare(`DELETE FROM vector_chunks WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM hearing_preparation_state WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM published_materials WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM published_attachments WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM published_responses WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM prepared_materials WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM prepared_attachments WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM prepared_responses WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM raw_materials WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM raw_attachments WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM raw_responses WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM hearings WHERE id=?`).run(hearingId);
        });
        tx();
        res.json({ success: true });
    } catch (error) {
        console.error('[GDPR] delete hearing failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke slette høring' });
    }
});

app.delete('/api/gdpr/hearing/:id/published', async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    // Get live db reference
    const db = sqliteModule ? sqliteModule.db : sqliteDb;
    if (!db || typeof db.prepare !== 'function') {
        return res.status(500).json({ success: false, error: 'Database utilgængelig' });
    }
    try {
        const tx = db.transaction(() => {
            db.prepare(`DELETE FROM published_responses WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM published_attachments WHERE hearing_id=?`).run(hearingId);
            db.prepare(`DELETE FROM published_materials WHERE hearing_id=?`).run(hearingId);
        });
        tx();
        // Update preparation state to remove published_at
        updatePreparationState(hearingId, { published_at: null });
        res.json({ success: true });
    } catch (error) {
        console.error('[GDPR] delete published failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke slette publicerede data' });
    }
});

app.post('/api/gdpr/hearing/:id/publish', express.json({ limit: '1mb' }), async (req, res) => {
    const hearingId = toInt(req.params.id);
    if (!hearingId) return res.status(400).json({ success: false, error: 'Ugyldigt hørings-ID' });
    try {
        const onlyApproved = req.body && Object.prototype.hasOwnProperty.call(req.body, 'onlyApproved')
            ? !!req.body.onlyApproved
            : true;
        const state = publishPreparedHearing(hearingId, { onlyApproved });
        // Don't rebuild vector store on publish - it will be built on-demand when prompt runs
        res.json({ success: true, state });
    } catch (error) {
        console.error('[GDPR] publish failed:', error);
        res.status(500).json({ success: false, error: 'Kunne ikke publicere høring' });
    }
});

// Latest variants for a hearing (from the most recent job), for robust client fallback
app.get('/api/hearing/:id/variants/latest', (req, res) => {
    try {
        if (!sqliteDb || !sqliteDb.prepare) {
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }
        const hid = String(req.params.id).trim();
        const row = sqliteDb.prepare(`SELECT job_id FROM jobs WHERE hearing_id = ? ORDER BY updated_at DESC LIMIT 1`).get(Number(hid));
        if (!row || !row.job_id) {
            return res.json({ success: true, variants: [] });
        }
        const rows = sqliteDb.prepare(`SELECT variant as id, markdown, summary, headings_json as headingsJson FROM job_variants WHERE job_id=? ORDER BY variant ASC`).all(row.job_id);
        const variants = rows.map(r => ({ id: r.id, markdown: r.markdown || '', summary: r.summary || '', headings: r.headingsJson ? JSON.parse(r.headingsJson) : [] }))
            .filter(v => (v.markdown && v.markdown.trim().length) || (v.summary && v.summary.trim().length));
        return res.json({ success: true, variants });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// Recent in-memory variants (best-effort) for very fresh results even if DB not yet updated
app.get('/api/hearing/:id/variants/recent', (req, res) => {
    try {
        const hid = String(req.params.id || '').trim();
        if (!hid || !recentVariantsByHearing.has(hid)) return res.json({ success: true, variants: [] });
        const m = recentVariantsByHearing.get(hid);
        const out = Array.from(m.values()).sort((a,b) => Number(a.id) - Number(b.id));
        return res.json({ success: true, variants: out });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// Simple backend debug view to inspect API output without a frontend
app.get('/debug/hearing/:id', async (req, res) => {
    try {
        const apiUrl = `/api/hearing/${encodeURIComponent(req.params.id)}`;
        // Call our own API internally
        const localUrl = `http://localhost:${PORT}${apiUrl}`;
        const r = await axios.get(localUrl, { validateStatus: () => true });
        const payload = r.data || {};
        const html = `
            <!doctype html>
            <html lang="da">
            <head>
                <meta charset="utf-8" />
                <title>Debug: Høringssvar ${req.params.id}</title>
                <style>
                    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 20px; }
                    h1 { font-weight: 400; }
                    .meta { background:#eef6ff; padding:12px; border-left:4px solid #1e88e5; margin:16px 0; }
                    .resp { border:1px solid #eee; border-radius:8px; padding:12px; margin:12px 0; }
                    .atts a { display:block; margin:2px 0; color:#1e88e5; text-decoration:none; }
                    code, pre { background:#f8f9fa; padding: 8px; border-radius: 6px; display:block; overflow:auto; }
                </style>
            </head>
            <body>
                <h1>Debug: Høringssvar ${req.params.id}</h1>
                <div class="meta">
                    <div><strong>ID:</strong> ${payload?.hearing?.id ?? ''}</div>
                    <div><strong>Titel:</strong> ${payload?.hearing?.title ?? ''}</div>
                    <div><strong>Status:</strong> ${payload?.hearing?.status ?? ''}</div>
                    <div><strong>Start:</strong> ${payload?.hearing?.startDate ?? ''}</div>
                    <div><strong>Frist:</strong> ${payload?.hearing?.deadline ?? ''}</div>
                    <div><strong>URL:</strong> <a href="${payload?.hearing?.url ?? '#'}" target="_blank">${payload?.hearing?.url ?? ''}</a></div>
                    <div><strong>Antal svar:</strong> ${payload?.totalResponses ?? 0}</div>
                </div>
                ${(payload?.responses || []).map(r => `
                    <div class="resp">
                        <div><strong>Svarnummer:</strong> ${r.id}</div>
                        ${r.submittedAt ? `<div><strong>Dato:</strong> ${r.submittedAt}</div>` : ''}
                        ${r.author || r.organization ? `<div><strong>Forfatter/Org.:</strong> ${(r.author||'') + (r.organization? ' – '+r.organization : '')}</div>` : ''}
                        ${r.onBehalfOf ? `<div><strong>På vegne af:</strong> ${r.onBehalfOf}</div>` : ''}
                        ${r.authorAddress ? `<div><strong>Adresse:</strong> ${r.authorAddress}</div>` : ''}
                        <div style="margin-top:8px; white-space:pre-wrap">${(r.text||'').replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}</div>
                        ${Array.isArray(r.attachments) && r.attachments.length ? `<div class="atts" style="margin-top:8px;"><strong>Bilag:</strong>${r.attachments.map(a => `<a href="${a.url}" target="_blank">📄 ${a.filename}</a>`).join('')}</div>` : ''}
                    </div>
                `).join('')}
                <h3>Rå JSON</h3>
                <pre>${JSON.stringify(payload, null, 2).replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}</pre>
            </body>
            </html>
        `;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        res.status(500).send(`<pre>Fejl: ${error.message}</pre>`);
    }
});

// Accept client-side logs to surface errors in Render logs
app.post('/api/client-log', express.json({ limit: '256kb' }), (req, res) => {
    try {
        const { level = 'info', message = '', meta = {} } = req.body || {};
        const line = `[client] ${level}: ${message} ${Object.keys(meta||{}).length ? JSON.stringify(meta) : ''}`;
        logDebug(line);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Health endpoints for Render
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// Test SQLite installation
app.get('/api/test-sqlite', (req, res) => {
    try {
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (e) {
            return res.json({ 
                betterSqlite3: false, 
                error: e.message,
                stack: e.stack 
            });
        }
        
        const testPath = path.join(process.cwd(), 'test.db');
        try {
            const testDb = new Database(testPath);
            testDb.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER)');
            const result = testDb.prepare('SELECT 1 as test').get();
            testDb.close();
            fs.unlinkSync(testPath);
            
            return res.json({ 
                betterSqlite3: true, 
                testSuccess: true,
                result,
                testPath
            });
        } catch (e) {
            return res.json({ 
                betterSqlite3: true, 
                testSuccess: false,
                error: e.message,
                stack: e.stack,
                testPath
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Force database re-initialization endpoint
app.post('/api/db-reinit', (req, res) => {
    try {
        console.log('[API] Forcing database re-initialization...');
        initDb();
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && sqlite.db && sqlite.db.prepare) sqlite.db.prepare('SELECT 1').get();
        } catch {}
        res.json({ success: true, message: 'Database re-initialized' });
    } catch (e) {
        console.error('[API] Database re-init failed:', e);
        res.status(500).json({ success: false, error: e.message, stack: e.stack });
    }
});

// Database status endpoint for debugging
app.get('/api/db-status', (req, res) => {
    try {
        const isRender = process.env.RENDER === 'true';
        const dbPath = process.env.DB_PATH || (isRender
            ? '/opt/render/project/src/data/hearings.db'
            : path.join(__dirname, 'data', 'hearings.db'));
        const status = {
            dbPath: dbPath,
            isRender: isRender,
            dbExists: false,
            hearingCount: 0,
            responseCount: 0,
            materialCount: 0,
            rawResponseCount: 0,
            publishedResponseCount: 0,
            rawMaterialCount: 0,
            publishedMaterialCount: 0,
            lastHearingUpdate: null,
            error: null,
            fileExists: fs.existsSync(dbPath),
            dirExists: fs.existsSync(path.dirname(dbPath)),
            workingDir: process.cwd()
        };
        
        // Get the current database instance from the module
        const sqlite = require('./db/sqlite');
        const currentDb = sqlite.db;
        
        if (currentDb && currentDb.prepare) {
            try {
                status.dbExists = true;
                status.hearingCount = currentDb.prepare('SELECT COUNT(*) as count FROM hearings').get().count;
                status.rawResponseCount = currentDb.prepare('SELECT COUNT(*) as count FROM raw_responses').get().count;
                status.publishedResponseCount = currentDb.prepare('SELECT COUNT(*) as count FROM published_responses').get().count;
                status.responseCount = status.publishedResponseCount || status.rawResponseCount;
                status.rawMaterialCount = currentDb.prepare('SELECT COUNT(*) as count FROM raw_materials').get().count;
                status.publishedMaterialCount = currentDb.prepare('SELECT COUNT(*) as count FROM published_materials').get().count;
                status.materialCount = status.publishedMaterialCount || status.rawMaterialCount;
                
                const lastUpdate = currentDb.prepare('SELECT MAX(updated_at) as last FROM hearings').get();
                status.lastHearingUpdate = lastUpdate.last ? new Date(lastUpdate.last).toISOString() : null;
            } catch (e) {
                status.error = e.message;
                status.errorStack = e.stack;
            }
        } else {
            status.error = 'Database not initialized';
            status.sqliteDb = !!sqliteDb;
            status.currentDb = !!currentDb;
            status.sqliteDbPrepare = !!(sqliteDb && sqliteDb.prepare);
            status.currentDbPrepare = !!(currentDb && currentDb.prepare);
        }
        
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Rebuild/warm hearings search index on demand (fire-and-forget)
app.post('/api/rebuild-index', async (req, res) => {
    try {
        setImmediate(() => {
            try { warmHearingIndex().catch(() => {}); } catch {}
        });
        res.json({ success: true, queued: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke starte genopbygning' });
    }
});

// Prefetch and persist all data for a hearing (meta+responses+materials) to disk
app.post('/api/prefetch/:id', async (req, res) => {
    try {
        const hearingId = String(req.params.id).trim();
        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        const apiOnly = String(req.query.apiOnly || '').trim() === '1' || API_ONLY_PREFETCH;
        if (prefetchInFlight.has(hearingId)) {
            return res.json({ success: true, skipped: true, reason: 'in-flight' });
        }
        prefetchInFlight.add(hearingId);
        let payload = null;
        if (apiOnly) {
            // Use API-only routes to avoid HTML scraping for cron/prefetch.
            // IMPORTANT: The DB-only aggregate endpoint may 404 if not yet persisted.
            // Prefer the dedicated meta endpoint which fetches from source.
            const [metaResp, resps, mats] = await Promise.all([
                axios.get(`${base}/api/hearing/${hearingId}/meta`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/responses?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS })
            ]);
            if (metaResp.status === 200 && metaResp.data && metaResp.data.success) {
                payload = {
                    success: true,
                    hearing: metaResp.data.hearing,
                    responses: Array.isArray(resps?.data?.responses) ? resps.data.responses : [],
                    materials: Array.isArray(mats?.data?.materials) ? mats.data.materials : [],
                    totalPages: metaResp.data.totalPages || undefined
                };
            } else {
                // Fallback minimal payload allows persisting responses/materials even if meta fails
                payload = {
                    success: true,
                    hearing: { id: Number(hearingId), title: `Høring ${hearingId}`, startDate: null, deadline: null, status: 'ukendt' },
                    responses: Array.isArray(resps?.data?.responses) ? resps.data.responses : [],
                    materials: Array.isArray(mats?.data?.materials) ? mats.data.materials : []
                };
            }
        } else {
            const [agg, resps, mats] = await Promise.all([
                axios.get(`${base}/api/hearing/${hearingId}?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/responses?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }),
                axios.get(`${base}/api/hearing/${hearingId}/materials?nocache=1`, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS })
            ]);
            if (agg.status === 200 && agg.data && agg.data.success) payload = agg.data;
            else if (resps.status === 200 && mats.status === 200 && resps.data && mats.data) {
                payload = {
                    success: true,
                    hearing: { id: Number(hearingId) },
                    responses: Array.isArray(resps.data.responses) ? resps.data.responses : [],
                    materials: Array.isArray(mats.data.materials) ? mats.data.materials : []
                };
            }
        }
        if (!payload) { prefetchInFlight.delete(hearingId); return res.status(500).json({ success: false, message: 'Kunne ikke hente data' }); }

        // Fallback: If materials are missing, try a targeted hydration to extract materials
        try {
            const needsMaterials = !Array.isArray(payload.materials) || payload.materials.length === 0;
            if (needsMaterials) {
                const hyd = await hydrateHearingDirect(hearingId);
                if (hyd && hyd.success) {
                    // Prefer responses with more items
                    if (Array.isArray(hyd.materials) && hyd.materials.length > 0) {
                        payload.materials = hyd.materials;
                    }
                    if (Array.isArray(hyd.responses) && ((payload.responses||[]).length < hyd.responses.length)) {
                        payload.responses = hyd.responses;
                    }
                    if (payload.hearing && typeof payload.hearing === 'object') {
                        // If hydrate wrote improved meta to DB, keep current payload.hearing as-is
                    }
                }
            }
        } catch {}
        writePersistedHearing(hearingId, payload);
        // Also persist to SQLite for stable reads (use fresh handle to avoid stale captures)
        try {
            const sqlite = require('./db/sqlite');
            if (sqlite && typeof sqlite.upsertHearing === 'function' && sqlite.db && sqlite.db.prepare) {
                if (payload.hearing) sqlite.upsertHearing(payload.hearing);
                if (Array.isArray(payload.responses)) sqlite.replaceResponses(hearingId, payload.responses);
                if (Array.isArray(payload.materials)) sqlite.replaceMaterials(hearingId, payload.materials);
            } else {
            if (payload.hearing) upsertHearing(payload.hearing);
            if (Array.isArray(payload.responses)) replaceResponses(hearingId, payload.responses);
            if (Array.isArray(payload.materials)) replaceMaterials(hearingId, payload.materials);
            }
        } catch (e) {
            console.error('[prefetch] SQLite persist failed:', e && e.message ? e.message : e);
        }
        prefetchInFlight.delete(hearingId);
        res.json({ success: true, message: 'Prefetch gemt', counts: { responses: payload.responses?.length || 0, materials: payload.materials?.length || 0 } });
    } catch (e) {
        try { prefetchInFlight.delete(String(req.params.id).trim()); } catch {}
        res.status(500).json({ success: false, message: 'Prefetch-fejl', error: e.message });
    }
});

// Kick off a one-off job on Render to run our prefetch endpoint.
// Body: { hearingId: number, apiOnly?: boolean }
app.post('/api/render-job/prefetch', express.json({ limit: '256kb' }), async (req, res) => {
    try {
        const hearingId = Number(req.body?.hearingId);
        const apiOnly = !!req.body?.apiOnly;
        if (!Number.isFinite(hearingId)) return res.status(400).json({ success: false, message: 'Ugyldigt hearingId' });
        if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(400).json({ success: false, message: 'Render API mangler konfiguration' });

        // Build a job that curls our own endpoint within the same service container
        // Render will boot a new instance of this service with the provided command
        const command = `bash -lc "curl -s -X POST ${process.env.PUBLIC_URL || 'http://localhost:'+PORT}/api/prefetch/${hearingId}?apiOnly=${apiOnly?'1':'0'} -H 'Content-Type: application/json' --data '{"reason":"render-job"}' | cat"`;
        const url = `${RENDER_API_BASE}/v1/services/${encodeURIComponent(RENDER_SERVICE_ID)}/jobs`;
        const r = await axios.post(url, { command }, { headers: { Authorization: `Bearer ${RENDER_API_KEY}` }, validateStatus: () => true });
        if (r.status >= 200 && r.status < 300) {
            return res.json({ success: true, job: r.data });
        }
        return res.status(r.status || 500).json({ success: false, message: 'Render job fejlede', error: r.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke oprette Render job', error: e.message });
    }
});

// Create a Render one-off job that hits our refresh-open endpoint to prefetch all target hearings
app.post('/api/render-job/refresh-open', async (req, res) => {
    try {
        if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(400).json({ success: false, message: 'Render API mangler konfiguration' });
        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
        const command = `bash -lc "curl -sS -X POST '${base}/api/refresh/open' | cat"`;
        const url = `${RENDER_API_BASE}/v1/services/${encodeURIComponent(RENDER_SERVICE_ID)}/jobs`;
        const r = await axios.post(url, { command }, { headers: { Authorization: `Bearer ${RENDER_API_KEY}` }, validateStatus: () => true });
        if (r.status >= 200 && r.status < 300) {
            return res.json({ success: true, job: r.data });
        }
        return res.status(r.status || 500).json({ success: false, message: 'Render job fejlede', error: r.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Kunne ikke oprette Render job', error: e.message });
    }
});

// ============================================================================
// ANALYSIS PIPELINE INTEGRATION
// ============================================================================

// Track running pipeline processes and failure state
const runningPipelines = new Map(); // hearingId -> { process, startedAt, label }
const pipelineFailures = new Map(); // hearingId -> { count, lastFailedAt }

const PIPELINE_DIR = path.join(__dirname, 'analysis-pipeline');
const PIPELINE_OUTPUT_DIR = path.join(PIPELINE_DIR, 'output', 'runs');
const PIPELINE_RETRY_LIMIT = 3;
const PIPELINE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Find all completed runs for a hearing, sorted by completion time (newest first)
 */
function findPipelineRuns(hearingId) {
    const hearingDir = path.join(PIPELINE_OUTPUT_DIR, String(hearingId));
    if (!fs.existsSync(hearingDir)) return [];
    
    try {
        const labels = fs.readdirSync(hearingDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        
        const runs = [];
        for (const label of labels) {
            const progressPath = path.join(hearingDir, label, 'progress.json');
            const summaryPath = path.join(hearingDir, label, 'run-summary.json');
            const docxPath = path.join(hearingDir, label, `hearing-${hearingId}-analysis.docx`);
            
            if (!fs.existsSync(progressPath)) continue;
            
            try {
                const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
                let summary = null;
                if (fs.existsSync(summaryPath)) {
                    try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')); } catch {}
                }
                
                runs.push({
                    label,
                    status: progress.status || 'unknown',
                    completedAt: progress.endTime || progress.lastUpdate,
                    startTime: progress.startTime,
                    responseCount: progress.dataStats?.responseCount || 0,
                    qualityScore: summary?.quality?.score,
                    qualityGrade: summary?.quality?.grade,
                    progress: progress.progress || 0,
                    currentStep: progress.currentStep,
                    hasDocx: fs.existsSync(docxPath),
                    totalCost: summary?.usage?.totals?.totalCostFormatted
                });
            } catch (e) {
                console.warn(`[Pipeline] Failed to read progress for ${label}:`, e.message);
            }
        }
        
        // Sort by completion time, newest first
        return runs.sort((a, b) => {
            const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
            const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
            return bTime - aTime;
        });
    } catch (e) {
        console.error('[Pipeline] findPipelineRuns error:', e.message);
        return [];
    }
}

/**
 * Get the latest completed run for a hearing
 */
function getLatestCompletedRun(hearingId) {
    const runs = findPipelineRuns(hearingId);
    return runs.find(r => r.status === 'completed') || null;
}

/**
 * Get current response count from database for a hearing
 */
function getCurrentResponseCount(hearingId) {
    try {
        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') return 0;
        // Try published first, then prepared, then raw
        let row = sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM published_responses WHERE hearing_id=?`).get(hearingId);
        if (row && row.cnt > 0) return row.cnt;
        row = sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM prepared_responses WHERE hearing_id=?`).get(hearingId);
        if (row && row.cnt > 0) return row.cnt;
        row = sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM raw_responses WHERE hearing_id=?`).get(hearingId);
        return row?.cnt || 0;
    } catch (e) {
        console.warn('[Pipeline] getCurrentResponseCount error:', e.message);
        return 0;
    }
}

/**
 * Check if pipeline can be started (not running, not in timeout)
 */
function canStartPipeline(hearingId) {
    // Check if already running
    if (runningPipelines.has(hearingId)) {
        return { canStart: false, reason: 'already_running' };
    }
    
    // Check failure timeout
    const failures = pipelineFailures.get(hearingId);
    if (failures && failures.count >= PIPELINE_RETRY_LIMIT) {
        const timeoutEnd = failures.lastFailedAt + PIPELINE_TIMEOUT_MS;
        if (Date.now() < timeoutEnd) {
            const remainingMs = timeoutEnd - Date.now();
            const remainingMins = Math.ceil(remainingMs / 60000);
            return { 
                canStart: false, 
                reason: 'timeout',
                timeoutEndsAt: new Date(timeoutEnd).toISOString(),
                remainingMinutes: remainingMins
            };
        } else {
            // Timeout expired, reset failures
            pipelineFailures.delete(hearingId);
        }
    }
    
    return { canStart: true };
}

/**
 * Generate a new run label
 */
function generateRunLabel() {
    return `run-${Date.now()}`;
}

// GET /api/pipeline/:hearingId/status - Get pipeline status for a hearing
app.get('/api/pipeline/:hearingId/status', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }
        
        const latestRun = getLatestCompletedRun(hearingId);
        const currentResponseCount = getCurrentResponseCount(hearingId);
        const running = runningPipelines.get(hearingId);
        const canStartCheck = canStartPipeline(hearingId);
        
        // Get all runs for this hearing
        const allRuns = findPipelineRuns(hearingId);
        
        // Calculate if incremental update is needed
        let canRunIncremental = false;
        let newResponseCount = 0;
        if (latestRun && latestRun.responseCount > 0) {
            newResponseCount = currentResponseCount - latestRun.responseCount;
            canRunIncremental = newResponseCount > 0;
        }
        
        res.json({
            success: true,
            hearingId,
            hasCompletedRun: !!latestRun,
            latestRun: latestRun ? {
                label: latestRun.label,
                completedAt: latestRun.completedAt,
                responseCount: latestRun.responseCount,
                qualityScore: latestRun.qualityScore,
                qualityGrade: latestRun.qualityGrade,
                hasDocx: latestRun.hasDocx,
                totalCost: latestRun.totalCost
            } : null,
            currentResponseCount,
            newResponseCount,
            canRunIncremental,
            isRunning: !!running,
            runningInfo: running ? {
                label: running.label,
                startedAt: running.startedAt
            } : null,
            canStart: canStartCheck.canStart,
            canStartReason: canStartCheck.reason,
            timeoutInfo: canStartCheck.reason === 'timeout' ? {
                endsAt: canStartCheck.timeoutEndsAt,
                remainingMinutes: canStartCheck.remainingMinutes
            } : null,
            allRuns: allRuns.slice(0, 5) // Return last 5 runs
        });
    } catch (e) {
        console.error('[Pipeline] status error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/start - Start a pipeline run
app.post('/api/pipeline/:hearingId/start', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }
        
        // Check if can start
        const canStartCheck = canStartPipeline(hearingId);
        if (!canStartCheck.canStart) {
            return res.status(409).json({
                success: false,
                error: canStartCheck.reason === 'already_running' 
                    ? 'Pipeline kører allerede for denne høring'
                    : `Pipeline er i timeout. Prøv igen om ${canStartCheck.remainingMinutes} minutter.`,
                ...canStartCheck
            });
        }
        
        // Determine if this should be incremental
        const forceFullRun = req.body?.forceFullRun === true;
        const latestRun = getLatestCompletedRun(hearingId);
        const isIncremental = !forceFullRun && latestRun && latestRun.responseCount > 0;
        
        // Generate labels
        const newLabel = generateRunLabel();
        const baselineLabel = isIncremental ? latestRun.label : null;
        
        // Build command arguments
        const args = [
            'run', 'pipeline:run', '--',
            String(hearingId),
            `--checkpoint=${newLabel}`,
            '--save-checkpoints',
            '--write'
        ];
        
        if (isIncremental && baselineLabel) {
            args.push(`--incremental=${baselineLabel}`);
        }
        
        console.log(`[Pipeline] Starting pipeline for hearing ${hearingId}:`, args.join(' '));
        console.log(`[Pipeline] Working directory: ${PIPELINE_DIR}`);
        
        // Spawn the pipeline process
        const child = spawn('npm', args, {
            cwd: PIPELINE_DIR,
            env: {
                ...process.env,
                DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data', 'hearing-data.db')
            },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        const startedAt = new Date().toISOString();
        
        // Track the running process
        runningPipelines.set(hearingId, {
            process: child,
            startedAt,
            label: newLabel,
            pid: child.pid
        });
        
        // Capture output for logging
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
            // Log last line periodically
            const lines = stdout.split('\n').filter(l => l.trim());
            if (lines.length > 0) {
                console.log(`[Pipeline ${hearingId}] ${lines[lines.length - 1].substring(0, 200)}`);
            }
        });
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        
        // Handle process completion
        child.on('close', (code) => {
            runningPipelines.delete(hearingId);
            
            if (code === 0) {
                console.log(`[Pipeline] Hearing ${hearingId} completed successfully`);
                // Reset failure count on success
                pipelineFailures.delete(hearingId);
            } else {
                console.error(`[Pipeline] Hearing ${hearingId} failed with code ${code}`);
                console.error(`[Pipeline] stderr: ${stderr.substring(0, 1000)}`);
                
                // Track failure
                const failures = pipelineFailures.get(hearingId) || { count: 0, lastFailedAt: 0 };
                failures.count += 1;
                failures.lastFailedAt = Date.now();
                pipelineFailures.set(hearingId, failures);
            }
        });
        
        child.on('error', (err) => {
            console.error(`[Pipeline] Hearing ${hearingId} spawn error:`, err.message);
            runningPipelines.delete(hearingId);
            
            // Track failure
            const failures = pipelineFailures.get(hearingId) || { count: 0, lastFailedAt: 0 };
            failures.count += 1;
            failures.lastFailedAt = Date.now();
            pipelineFailures.set(hearingId, failures);
        });
        
        // Allow process to continue after parent exits
        child.unref();
        
        res.json({
            success: true,
            message: isIncremental 
                ? `Inkrementel opdatering startet (baseline: ${baselineLabel})`
                : 'Fuld analyse startet',
            label: newLabel,
            isIncremental,
            baselineLabel,
            startedAt,
            pid: child.pid
        });
    } catch (e) {
        console.error('[Pipeline] start error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/start-preview - Start pipeline in preview mode
app.post('/api/pipeline/:hearingId/start-preview', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        // Check if can start
        const canStartCheck = canStartPipeline(hearingId);
        if (!canStartCheck.canStart) {
            return res.status(409).json({
                success: false,
                error: canStartCheck.reason === 'already_running'
                    ? 'Pipeline kører allerede for denne høring'
                    : `Pipeline er i timeout. Prøv igen om ${canStartCheck.remainingMinutes} minutter.`,
                ...canStartCheck
            });
        }

        // Generate labels
        const newLabel = generateRunLabel() + '-preview';
        const baselineLabel = req.body?.baselineLabel;

        // Build command arguments with --preview flag
        const args = [
            'run', 'pipeline:run', '--',
            String(hearingId),
            `--checkpoint=${newLabel}`,
            '--save-checkpoints',
            '--preview'  // Enable preview mode
        ];

        // If baseline provided, use it as source checkpoint
        if (baselineLabel) {
            args.push(`--checkpoint=${baselineLabel}:${newLabel}`);
        }

        console.log(`[Pipeline] Starting PREVIEW pipeline for hearing ${hearingId}:`, args.join(' '));

        // Spawn the pipeline process
        const child = spawn('npm', args, {
            cwd: PIPELINE_DIR,
            env: {
                ...process.env,
                DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data', 'hearing-data.db')
            },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const startedAt = new Date().toISOString();

        // Track the running process
        runningPipelines.set(hearingId, {
            process: child,
            startedAt,
            label: newLabel,
            pid: child.pid,
            isPreview: true
        });

        // Capture output for logging
        child.stdout?.on('data', (data) => {
            console.log(`[Pipeline PREVIEW ${hearingId}] ${data.toString().split('\n')[0]?.substring(0, 200)}`);
        });

        child.stderr?.on('data', (data) => {
            console.error(`[Pipeline PREVIEW ${hearingId}] ERROR: ${data.toString().substring(0, 500)}`);
        });

        child.on('exit', (code) => {
            console.log(`[Pipeline PREVIEW ${hearingId}] Process exited with code ${code}`);
            runningPipelines.delete(hearingId);
        });

        // Don't wait for completion - return immediately
        child.unref();

        res.json({
            success: true,
            message: 'Preview pipeline startet',
            label: newLabel,
            startedAt,
            pid: child.pid,
            isPreview: true
        });
    } catch (e) {
        console.error('[Pipeline] start-preview error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/progress - Get current progress
app.get('/api/pipeline/:hearingId/progress', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }
        
        // Check if running
        const running = runningPipelines.get(hearingId);
        const label = running?.label || req.query.label;
        
        if (!label) {
            // Try to get latest run's progress
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) {
                return res.json({
                    success: true,
                    isRunning: false,
                    status: 'completed',
                    ...latestRun
                });
            }
            return res.json({
                success: true,
                isRunning: false,
                status: 'not_started',
                message: 'Ingen analyse fundet'
            });
        }
        
        // Read progress.json
        const progressPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), label, 'progress.json');
        if (!fs.existsSync(progressPath)) {
            return res.json({
                success: true,
                isRunning: !!running,
                status: running ? 'starting' : 'not_found',
                label,
                progress: 0,
                message: running ? 'Pipeline starter...' : 'Progress-fil ikke fundet'
            });
        }
        
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        
        res.json({
            success: true,
            isRunning: !!running,
            label,
            status: progress.status,
            progress: progress.progress || 0,
            currentStep: progress.currentStep,
            completedSteps: progress.completedSteps?.length || 0,
            totalSteps: progress.totalSteps || 30,
            estimatedTimeRemaining: progress.estimatedTimeRemaining,
            dataStats: progress.dataStats,
            startTime: progress.startTime,
            lastUpdate: progress.lastUpdate,
            errors: progress.errors?.slice(0, 5),
            warnings: progress.warnings?.length || 0
        });
    } catch (e) {
        console.error('[Pipeline] progress error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/download - Download the DOCX file
app.get('/api/pipeline/:hearingId/download', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }
        
        const label = req.query.label;
        let targetLabel = label;
        
        // If no label specified, use latest completed run
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (!latestRun) {
                return res.status(404).json({ success: false, error: 'Ingen analyse fundet' });
            }
            targetLabel = latestRun.label;
        }
        
        const docxPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, `hearing-${hearingId}-analysis.docx`);
        
        if (!fs.existsSync(docxPath)) {
            return res.status(404).json({ success: false, error: 'DOCX-fil ikke fundet' });
        }
        
        // Get hearing title for filename
        let hearingTitle = `Høring ${hearingId}`;
        try {
            if (sqliteDb && sqliteDb.prepare) {
                const row = sqliteDb.prepare(`SELECT title FROM hearings WHERE id=?`).get(hearingId);
                if (row?.title) {
                    hearingTitle = row.title.substring(0, 50).replace(/[^a-zA-Z0-9æøåÆØÅ\s-]/g, '').trim();
                }
            }
        } catch {}
        
        const filename = `${hearingTitle} - Høringsanalyse.docx`;
        
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        
        const stream = fs.createReadStream(docxPath);
        stream.pipe(res);
    } catch (e) {
        console.error('[Pipeline] download error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/cancel - Cancel a running pipeline (best effort)
app.post('/api/pipeline/:hearingId/cancel', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }
        
        const running = runningPipelines.get(hearingId);
        if (!running) {
            return res.status(404).json({ success: false, error: 'Ingen kørende pipeline fundet' });
        }
        
        try {
            if (running.process && running.process.pid) {
                process.kill(-running.process.pid, 'SIGTERM');
            }
        } catch (killErr) {
            console.warn(`[Pipeline] Could not kill process group:`, killErr.message);
            try {
                running.process?.kill('SIGTERM');
            } catch {}
        }
        
        runningPipelines.delete(hearingId);
        
        res.json({ success: true, message: 'Pipeline afbrudt' });
    } catch (e) {
        console.error('[Pipeline] cancel error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/analysis - Get analysis results from JSON file
app.get('/api/pipeline/:hearingId/analysis', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;

        // If no label specified, use latest completed run
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (!latestRun) {
                return res.status(404).json({ success: false, error: 'Ingen analyse fundet' });
            }
            targetLabel = latestRun.label;
        }

        const analysisPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, `hearing-${hearingId}-analysis.json`);

        if (!fs.existsSync(analysisPath)) {
            return res.status(404).json({ success: false, error: 'Analyse-fil ikke fundet' });
        }

        const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));

        res.json({
            success: true,
            label: targetLabel,
            ...analysis
        });
    } catch (e) {
        console.error('[Pipeline] analysis error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/citation/:responseNumber - Get full response text for citation tracing
app.get('/api/pipeline/:hearingId/citation/:responseNumber', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        const responseNumber = parseInt(req.params.responseNumber, 10);

        if (!Number.isFinite(hearingId) || !Number.isFinite(responseNumber)) {
            return res.status(400).json({ success: false, error: 'Invalid parameters' });
        }

        // Get the response text from published_responses table
        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database not available' });
        }

        // First try prepared_responses (GDPR-cleaned), then fall back to raw_responses
        let response = sqliteDb.prepare(`
            SELECT
                prepared_id as id,
                source_response_id as responseNumber,
                respondent_name as respondentName,
                respondent_type as respondentType,
                text_md as text,
                submitted_at as submittedAt,
                focus_mode as focusMode
            FROM prepared_responses
            WHERE hearing_id = ? AND source_response_id = ?
        `).get(hearingId, responseNumber);

        let attachments = [];
        let usedPrepared = false;

        if (response) {
            usedPrepared = true;
            // Get attachments for this prepared response
            attachments = sqliteDb.prepare(`
                SELECT
                    attachment_id as attachmentId,
                    original_filename as filename,
                    converted_md as contentMd
                FROM prepared_attachments
                WHERE hearing_id = ? AND prepared_id = ?
                ORDER BY attachment_id ASC
            `).all(hearingId, response.id);
        } else {
            // Fall back to raw_responses
            response = sqliteDb.prepare(`
                SELECT
                    response_id as responseNumber,
                    author as respondentName,
                    'Borger' as respondentType,
                    text,
                    submitted_at as submittedAt
                FROM raw_responses
                WHERE hearing_id = ? AND response_id = ?
            `).get(hearingId, responseNumber);

            if (response) {
                // Get attachments for this raw response
                attachments = sqliteDb.prepare(`
                    SELECT
                        idx as attachmentId,
                        filename,
                        NULL as contentMd
                    FROM raw_attachments
                    WHERE hearing_id = ? AND response_id = ?
                    ORDER BY idx ASC
                `).all(hearingId, responseNumber);
            }
        }

        if (!response) {
            return res.status(404).json({ success: false, error: 'Høringssvar ikke fundet' });
        }

        // Combine response text with attachment content (same logic as DataLoader)
        const responseText = (response.text || '').trim();
        const attachmentTexts = attachments
            .map(a => (a.contentMd || '').trim())
            .filter(text => text.length > 0);

        // Check if response text is a placeholder
        const isPlaceholder = (text) => {
            if (!text || text.trim().length === 0) return true;
            const trimmed = text.trim().toLowerCase();
            const placeholderPatterns = [
                /^høringssvar modtaget på (mail|blivhørt)\.?$/i,
                /^modtaget på (mail|blivhørt)\.?$/i,
                /^sendt via (mail|email)\.?$/i,
                /^vedhæftet\.?$/i,
                /^se vedhæftning\.?$/i,
                /^se vedhæftet\.?$/i,
            ];
            return placeholderPatterns.some(pattern => pattern.test(trimmed));
        };

        // Determine textFrom and combine text
        let textFrom = response.focusMode || null;
        const hasAttachmentContent = attachmentTexts.length > 0;

        // Auto-correct if placeholder text
        if ((textFrom === 'response' || textFrom === null) && isPlaceholder(responseText) && hasAttachmentContent) {
            textFrom = 'attachment';
        }

        let combinedText = '';
        if (textFrom === 'response') {
            combinedText = responseText;
        } else if (textFrom === 'attachment') {
            combinedText = attachmentTexts.join('\n\n');
        } else {
            const parts = [];
            if (responseText && !isPlaceholder(responseText)) parts.push(responseText);
            if (attachmentTexts.length > 0) parts.push(...attachmentTexts);
            combinedText = parts.join('\n\n');
        }

        // Get the analysis to find quotes for this response
        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        let highlightPositions = [];
        if (targetLabel) {
            try {
                const analysisPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, `hearing-${hearingId}-analysis.json`);
                if (fs.existsSync(analysisPath)) {
                    const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));

                    // Find all quotes from this response
                    for (const topic of (analysis.topics || [])) {
                        for (const position of (topic.positions || [])) {
                            for (const ref of (position.hybridReferences || [])) {
                                for (const quote of (ref.quotes || [])) {
                                    if (quote.responseNumber === responseNumber && quote.quote) {
                                        // Find the quote in the combined text (includes attachments)
                                        const quoteText = quote.quote;
                                        const index = combinedText.indexOf(quoteText);
                                        if (index !== -1) {
                                            highlightPositions.push({
                                                start: index,
                                                end: index + quoteText.length,
                                                quote: quoteText,
                                                position: position.title,
                                                theme: topic.name,
                                                refId: ref.id
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('[Pipeline] Could not load analysis for highlighting:', e.message);
            }
        }

        // Sort highlights by position
        highlightPositions.sort((a, b) => a.start - b.start);

        res.json({
            success: true,
            response: {
                responseNumber: response.responseNumber,
                respondentName: response.respondentName || 'Borger',
                respondentType: response.respondentType || 'Borger',
                text: combinedText, // Combined text including attachments
                originalText: responseText, // Original response text only
                submittedAt: response.submittedAt,
                textFrom: textFrom // Indicates what's included
            },
            attachments: attachments.map(a => ({
                attachmentId: a.attachmentId,
                filename: a.filename,
                hasContent: !!(a.contentMd && a.contentMd.trim())
            })),
            highlightPositions
        });
    } catch (e) {
        console.error('[Pipeline] citation error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/search - Search in hearing responses
app.get('/api/pipeline/:hearingId/search', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const query = (req.query.q || '').trim();
        if (!query) {
            return res.status(400).json({ success: false, error: 'Query parameter "q" required' });
        }

        const respondentType = req.query.respondentType;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;

        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database not available' });
        }

        // Search in prepared_responses first, then raw_responses
        let sql = `
            SELECT
                source_response_id as responseNumber,
                respondent_name as respondentName,
                respondent_type as respondentType,
                text_md as text,
                submitted_at as submittedAt
            FROM prepared_responses
            WHERE hearing_id = ? AND text_md LIKE ?
        `;
        const params = [hearingId, `%${query}%`];

        if (respondentType) {
            sql += ` AND respondent_type = ?`;
            params.push(respondentType);
        }

        sql += ` ORDER BY source_response_id ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        let results = sqliteDb.prepare(sql).all(...params);

        // If no results from prepared, try raw
        if (!results.length) {
            let rawSql = `
                SELECT
                    response_id as responseNumber,
                    author as respondentName,
                    'Borger' as respondentType,
                    text,
                    submitted_at as submittedAt
                FROM raw_responses
                WHERE hearing_id = ? AND text LIKE ?
                ORDER BY response_id ASC LIMIT ? OFFSET ?
            `;
            results = sqliteDb.prepare(rawSql).all(hearingId, `%${query}%`, limit, offset);
        }

        // Count total matches
        const countSql = `
            SELECT COUNT(*) as count
            FROM prepared_responses
            WHERE hearing_id = ? AND text_md LIKE ?
        `;
        const countResult = sqliteDb.prepare(countSql).get(hearingId, `%${query}%`);

        // Highlight matches in text
        const highlightedResults = results.map(r => {
            const text = r.text || '';
            const lowerText = text.toLowerCase();
            const lowerQuery = query.toLowerCase();
            const matchIndex = lowerText.indexOf(lowerQuery);

            let context = '';
            if (matchIndex !== -1) {
                const contextStart = Math.max(0, matchIndex - 100);
                const contextEnd = Math.min(text.length, matchIndex + query.length + 100);
                context = (contextStart > 0 ? '...' : '') +
                         text.substring(contextStart, contextEnd) +
                         (contextEnd < text.length ? '...' : '');
            }

            return {
                responseNumber: r.responseNumber,
                respondentName: r.respondentName || 'Borger',
                respondentType: r.respondentType || 'Borger',
                matchedText: query,
                context,
                submittedAt: r.submittedAt
            };
        });

        res.json({
            success: true,
            query,
            results: highlightedResults,
            count: highlightedResults.length,
            total: countResult?.count || highlightedResults.length,
            hasMore: offset + limit < (countResult?.count || 0)
        });
    } catch (e) {
        console.error('[Pipeline] search error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/summary - Get run summary with quality scores
app.get('/api/pipeline/:hearingId/summary', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;

        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (!latestRun) {
                return res.status(404).json({ success: false, error: 'Ingen analyse fundet' });
            }
            targetLabel = latestRun.label;
        }

        const summaryPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, 'run-summary.json');

        if (!fs.existsSync(summaryPath)) {
            return res.status(404).json({ success: false, error: 'Summary-fil ikke fundet' });
        }

        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

        res.json({
            success: true,
            label: targetLabel,
            ...summary
        });
    } catch (e) {
        console.error('[Pipeline] summary error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/reanalyze - Start re-analysis with feedback
app.post('/api/pipeline/:hearingId/reanalyze', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        // Check if already running
        if (runningPipelines.has(hearingId)) {
            return res.status(409).json({
                success: false,
                error: 'En analyse kører allerede for denne høring',
                status: 'running'
            });
        }

        const { feedback, mode, targetPositions, baseLabel } = req.body;

        // Generate new label for this run
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const label = `reanalyze-${timestamp}`;

        // Determine which checkpoint to start from
        let resumeFrom = null;
        let baseCheckpoint = baseLabel;

        if (!baseCheckpoint) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) baseCheckpoint = latestRun.label;
        }

        // Determine resume point based on mode and feedback
        if (mode === 'targeted' && targetPositions?.length) {
            resumeFrom = 'hybrid-position-writing';
        } else if (mode === 'incremental') {
            resumeFrom = 'aggregate';
        }
        // full mode = no resume, start from beginning

        // Create feedback file for pipeline to consume
        const feedbackDir = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), label);
        fs.mkdirSync(feedbackDir, { recursive: true });

        if (feedback && Array.isArray(feedback) && feedback.length > 0) {
            const feedbackPath = path.join(feedbackDir, 'user-feedback.json');
            fs.writeFileSync(feedbackPath, JSON.stringify({
                createdAt: new Date().toISOString(),
                mode,
                feedback,
                targetPositions
            }, null, 2));
        }

        // Build pipeline command
        const args = [
            'scripts/run-pipeline.js',
            String(hearingId),
            `--checkpoint=${baseCheckpoint ? baseCheckpoint + ':' + label : label}`,
            '--save-checkpoints',
            '--write'
        ];

        if (resumeFrom) {
            args.push(`--resume=${resumeFrom}`);
        }

        // Add feedback file path as argument
        if (feedback && feedback.length > 0) {
            args.push(`--feedback=${path.join(feedbackDir, 'user-feedback.json')}`);
        }

        console.log(`[Pipeline] Starting re-analysis for hearing ${hearingId} with label ${label}`);
        console.log(`[Pipeline] Args:`, args);

        // Spawn the pipeline process
        const child = spawn('node', args, {
            cwd: PIPELINE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
            env: { ...process.env }
        });

        // Track the running pipeline
        runningPipelines.set(hearingId, {
            process: child,
            startedAt: Date.now(),
            label,
            mode,
            isReanalyze: true
        });

        // Log output
        const logPath = path.join(feedbackDir, 'terminal.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        child.stdout.pipe(logStream);
        child.stderr.pipe(logStream);

        child.on('exit', (code) => {
            console.log(`[Pipeline] Re-analysis ${hearingId}/${label} exited with code ${code}`);
            runningPipelines.delete(hearingId);
            logStream.end();
        });

        child.on('error', (err) => {
            console.error(`[Pipeline] Re-analysis ${hearingId}/${label} error:`, err);
            runningPipelines.delete(hearingId);
            logStream.end();
        });

        // Unref so the parent can exit without waiting
        child.unref();

        res.json({
            success: true,
            jobId: label,
            label,
            mode: mode || 'full',
            status: 'started',
            message: 'Re-analyse startet'
        });
    } catch (e) {
        console.error('[Pipeline] reanalyze error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/classify-feedback - Classify user feedback
app.post('/api/pipeline/:hearingId/classify-feedback', express.json({ limit: '100kb' }), async (req, res) => {
    try {
        const { feedback } = req.body;
        if (!feedback || typeof feedback !== 'string') {
            return res.status(400).json({ success: false, error: 'Feedback text required' });
        }

        // Use OpenAI to classify the feedback
        if (!openai) {
            // Fallback: simple keyword-based classification
            const lower = feedback.toLowerCase();
            let category = 'context_note';
            let confidence = 0.5;

            if (lower.includes('slå sammen') || lower.includes('merge') || lower.includes('tema')) {
                category = 'structure_change';
                confidence = 0.7;
            } else if (lower.includes('citat') || lower.includes('kontekst') || lower.includes('misvisende')) {
                category = 'citation_problem';
                confidence = 0.7;
            } else if (lower.includes('mangler') || lower.includes('overset') || lower.includes('vigtig')) {
                category = 'missing_content';
                confidence = 0.7;
            } else if (lower.includes('forkert') || lower.includes('fejl') || lower.includes('opsummering')) {
                category = 'factual_error';
                confidence = 0.7;
            } else if (lower.includes('irrelevant') || lower.includes('slet') || lower.includes('fjern')) {
                category = 'irrelevant_position';
                confidence = 0.7;
            } else if (lower.includes('betyder') || lower.includes('er lig med') || lower.includes('=')) {
                category = 'context_note';
                confidence = 0.8;
            }

            return res.json({
                success: true,
                category,
                confidence,
                isSpecific: category === 'context_note' || category === 'citation_problem',
                suggestion: category === 'context_note'
                    ? 'Dette ser ud til at være specifik kontekst til et citat'
                    : 'Dette ser ud til at være en generel regel for analysen'
            });
        }

        // Use LLM for better classification
        const classificationPrompt = `Klassificér denne bruger-feedback til en høringsanalyse:

"${feedback}"

Returnér JSON med følgende felter:
- category: en af [context_note, citation_problem, missing_content, irrelevant_position, structure_change, factual_error]
- confidence: 0.0-1.0
- isSpecific: boolean - om feedbacken handler om ét specifikt citat/svar
- target: objekt med responseNumber og/eller positionTitle hvis relevant
- suggestion: kort forklaring på dansk

Kategorier:
- context_note: Specifik kontekst (fx "NF betyder Nordisk Film")
- citation_problem: Problem med citat (fx "taget ud af kontekst")
- missing_content: Indhold der mangler (fx "vigtig pointe overset")
- irrelevant_position: Position der bør fjernes
- structure_change: Strukturændring (fx "slå temaer sammen")
- factual_error: Faktuel fejl i opsummering`;

        const completion = await openai.chat.completions.create({
            model: MODEL_ID,
            messages: [{ role: 'user', content: classificationPrompt }],
            response_format: { type: 'json_object' }
        });

        const result = JSON.parse(completion.choices[0].message.content);

        res.json({
            success: true,
            ...result
        });
    } catch (e) {
        console.error('[Pipeline] classify-feedback error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/responses - Get all responses for source-first view
app.get('/api/pipeline/:hearingId/responses', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const offset = parseInt(req.query.offset, 10) || 0;
        const reviewed = req.query.reviewed; // 'true', 'false', or undefined for all
        const search = req.query.search ? req.query.search.trim() : null;

        if (!sqliteDb || typeof sqliteDb.prepare !== 'function') {
            return res.status(500).json({ success: false, error: 'Database not available' });
        }

        // Get responses
        let sql = `
            SELECT
                source_response_id as responseNumber,
                respondent_name as respondentName,
                respondent_type as respondentType,
                text_md as text,
                submitted_at as submittedAt,
                approved as reviewed
            FROM prepared_responses
            WHERE hearing_id = ?
        `;
        const params = [hearingId];

        if (reviewed === 'true') {
            sql += ` AND approved = 1`;
        } else if (reviewed === 'false') {
            sql += ` AND (approved IS NULL OR approved = 0)`;
        }

        // Add search filter
        if (search) {
            sql += ` AND (text_md LIKE ? OR respondent_name LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
        }

        sql += ` ORDER BY source_response_id ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const responses = sqliteDb.prepare(sql).all(...params);

        // Get total count (with same filters)
        let countSql = `SELECT COUNT(*) as count FROM prepared_responses WHERE hearing_id = ?`;
        const countParams = [hearingId];

        if (reviewed === 'true') {
            countSql += ` AND approved = 1`;
        } else if (reviewed === 'false') {
            countSql += ` AND (approved IS NULL OR approved = 0)`;
        }

        if (search) {
            countSql += ` AND (text_md LIKE ? OR respondent_name LIKE ?)`;
            const searchPattern = `%${search}%`;
            countParams.push(searchPattern, searchPattern);
        }

        const countResult = sqliteDb.prepare(countSql).get(...countParams);

        // Load analysis to find citations for each response
        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        // Build reverse index: responseNumber -> citations
        const citationIndex = {};
        if (targetLabel) {
            try {
                const analysisPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, `hearing-${hearingId}-analysis.json`);
                if (fs.existsSync(analysisPath)) {
                    const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));

                    for (const topic of (analysis.topics || [])) {
                        for (const position of (topic.positions || [])) {
                            for (const ref of (position.hybridReferences || [])) {
                                for (const quote of (ref.quotes || [])) {
                                    const rn = quote.responseNumber;
                                    if (!citationIndex[rn]) citationIndex[rn] = [];
                                    citationIndex[rn].push({
                                        quote: quote.quote,
                                        position: position.title,
                                        theme: topic.name,
                                        refId: ref.id
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('[Pipeline] Could not load analysis for citation index:', e.message);
            }
        }

        // Enrich responses with citation info
        const enrichedResponses = responses.map(r => {
            const citations = citationIndex[r.responseNumber] || [];
            return {
                ...r,
                citations,
                citationCount: citations.length
            };
        });

        res.json({
            success: true,
            responses: enrichedResponses,
            count: responses.length,
            total: countResult?.count || responses.length,
            offset,
            limit,
            hasMore: offset + limit < (countResult?.count || 0),
            search: search || null
        });
    } catch (e) {
        console.error('[Pipeline] responses error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/annotation - Save annotation on citation or position
app.post('/api/pipeline/:hearingId/annotation', express.json({ limit: '100kb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const { type, responseNumber, positionTitle, status, comment, category } = req.body;

        if (!type || !['citation', 'position', 'response'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid annotation type' });
        }

        // Get or create annotations file
        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen analyse fundet' });
        }

        const annotationsPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, 'annotations.json');

        let annotations = { citations: {}, positions: {}, responses: {}, createdAt: new Date().toISOString() };
        if (fs.existsSync(annotationsPath)) {
            annotations = JSON.parse(fs.readFileSync(annotationsPath, 'utf-8'));
        }

        // Create annotation entry
        const annotation = {
            status, // 'approved', 'problem', 'unsure'
            comment,
            category, // for problems: 'out_of_context', 'wrong_theme', etc.
            updatedAt: new Date().toISOString()
        };

        if (type === 'citation' && responseNumber) {
            if (!annotations.citations[responseNumber]) {
                annotations.citations[responseNumber] = {};
            }
            if (positionTitle) {
                annotations.citations[responseNumber][positionTitle] = annotation;
            } else {
                annotations.citations[responseNumber]._general = annotation;
            }
        } else if (type === 'position' && positionTitle) {
            annotations.positions[positionTitle] = annotation;
        } else if (type === 'response' && responseNumber) {
            annotations.responses[responseNumber] = annotation;
        }

        // Save annotations
        fs.writeFileSync(annotationsPath, JSON.stringify(annotations, null, 2));

        res.json({
            success: true,
            message: 'Annotation gemt'
        });
    } catch (e) {
        console.error('[Pipeline] annotation error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/annotations - Get all annotations
app.get('/api/pipeline/:hearingId/annotations', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen analyse fundet' });
        }

        const annotationsPath = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, 'annotations.json');

        if (!fs.existsSync(annotationsPath)) {
            return res.json({
                success: true,
                annotations: { citations: {}, positions: {}, responses: {} }
            });
        }

        const annotations = JSON.parse(fs.readFileSync(annotationsPath, 'utf-8'));

        // Calculate summary stats
        const stats = {
            totalCitations: Object.keys(annotations.citations || {}).length,
            approvedCitations: 0,
            problemCitations: 0,
            totalPositions: Object.keys(annotations.positions || {}).length,
            reviewedResponses: Object.keys(annotations.responses || {}).length
        };

        for (const [rn, posAnnotations] of Object.entries(annotations.citations || {})) {
            for (const ann of Object.values(posAnnotations)) {
                if (ann.status === 'approved') stats.approvedCitations++;
                else if (ann.status === 'problem') stats.problemCitations++;
            }
        }

        res.json({
            success: true,
            label: targetLabel,
            annotations,
            stats
        });
    } catch (e) {
        console.error('[Pipeline] get annotations error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// ANALYSIS DRAFTS - Interactive editing endpoints
// ============================================================================

// GET /api/pipeline/:hearingId/draft - Get active draft
app.get('/api/pipeline/:hearingId/draft', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const draft = db.getActiveDraft(hearingId);
        if (!draft) {
            return res.json({ success: true, draft: null });
        }

        // Also get positions if draft exists
        const positions = db.getDraftPositions(draft.id);
        const operations = db.getDraftOperations(draft.id);

        res.json({
            success: true,
            draft: {
                ...draft,
                positions,
                operationCount: operations.length
            }
        });
    } catch (e) {
        console.error('[Draft] get draft error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/draft - Create new draft from pipeline run
app.post('/api/pipeline/:hearingId/draft', express.json({ limit: '10mb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const { label, themes } = req.body;

        // Determine base label
        let baseLabel = label;
        if (!baseLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) baseLabel = latestRun.label;
        }

        if (!baseLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Create draft
        const draft = db.createDraft(hearingId, baseLabel);

        // If themes provided, initialize positions from them
        // Otherwise, load from checkpoint
        let themesToUse = themes;
        if (!themesToUse) {
            const checkpointPath = path.join(
                PIPELINE_OUTPUT_DIR,
                String(hearingId),
                baseLabel,
                'checkpoints',
                'sort-positions.json'
            );
            if (fs.existsSync(checkpointPath)) {
                themesToUse = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
            }
        }

        if (themesToUse && Array.isArray(themesToUse)) {
            db.initializeDraftPositions(draft.id, themesToUse);
        }

        const positions = db.getDraftPositions(draft.id);

        res.json({
            success: true,
            draft: {
                ...draft,
                positions
            }
        });
    } catch (e) {
        console.error('[Draft] create draft error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/draft/operation - Apply an operation
app.post('/api/pipeline/:hearingId/draft/operation', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const draft = db.getActiveDraft(hearingId);
        if (!draft) {
            return res.status(404).json({ success: false, error: 'Ingen aktiv kladde fundet' });
        }

        const { type, ...operationData } = req.body;
        if (!type) {
            return res.status(400).json({ success: false, error: 'Operationstype mangler' });
        }

        let inverseData = {};

        // Apply operation and calculate inverse
        switch (type) {
            case 'move_citation': {
                const { responseNumber, fromPositionId, toPositionId } = operationData;
                db.moveDraftCitation(draft.id, responseNumber, fromPositionId, toPositionId);
                inverseData = { responseNumber, fromPositionId: toPositionId, toPositionId: fromPositionId };
                break;
            }
            case 'create_position': {
                const { themeName, title, responseNumbers } = operationData;
                const newPositionId = db.createDraftPosition(draft.id, themeName, title, responseNumbers || []);
                inverseData = { positionId: newPositionId };
                operationData.positionId = newPositionId;
                break;
            }
            case 'delete_position': {
                const { positionId } = operationData;
                // Store current state for undo
                const positions = db.getDraftPositions(draft.id);
                const flatPositions = positions.flatMap(t => t.positions);
                const posToDelete = flatPositions.find(p => p.positionId === positionId);
                if (posToDelete) {
                    inverseData = {
                        themeName: positions.find(t => t.positions.some(p => p.positionId === positionId))?.name,
                        title: posToDelete.title,
                        responseNumbers: posToDelete.responseNumbers
                    };
                }
                db.deleteDraftPosition(draft.id, positionId);
                break;
            }
            case 'merge_positions': {
                const { sourcePositionIds, newTitle, themeName } = operationData;
                // Store source positions for undo
                const positions = db.getDraftPositions(draft.id);
                const flatPositions = positions.flatMap(t => t.positions.map(p => ({ ...p, themeName: t.name })));
                inverseData = {
                    sourcePositions: sourcePositionIds.map(id => flatPositions.find(p => p.positionId === id)).filter(Boolean)
                };
                const mergedId = db.mergeDraftPositions(draft.id, sourcePositionIds, newTitle, themeName);
                operationData.mergedPositionId = mergedId;
                inverseData.mergedPositionId = mergedId;
                break;
            }
            default:
                return res.status(400).json({ success: false, error: `Ukendt operationstype: ${type}` });
        }

        // Record the operation
        const operation = db.addDraftOperation(draft.id, type, operationData, inverseData);

        // Return updated positions
        const updatedPositions = db.getDraftPositions(draft.id);

        res.json({
            success: true,
            operation,
            positions: updatedPositions
        });
    } catch (e) {
        console.error('[Draft] operation error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/draft/undo - Undo last operation
app.post('/api/pipeline/:hearingId/draft/undo', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const draft = db.getActiveDraft(hearingId);
        if (!draft) {
            return res.status(404).json({ success: false, error: 'Ingen aktiv kladde fundet' });
        }

        const undone = db.undoDraftOperation(draft.id);
        if (!undone) {
            return res.json({ success: true, message: 'Intet at fortryde', undone: null });
        }

        // Apply inverse operation
        const { operationType, inverseData } = undone;
        switch (operationType) {
            case 'move_citation':
                db.moveDraftCitation(draft.id, inverseData.responseNumber, inverseData.fromPositionId, inverseData.toPositionId);
                break;
            case 'create_position':
                db.deleteDraftPosition(draft.id, inverseData.positionId);
                break;
            case 'delete_position':
                db.createDraftPosition(draft.id, inverseData.themeName, inverseData.title, inverseData.responseNumbers);
                break;
            case 'merge_positions':
                // Restore source positions and delete merged
                db.deleteDraftPosition(draft.id, inverseData.mergedPositionId);
                for (const pos of inverseData.sourcePositions || []) {
                    db.createDraftPosition(draft.id, pos.themeName, pos.title, pos.responseNumbers);
                }
                break;
        }

        const updatedPositions = db.getDraftPositions(draft.id);

        res.json({
            success: true,
            undone,
            positions: updatedPositions
        });
    } catch (e) {
        console.error('[Draft] undo error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/draft/redo - Redo last undone operation
app.post('/api/pipeline/:hearingId/draft/redo', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const draft = db.getActiveDraft(hearingId);
        if (!draft) {
            return res.status(404).json({ success: false, error: 'Ingen aktiv kladde fundet' });
        }

        const redone = db.redoDraftOperation(draft.id);
        if (!redone) {
            return res.json({ success: true, message: 'Intet at gentage', redone: null });
        }

        // Re-apply the operation
        const { operationType, operationData } = redone;
        switch (operationType) {
            case 'move_citation':
                db.moveDraftCitation(draft.id, operationData.responseNumber, operationData.fromPositionId, operationData.toPositionId);
                break;
            case 'create_position':
                db.createDraftPosition(draft.id, operationData.themeName, operationData.title, operationData.responseNumbers);
                break;
            case 'delete_position':
                db.deleteDraftPosition(draft.id, operationData.positionId);
                break;
            case 'merge_positions':
                db.mergeDraftPositions(draft.id, operationData.sourcePositionIds, operationData.newTitle, operationData.themeName);
                break;
        }

        const updatedPositions = db.getDraftPositions(draft.id);

        res.json({
            success: true,
            redone,
            positions: updatedPositions
        });
    } catch (e) {
        console.error('[Draft] redo error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/draft/commit - Commit draft and continue pipeline
app.post('/api/pipeline/:hearingId/draft/commit', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const draft = db.getActiveDraft(hearingId);
        if (!draft) {
            return res.status(404).json({ success: false, error: 'Ingen aktiv kladde fundet' });
        }

        // Export draft positions to checkpoint format
        const positions = db.getDraftPositions(draft.id);

        // Create new checkpoint label for committed draft
        const now = new Date();
        const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
        const timePart = now.toISOString().slice(11, 16).replace(':', '');
        const randomPart = Math.random().toString(36).slice(2, 4);
        const newLabel = `${datePart}-${timePart}-${randomPart}-draft`;

        // Create checkpoint directory
        const checkpointDir = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), newLabel, 'checkpoints');
        fs.mkdirSync(checkpointDir, { recursive: true });

        // Copy base checkpoint files (except sort-positions which we'll override)
        const baseCheckpointDir = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), draft.baseRunLabel, 'checkpoints');
        if (fs.existsSync(baseCheckpointDir)) {
            const files = fs.readdirSync(baseCheckpointDir);
            for (const file of files) {
                if (file !== 'sort-positions.json' && file !== 'hybrid-position-writing.json') {
                    const src = path.join(baseCheckpointDir, file);
                    const dest = path.join(checkpointDir, file);
                    fs.copyFileSync(src, dest);
                }
            }
        }

        // Write edited positions as the new sort-positions checkpoint
        fs.writeFileSync(
            path.join(checkpointDir, 'sort-positions.json'),
            JSON.stringify(positions, null, 2)
        );

        // Write metadata
        fs.writeFileSync(
            path.join(checkpointDir, '_draft-commit.json'),
            JSON.stringify({
                draftId: draft.id,
                baseLabel: draft.baseRunLabel,
                committedAt: Date.now(),
                operationCount: db.getDraftOperations(draft.id).length
            }, null, 2)
        );

        // Mark draft as applied
        db.updateDraftStatus(draft.id, 'applied');

        res.json({
            success: true,
            message: 'Kladde committed',
            newLabel,
            resumeFrom: 'hybrid-position-writing',
            positions
        });
    } catch (e) {
        console.error('[Draft] commit error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/groupings - Get groupings from checkpoint or analysis.json
app.get('/api/pipeline/:hearingId/groupings', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        const runDir = path.join(PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel);

        // Try sort-positions checkpoint first
        const checkpointPath = path.join(runDir, 'checkpoints', 'sort-positions.json');
        if (fs.existsSync(checkpointPath)) {
            const groupings = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
            return res.json({
                success: true,
                label: targetLabel,
                groupings
            });
        }

        // Fallback: load from analysis.json (topics field)
        const analysisPath = path.join(runDir, `hearing-${hearingId}-analysis.json`);
        if (fs.existsSync(analysisPath)) {
            const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
            const groupings = analysis.topics || [];
            return res.json({
                success: true,
                label: targetLabel,
                groupings
            });
        }

        return res.status(404).json({ success: false, error: 'Grupperinger ikke fundet' });
    } catch (e) {
        console.error('[Draft] get groupings error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/confidence - Get confidence scores for positions
app.get('/api/pipeline/:hearingId/confidence', async (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Load sort-positions checkpoint
        const checkpointPath = path.join(
            PIPELINE_OUTPUT_DIR,
            String(hearingId),
            targetLabel,
            'checkpoints',
            'sort-positions.json'
        );

        if (!fs.existsSync(checkpointPath)) {
            return res.status(404).json({ success: false, error: 'Positioner ikke fundet' });
        }

        const groupings = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
        const themes = groupings.themes || [];

        // Import confidence calculator dynamically
        const { calculateThemeConfidences, getReviewQueue } = await import('./analysis-pipeline/src/utils/confidence-calculator.js');

        // Calculate confidence for all positions
        const themesWithConfidence = calculateThemeConfidences(themes, {});

        // Get review queue (sorted by priority)
        const reviewQueue = getReviewQueue(themesWithConfidence);

        // Calculate summary stats
        const allPositions = reviewQueue;
        const stats = {
            total: allPositions.length,
            highPriority: allPositions.filter(p => p.confidence.reviewPriority === 'high').length,
            mediumPriority: allPositions.filter(p => p.confidence.reviewPriority === 'medium').length,
            lowPriority: allPositions.filter(p => p.confidence.reviewPriority === 'low').length,
            averageScore: allPositions.length > 0
                ? Math.round(allPositions.reduce((sum, p) => sum + p.confidence.overall, 0) / allPositions.length * 100) / 100
                : 0
        };

        res.json({
            success: true,
            label: targetLabel,
            themes: themesWithConfidence,
            reviewQueue,
            stats
        });
    } catch (e) {
        console.error('[Confidence] get error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// SAVED SEARCHES
// ============================================================================

// GET /api/pipeline/:hearingId/saved-searches
app.get('/api/pipeline/:hearingId/saved-searches', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const searches = db.getSavedSearches(hearingId);
        res.json({ success: true, searches });
    } catch (e) {
        console.error('[SavedSearches] get error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/saved-searches
app.post('/api/pipeline/:hearingId/saved-searches', express.json({ limit: '100kb' }), (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const { name, filters } = req.body;
        if (!name || !filters) {
            return res.status(400).json({ success: false, error: 'Navn og filtre er påkrævet' });
        }

        const search = db.createSavedSearch(hearingId, name, filters);
        res.json({ success: true, search });
    } catch (e) {
        console.error('[SavedSearches] create error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/pipeline/:hearingId/saved-searches/:searchId
app.delete('/api/pipeline/:hearingId/saved-searches/:searchId', (req, res) => {
    try {
        const searchId = parseInt(req.params.searchId, 10);
        if (!Number.isFinite(searchId)) {
            return res.status(400).json({ success: false, error: 'Invalid search ID' });
        }

        db.deleteSavedSearch(searchId);
        res.json({ success: true, message: 'Søgning slettet' });
    } catch (e) {
        console.error('[SavedSearches] delete error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// ADVANCED SEARCH & FILTERING
// ============================================================================

// Cosine similarity helper
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Load embeddings from checkpoint
function loadEmbeddingsFromCheckpoint(hearingId, label) {
    const embeddingPath = path.join(
        PIPELINE_OUTPUT_DIR,
        String(hearingId),
        label,
        'checkpoints',
        'embedding.json'
    );
    if (!fs.existsSync(embeddingPath)) return null;
    return JSON.parse(fs.readFileSync(embeddingPath, 'utf-8'));
}

// GET /api/pipeline/:hearingId/find-similar/:responseNum - Find similar responses
app.get('/api/pipeline/:hearingId/find-similar/:responseNum', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        const responseNum = parseInt(req.params.responseNum, 10);
        if (!Number.isFinite(hearingId) || !Number.isFinite(responseNum)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing or response ID' });
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
        const threshold = parseFloat(req.query.threshold) || 0.7;

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Load embeddings
        const embeddings = loadEmbeddingsFromCheckpoint(hearingId, targetLabel);
        if (!embeddings || !embeddings.responseEmbeddings) {
            return res.status(404).json({ success: false, error: 'Embeddings ikke fundet' });
        }

        // Find the target response embedding
        const targetEmb = embeddings.responseEmbeddings.find(e => e.responseNumber === responseNum);
        if (!targetEmb || !targetEmb.embedding) {
            return res.status(404).json({ success: false, error: 'Response embedding ikke fundet' });
        }

        // Calculate similarity to all other responses
        const similarities = embeddings.responseEmbeddings
            .filter(e => e.responseNumber !== responseNum && e.embedding)
            .map(e => ({
                responseNumber: e.responseNumber,
                similarity: cosineSimilarity(targetEmb.embedding, e.embedding)
            }))
            .filter(s => s.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);

        // Enrich with response details
        const enrichedResults = similarities.map(s => {
            const sql = `
                SELECT respondent_name as respondentName, respondent_type as respondentType,
                       SUBSTR(text_md, 1, 300) as textPreview
                FROM prepared_responses
                WHERE hearing_id = ? AND source_response_id = ?
            `;
            const row = sqliteDb.prepare(sql).get(hearingId, s.responseNumber);
            return {
                ...s,
                respondentName: row?.respondentName || 'Ukendt',
                respondentType: row?.respondentType || 'Borger',
                textPreview: row?.textPreview ? row.textPreview + '...' : ''
            };
        });

        res.json({
            success: true,
            label: targetLabel,
            sourceResponse: responseNum,
            threshold,
            similar: enrichedResults
        });
    } catch (e) {
        console.error('[FindSimilar] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/response-clusters - Get clusters of similar responses
app.get('/api/pipeline/:hearingId/response-clusters', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const minClusterSize = parseInt(req.query.minSize, 10) || 3;
        const threshold = parseFloat(req.query.threshold) || 0.85; // High threshold for copy-paste detection

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Load embeddings
        const embeddings = loadEmbeddingsFromCheckpoint(hearingId, targetLabel);
        if (!embeddings || !embeddings.responseEmbeddings) {
            return res.status(404).json({ success: false, error: 'Embeddings ikke fundet' });
        }

        // Simple greedy clustering
        const responsesWithEmbeddings = embeddings.responseEmbeddings.filter(e => e.embedding);
        const used = new Set();
        const clusters = [];

        for (const response of responsesWithEmbeddings) {
            if (used.has(response.responseNumber)) continue;

            // Find all similar responses
            const cluster = [response.responseNumber];
            used.add(response.responseNumber);

            for (const other of responsesWithEmbeddings) {
                if (used.has(other.responseNumber)) continue;
                const similarity = cosineSimilarity(response.embedding, other.embedding);
                if (similarity >= threshold) {
                    cluster.push(other.responseNumber);
                    used.add(other.responseNumber);
                }
            }

            if (cluster.length >= minClusterSize) {
                clusters.push({
                    id: clusters.length + 1,
                    responseNumbers: cluster.sort((a, b) => a - b),
                    size: cluster.length
                });
            }
        }

        // Sort clusters by size (largest first)
        clusters.sort((a, b) => b.size - a.size);

        // Enrich with representative text
        const enrichedClusters = clusters.map(cluster => {
            const firstNum = cluster.responseNumbers[0];
            const sql = `
                SELECT respondent_name as respondentName, SUBSTR(text_md, 1, 200) as textPreview
                FROM prepared_responses
                WHERE hearing_id = ? AND source_response_id = ?
            `;
            const row = sqliteDb.prepare(sql).get(hearingId, firstNum);
            return {
                ...cluster,
                representativeText: row?.textPreview ? row.textPreview + '...' : '',
                firstRespondent: row?.respondentName || 'Ukendt'
            };
        });

        res.json({
            success: true,
            label: targetLabel,
            threshold,
            minClusterSize,
            totalClusters: enrichedClusters.length,
            totalClusteredResponses: enrichedClusters.reduce((sum, c) => sum + c.size, 0),
            clusters: enrichedClusters
        });
    } catch (e) {
        console.error('[ResponseClusters] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/uncited-responses - Get responses without citations
app.get('/api/pipeline/:hearingId/uncited-responses', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Load sort-positions to get cited responses
        const sortedPositionsPath = path.join(
            PIPELINE_OUTPUT_DIR,
            String(hearingId),
            targetLabel,
            'checkpoints',
            'sort-positions.json'
        );

        if (!fs.existsSync(sortedPositionsPath)) {
            return res.status(404).json({ success: false, error: 'Positioner ikke fundet' });
        }

        const sortedPositions = JSON.parse(fs.readFileSync(sortedPositionsPath, 'utf-8'));

        // Collect all cited response numbers
        const citedResponses = new Set();
        for (const theme of (sortedPositions.themes || [])) {
            for (const position of (theme.positions || [])) {
                for (const num of (position.responseNumbers || [])) {
                    citedResponses.add(num);
                }
            }
        }

        // Get all responses for this hearing
        const sql = `
            SELECT source_response_id as responseNumber, respondent_name as respondentName,
                   respondent_type as respondentType, SUBSTR(text_md, 1, 300) as textPreview
            FROM prepared_responses
            WHERE hearing_id = ?
            ORDER BY source_response_id ASC
        `;
        const allResponses = sqliteDb.prepare(sql).all(hearingId);

        // Find uncited
        const uncitedResponses = allResponses.filter(r => !citedResponses.has(r.responseNumber));

        res.json({
            success: true,
            label: targetLabel,
            totalResponses: allResponses.length,
            citedCount: citedResponses.size,
            uncitedCount: uncitedResponses.length,
            uncited: uncitedResponses.map(r => ({
                ...r,
                textPreview: r.textPreview ? r.textPreview + '...' : ''
            }))
        });
    } catch (e) {
        console.error('[UncitedResponses] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/pipeline/:hearingId/semantic-search - Semantic search using embeddings
app.post('/api/pipeline/:hearingId/semantic-search', express.json({ limit: '10kb' }), async (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const { query, threshold = 0.6, limit = 20 } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ success: false, error: 'Query er påkrævet' });
        }

        const label = req.query.label || req.body.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Load embeddings
        const embeddings = loadEmbeddingsFromCheckpoint(hearingId, targetLabel);
        if (!embeddings || !embeddings.responseEmbeddings) {
            return res.status(404).json({ success: false, error: 'Embeddings ikke fundet' });
        }

        // Generate embedding for query using OpenAI
        const { OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const embeddingResponse = await openai.embeddings.create({
            model: 'text-embedding-3-large',
            input: query
        });

        const queryEmbedding = embeddingResponse.data[0].embedding;

        // Find similar responses
        const similarities = embeddings.responseEmbeddings
            .filter(e => e.embedding)
            .map(e => ({
                responseNumber: e.responseNumber,
                similarity: cosineSimilarity(queryEmbedding, e.embedding)
            }))
            .filter(s => s.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, Math.min(limit, 50));

        // Enrich with response details
        const enrichedResults = similarities.map(s => {
            const sql = `
                SELECT respondent_name as respondentName, respondent_type as respondentType,
                       SUBSTR(text_md, 1, 400) as textPreview
                FROM prepared_responses
                WHERE hearing_id = ? AND source_response_id = ?
            `;
            const row = sqliteDb.prepare(sql).get(hearingId, s.responseNumber);
            return {
                ...s,
                respondentName: row?.respondentName || 'Ukendt',
                respondentType: row?.respondentType || 'Borger',
                textPreview: row?.textPreview ? row.textPreview + '...' : ''
            };
        });

        res.json({
            success: true,
            label: targetLabel,
            query,
            threshold,
            resultCount: enrichedResults.length,
            results: enrichedResults
        });
    } catch (e) {
        console.error('[SemanticSearch] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/pipeline/:hearingId/smart-suggestions - AI suggestions for grouping
app.get('/api/pipeline/:hearingId/smart-suggestions', (req, res) => {
    try {
        const hearingId = parseInt(req.params.hearingId, 10);
        if (!Number.isFinite(hearingId)) {
            return res.status(400).json({ success: false, error: 'Invalid hearing ID' });
        }

        const label = req.query.label;
        let targetLabel = label;
        if (!targetLabel) {
            const latestRun = getLatestCompletedRun(hearingId);
            if (latestRun) targetLabel = latestRun.label;
        }

        if (!targetLabel) {
            return res.status(404).json({ success: false, error: 'Ingen pipeline-kørsel fundet' });
        }

        // Load micro-summaries and sort-positions
        const microSummaryPath = path.join(
            PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, 'checkpoints', 'micro-summarize.json'
        );
        const sortedPositionsPath = path.join(
            PIPELINE_OUTPUT_DIR, String(hearingId), targetLabel, 'checkpoints', 'sort-positions.json'
        );

        if (!fs.existsSync(microSummaryPath) || !fs.existsSync(sortedPositionsPath)) {
            return res.status(404).json({ success: false, error: 'Analysedata ikke fundet' });
        }

        const microSummaries = JSON.parse(fs.readFileSync(microSummaryPath, 'utf-8'));
        const sortedPositions = JSON.parse(fs.readFileSync(sortedPositionsPath, 'utf-8'));

        const suggestions = [];

        // Collect keyword frequencies from micro-summaries
        const keywordToResponses = {};
        const citedResponses = new Set();

        for (const theme of (sortedPositions.themes || [])) {
            for (const position of (theme.positions || [])) {
                for (const num of (position.responseNumbers || [])) {
                    citedResponses.add(num);
                }
            }
        }

        // Analyze micro-summaries for patterns
        const summaryMap = {};
        for (const summary of (microSummaries.microSummaries || [])) {
            summaryMap[summary.responseNumber] = summary;
            for (const arg of (summary.arguments || [])) {
                const keywords = (arg.keywords || []);
                for (const kw of keywords) {
                    if (!keywordToResponses[kw]) keywordToResponses[kw] = [];
                    keywordToResponses[kw].push(summary.responseNumber);
                }
            }
        }

        // Find responses with shared keywords but different positions
        for (const [keyword, responseNums] of Object.entries(keywordToResponses)) {
            if (responseNums.length >= 3 && responseNums.length <= 15) {
                // Check if these are in same theme
                const positions = new Set();
                for (const num of responseNums) {
                    for (const theme of (sortedPositions.themes || [])) {
                        for (const position of (theme.positions || [])) {
                            if (position.responseNumbers?.includes(num)) {
                                positions.add(`${theme.name}::${position.title}`);
                            }
                        }
                    }
                }

                if (positions.size > 1) {
                    suggestions.push({
                        type: 'scattered_keyword',
                        message: `${responseNums.length} responses med keyword "${keyword}" er fordelt på ${positions.size} positioner`,
                        keyword,
                        responseNumbers: responseNums,
                        positions: Array.from(positions)
                    });
                }
            }
        }

        // Find uncited responses with content
        const uncitedWithContent = [];
        for (const summary of (microSummaries.microSummaries || [])) {
            if (!citedResponses.has(summary.responseNumber) && summary.arguments?.length > 0) {
                uncitedWithContent.push({
                    responseNumber: summary.responseNumber,
                    argumentCount: summary.arguments.length,
                    direction: summary.direction
                });
            }
        }

        if (uncitedWithContent.length > 0) {
            suggestions.push({
                type: 'uncited_with_arguments',
                message: `${uncitedWithContent.length} uciterede responses har gyldige argumenter`,
                responses: uncitedWithContent.slice(0, 20)
            });
        }

        res.json({
            success: true,
            label: targetLabel,
            suggestionCount: suggestions.length,
            suggestions: suggestions.slice(0, 10)
        });
    } catch (e) {
        console.error('[SmartSuggestions] error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================================
// END ANALYSIS PIPELINE INTEGRATION
// ============================================================================

// Create HTTP server explicitly to control keepAlive and header timeouts (helps SSE on some proxies)
const server = http.createServer(app);
try { server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS; } catch {}
try { server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS; } catch {}
try { if (typeof server.requestTimeout !== 'undefined') server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS; } catch {}

// Validate/sanitize cron specs to avoid runtime errors inside node-cron
function resolveCronSpec(value, fallback) {
    try {
        const raw = (typeof value === 'string') ? value.trim() : '';
        const spec = raw || fallback;
        if (typeof spec !== 'string' || !spec.trim()) return fallback;
        if (typeof cron.validate === 'function') {
            return cron.validate(spec) ? spec : fallback;
        }
        // If validate not available, do a simple shape check: at least 5 fields
        const parts = spec.trim().split(/\s+/);
        if (parts.length >= 5 && parts.length <= 7) return spec;
        return fallback;
    } catch {
        return fallback;
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    
    // Warm search index after server is listening
    loadIndexFromDisk();
    // Build search index from SQLite only at runtime
    try {
        if (sqliteDb && sqliteDb.prepare) {
            const rows = sqliteDb.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all('afventer konklusion');
            hearingIndex = (rows || []).map(enrichHearingForIndex);
        }
    } catch (e) {
        console.warn('Index from DB failed at startup:', e && e.message);
    }
    // On deploy: run a full scrape/hydration once (non-blocking) - DISABLED in LITE_MODE
    if (!LITE_MODE) {
        (async () => {
            try {
                console.log('[Server] Running startup data scrape...');
                const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                const response = await axios.post(`${base}/api/run-daily-scrape`, { reason: 'startup' }, { validateStatus: () => true, timeout: 120000 });
                console.log('[Server] Startup scrape response:', response.status, response.data);
            } catch (e) {
                console.error('[Server] Startup scrape failed:', e.message);
            }
        })();
    } else {
        console.log('[Server] LITE_MODE enabled - skipping startup scrape');
    }
    // Periodic refresh to keep index robust - DISABLED in LITE_MODE
    if (!LITE_MODE) {
        const refreshMs = Number(process.env.INDEX_REFRESH_MS || (6 * 60 * 60 * 1000));
        if (Number.isFinite(refreshMs) && refreshMs > 0) {
            setInterval(() => {
                warmHearingIndex().catch((err) => {
                    console.error('Error warming hearing index on interval:', err.message);
                });
            }, refreshMs);
        }
    } else {
        console.log('[Server] LITE_MODE enabled - skipping periodic index refresh');
    }

    // Optional cron-based jobs controlled via env - DISABLED in LITE_MODE
    if (!LITE_MODE && (process.env.CRON_ENABLED || '1') !== '0') {
        try {
            // Daily discovery+hydrate focused on 'Afventer konklusion'
            const dailySpec = resolveCronSpec(process.env.CRON_DAILY_SCRAPE || '0 3 * * *', '0 3 * * *');
            cron.schedule(dailySpec, async () => {
                try {
                    // Discover
                    const baseApi = 'https://blivhoert.kk.dk/api/hearing';
                    let page = 1;
                    const pageSize = 50;
                    const ids = [];
                    for (;;) {
                        const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
                        const r = await axios.get(url, { validateStatus: () => true });
                        if (r.status !== 200 || !r.data) break;
                        const items = Array.isArray(r.data?.data) ? r.data.data : [];
                        const included = Array.isArray(r.data?.included) ? r.data.included : [];
                        const statusById = new Map();
                        for (const inc of included) if (inc?.type === 'hearingStatus') statusById.set(String(inc.id), inc?.attributes?.name || null);
                        for (const it of items) {
                            if (!it || it.type !== 'hearing') continue;
                            const statusRelId = it.relationships?.hearingStatus?.data?.id;
                            const statusText = statusById.get(String(statusRelId)) || null;
                            if (String(statusText || '').toLowerCase().includes('afventer konklusion')) {
                                ids.push(Number(it.id));
                            }
                        }
                        const totalPages = r.data?.meta?.Pagination?.totalPages || page;
                        if (page >= totalPages) break;
                        page += 1;
                    }
                    const targetIds = Array.from(new Set(ids)).filter(Number.isFinite);
                    // Archive any hearings in DB not in target set
                    try {
                        const existing = listAllHearingIds();
                        const targetSet = new Set(targetIds);
                        for (const id of existing) {
                            if (!targetSet.has(id)) setHearingArchived(id, 1);
                            else setHearingArchived(id, 0);
                        }
                    } catch {}
                    // Hydrate each target id using prefetch (network), then mark complete
                    const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                    let idx = 0;
                    const workers = new Array(Math.min(REFRESH_CONCURRENCY, Math.max(1, targetIds.length))).fill(0).map(async () => {
                        while (idx < targetIds.length) {
                            const id = targetIds[idx++];
                            try {
                                // Skip if already complete (static dataset)
                                try { const comp = isHearingComplete(id); if (comp && comp.complete) continue; } catch {}
                                await hydrateHearingDirect(id);
                            } catch {}
                        }
                    });
                    await Promise.all(workers);
                    // Rebuild in-memory index from DB
                    try {
                        const rows = sqliteDb.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all('afventer konklusion');
                        hearingIndex = (rows || []).map(enrichHearingForIndex);
                    } catch {}
                } catch (e) {
                    console.warn('Daily scrape failed:', e && e.message);
                }
            });

            // Expose an admin endpoint to trigger daily scrape on demand
            app.post('/api/run-daily-scrape', async (req, res) => {
                try {
                    await (async () => { try { await axios.post(`http://localhost:${PORT}/__internal/run-daily-scrape`); } catch {} })();
                    res.json({ success: true, queued: true });
                } catch (e) {
                    res.status(500).json({ success: false, message: 'Kunne ikke starte daglig scraping' });
                }
            });
            // Internal endpoint called above to avoid re-creating logic in route handler
            app.post('/__internal/run-daily-scrape', async (req, res) => {
                try {
                    const run = async () => {
                        try {
                            const baseApi = 'https://blivhoert.kk.dk/api/hearing';
                            let page = 1; const pageSize = 50; const ids = [];
                            for (;;) {
                                const url = `${baseApi}?PageIndex=${page}&PageSize=${pageSize}`;
                                const r = await axios.get(url, { validateStatus: () => true });
                                if (r.status !== 200 || !r.data) break;
                                const items = Array.isArray(r.data?.data) ? r.data.data : [];
                                const included = Array.isArray(r.data?.included) ? r.data.included : [];
                                const statusById = new Map();
                                for (const inc of included) if (inc?.type === 'hearingStatus') statusById.set(String(inc.id), inc?.attributes?.name || null);
                                for (const it of items) {
                                    if (!it || it.type !== 'hearing') continue;
                                    const statusRelId = it.relationships?.hearingStatus?.data?.id;
                                    const statusText = statusById.get(String(statusRelId)) || null;
                                    if (String(statusText || '').toLowerCase().includes('afventer konklusion')) ids.push(Number(it.id));
                                }
                                const totalPages = r.data?.meta?.Pagination?.totalPages || page;
                                if (page >= totalPages) break;
                                page += 1;
                            }
                            const targetIds = Array.from(new Set(ids)).filter(Number.isFinite);
                            const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                            let idx = 0;
                            const workers = new Array(Math.min(REFRESH_CONCURRENCY, Math.max(1, targetIds.length))).fill(0).map(async () => {
                                while (idx < targetIds.length) {
                                    const id = targetIds[idx++];
                                    try {
                                        // Skip if already complete (static dataset)
                                        try { const comp = isHearingComplete(id); if (comp && comp.complete) continue; } catch {}
                                        await hydrateHearingDirect(id);
                                    } catch {}
                                }
                            });
                            await Promise.all(workers);
                            try {
                                const rows = sqliteDb.prepare(`SELECT id,title,start_date as startDate,deadline,status FROM hearings WHERE archived IS NOT 1 AND LOWER(status) LIKE '%' || ? || '%'`).all('afventer konklusion');
                                hearingIndex = (rows || []).map(enrichHearingForIndex);
                            } catch {}
                        } catch {}
                    };
                    setImmediate(() => { run().catch(() => {}); });
                    res.json({ success: true, queued: true });
                } catch (e) {
                    res.status(500).json({ success: false });
                }
            });

            // Jobs cleanup
            const jobCleanupSpec = resolveCronSpec(process.env.CRON_JOBS_CLEANUP, '12 * * * *');
            cron.schedule(jobCleanupSpec, () => {
                try { cleanupOldJobs(); } catch {}
            });

            // Hearing refresh cron job
            const hearingRefreshSpec = resolveCronSpec(process.env.CRON_HEARING_REFRESH, '*/30 * * * *');
            if (hearingRefreshSpec) {
                console.log(`Setting up hearing refresh cron with schedule: ${hearingRefreshSpec}`);
                cron.schedule(hearingRefreshSpec, async () => {
                    try {
                        console.log('[CRON] Starting hearing refresh job');
                        const base = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
                        
                        // First, warm the hearing index - this will:
                        // 1. Fetch all hearings from API
                        // 2. Only include ones with status "Afventer konklusion"
                        // 3. Update hearing_index table in SQLite with proper titles
                        await warmHearingIndex();
                        
                        // Then refresh hearings marked as 'Afventer konklusion'
                        if (sqliteDb && sqliteDb.prepare) {
                            const pendingHearings = sqliteDb.prepare(`
                                SELECT id FROM hearings 
                                WHERE archived IS NOT 1 
                                AND LOWER(status) LIKE '%afventer konklusion%'
                                ORDER BY updated_at ASC
                                LIMIT 10
                            `).all();
                            
                            console.log(`[CRON] Found ${pendingHearings.length} pending hearings to refresh`);
                            
                            for (const hearing of pendingHearings) {
                                try {
                                    await axios.post(`${base}/api/prefetch/${hearing.id}?apiOnly=1`, 
                                        { reason: 'cron_refresh' }, 
                                        { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }
                                    );
                                    console.log(`[CRON] Refreshed hearing ${hearing.id}`);
                                } catch (e) {
                                    console.error(`[CRON] Failed to refresh hearing ${hearing.id}:`, e.message);
                                }
                            }
                        }
                        console.log('[CRON] Hearing refresh job completed');
                    } catch (e) {
                        console.error('[CRON] Hearing refresh job failed:', e.message);
                    }
                });
            }
        } catch (e) {
            console.warn('Cron setup failed:', e.message);
        }
    }

    // Resume any dangling jobs from previous run
    try { resumeDanglingJobs(); } catch (e) { console.warn('resumeDanglingJobs failed:', e.message); }
});

// =============================
// Robust refresh for open hearings (materials + responses) with stabilization
// =============================

function statusMatchesRefreshTargets(statusText) {
    const s = String(statusText || '').toLowerCase();
    return REFRESH_TARGET_STATUSES.some(t => s.includes(t));
}

async function fetchAggregateOnce(localBase, hearingId) {
    const aggUrl = `${localBase}/api/hearing/${encodeURIComponent(hearingId)}?nocache=1`;
    const matUrl = `${localBase}/api/hearing/${encodeURIComponent(hearingId)}/materials?nocache=1`;
    const [agg, mats] = await Promise.all([
        axios.get(aggUrl, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }).catch(() => ({ status: 0, data: null })),
        axios.get(matUrl, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS }).catch(() => ({ status: 0, data: null }))
    ]);
    const hearing = (agg.data && agg.data.hearing) ? agg.data.hearing : null;
    const responses = (agg.data && Array.isArray(agg.data.responses)) ? agg.data.responses : [];
    const materials = (mats.data && Array.isArray(mats.data.materials)) ? mats.data.materials : [];
    const ok = !!hearing && responses.length >= 0 && materials.length >= 0;
    return { ok, hearing, responses, materials };
}

function snapshotSignature(s) {
    if (!s) return 'x';
    const numR = Array.isArray(s.responses) ? s.responses.length : 0;
    const numM = Array.isArray(s.materials) ? s.materials.length : 0;
    const firstRid = numR ? (s.responses[0]?.id || s.responses[0]?.responseNumber || 0) : 0;
    const lastRid = numR ? (s.responses[numR - 1]?.id || s.responses[numR - 1]?.responseNumber || 0) : 0;
    const firstM = numM ? (s.materials[0]?.title || s.materials[0]?.url || '') : '';
    const lastM = numM ? (s.materials[numM - 1]?.title || s.materials[numM - 1]?.url || '') : '';
    return `${numR}|${firstRid}|${lastRid}::${numM}|${firstM}|${lastM}`;
}

// Hydrate a hearing directly from Bliv hørt (no HTTP calls to our own endpoints)
async function hydrateHearingDirect(hearingId) {
    try {
        const baseUrl = 'https://blivhoert.kk.dk';
        // Increased timeout to handle large hearings (1700+ responses can take 30+ seconds)
        const axiosInstance = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'da-DK,da;q=0.9',
                'Cookie': 'kk-xyz=1',
                'Referer': `${baseUrl}/hearing/${hearingId}/comments`,
                'Origin': baseUrl
            },
            timeout: 120000,
            validateStatus: () => true
        });

        // Fetch responses (HTML + JSON API merge)
        // OPTIMIZATION: If HTML scraping returns 0 responses on page 1 but has totalPages,
        // skip all remaining HTML pages and rely solely on API (which is more reliable for large hearings)
        let htmlResponses = [];
        let totalPages = 1;
        let skipHtmlPages = false;
        try {
            const first = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, 1, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            htmlResponses = (first.responses || []).map(r => ({ ...r, page: 1 }));
            totalPages = first.totalPages || 1;
            
            // If page 1 returned 0 responses but claims there are many pages,
            // the HTML parsing is likely failing (e.g., __NEXT_DATA__ structure changed)
            // Skip remaining HTML pages to save time - API will provide the data
            if (htmlResponses.length === 0 && totalPages > 1) {
                console.log(`[hydrateHearingDirect] HTML scraping returned 0 responses on page 1 but totalPages=${totalPages} - skipping remaining HTML pages, will use API only`);
                skipHtmlPages = true;
            }
            
            if (!skipHtmlPages && typeof totalPages === 'number' && totalPages > 1) {
                const remaining = [];
                for (let p = 2; p <= totalPages; p += 1) remaining.push(p);
                const maxConcurrent = 4;
                let cursor = 0;
                const workers = new Array(Math.min(maxConcurrent, remaining.length)).fill(0).map(async () => {
                    while (cursor < remaining.length) {
                        const myIdx = cursor++;
                        const p = remaining[myIdx];
                        const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, p, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                        const pageItems = Array.isArray(result.responses) ? result.responses.map(r => ({ ...r, page: p })) : [];
                        if (pageItems.length) htmlResponses = htmlResponses.concat(pageItems);
                    }
                });
                await Promise.all(workers);
            } else if (!skipHtmlPages) {
                // Unknown pages fallback
                let pageIndex = 2;
                let consecutiveEmpty = 0;
                let lastFirstId = htmlResponses[0]?.responseNumber ?? null;
                for (;;) {
                    const result = await withRetries(() => fetchCommentsPage(baseUrl, hearingId, pageIndex, axiosInstance), { attempts: 2, baseDelayMs: 400 });
                    const pageItems = Array.isArray(result.responses) ? result.responses.map(r => ({ ...r, page: pageIndex })) : [];
                    if (!pageItems.length) {
                        consecutiveEmpty += 1; if (consecutiveEmpty >= 2) break;
                    } else {
                        consecutiveEmpty = 0;
                        const currentFirstId = pageItems[0]?.responseNumber ?? null;
                        if (lastFirstId !== null && currentFirstId !== null && currentFirstId === lastFirstId) break;
                        lastFirstId = currentFirstId;
                        htmlResponses = htmlResponses.concat(pageItems);
                    }
                    if (!totalPages && result.totalPages) totalPages = result.totalPages;
                    pageIndex += 1;
                    if (pageIndex > 200) break;
                }
            }
        } catch (_) { htmlResponses = []; totalPages = 1; }

        // API - always fetch (primary data source for large hearings)
        let viaApi = { responses: [], totalPages: null };
        try { viaApi = await fetchCommentsViaApi(`${baseUrl}/api`, hearingId, axiosInstance); } catch {}
        const merged = mergeResponsesPreferFullText(htmlResponses, viaApi.responses || []);
        const normalizedResponses = normalizeResponses(merged);

        // Meta via root page (__NEXT_DATA__) then JSON API
        let hearingMeta = { title: null, deadline: null, startDate: null, status: null };
        try {
            const rootPage = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            if (rootPage.nextJson) hearingMeta = extractMetaFromNextJson(rootPage.nextJson);
        } catch {}
        if (!hearingMeta.title || !hearingMeta.deadline || !hearingMeta.startDate || !hearingMeta.status) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { headers: { Accept: 'application/json' } });
                if (r.status === 200 && r.data) {
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    const contents = included.filter(x => x?.type === 'content');
                    const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                    const attrs = item?.attributes || {};
                    const statusRelId = item?.relationships?.hearingStatus?.data?.id;
                    const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
                    hearingMeta = {
                        title: hearingMeta.title || (titleContent ? fixEncoding(String(titleContent.attributes.textContent).trim()) : null),
                        deadline: hearingMeta.deadline || attrs.deadline || null,
                        startDate: hearingMeta.startDate || attrs.startDate || null,
                        status: hearingMeta.status || statusIncluded?.attributes?.name || null
                    };
                }
            } catch {}
        }
        const hearing = {
            id: Number(hearingId),
            title: hearingMeta.title || `Høring ${hearingId}`,
            startDate: hearingMeta.startDate || null,
            deadline: hearingMeta.deadline || null,
            status: hearingMeta.status || 'ukendt',
            url: `${baseUrl}/hearing/${hearingId}/comments`
        };

        // Materials via root page then JSON API fallback
        let materials = [];
        try {
            const res1 = await withRetries(() => fetchHearingRootPage(baseUrl, hearingId, axiosInstance), { attempts: 3, baseDelayMs: 600 });
            materials = res1.materials || [];
        } catch {}
        if (!materials.length) {
            try {
                const apiUrl = `${baseUrl}/api/hearing/${hearingId}`;
                const r = await axiosInstance.get(apiUrl, { headers: { Accept: 'application/json' } });
                if (r.status === 200 && r.data) {
                    const data = r.data;
                    const item = (data?.data && data.data.type === 'hearing') ? data.data : null;
                    const included = Array.isArray(data?.included) ? data.included : [];
                    const contentById = new Map();
                    included.filter(x => x?.type === 'content').forEach(c => contentById.set(String(c.id), c));
                    const refs = Array.isArray(item?.relationships?.contents?.data) ? item.relationships.contents.data : [];
                    let combinedText = '';
                    const discoveredLinks = new Map();
                    function shouldIgnoreExternal(url) {
                        const u = String(url).toLowerCase();
                        if (u.includes('klagevejledning')) return true;
                        if (u.includes('kk.dk/dagsordener-og-referater')) return true;
                        const isPlanDocPdf = /dokument\.plandata\.dk\/.*\.pdf(\?|$)/i.test(u);
                        if (isPlanDocPdf) return false;
                        if (u.includes('plst.dk') || u.includes('plandata.dk') || u.includes('plandata')) return true;
                        return false;
                    }
                    function addLink(url, title) {
                        if (!url) return;
                        const clean = String(url).trim();
                        if (!clean) return;
                        if (shouldIgnoreExternal(clean)) return;
                        if (!discoveredLinks.has(clean)) discoveredLinks.set(clean, { title: title || clean });
                    }
                    for (const ref of refs) {
                        const cid = ref?.id && String(ref.id);
                        if (!cid || !contentById.has(cid)) continue;
                        const c = contentById.get(cid);
                        const a = c?.attributes || {};
                        const rel = c?.relationships || {};
                        const isHearingField = !!(rel?.field?.data?.id);
                        const isCommentContent = !!(rel?.comment?.data?.id);
                        if (typeof a.textContent === 'string' && a.textContent.trim() && isHearingField && !isCommentContent) {
                            const text = a.textContent.trim();
                            combinedText += (combinedText ? '\n\n' : '') + text;
                            const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g; let m;
                            while ((m = mdLinkRe.exec(text)) !== null) addLink(m[2], m[1]);
                            const urlRe = /(https?:\/\/[^\s)]+)(?![^\[]*\])/g; let u;
                            while ((u = urlRe.exec(text)) !== null) addLink(u[1]);
                        }
                        if (typeof a.filePath === 'string' && a.filePath.trim() && isHearingField && !isCommentContent) {
                            const filePath = String(a.filePath).trim();
                            const fileName = String(a.fileName || '').trim() || (filePath.split('/').pop() || 'Dokument');
                            materials.push({ type: 'file', title: fileName, url: buildFileUrl(baseUrl, filePath, fileName) });
                        }
                    }
                    if (combinedText.trim()) materials.push({ type: 'description', title: 'Høringstekst', content: fixEncoding(combinedText) });
                    for (const [url, meta] of discoveredLinks.entries()) {
                        if (/\.(pdf|doc|docx|xls|xlsx)(\?|$)/i.test(url)) materials.push({ type: 'file', title: meta.title || url, url });
                    }
                    // Deduplicate
                    const seen = new Set(); const deduped = [];
                    for (const m of materials) {
                        const key = `${m.type}|${m.title || ''}|${m.url || ''}|${(m.content || '').slice(0,50)}`;
                        if (seen.has(key)) continue; seen.add(key); deduped.push(m);
                    }
                    materials = deduped;
                }
            } catch {}
        }

        const derivedTotalPages = viaApi.totalPages || totalPages || null;
        if (PERSIST_ALWAYS_WRITE) {
            try {
                const existingMeta = readPersistedHearingWithMeta(hearingId);
                const existing = existingMeta?.data || null;
                const snapshot = mergePersistPayload(existing, {
                    success: true,
                    hearing,
                    responses: normalizedResponses,
                    materials,
                    totalResponses: normalizedResponses.length,
                    totalPages: derivedTotalPages || undefined
                });
                writePersistedHearing(hearingId, snapshot);
            } catch (persistErr) {
                console.warn(`[hydrate] failed to persist snapshot for ${hearingId}:`, persistErr?.message || persistErr);
            }
        }

        try { upsertHearing(hearing); replaceResponses(hearing.id, normalizedResponses); replaceMaterials(hearing.id, materials); } catch {}
        const sig = snapshotSignature({ responses: normalizedResponses, materials });
        try { markHearingComplete(hearing.id, sig, normalizedResponses.length, materials.length); } catch {}
        return {
            success: true,
            hearingId: hearing.id,
            responses: normalizedResponses.length,
            materials: materials.length,
            totalPages: derivedTotalPages || undefined
        };
    } catch (e) {
        return { success: false, error: e && e.message };
    }
}

async function refreshHearingUntilStable(hearingId) {
    // If API-only prefetch is enabled for cron, prefer that to reduce heavy scraping
    if (API_ONLY_PREFETCH) {
        try {
            await axios.post(`${(process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`}/api/prefetch/${encodeURIComponent(hearingId)}?apiOnly=1`, { reason: 'refresh' }, { validateStatus: () => true, timeout: INTERNAL_API_TIMEOUT_MS });
            return { success: true };
        } catch {}
    }
    const localBase = (process.env.PUBLIC_URL || '').trim() || `http://localhost:${PORT}`;
    let lastSig = '';
    let stableRepeats = 0;
    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
        const snap = await fetchAggregateOnce(localBase, hearingId);
        if (!snap.ok) {
            await sleep(400 * attempt);
            continue;
        }
        if (!statusMatchesRefreshTargets(snap.hearing?.status || '')) {
            return { skipped: true, reason: 'status-mismatch' };
        }
        const sig = snapshotSignature(snap);
        if (sig === lastSig) {
            stableRepeats += 1;
            if (stableRepeats >= REFRESH_STABLE_REPEATS) {
                return { success: true, responses: snap.responses.length, materials: snap.materials.length };
            }
        } else {
            lastSig = sig;
            stableRepeats = 1;
        }
        await sleep(500 * attempt);
    }
    return { success: false };
}

async function listRefreshTargetHearings() {
    let ids = [];
    
    // Always check database first (more reliable for cron jobs)
    if (sqliteDb && sqliteDb.prepare) {
        try {
            const rows = sqliteDb.prepare(`SELECT id, status FROM hearings WHERE status IS NOT NULL`).all();
            ids = rows.filter(r => statusMatchesRefreshTargets(r.status)).map(r => r.id);
            console.log(`[listRefreshTargetHearings] Found ${ids.length} hearings in DB with matching status`);
        } catch (e) {
            console.warn('[listRefreshTargetHearings] DB query failed:', e.message);
        }
    }
    
    // If no results from DB, try in-memory index
    if (!ids.length) {
        try {
            ids = hearingIndex
                .filter(h => statusMatchesRefreshTargets(h.status))
                .map(h => h.id);
            console.log(`[listRefreshTargetHearings] Found ${ids.length} hearings in memory index`);
        } catch {}
    }
    
    return Array.from(new Set(ids)).filter(x => Number.isFinite(x));
}

app.post('/api/refresh/open', async (req, res) => {
    try {
        const ids = await listRefreshTargetHearings();
        console.log(`[refresh/open] Found ${ids?.length || 0} hearings to refresh`);
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.json({ success: true, total: 0, refreshed: 0, results: [], message: 'No hearings to refresh' });
        }
        
        let idx = 0;
        let completed = 0;
        const results = [];
        const workers = new Array(Math.min(REFRESH_CONCURRENCY, Math.max(1, ids.length))).fill(0).map(async () => {
            while (idx < ids.length) {
                const my = ids[idx++];
                const out = await refreshHearingUntilStable(my);
                results.push({ id: my, ...out });
                completed += 1;
            }
        });
        await Promise.all(workers);
        res.json({ success: true, total: ids.length, refreshed: completed, results });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Refresh failed', error: e.message });
    }
});