/**
 * Material Analyzer
 * 
 * Analyzes hearing materials to establish a consistent taxonomy of themes.
 * This creates a "ground truth" for theme classification before processing individual responses.
 * 
 * Supports chunking for large documents to avoid content cutoff.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { smartChunk } from '../utils/document-chunker.js';
import { PDFConverter } from '../utils/pdf-converter.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class MaterialAnalyzer {
  constructor(options = {}) {
    // Use LIGHT complexity level for theme extraction (fast, simple task)
    // Note: light-plus caused timeouts on large documents - keep it simple
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'light');
    
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
      temperature: options.temperature || 0.2 // Low temperature for consistent output
    });
    
    // Log actual model being used
    console.log(`[MaterialAnalyzer] Initialized with model=${this.client.model}`);

    // PDF converter for materials without proper markdown headers
    this.pdfConverter = new PDFConverter(options.pdfConverter || {});

    // Chunking threshold - documents larger than this will use chunking
    this.chunkThreshold = options.chunkThreshold || 45000;
    
    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/material-analysis-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[MaterialAnalyzer] Could not load prompt template, using default');
      this.promptTemplate = null;
    }
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
  }

  /**
   * Analyze materials to generate theme taxonomy
   * Supports chunking for large documents to avoid content cutoff.
   * @param {Array} materials - Hearing materials
   * @returns {Promise<Object>} Taxonomy with themes and descriptions
   */
  async analyze(materials) {
    if (!materials || materials.length === 0) {
      console.warn('[MaterialAnalyzer] No materials provided for analysis');
      return { themes: [] };
    }

    // Convert PDFs to markdown with proper headers
    const convertedMaterials = await this.pdfConverter.convertMaterials(materials);
    console.log(`[MaterialAnalyzer] Using converted materials (${convertedMaterials.length} items)`);

    // Prepare material text - NO CUTOFF per material
    const materialsText = convertedMaterials
      .map(m => {
        const title = m.title || 'Materiale';
        const content = m.contentMd || m.content || '';
        // Only add title header if content doesn't already start with a header
        const hasExistingHeader = content.trim().startsWith('#');
        return hasExistingHeader ? content : `## ${title}\n\n${content}`;
      })
      .join('\n\n');

    console.log(`[MaterialAnalyzer] Material text: ${materialsText.length} chars (threshold: ${this.chunkThreshold})`);

    // CRITICAL: Extract ALL section headers from FULL document FIRST
    // This ensures we find §1-§13, not just §1-§4 from first chunk
    const allSectionHeaders = this.extractSectionHeaders(materialsText);
    this.extractedSectionHeaders = allSectionHeaders; // Pre-populate for buildPrompt
    console.log(`[MaterialAnalyzer] Pre-extracted ${allSectionHeaders.length} section headers from full document`);

    // Check if chunking is needed
    if (materialsText.length <= this.chunkThreshold) {
      // Small document - process directly
      console.log(`[MaterialAnalyzer] Small document - processing directly`);
      return this.analyzeText(materialsText);
    }

    // Large document - use smart chunking strategy
    console.log(`[MaterialAnalyzer] Large document - using chunking strategy`);
    const chunks = smartChunk(materialsText, {
      maxChunkSize: this.chunkThreshold,
      minChunkSize: 10000,
      overlapSize: 1000,
      preferHeaderBreaks: true
    });

    console.log(`[MaterialAnalyzer] Split into ${chunks.length} chunks`);

    // Check if first chunk has document structure (§ sections, table of contents)
    if (this.hasDocumentStructure(chunks[0].text)) {
      // Primary path - first chunk has the structure (most lokalplaner)
      // NOTE: We already extracted headers from full document above
      console.log(`[MaterialAnalyzer] First chunk has document structure - using primary path (1 LLM call)`);
      return this.analyzeText(chunks[0].text);
    }

    // Fallback path - process chunks in parallel and merge themes
    console.log(`[MaterialAnalyzer] First chunk lacks structure - processing ${chunks.length} chunks in parallel`);

    try {
      const chunkPromises = chunks.map((chunk, idx) =>
        this.analyzeText(chunk.text)
          .then(result => {
            console.log(`[MaterialAnalyzer] Chunk ${idx + 1}/${chunks.length} done: ${result.themes?.length || 0} themes`);
            return result;
          })
          .catch(err => {
            console.warn(`[MaterialAnalyzer] Chunk ${idx + 1} failed: ${err.message}`);
            return { themes: [] };
          })
      );

      const chunkResults = await Promise.all(chunkPromises);

      // Merge and deduplicate themes from all chunks
      const mergedThemes = this.mergeAndDeduplicateThemes(chunkResults);
      console.log(`[MaterialAnalyzer] Merged ${chunkResults.reduce((sum, r) => sum + (r.themes?.length || 0), 0)} themes into ${mergedThemes.length} unique themes`);

      return { themes: mergedThemes };
    } catch (error) {
      console.error('[MaterialAnalyzer] Parallel analysis failed:', error);
      return this.getFallbackTaxonomy();
    }
  }

  /**
   * Check if text contains document structure indicators
   */
  hasDocumentStructure(text) {
    if (!text) return false;

    let structureScore = 0;

    // § sections (very strong indicator for lokalplaner)
    const paragraphMatches = (text.match(/§\s*\d+/g) || []).length;
    if (paragraphMatches >= 3) structureScore += 3;
    else if (paragraphMatches >= 1) structureScore += 1;

    // "Bestemmelser" section header
    if (/bestemmelser/i.test(text)) structureScore += 2;

    // "Indholdsfortegnelse" or similar
    if (/indholdsfortegnelse|indhold/i.test(text)) structureScore += 2;

    // Multiple markdown headers
    const headerMatches = (text.match(/^#{2,3}\s+.+$/gm) || []).length;
    if (headerMatches >= 5) structureScore += 2;
    else if (headerMatches >= 2) structureScore += 1;

    console.log(`[MaterialAnalyzer] Structure score: ${structureScore} (§: ${paragraphMatches}, headers: ${headerMatches})`);

    return structureScore >= 3;
  }

  /**
   * Merge and deduplicate themes from multiple chunks
   */
  mergeAndDeduplicateThemes(chunkResults) {
    const allThemes = chunkResults.flatMap(r => r.themes || []);
    const seenIds = new Map(); // id -> theme
    const seenNames = new Map(); // name.toLowerCase() -> theme
    const mergedThemes = [];

    for (const theme of allThemes) {
      const id = (theme.id || '').toLowerCase().trim();
      const nameLower = (theme.name || '').toLowerCase().trim();

      if (!nameLower) continue;

      // Check for duplicate by ID
      if (id && seenIds.has(id)) {
        continue;
      }

      // Check for duplicate by name (fuzzy match)
      let isDuplicate = false;
      for (const [existingName] of seenNames) {
        if (existingName === nameLower ||
            existingName.includes(nameLower) ||
            nameLower.includes(existingName)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        if (id) seenIds.set(id, theme);
        seenNames.set(nameLower, theme);
        mergedThemes.push(theme);
      }
    }

    // NOTE: "Andre emner" is added by ThemeMapper as the sole catch-all theme
    // No need to add "Generelt" during material analysis

    return mergedThemes;
  }

  /**
   * Normalize theme names to match actual § section naming conventions.
   * Uses extracted section headers as "ground truth" when available.
   * 
   * LLM sometimes invents incorrect names like "Trafik og adgange" instead of "Veje"
   * @param {Array} themes - Array of theme objects
   * @returns {Array} Themes with normalized names
   */
  normalizeThemeNames(themes) {
    if (!themes || !Array.isArray(themes)) return themes;

    // First pass: Clean up any HTML/XML artifacts from theme names
    themes = themes.map(theme => {
      let cleanName = theme.name || '';
      const originalName = cleanName;
      
      // Remove any HTML/XML-like fragments
      cleanName = cleanName.replace(/<\/?[^>]*>/g, ''); // Full tags
      cleanName = cleanName.replace(/<\/?/g, ''); // Partial opening/closing tags
      cleanName = cleanName.replace(/[<>]/g, ''); // Stray angle brackets
      cleanName = cleanName.trim();
      
      if (cleanName !== originalName) {
        console.log(`[MaterialAnalyzer] 🧹 Cleaned theme name: "${originalName}" → "${cleanName}"`);
      }
      
      return { ...theme, name: cleanName };
    });

    // Second pass: Static corrections for common LLM hallucinations
    // Maps invented names → standard lokalplan section names
    const themeNameCorrections = {
      // § 1 - Formål
      'formål og overblik': 'Formål',
      'formål og baggrund': 'Formål',
      'lokalplanens formål': 'Formål',
      
      // § 2 - Område
      'områdeafgrænsning og delområder': 'Område',
      'område og afgrænsning': 'Område',
      
      // § 3 - Anvendelse
      'anvendelse og boligstruktur': 'Anvendelse',
      
      // § 4 - Veje (NOT "Trafik og adgange")
      'trafik og adgange (veje og stier)': 'Veje',
      'trafik og adgange': 'Veje',
      'trafik og vejforhold': 'Veje',
      'trafik og forbindelser': 'Veje',
      'trafikforhold': 'Veje',
      'vejforhold': 'Veje',
      
      // § 5 - Bil- og cykelparkering (the FULL name, not just "Parkering")
      'parkering': 'Bil- og cykelparkering',
      'bil og cykelparkering': 'Bil- og cykelparkering',
      'bilparkering': 'Bil- og cykelparkering',
      
      // § 6 - Bebyggelsens omfang og placering (usually correct)
      
      // § 7 - Bebyggelsens ydre fremtræden (usually correct)
      
      // § 8 - Ubebyggede arealer
      'ubebyggede arealer og byrum': 'Ubebyggede arealer',
      'byrum og kantzoner': 'Ubebyggede arealer',
      'friarealer': 'Ubebyggede arealer',
      
      // § 9 - Støj og anden forurening
      'støj': 'Støj og anden forurening',
      'støjforhold': 'Støj og anden forurening',
      
      // Non-existent themes that should go to "Andre emner"
      'miljø og risiko': 'Andre emner',
      'miljø og risiko (oversvømmelse, skybrud, jord- og grundvand)': 'Andre emner',
      'miljøforhold': 'Andre emner',
      'kulturmiljø': 'Andre emner',
      'kulturmiljø og omkringliggende områder': 'Andre emner',
      'proces og borgerinddragelse': 'Andre emner',
      'ekspropriation og rettigheder': 'Andre emner',
      
      // Generic catch-alls
      'andet og diverse': 'Andre emner',
      'øvrige forhold': 'Andre emner',
      'andet': 'Andre emner'
    };

    themes = themes.map(theme => {
      const nameLower = (theme.name || '').toLowerCase().trim();
      
      if (themeNameCorrections[nameLower]) {
        const corrected = themeNameCorrections[nameLower];
        console.log(`[MaterialAnalyzer] 🔧 Theme name correction: "${theme.name}" → "${corrected}"`);
        return { ...theme, name: corrected };
      }
      
      return theme;
    });

    // Third pass: Validate against extracted section headers (if available)
    if (this.extractedSectionHeaders && this.extractedSectionHeaders.length > 0) {
      const validNames = new Set(this.extractedSectionHeaders.map(h => h.name.toLowerCase()));
      validNames.add('andre emner'); // Always valid
      validNames.add('generelt'); // Always valid
      
      themes = themes.map(theme => {
        const nameLower = (theme.name || '').toLowerCase().trim();
        
        // If exact match found, keep it
        if (validNames.has(nameLower)) {
          return theme;
        }
        
        // Try to find closest match in valid names
        const closestMatch = this.findClosestSectionHeader(theme.name, this.extractedSectionHeaders);
        if (closestMatch) {
          console.log(`[MaterialAnalyzer] 🎯 Matched to section header: "${theme.name}" → "${closestMatch.name}"`);
          return { ...theme, name: closestMatch.name, sectionReference: closestMatch.fullRef };
        }
        
        // No match found - this theme doesn't exist in the material
        // Map to "Andre emner" if it's not a standard theme
        if (!['generelt', 'andre emner'].includes(nameLower)) {
          console.log(`[MaterialAnalyzer] ⚠️ Theme not in material, mapping to "Andre emner": "${theme.name}"`);
          return { ...theme, name: 'Andre emner', _originalName: theme.name };
        }
        
        return theme;
      });
      
      // Deduplicate themes after corrections (multiple may have become "Andre emner")
      const seenNames = new Set();
      themes = themes.filter(theme => {
        const nameLower = (theme.name || '').toLowerCase();
        if (seenNames.has(nameLower)) return false;
        seenNames.add(nameLower);
        return true;
      });
    }

    return themes;
  }

  /**
   * Find closest matching section header using fuzzy matching
   * @param {string} themeName - Theme name to match
   * @param {Array} headers - Array of section headers
   * @returns {Object|null} Matching header or null
   */
  findClosestSectionHeader(themeName, headers) {
    if (!themeName || !headers || headers.length === 0) return null;
    
    const targetLower = themeName.toLowerCase().trim();
    
    // Try exact match first
    const exact = headers.find(h => h.name.toLowerCase() === targetLower);
    if (exact) return exact;
    
    // Try substring match (theme contains header name or vice versa)
    for (const header of headers) {
      const headerLower = header.name.toLowerCase();
      if (targetLower.includes(headerLower) || headerLower.includes(targetLower)) {
        return header;
      }
    }
    
    // Try keyword matching
    const targetWords = targetLower.split(/\s+/).filter(w => w.length > 2);
    let bestMatch = null;
    let bestScore = 0;
    
    for (const header of headers) {
      const headerWords = header.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const overlap = targetWords.filter(w => headerWords.includes(w)).length;
      const score = overlap / Math.max(targetWords.length, headerWords.length);
      
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestMatch = header;
      }
    }
    
    return bestMatch;
  }

  /**
   * Analyze a single text (used for both small docs and chunks)
   */
  async analyzeText(materialsText) {
    const prompt = this.buildPrompt(materialsText);

    try {
      console.log('[MaterialAnalyzer] Generating theme taxonomy from materials...');

      const completion = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en erfaren byplanlægger og sagsbehandler. Din opgave er at strukturere en høring ved at identificere de centrale temaer i høringsmaterialet.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: getResponseFormat('taxonomy')
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error('No content in completion');

      const result = JSON.parse(content);

      // Validate structure
      if (!result.themes || !Array.isArray(result.themes)) {
        throw new Error('Invalid taxonomy format returned');
      }

      // CRITICAL: Normalize theme names to match actual § section names
      // LLM sometimes invents names like "Formål og overblik" instead of "Formål"
      result.themes = this.normalizeThemeNames(result.themes);

      console.log(`[MaterialAnalyzer] Generated taxonomy with ${result.themes.length} themes`);
      return result;

    } catch (error) {
      console.error('[MaterialAnalyzer] Analysis failed:', error);
      return this.getFallbackTaxonomy();
    }
  }

  /**
   * Get fallback taxonomy when analysis fails
   */
  getFallbackTaxonomy() {
    return {
      themes: [
        { id: "andre_emner", name: "Andre emner", description: "Emner uden specifik tematisk tilknytning" },
        { id: "arkitektur", name: "Arkitektur og Byrum", description: "Bygningers udseende, højde og placering" },
        { id: "trafik", name: "Trafik og Parkering", description: "Trafikale forhold, cykler og biler" },
        { id: "miljo", name: "Miljø og Klima", description: "Støj, skygge, vind og grønne områder" }
      ]
    };
  }

  /**
   * Extract § section headers directly from material text.
   * This provides "ground truth" theme names that the LLM must use.
   * 
   * Handles multiple formats:
   * 1. Markdown: "###### § 1. Formål .................................................................... 23"
   * 2. Plain text multi-line: "§ 1." followed by "Formål" on next line
   * 3. Plain text inline: "§ 1. Formål"
   * 
   * @param {string} text - Material text
   * @returns {Array} Array of {sectionNumber, name} objects
   */
  extractSectionHeaders(text) {
    if (!text) return [];
    
    const headers = [];
    const lines = text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // FORMAT 1: Markdown header with § inline
      // Pattern: "###### § 1. Formål .................................................................... 23"
      const markdownMatch = line.match(/^#{1,6}\s*§\s*(\d+)\.\s*([A-ZÆØÅa-zæøå][^\.]{2,}?)(?:\s*\.{2,}.*|\s*\d+\s*)?$/);
      if (markdownMatch) {
        const sectionNumber = markdownMatch[1];
        let title = markdownMatch[2]
          .replace(/\.{2,}.*$/, '') // Remove trailing dots and page numbers
          .replace(/\s+/g, ' ')
          .trim();
        
        if (title && title.length > 1 && title.length < 100 && !headers.find(h => h.sectionNumber === sectionNumber)) {
          headers.push({
            sectionNumber,
            name: title,
            fullRef: `§ ${sectionNumber}. ${title}`
          });
          console.log(`[MaterialAnalyzer] Found section (markdown): § ${sectionNumber}. ${title}`);
        }
        continue;
      }
      
      // FORMAT 2: Plain text multi-line - "§ X." on one line, title on next
      const plainSectionMatch = line.match(/^§\s*(\d+)\.\s*$/);
      if (plainSectionMatch) {
        const sectionNumber = plainSectionMatch[1];
        const nextLine = lines[i + 1]?.trim() || '';
        
        let title = nextLine
          .replace(/\.{2,}\s*\d+\s*$/, '') // Remove ".... 23" style page refs
          .replace(/\.{2,}.*$/, '') // Remove any remaining dots
          .replace(/\s+/g, ' ')
          .trim();
        
        if (title && !title.match(/^§/) && title.length > 1 && title.length < 100 && !headers.find(h => h.sectionNumber === sectionNumber)) {
          headers.push({
            sectionNumber,
            name: title,
            fullRef: `§ ${sectionNumber}. ${title}`
          });
          console.log(`[MaterialAnalyzer] Found section (multi-line): § ${sectionNumber}. ${title}`);
        }
        continue;
      }
      
      // FORMAT 3: Plain text inline - "§ 4. Veje" all on same line (no markdown header)
      const inlineMatch = line.match(/^§\s*(\d+)\.\s+([A-ZÆØÅ][a-zæøåA-ZÆØÅ\s\-]+)$/);
      if (inlineMatch && !headers.find(h => h.sectionNumber === inlineMatch[1])) {
        const sectionNumber = inlineMatch[1];
        const title = inlineMatch[2].trim();
        
        if (title && title.length > 1 && title.length < 100) {
          headers.push({
            sectionNumber,
            name: title,
            fullRef: `§ ${sectionNumber}. ${title}`
          });
          console.log(`[MaterialAnalyzer] Found section (inline): § ${sectionNumber}. ${title}`);
        }
      }
    }
    
    // Deduplicate (same section may appear multiple times in document)
    const seen = new Set();
    const unique = headers.filter(h => {
      const key = `${h.sectionNumber}-${h.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    console.log(`[MaterialAnalyzer] Extracted ${unique.length} unique section headers from material`);
    return unique;
  }

  /**
   * Build analysis prompt with extracted section headers as constraints
   */
  buildPrompt(materialsText) {
    // Use pre-extracted headers if available (from full document), otherwise extract from chunk
    // This is critical for large documents where chunks only contain partial § sections
    const sectionHeaders = this.extractedSectionHeaders?.length > 0
      ? this.extractedSectionHeaders
      : this.extractSectionHeaders(materialsText);

    // Only update stored headers if we extracted fresh ones
    if (!this.extractedSectionHeaders?.length) {
      this.extractedSectionHeaders = sectionHeaders;
    }

    // Build the allowed themes list
    let allowedThemesList = '';
    if (sectionHeaders.length > 0) {
      allowedThemesList = `
**GYLDIGE TEMANAVNE (du SKAL bruge disse PRÆCISE navne):**
${sectionHeaders.map(h => `- "${h.name}" (${h.fullRef})`).join('\n')}
- "Andre emner" (for emner uden for dokumentets beføjelser)

**KRITISK:** Du må KUN bruge temanavne fra listen ovenfor. Opfind IKKE egne navne som "Trafik og adgange" når materialet siger "Veje".
`;
    }
    
    if (this.promptTemplate) {
      return this.promptTemplate
        .replace('{materials}', materialsText)
        .replace('{allowedThemes}', allowedThemesList);
    }

    return `Analysér følgende høringsmateriale og definér en udtømmende liste af temaer (taksonomi), som borgernes høringssvar sandsynligvis vil falde ind under.

MATERIALE:
${materialsText}
${allowedThemesList}

Din opgave:
1. Identificer hovedtemaer baseret på materialets indhold - BRUG KUN de § navne der findes i materialet.
2. Inkluder altid "Andre emner" for emner uden for dokumentets beføjelser.
3. Giv hvert tema et kort ID (snake_case), det PRÆCISE navn fra materialet, og en kort beskrivelse.

Output skal være JSON med strukturen: { "themes": [{ "id": "...", "name": "...", "description": "..." }] }`;
  }
}

