/**
 * Data Loader
 * 
 * Loads published data from SQLite database via the same connection as the server.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Try multiple .env paths - prioritize main gdpr .env (where DB_PATH is set)
dotenv.config({ path: join(__dirname, '../../../.env') });
dotenv.config({ path: join(__dirname, '../../config/.env') });

/**
 * Detect if response text is a placeholder that should be ignored in favor of attachments.
 * Common patterns: "Høringssvar modtaget på mail", "Høringssvar modtaget på blivhørt", etc.
 * 
 * NOTE: Short texts like "Bevar Palads" are NOT placeholders - they are valid (if brief) responses.
 * We only detect explicit placeholder patterns that indicate the real content is elsewhere.
 * 
 * @param {string} text - The response text to check
 * @returns {boolean} True if text appears to be a placeholder
 */
function isPlaceholderText(text) {
  if (!text || text.trim().length === 0) return true;
  
  const trimmed = text.trim().toLowerCase();
  
  // Known placeholder patterns - these indicate the actual content is in an attachment
  const placeholderPatterns = [
    /^høringssvar modtaget på (mail|blivhørt)\.?$/i,
    /^modtaget på (mail|blivhørt)\.?$/i,
    /^sendt via (mail|email)\.?$/i,
    /^vedhæftet\.?$/i,
    /^se vedhæftning\.?$/i,
    /^se vedhæftet\.?$/i,
  ];
  
  return placeholderPatterns.some(pattern => pattern.test(trimmed));
}

export class DataLoader {
  constructor(options = {}) {
    // Use DB_PATH from env if available (same as server uses)
    // Production path is configured via DB_PATH environment variable
    const dbPathFromEnv = process.env.DB_PATH;
    const dbPath = options.dbPath || dbPathFromEnv;
    
    // Resolve path: if absolute, use as-is (from .env)
    // If relative or not set, resolve from gdpr root
    const absolutePath = dbPath && dbPath.startsWith('/') 
      ? dbPath 
      : (dbPath 
          ? resolve(__dirname, '../../../', dbPath)
          : resolve(__dirname, '../../../data/app.sqlite')); // Fallback to default
    
    try {
      // Use direct connection and ensure we can see committed WAL data
      this.db = new Database(absolutePath);
      this.db.pragma('journal_mode = WAL');
      // Force checkpoint to ensure we see all committed data
      this.db.pragma('wal_checkpoint(FULL)');
      console.log(`[DataLoader] Connected to database: ${absolutePath} (from DB_PATH: ${dbPathFromEnv})`);
    } catch (error) {
      throw new Error(`Failed to connect to database: ${error.message}`);
    }
  }

  /**
   * Load published hearing data
   * @param {number} hearingId - Hearing ID
   * @returns {Object} Hearing data with responses and materials
   */
  async loadPublishedHearing(hearingId) {
    // FIRST: Try to load from database (GDPR secured data with converted attachments)
    try {
      // Check if published_responses has data
      const publishedCount = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM published_responses
        WHERE hearing_id = ?
      `).get(hearingId);
      
      if (publishedCount && publishedCount.count > 0) {
        console.log(`[DataLoader] Loading GDPR secured data from published_responses for hearing ${hearingId}`);
        return await this._loadFromDatabase(hearingId);
      }
      
      // FALLBACK: Try to load from prepared_responses (GDPR secured but not yet published)
      const preparedCount = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM prepared_responses
        WHERE hearing_id = ?
      `).get(hearingId);
      
      if (preparedCount && preparedCount.count > 0) {
        console.log(`[DataLoader] Loading GDPR secured data from prepared_responses for hearing ${hearingId} (not yet published)`);
        return await this._loadFromPrepared(hearingId);
      }
    } catch (error) {
      console.warn(`[DataLoader] Could not load from database: ${error.message}`);
    }
    
