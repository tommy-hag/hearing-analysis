/**
 * Theme Extractor
 * 
 * Uses LLM to extract structured themes from hearing materials based on document structure.
 * Supports hybrid approach: combines document structure with theme templates.
 * Identifies document purpose, scope, and distinguishes between regulation themes,
 * general purpose comments, and out-of-scope content.
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
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class ThemeExtractor {
  constructor(options = {}) {
    // Use LIGHT complexity level for theme extraction (fast, simple task)
    // Note: light-plus caused timeouts on large documents - keep it simple
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'light');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    
    // Log actual model being used
    console.log(`[ThemeExtractor] Initialized with model=${this.client.model}`);

    // PDF converter for materials without proper markdown headers
    this.pdfConverter = new PDFConverter(options.pdfConverter || {});

    // Chunking threshold - documents larger than this will use chunking
    this.chunkThreshold = options.chunkThreshold || 50000;

    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/theme-extraction-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[ThemeExtractor] Could not load prompt template');
      this.promptTemplate = null;
    }

    // Load theme templates
    try {
      const templatePath = join(__dirname, '../../config/theme-templates.json');
      this.themeTemplates = JSON.parse(readFileSync(templatePath, 'utf-8'));
    } catch (error) {
      console.warn('[ThemeExtractor] Could not load theme templates, using defaults');
      this.themeTemplates = {
        documentTypes: { default: { commonThemes: [], outOfScopeIndicators: [], generalPurposeKeywords: [] } },
        mappingStrategy: { hybrid: true, useTemplate: true, useDocumentStructure: true, preferDocumentStructure: true }
      };
    }
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
  }

  /**
   * Extract themes from hearing materials using LLM with hybrid approach
   * Supports chunking for large documents to avoid content cutoff.
   * @param {Array} materials - Hearing materials
   * @returns {Promise<Array>} Array of themes with name, level, category, and description
   */
  async extractThemes(materials) {
    if (!materials || materials.length === 0) {
      return [{ name: 'Andre emner', level: 0, category: 'out-of-scope', description: 'Emner uden specifik tematisk tilknytning' }];
    }

    // Convert PDFs to markdown with proper headers (like SubstanceExtractor does)
    const convertedMaterials = await this.pdfConverter.convertMaterials(materials);
    console.log(`[ThemeExtractor] Using converted materials (${convertedMaterials.length} items)`);

    // Identify document type and get template
    const documentType = this.identifyDocumentType(convertedMaterials);
    const template = this.themeTemplates.documentTypes[documentType] || this.themeTemplates.documentTypes.default;

    // Combine material content using converted markdown with proper headers
    const materialText = convertedMaterials
      .map((m, idx) => {
        const title = m.title || `Materiale ${idx + 1}`;
        const content = m.contentMd || m.content || '';
        // Only add title header if content doesn't already start with a header
        const hasExistingHeader = content.trim().startsWith('#');
        return hasExistingHeader ? content : `## ${title}\n\n${content}`;
      })
      .join('\n\n');

    console.log(`[ThemeExtractor] Material text: ${materialText.length} chars (threshold: ${this.chunkThreshold})`);

    // Check if chunking is needed
    if (materialText.length <= this.chunkThreshold) {
      // Small document - process directly (no cutoff needed)
      console.log(`[ThemeExtractor] Small document - processing directly`);
      return this.extractThemesFromText(materialText, documentType, template, convertedMaterials);
    }

    // Large document - use smart chunking strategy
    console.log(`[ThemeExtractor] Large document - using chunking strategy`);
    const chunks = smartChunk(materialText, { 
      maxChunkSize: this.chunkThreshold,
      minChunkSize: 10000,
      overlapSize: 1000,
      preferHeaderBreaks: true,
      documentType: documentType
    });
    
    console.log(`[ThemeExtractor] Split into ${chunks.length} chunks`);

    // Check if first chunk has document structure (§ sections, table of contents)
    if (this.hasDocumentStructure(chunks[0].text)) {
      // Primary path - first chunk has the structure (most lokalplaner)
      console.log(`[ThemeExtractor] First chunk has document structure - using primary path (1 LLM call)`);
      return this.extractThemesFromText(chunks[0].text, documentType, template, convertedMaterials);
    }

    // Fallback path - process chunks in parallel and merge
    console.log(`[ThemeExtractor] First chunk lacks structure - processing ${chunks.length} chunks in parallel`);
    
    try {
      const chunkPromises = chunks.map((chunk, idx) => 
        this.extractThemesFromText(chunk.text, documentType, template, convertedMaterials)
          .then(themes => {
            console.log(`[ThemeExtractor] Chunk ${idx + 1}/${chunks.length} done: ${themes.length} themes`);
            return themes;
          })
          .catch(err => {
            console.warn(`[ThemeExtractor] Chunk ${idx + 1} failed: ${err.message}`);
            return [];
          })
      );

      const chunkResults = await Promise.all(chunkPromises);
      
      // Merge and deduplicate themes from all chunks
      const mergedThemes = this.mergeAndDeduplicateThemes(chunkResults, convertedMaterials);
      console.log(`[ThemeExtractor] Merged ${chunkResults.flat().length} themes into ${mergedThemes.length} unique themes`);
      
      return mergedThemes;
    } catch (error) {
      console.warn('[ThemeExtractor] Parallel extraction failed, falling back to header extraction:', error.message);
      return this.extractThemesFromHeaders(convertedMaterials);
    }
  }

  /**
   * Check if text contains document structure indicators
   * (§ sections, table of contents, numbered bestemmelser)
   */
  hasDocumentStructure(text) {
    if (!text) return false;
    
    // Count indicators of document structure
    let structureScore = 0;
    
    // § sections (very strong indicator for lokalplaner)
    const paragraphMatches = (text.match(/§\s*\d+/g) || []).length;
    if (paragraphMatches >= 3) structureScore += 3;
    else if (paragraphMatches >= 1) structureScore += 1;
    
    // "Bestemmelser" section header
    if (/bestemmelser/i.test(text)) structureScore += 2;
    
    // "Indholdsfortegnelse" or similar
    if (/indholdsfortegnelse|indhold/i.test(text)) structureScore += 2;
    
    // Multiple markdown headers (## or ###)
    const headerMatches = (text.match(/^#{2,3}\s+.+$/gm) || []).length;
    if (headerMatches >= 5) structureScore += 2;
    else if (headerMatches >= 2) structureScore += 1;
    
    // Numbered sections (1., 2., etc. at start of line)
    const numberedMatches = (text.match(/^\d+\.\s+[A-ZÆØÅ]/gm) || []).length;
    if (numberedMatches >= 3) structureScore += 1;
    
    console.log(`[ThemeExtractor] Structure score: ${structureScore} (§: ${paragraphMatches}, headers: ${headerMatches})`);
    
    // Threshold: need at least 3 points to consider it "structured"
    return structureScore >= 3;
  }

  /**
   * Merge and deduplicate themes from multiple chunks
   */
  mergeAndDeduplicateThemes(chunkResults, materials) {
    const allThemes = chunkResults.flat();
    const seenNames = new Map(); // name.toLowerCase() -> theme object
    const mergedThemes = [];
    
    for (const theme of allThemes) {
      const nameLower = (theme.name || '').toLowerCase().trim();
      if (!nameLower) continue;
      
      // Check for exact or fuzzy match
      let existingKey = null;
      for (const [key, existing] of seenNames) {
        // Exact match
        if (key === nameLower) {
          existingKey = key;
          break;
        }
        // Fuzzy match: one contains the other (for partial matches like "§ 7" vs "§ 7 Bebyggelse")
        if (key.includes(nameLower) || nameLower.includes(key)) {
          existingKey = key;
          break;
        }
      }
      
      if (existingKey) {
        // Merge keywords from this theme into existing
        const existing = seenNames.get(existingKey);
        if (theme.keywords && Array.isArray(theme.keywords)) {
          existing.keywords = [...new Set([...(existing.keywords || []), ...theme.keywords])];
        }
        // Keep higher regulatory weight
        if (theme.regulatoryWeight > (existing.regulatoryWeight || 0)) {
          existing.regulatoryWeight = theme.regulatoryWeight;
        }
      } else {
        // New theme
        seenNames.set(nameLower, theme);
        mergedThemes.push(theme);
      }
    }
    
    // Sort by regulatory weight
    mergedThemes.sort((a, b) => {
      if ((a.regulatoryWeight || 0) !== (b.regulatoryWeight || 0)) {
        return (b.regulatoryWeight || 0) - (a.regulatoryWeight || 0);
      }
      return (a.firstOccurrence || 0) - (b.firstOccurrence || 0);
    });
    
    // NOTE: "Andre emner" is now added by ThemeMapper as the sole catch-all
    // No need to add any fallback theme during extraction
    
    return mergedThemes;
  }

  /**
   * Extract themes from text (single chunk or full document)
   */
  async extractThemesFromText(materialText, documentType, template, materials) {
    // Build prompt from template
    const prompt = this.buildPrompt(materialText, template, documentType);

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at identificere strukturelle temaer i høringsmateriale.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: getResponseFormat('themeExtraction')
        // Note: GPT-5 models control temperature via verbosity/reasoning parameters
      });

      let content = response.choices[0]?.message?.content || '';

      // Clean content
      content = content.trim();
      if (content.startsWith('```json')) {
        content = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      } else if (content.startsWith('```')) {
        content = content.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
      }
      content = content.trim();

      // Extract JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        content = jsonMatch[0];
      }

      // Clean control characters
      content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

      const parsed = JSON.parse(content);

      // Process themes with hybrid approach
      let themes = [];
      if (parsed.themes && Array.isArray(parsed.themes) && parsed.themes.length > 0) {
        themes = parsed.themes.map((t, idx) => ({
          name: this.cleanThemeName(t.name) || 'Andre emner',
          level: t.level || 0,
          description: t.description || '',
          category: t.category || 'regulation',
          sectionReference: t.sectionReference || null,
          keywords: t.keywords || [],
          // Track regulatory priority based on position and material context
          regulatoryWeight: this.calculateRegulatoryWeight(t, materials, idx),
          firstOccurrence: idx // Order in which theme appears
        }));

        // Sort themes by regulatory weight (regulatory sections first, then explanatory)
        themes.sort((a, b) => {
          // First by regulatory weight
          if (a.regulatoryWeight !== b.regulatoryWeight) {
            return b.regulatoryWeight - a.regulatoryWeight; // Higher weight first
          }
          // Then by first occurrence
          return a.firstOccurrence - b.firstOccurrence;
        });
      }

      // Apply hybrid mapping: merge with template themes if needed
      if (this.themeTemplates.mappingStrategy?.hybrid && template.commonThemes.length > 0) {
        themes = this.mergeWithTemplate(themes, template, documentType);
      }

      // NOTE: "Andre emner" is added by ThemeMapper as the sole catch-all theme
      // No need to add any fallback theme during extraction

      // Store document metadata for later use
      this.documentMetadata = {
        purpose: parsed.documentPurpose || '',
        type: parsed.documentType || documentType,
        outOfScope: parsed.outOfScope || { identified: false, examples: [] }
      };

      return themes.length > 0 ? themes : this.extractThemesFromHeaders(materials);
    } catch (error) {
      console.warn('[ThemeExtractor] LLM extraction failed, falling back to header extraction:', error.message);
      return this.extractThemesFromHeaders(materials);
    }
  }

  /**
   * Build prompt from template
   */
  buildPrompt(materialText, template, documentType) {
    if (this.promptTemplate) {
      // Build template context
      const templateContext = template.commonThemes.length > 0
        ? `\n\n**Tema-skabelon for ${documentType}:**\n${template.commonThemes.map(t => `- ${t.name}: ${t.description || t.keywords?.join(', ') || ''}`).join('\n')}`
        : '';

      return this.promptTemplate
        .replace('{materialText}', materialText)
        .replace('{templateContext}', templateContext);
    }

    // Fallback prompt
    return `Analysér følgende høringsmateriale og identificer de strukturelle temaer/sektioner som materialet er organiseret efter.

Høringsmateriale:
${materialText}

Identificér temaerne baseret på dokumentets struktur og formål.`;
  }

  /**
   * Identify document type from materials
   */
  identifyDocumentType(materials) {
    const combinedText = materials
      .map(m => (m.title || '') + ' ' + (m.contentMd || m.content || ''))
      .join(' ')
      .toLowerCase();

    // Check for document type indicators
    if (combinedText.includes('lokalplan') || combinedText.includes('lokal plan')) {
      return 'lokalplan';
    }
    if (combinedText.includes('bygningsreglement') || combinedText.includes('bygnings reglement')) {
      return 'bygningsreglement';
    }
    if (combinedText.includes('vedtægt') || combinedText.includes('vedtaegt')) {
      return 'vedtægt';
    }

    return 'default';
  }

  /**
   * Merge extracted themes with template themes (hybrid approach)
   */
  mergeWithTemplate(extractedThemes, template, documentType) {
    const merged = [...extractedThemes];
    const extractedNames = new Set(extractedThemes.map(t => t.name.toLowerCase()));

    // Add template themes that aren't already extracted
    template.commonThemes.forEach(templateTheme => {
      const templateNameLower = templateTheme.name.toLowerCase();
      if (!extractedNames.has(templateNameLower)) {
        // Check if similar theme exists (fuzzy match)
        const similar = extractedThemes.find(et =>
          et.name.toLowerCase().includes(templateNameLower) ||
          templateNameLower.includes(et.name.toLowerCase())
        );

        if (!similar) {
          merged.push({
            name: templateTheme.name,
            level: 0,
            category: templateTheme.category || 'regulation',
            description: templateTheme.description || '',
            sectionReference: templateTheme.typicalSections?.[0] || null,
            fromTemplate: true
          });
        }
      }
    });

    return merged;
  }

  /**
   * Fallback: Extract themes from markdown headers
   */
  extractThemesFromHeaders(materials) {
    const themes = [];
    const seen = new Set();

    materials.forEach(material => {
      const content = material.contentMd || material.content || '';
      if (!content) return;

      // Extract headers and section titles
      // Look for patterns like "# Titel", "§ X. Titel", "Kapitel X", etc.
      const patterns = [
        /^#{1,6}\s+(.+)$/gm,  // Markdown headers
        /^§\s*\d+\.?\s+(.+)$/gm,  // § 1. Titel
        /^(?:Kapitel|KAPITEL)\s+\d+[\.:]?\s+(.+)$/gm,  // Kapitel 1: Titel
        /^([A-ZÆØÅ][A-ZÆØÅa-zæøå\s\-]+)$/gm  // All caps titles (fallback)
      ];

      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const title = match[1]?.trim();
          if (title && title.length > 3 && title.length < 100) {
            // Clean title
            const cleanTitle = title
              .replace(/^§\s*\d+\.?\s*/, '')
              .replace(/^(?:Kapitel|KAPITEL)\s+\d+[\.:]?\s*/, '')
              .trim();

            if (cleanTitle && !seen.has(cleanTitle.toLowerCase())) {
              seen.add(cleanTitle.toLowerCase());
              themes.push({
                name: cleanTitle,
                level: 0,
                category: 'regulation',
                description: ''
              });
            }
          }
        }
      });
    });

    // If no themes found, return default
    if (themes.length === 0) {
      return [{ name: 'Andre emner', level: 0, category: 'out-of-scope', description: 'Emner uden specifik tematisk tilknytning' }];
    }

    // NOTE: "Andre emner" is added by ThemeMapper as the sole catch-all
    return themes;
  }

  /**
   * Get document metadata (purpose, type, out-of-scope info)
   */
  getDocumentMetadata() {
    return this.documentMetadata || null;
  }

  /**
   * Clean theme name by removing document-specific prefixes
   * Examples:
   * - "§ 8. Ubebyggede arealer" -> "Ubebyggede arealer"
   * - "Kapitel 1 Formål" -> "Formål"
   * - "2.1.3 Veje under banen" -> "Veje under banen"
   * @param {string} name - Raw theme name from LLM
   * @returns {string} Cleaned theme name
   */
  cleanThemeName(name) {
    if (!name || typeof name !== 'string') {
      return name;
    }

    let cleaned = name.trim();

    // Remove § X. prefix (e.g. "§ 8. Ubebyggede arealer" -> "Ubebyggede arealer")
    cleaned = cleaned.replace(/^§\s*\d+\.?\s*/i, '');

    // Remove "Kapitel X" or "KAPITEL X" prefix (e.g. "Kapitel 1 Formål" -> "Formål")
    cleaned = cleaned.replace(/^(?:kapitel|KAPITEL)\s+\d+[\.:\s]*/i, '');

    // Remove numbered section prefix (e.g. "2.1.3 Veje under banen" -> "Veje under banen")
    // Matches patterns like "1.", "1.2", "1.2.3", "1.2.3.4" at the start
    cleaned = cleaned.replace(/^\d+(?:\.\d+)*\.?\s+/i, '');

    // Remove "Stk. X" prefix (e.g. "Stk. 2 Bebyggelse" -> "Bebyggelse")
    cleaned = cleaned.replace(/^stk\.?\s*\d+\.?\s*/i, '');

    // Remove "Bilag X" prefix (e.g. "Bilag 1 Kortbilag" -> "Kortbilag")
    cleaned = cleaned.replace(/^bilag\s*\d*\.?\s*/i, '');

    // Trim again after replacements
    cleaned = cleaned.trim();

    // Capitalize first letter if now lowercase after prefix removal
    if (cleaned.length > 0 && cleaned[0] === cleaned[0].toLowerCase()) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    // Log if we made changes
    if (cleaned !== name.trim()) {
      console.log(`[ThemeExtractor] Cleaned theme name: "${name}" -> "${cleaned}"`);
    }

    return cleaned || name; // Return original if cleaning resulted in empty string
  }

  /**
   * Calculate regulatory weight for a theme based on material context
   * Higher weight = appears in regulatory/normative sections
   * Lower weight = appears only in explanatory sections
   */
  calculateRegulatoryWeight(theme, materials, themeIndex) {
    let weight = 50; // Base weight

    // Analyze theme name and section reference for regulatory indicators
    const themeName = (theme.name || '').toLowerCase();
    const sectionRef = (theme.sectionReference || '').toLowerCase();

    // Indicators of regulatory content (highest weight)
    const regulatoryIndicators = [
      'anvendelse',
      'bebyggelse',
      'formål',
      'udstykninger',
      'vej',
      'parkering',
      'miljø',
      'arkitektur',
      'støj',
      'friarealer',
      'zone',
      'højde',
      'etager',
      'facader',
      'materiale'
    ];

    // Check if theme name contains regulatory indicators
    const hasRegulatoryIndicator = regulatoryIndicators.some(indicator =>
      themeName.includes(indicator) || sectionRef.includes(indicator)
    );

    if (hasRegulatoryIndicator) {
      weight += 30; // Strong regulatory indicator
    }

    // Check material titles for regulatory context
    materials.forEach(material => {
      const title = (material.title || '').toLowerCase();
      const content = (material.contentMd || material.content || '').toLowerCase();

      // Identify regulatory materials (localplan, plan sections, regulations)
      if (title.includes('lokalplan') || title.includes('plan ')) {
        const themeSearchPattern = themeName.slice(0, 30); // First 30 chars
        const themeInContent = content.includes(themeSearchPattern);

        if (themeInContent) {
          // Find position in content (earlier = more important)
          const position = content.indexOf(themeSearchPattern);
          const relativePosition = position / Math.max(content.length, 1);

          // Earlier occurrence in regulatory material = higher weight
          if (relativePosition < 0.3) {
            weight += 20; // Early in document
          } else if (relativePosition < 0.6) {
            weight += 10; // Middle of document
          } else {
            weight += 5; // Late in document
          }
        }
      }
      // Identify explanatory materials (redegørelse, background)
      else if (title.includes('redegørelse') || title.includes('baggrund')) {
        const themeSearchPattern = themeName.slice(0, 30);
        const themeInContent = content.includes(themeSearchPattern);

        if (themeInContent) {
          weight -= 10; // Found primarily in explanatory material
        }
      }
    });

    // Section reference indicators (§ numbers = regulatory)
    if (sectionRef && /§\s*\d+/.test(sectionRef)) {
      weight += 15; // Has explicit section reference
    }

    // Category-based adjustment
    if (theme.category === 'regulation') {
      weight += 10;
    } else if (theme.category === 'general') {
      weight -= 20; // General themes go last
    }

    // Ensure weight is within reasonable bounds
    return Math.max(0, Math.min(100, weight));
  }
}