    // FALLBACK: Try to load from JSON file (for test data)
    const jsonPath = resolve(__dirname, `../../data/hearing-${hearingId}.json`);
    if (existsSync(jsonPath)) {
      console.log(`[DataLoader] Loading from JSON file: ${jsonPath}`);
      const jsonData = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      
      return {
        hearing: {
          id: jsonData.hearing.id,
          title: jsonData.hearing.title
          // Removed: status (irrelevant for analysis)
        },
        responses: (jsonData.responses || []).map(r => {
          // Collect text content based on textFrom
          let textFrom = r.textFrom || r.focusMode || null;
          const responseText = (r.text || '').trim();
          const attachmentTexts = (r.attachments || [])
            .map(a => (a.contentMd || a.content_md || '').trim())
            .filter(text => text.length > 0);
          
          // AUTO-CORRECTION: If textFrom is 'response' but the response text is a placeholder
          // (e.g., "Høringssvar modtaget på mail") and there are attachments with content,
          // automatically switch to using attachment content instead.
          const hasAttachmentContent = attachmentTexts.length > 0;
          if ((textFrom === 'response' || textFrom === null) && isPlaceholderText(responseText) && hasAttachmentContent) {
            console.log(`[DataLoader] Auto-correcting textFrom for response ${r.id}: placeholder text detected, switching to 'attachment'`);
            textFrom = 'attachment';
          }
          
          // Combine text based on textFrom
          let combinedText = '';
          if (textFrom === 'response') {
            combinedText = responseText;
          } else if (textFrom === 'attachment') {
            combinedText = attachmentTexts.join('\n\n');
          } else {
            const parts = [];
            if (responseText && !isPlaceholderText(responseText)) parts.push(responseText);
            if (attachmentTexts.length > 0) parts.push(...attachmentTexts);
            combinedText = parts.join('\n\n');
          }
          
          return {
            id: r.id,
            text: combinedText, // All relevant text content combined based on textFrom
            respondentName: r.author || null,
            respondentType: null,
            textFrom: textFrom // Indicates where text comes from: "response" (only response text), "attachment" (only attachment text), "both" (both), or null (both)
            // Removed: sourceId, author, organization, onBehalfOf (irrelevant for analysis)
          };
        }),
              materials: (() => {
                const materials = (jsonData.materials || []).map(m => {
                  // Materials are PDF files - return file paths if available
                  const filePath = m.filePath || null;
                  return {
                    materialId: m.id || m.title,
                    title: m.title,
                    filePath: filePath, // Absolute path to PDF file (null if not available)
                    publishedAt: null
                  };
                });
          
          // Add PDF material for hearing 168 if it exists
          if (hearingId === 168) {
            const pdfPath = resolve(__dirname, '../../data/20_11326817_1744186742675.pdf');
            if (existsSync(pdfPath)) {
              materials.push({
                materialId: '20_11326817_1744186742675',
                title: '20_11326817_1744186742675.pdf',
                filePath: pdfPath,
                publishedAt: null
              });
            }
          }
          
          return materials;
        })()
      };
    }

    throw new Error(`No data found for hearing ${hearingId} in database or JSON files`);
  }

  /**
   * Load GDPR secured data from database
   * @private
   */
  async _loadFromDatabase(hearingId) {
    // Load hearing metadata
    let hearing = this.db.prepare(`
      SELECT id, title, start_date, deadline, status
      FROM hearings
      WHERE id = ?
    `).get(hearingId);

    if (!hearing) {
      hearing = {
        id: hearingId,
        title: `Høring ${hearingId}`,
        start_date: null,
        deadline: null,
        status: 'published'
      };
    }

    // Load published responses with converted attachments
    // JOIN on source_response_id (original ID from hearing system) to get focus_mode from prepared_responses
    const responseRows = this.db.prepare(`
      SELECT pr.*, p.focus_mode 
      FROM published_responses pr 
      LEFT JOIN prepared_responses p ON p.hearing_id = pr.hearing_id AND p.source_response_id = pr.source_response_id 
      WHERE pr.hearing_id = ? 
      ORDER BY pr.response_id ASC
    `).all(hearingId);

    const responses = await Promise.all(responseRows.map(async (r) => {
      // Load attachments with converted markdown
      const attachments = this.db.prepare(`
        SELECT 
          attachment_id as attachmentId,
          original_filename as filename,
          content_md,
          published_at as publishedAt
        FROM published_attachments
        WHERE hearing_id = ? AND response_id = ?
        ORDER BY attachment_id ASC
      `).all(hearingId, r.response_id);

      // Apply textFrom filtering: collect all relevant text content into a single text field
      // textFrom can be: "response" (only text), "attachment" (only attachments), "both" (both), or null/undefined (both)
      let textFrom = r.focus_mode || null;
      const responseText = (r.text_md || r.text || '').trim();
      const attachmentTexts = attachments
        .map(att => (att.content_md || '').trim())
        .filter(text => text.length > 0);
      
      // AUTO-CORRECTION: If textFrom is 'response' but the response text is a placeholder
      // (e.g., "Høringssvar modtaget på mail") and there are attachments with content,
      // automatically switch to using attachment content instead.
      const hasAttachmentContent = attachmentTexts.length > 0;
      if ((textFrom === 'response' || textFrom === null) && isPlaceholderText(responseText) && hasAttachmentContent) {
        console.log(`[DataLoader] Auto-correcting textFrom for response ${r.source_response_id || r.response_id}: placeholder text detected, switching to 'attachment'`);
        textFrom = 'attachment';
      }
      
      // Determine what to include based on textFrom and combine into single text field
      let combinedText = '';
      
      if (textFrom === 'response') {
        // Only include response text
        combinedText = responseText;
      } else if (textFrom === 'attachment') {
        // Only include attachment texts
        combinedText = attachmentTexts.join('\n\n');
      } else {
        // Include both (textFrom === 'both' or null/undefined)
        const parts = [];
        if (responseText && !isPlaceholderText(responseText)) parts.push(responseText);
        if (attachmentTexts.length > 0) parts.push(...attachmentTexts);
        combinedText = parts.join('\n\n');
      }
      
      // Extract attachment metadata for complexity assessment
      const attachmentFilenames = attachments.map(att => att.filename).filter(Boolean);
      const hasAttachments = attachmentFilenames.length > 0;

      return {
        id: r.source_response_id || r.response_id, // Use source_response_id as primary ID (reflects original hearing system, accounts for removed responses)
        text: combinedText, // All relevant text content combined based on textFrom
        respondentName: r.respondent_name || null,
        respondentType: r.respondent_type || null, // Type: "Borger", "Organisation", etc.
        textFrom: textFrom, // Indicates where text comes from: "response" (only response text), "attachment" (only attachment text), "both" (both), or null (both)
        hasAttachments: hasAttachments, // Whether response has attachments
        attachmentFilenames: hasAttachments ? attachmentFilenames : undefined // List of attachment filenames (for complexity assessment)
        // Removed: responseId, author, organization, onBehalfOf (irrelevant for analysis)
      };
    }));

    // Load materials (may have converted markdown if PDF was processed)
    const materialRows = this.db.prepare(`
      SELECT 
        material_id as materialId,
        title,
        content_md,
        published_at as publishedAt
      FROM published_materials
      WHERE hearing_id = ?
      ORDER BY material_id ASC
    `).all(hearingId);

    // Materials with converted markdown content from database
    const materials = materialRows.map(m => {
      // Construct file path: materials are stored in data/ directory
      // File name matches title (e.g., "20_11326817_1744186742675.pdf")
      const pdfPath = resolve(__dirname, '../../data', m.title);
      const filePath = existsSync(pdfPath) ? pdfPath : null;
      
      return {
        materialId: m.materialId,
        title: m.title,
        filePath: filePath, // Absolute path to PDF file (null if file doesn't exist)
        contentMd: m.content_md || '', // Converted markdown content from database
        content: m.content_md || '' // Alias for compatibility
        // Removed: publishedAt (irrelevant for analysis)
      };
    });

    // Add PDF material for hearing 168 if it exists and not already in materials
    if (hearingId === 168) {
      const pdfPath = resolve(__dirname, '../../data/20_11326817_1744186742675.pdf');
      if (existsSync(pdfPath) && !materials.some(m => m.title.includes('20_11326817'))) {
        materials.push({
          materialId: '20_11326817_1744186742675',
          title: '20_11326817_1744186742675.pdf',
          filePath: pdfPath,
          publishedAt: null
        });
      }
    }

    return {
      hearing: {
        id: hearing.id,
        title: hearing.title
        // Removed: status (irrelevant for analysis)
      },
      responses: responses,
      materials: materials
    };
  }

  /**
   * Load GDPR secured data from prepared_responses (not yet published)
   * @private
   */
  async _loadFromPrepared(hearingId) {
    // Load hearing metadata
    let hearing = this.db.prepare(`
      SELECT id, title, start_date, deadline, status
      FROM hearings
      WHERE id = ?
    `).get(hearingId);

    if (!hearing) {
      hearing = {
        id: hearingId,
        title: `Høring ${hearingId}`,
        start_date: null,
        deadline: null,
        status: 'draft'
      };
    }

    // Load prepared responses with converted attachments
    const responseRows = this.db.prepare(`
      SELECT *
      FROM prepared_responses
      WHERE hearing_id = ?
      ORDER BY prepared_id ASC
    `).all(hearingId);

    const responses = await Promise.all(responseRows.map(async (r) => {
      // Load attachments with converted markdown
      const attachments = this.db.prepare(`
        SELECT 
          attachment_id as attachmentId,
          original_filename as filename,
          converted_md as content_md,
          approved_at as publishedAt
        FROM prepared_attachments
        WHERE hearing_id = ? AND prepared_id = ?
        ORDER BY attachment_id ASC
      `).all(hearingId, r.prepared_id);

      // Apply textFrom filtering: collect all relevant text content into a single text field
      // textFrom can be: "response" (only text), "attachment" (only attachments), "both" (both), or null/undefined (both)
      let textFrom = r.focus_mode || null;
      const responseText = (r.text_md || '').trim();
      const attachmentTexts = attachments
        .map(att => (att.content_md || '').trim())
        .filter(text => text.length > 0);
      
      // AUTO-CORRECTION: If textFrom is 'response' but the response text is a placeholder
      // (e.g., "Høringssvar modtaget på mail") and there are attachments with content,
      // automatically switch to using attachment content instead.
      const hasAttachmentContent = attachmentTexts.length > 0;
      if ((textFrom === 'response' || textFrom === null) && isPlaceholderText(responseText) && hasAttachmentContent) {
        console.log(`[DataLoader] Auto-correcting textFrom for response ${r.source_response_id || r.prepared_id}: placeholder text detected, switching to 'attachment'`);
        textFrom = 'attachment';
      }
      
      // Determine what to include based on textFrom and combine into single text field
      let combinedText = '';
      
      if (textFrom === 'response') {
        // Only include response text
        combinedText = responseText;
      } else if (textFrom === 'attachment') {
        // Only include attachment texts
        combinedText = attachmentTexts.join('\n\n');
      } else {
        // Include both (textFrom === 'both' or null/undefined)
        const parts = [];
        if (responseText && !isPlaceholderText(responseText)) parts.push(responseText);
        if (attachmentTexts.length > 0) parts.push(...attachmentTexts);
        combinedText = parts.join('\n\n');
      }
      
      return {
        id: r.source_response_id || r.prepared_id, // Use source_response_id as primary ID (reflects original hearing system, accounts for removed responses)
        text: combinedText, // All relevant text content combined based on textFrom
        respondentName: r.respondent_name || null,
        respondentType: r.respondent_type || null,
        textFrom: textFrom // Indicates where text comes from: "response" (only response text), "attachment" (only attachment text), "both" (both), or null (both)
        // Removed: responseId, author, organization, onBehalfOf (irrelevant for analysis)
      };
    }));

    // Load materials (may have converted markdown if PDF was processed)
    const materialRows = this.db.prepare(`
      SELECT 
        material_id as materialId,
        title,
        content_md,
        approved_at as publishedAt
      FROM prepared_materials
      WHERE hearing_id = ?
      ORDER BY material_id ASC
    `).all(hearingId);

    // Materials with converted markdown content from database
    const materials = materialRows.map(m => {
      // Construct file path: materials are stored in data/ directory
      // File name matches title (e.g., "20_11326817_1744186742675.pdf")
      const pdfPath = resolve(__dirname, '../../data', m.title);
      const filePath = existsSync(pdfPath) ? pdfPath : null;
      
      return {
        materialId: m.materialId,
        title: m.title,
        filePath: filePath, // Absolute path to PDF file (null if file doesn't exist)
        contentMd: m.content_md || '', // Converted markdown content from database
        content: m.content_md || '' // Alias for compatibility
        // Removed: publishedAt (irrelevant for analysis)
      };
    });

    // Add PDF material for hearing 168 if it exists and not already in materials
    if (hearingId === 168) {
      const pdfPath = resolve(__dirname, '../../data/20_11326817_1744186742675.pdf');
      if (existsSync(pdfPath) && !materials.some(m => m.title.includes('20_11326817'))) {
        materials.push({
          materialId: '20_11326817_1744186742675',
          title: '20_11326817_1744186742675.pdf',
          filePath: pdfPath,
          publishedAt: null
        });
      }
    }

    return {
      hearing: {
        id: hearing.id,
        title: hearing.title
        // Removed: status (irrelevant for analysis)
      },
      responses: responses,
      materials: materials
    };
  }

  /**
   * Check if hearing exists and is published
   */
  isHearingPublished(hearingId) {
    const count = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM published_responses
      WHERE hearing_id = ?
    `).get(hearingId);

    return count.count > 0;
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

