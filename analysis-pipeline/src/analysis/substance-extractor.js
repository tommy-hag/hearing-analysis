/**
 * Substance Extractor
 * 
 * Dynamically extracts the "substance" from hearing materials based on document type.
 * Substance = what the document regulates/changes/proposes - the core content that
 * responses should be matched against.
 * 
 * For lokalplan: § bestemmelser
 * For dispensation: What's being dispensed from/to
 * For politik: Goals, proposals, priorities
 * For unknown types: Generically finds regulatory/proposal content
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { smartChunk, mergeChunkResults as mergeChunks } from '../utils/document-chunker.js';
import { PDFConverter } from '../utils/pdf-converter.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class SubstanceExtractor {
  constructor(options = {}) {
    // MEDIUM tier for high-relevance chunks (important content)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    
    // LIGHT tier for medium/low-relevance chunks (cost optimization)
    const lightConfig = getComplexityConfig('light');
    this.lightClient = new OpenAIClientWrapper({
      model: lightConfig.model,
      verbosity: lightConfig.verbosity,
      reasoningEffort: lightConfig.reasoningEffort
    });
    
    // Log actual models being used
    console.log(`[SubstanceExtractor] Initialized with MEDIUM=${this.client.model}, LIGHT=${this.lightClient.model}`);

    // PDF converter for materials without markdown
    this.pdfConverter = new PDFConverter(options.pdfConverter || {});

    // Load theme templates for document type awareness
    this.templatesPath = join(__dirname, '../../config/theme-templates.json');
    this.promptPath = join(__dirname, '../../prompts/substance-extraction-prompt.md');
    this.loadTemplates();
    this.loadPromptTemplate();
  }

  /**
   * Load prompt template from file
   */
  loadPromptTemplate() {
    try {
      this.promptTemplate = readFileSync(this.promptPath, 'utf-8');
    } catch (error) {
      console.warn('[SubstanceExtractor] Could not load prompt template, using inline fallback');
      this.promptTemplate = null;
    }
  }

  /**
   * Load theme templates from config
   */
  loadTemplates() {
    try {
      this.templates = JSON.parse(readFileSync(this.templatesPath, 'utf-8'));
    } catch (error) {
      console.warn('[SubstanceExtractor] Could not load theme templates, using defaults');
      this.templates = { documentTypes: {}, learnedPatterns: [] };
    }
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
    if (this.lightClient) this.lightClient.setJobId(jobId);
  }

  /**
   * Extract substance from materials based on document type
   * Uses chunking for large documents to avoid API timeouts
   * @param {Array} materials - Hearing materials
   * @param {string} documentType - Identified document type (lokalplan, dispensation, etc.)
   * @returns {Promise<Object>} Structured substance with items and metadata
   */
  async extractSubstance(materials, documentType) {
    console.log(`[SubstanceExtractor] Starting extraction for documentType: ${documentType}`);

    if (!materials || materials.length === 0) {
      console.log('[SubstanceExtractor] No materials provided');
      return { items: [], documentType: 'unknown', confidence: 0 };
    }

    // Get template for document type (or default)
    const template = this.templates.documentTypes?.[documentType] || 
                     this.templates.documentTypes?.default ||
                     this.getGenericTemplate();
    
    console.log(`[SubstanceExtractor] Using template: ${template.name || 'generic'}`);

    // Convert PDFs to markdown if needed (gets proper headers from PDF structure)
    const convertedMaterials = await this.pdfConverter.convertMaterials(materials);

    // Combine material content - using converted markdown with proper headers
    const fullText = convertedMaterials
      .map(m => {
        const title = m.title || 'Materiale';
        const content = m.contentMd || m.content || '';
        // Only add title header if content doesn't already start with a header
        const hasExistingHeader = content.trim().startsWith('#');
        return hasExistingHeader ? content : `## ${title}\n\n${content}`;
      })
      .join('\n\n');
    
    console.log(`[SubstanceExtractor] Full document: ${fullText.length} chars (converted from PDF: ${convertedMaterials.some(m => m.filePath) ? 'yes' : 'no'})`);

    // Use smart chunking from shared utility
    const CHUNK_THRESHOLD = 30000; // 30KB - documents larger than this will be chunked
    
    if (fullText.length <= CHUNK_THRESHOLD) {
      // Small document - process directly
      console.log(`[SubstanceExtractor] Small document - processing directly`);
      return this.extractFromText(fullText, documentType, template);
    }

    // Large document - use smart header-aware chunking with relevance scoring
    // Smaller chunks (8KB) for faster LLM responses and to avoid timeouts
    const chunks = smartChunk(fullText, {
      maxChunkSize: 8000,    // Reduced from 15KB to 8KB for faster processing
      minChunkSize: 2000,    // Reduced minimum
      overlapSize: 300,      // Reduced overlap
      preferHeaderBreaks: true,
      enableRelevanceScoring: true,
      documentType: documentType  // Pass document type for relevance patterns
    });
    
    console.log(`[SubstanceExtractor] Large document - smart chunking into ${chunks.length} parts`);

    chunks.forEach((chunk, idx) => {
      const headers = chunk.metadata.headers?.slice(0, 3).join(', ') || 'ingen headers';
      const rel = chunk.metadata.relevance;
      const relInfo = rel ? ` [relevance: ${rel.category} (${rel.score.toFixed(2)})]` : '';
      console.log(`[SubstanceExtractor]   Chunk ${idx + 1}: ${chunk.text.length} chars, headers: [${headers}]${relInfo}`);
    });

    try {
      // Process chunks in PARALLEL with retry logic
      // Smaller chunks (8KB) allow faster responses and reduce timeout risk
      const startTime = Date.now();
      const MAX_RETRIES = 2;
      
      // Create extraction promises with retry logic
      const extractionPromises = chunks.map(async (chunk, idx) => {
        let lastError = null;
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await this.extractFromChunk(
              chunk.text,
              idx + 1,
              chunks.length,
              documentType,
              template,
              chunk.metadata.relevance,
              chunk.metadata.parentContexts || [],  // Pass parent context for hierarchy
              chunk.metadata.headers || []
            );
            
            if (result.items?.length > 0) {
              console.log(`[SubstanceExtractor] ✅ Chunk ${idx + 1}/${chunks.length} done: ${result.items.length} items`);
            }
            return result;
          } catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES) {
              console.log(`[SubstanceExtractor] ⚠️ Chunk ${idx + 1} attempt ${attempt} failed, retrying... (${error.message})`);
              await new Promise(r => setTimeout(r, 1000)); // Brief pause before retry
            }
          }
        }
        
        console.warn(`[SubstanceExtractor] ❌ Chunk ${idx + 1} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
        return { items: [], confidence: 0, chunkRelevance: chunk.metadata.relevance || { score: 0.5, category: 'unknown' } };
      });
      
      // Wait for all chunks to complete (parallel)
      console.log(`[SubstanceExtractor] 🚀 Processing ${chunks.length} chunks in parallel...`);
      const chunkResults = await Promise.all(extractionPromises);

      // Merge results using shared utility with relevance weighting
      // Deduplicate by ID to prevent same § appearing multiple times with different titles
      const merged = mergeChunks(chunkResults, {
        itemsKey: 'items',
        deduplicateBy: ['id'],  // Use standardized ID (LP-§X) for deduplication
        applyRelevanceWeighting: true  // Weight items by chunk relevance
      });
      
      // Enhance with document type info
      const mergedResult = {
        ...merged,
        documentType: documentType,
        templateUsed: template.name || 'default',
        authorities: template.legalBasis?.authorities || [],
        limitations: template.legalBasis?.limitations || []
      };
      
      console.log(`[SubstanceExtractor] ✅ All ${chunks.length} chunks processed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      console.log(`[SubstanceExtractor] Merged result: ${mergedResult.items.length} items (deduped from ${merged.totalItemsBeforeDedup})`);
      if (merged.relevanceDistribution) {
        console.log(`[SubstanceExtractor] Relevance: ${merged.relevanceDistribution.high} high, ${merged.relevanceDistribution.medium} medium, ${merged.relevanceDistribution.low} low`);
      }

      return mergedResult;

    } catch (error) {
      console.error('[SubstanceExtractor] Chunked extraction failed:', error.message);
      return this.fallbackExtraction(fullText, documentType);
    }
  }

  /**
   * Extract substance from a single chunk
   * Uses tiered model selection based on chunk relevance for cost optimization
   * @param {Array} parentContexts - Parent headers for hierarchy (e.g., ["§ 5. Bil- og cykelparkering"])
   * @param {Array} chunkHeaders - Headers within this chunk
   */
  async extractFromChunk(chunkText, chunkNum, totalChunks, documentType, template, chunkRelevance = null, parentContexts = [], chunkHeaders = []) {
    const relInfo = chunkRelevance ? ` [${chunkRelevance.category}]` : '';

    // OPTIMIZATION: Use LIGHT model for medium/low relevance chunks
    // High relevance chunks get MEDIUM model for better extraction quality
    const useLight = chunkRelevance && (chunkRelevance.category === 'medium' || chunkRelevance.category === 'low');
    const modelInfo = useLight ? 'LIGHT' : 'MEDIUM';

    // Log parent context for debugging
    if (parentContexts.length > 0) {
      console.log(`[SubstanceExtractor] Processing chunk ${chunkNum}/${totalChunks}${relInfo} (${chunkText.length} chars) → ${modelInfo}, parents: [${parentContexts.join(', ')}]`);
    } else {
      console.log(`[SubstanceExtractor] Processing chunk ${chunkNum}/${totalChunks}${relInfo} (${chunkText.length} chars) → ${modelInfo}`);
    }

    try {
      const result = await this.extractFromText(chunkText, documentType, template, chunkNum, totalChunks, useLight, parentContexts, chunkHeaders);
      // Attach chunk relevance for merge weighting
      return {
        ...result,
        chunkRelevance: chunkRelevance || { score: 1.0, category: 'unknown' }
      };
    } catch (error) {
      console.warn(`[SubstanceExtractor] Chunk ${chunkNum} failed: ${error.message}`);
      return { items: [], confidence: 0, chunkRelevance: chunkRelevance || { score: 0.5, category: 'unknown' } };
    }
  }

  /**
   * Extract substance from text (used for both small docs and chunks)
   * @param {boolean} useLight - Use light model for cost optimization (default: false)
   * @param {Array} parentContexts - Parent headers for hierarchy (e.g., ["§ 5. Bil- og cykelparkering"])
   * @param {Array} chunkHeaders - Headers within this chunk
   */
  async extractFromText(text, documentType, template, chunkNum = null, totalChunks = null, useLight = false, parentContexts = [], chunkHeaders = []) {
    const chunkInfo = chunkNum ? ` (del ${chunkNum}/${totalChunks})` : '';
    const prompt = this.buildExtractionPrompt(text, documentType, template, chunkNum, totalChunks, parentContexts, chunkHeaders);
    
    // Select client based on useLight flag
    const client = useLight ? this.lightClient : this.client;
    
    console.log(`[SubstanceExtractor] 🚀 Calling LLM${chunkInfo}... (prompt: ${prompt.length} chars)`);
    const startTime = Date.now();
    
    const response = await client.createCompletion({
      messages: [
        {
          role: 'system',
          content: 'Du er specialist i at identificere substansen i høringsmaterialer - det der faktisk reguleres, ændres eller foreslås.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' }
    });

    console.log(`[SubstanceExtractor] ✅ LLM responded${chunkInfo} in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    
    let content = response.choices[0]?.message?.content;
    if (!content) throw new Error('No content in response');

    // Clean markdown wrappers - LLM sometimes returns ```json even with json_object format
    content = content.trim();
    if (content.startsWith('```json')) {
      content = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    } else if (content.startsWith('```')) {
      content = content.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    }
    content = content.trim();

    const result = JSON.parse(content);

    return this.enhanceResult(result, documentType, template);
  }

  /**
   * Build extraction prompt based on document type
   * @param {Array} parentContexts - Parent headers for hierarchy context
   * @param {Array} chunkHeaders - Headers within this chunk
   */
  buildExtractionPrompt(materialText, documentType, template, chunkNum = null, totalChunks = null, parentContexts = [], chunkHeaders = []) {
    const typeInstructions = this.getTypeSpecificInstructions(documentType, template);
    const learnedPatterns = this.getLearnedPatternsForType(documentType);
    const learnedPatternsText = learnedPatterns
      ? `## Lærte mønstre fra tidligere\n${learnedPatterns}`
      : '';

    // Add chunk context if processing in chunks
    let chunkContext = chunkNum
      ? `\n\n## BEMÆRK: Dette er del ${chunkNum} af ${totalChunks} af dokumentet. Ekstraher kun substans fra DENNE del.\n`
      : '';

    // Add parent context for hierarchy awareness (CRITICAL for Stk. numbering)
    if (parentContexts.length > 0) {
      chunkContext += `
## HIERARKISK KONTEKST (VIGTIGT!)
Denne del af dokumentet har følgende overordnede struktur:
${parentContexts.map(pc => `- Parent: "${pc}"`).join('\n')}

**ID-NAVNGIVNING:** Når du finder "Stk. X" bestemmelser, SKAL ID'et inkludere parent-§ nummeret.
Eksempel: Hvis parent er "§ 5. Bil- og cykelparkering" og du finder "Stk. 1. Bilparkering",
skal ID være "LP-§5-stk1" (IKKE bare "LP-stk1").

`;
    }

    // Use template if available
    if (this.promptTemplate) {
      return this.promptTemplate
        .replace('{documentType}', template.name || documentType || 'Ukendt')
        .replace('{documentDescription}', (template.description || '') + chunkContext)
        .replace('{typeInstructions}', typeInstructions)
        .replace('{learnedPatterns}', learnedPatternsText)
        .replace('{materialText}', materialText);
    }

    // Fallback inline prompt
    return `# Substans-ekstraktion fra høringsmateriale

## Dokumenttype: ${template.name || documentType || 'Ukendt'}
${template.description || ''}
${chunkContext}
## Din opgave
Find SUBSTANSEN i materialet - det der faktisk reguleres, ændres eller foreslås.
Dette er det høringssvarene skal matches mod.

${typeInstructions}

${learnedPatternsText}

## Materiale
${materialText}

## Output format
Returnér JSON:
{
  "items": [
    {
      "id": "unik_id",
      "reference": "§ 6" eller "Afsnit 3.2" eller "Mål 1",
      "title": "Kort titel",
      "content": "Konkret indhold/bestemmelse/forslag",
      "keywords": ["nøgleord", "for", "matching"],
      "category": "regulation|proposal|goal|condition|other"
    }
  ],
  "documentType": "${documentType}",
  "confidence": 0.0-1.0,
  "suggestedNewPatterns": [] // Hvis du opdager mønstre der ikke er dækket
}

## Regler
1. Fokusér på KONKRET indhold, ikke generelle beskrivelser
2. Inkludér de faktiske værdier (højder, procenter, grænser)
3. Hver item skal kunne stå alene som reference for høringssvar
4. Hvis dokumenttypen er ukendt, find det der ligner regulering/forslag
`;
  }

  /**
   * Get type-specific extraction instructions
   */
  getTypeSpecificInstructions(documentType, template) {
    const instructions = {
      lokalplan: `
### For lokalplaner:
- Find alle § bestemmelser (§ 1, § 2, ... § 13 osv.)
- Ekstraher det KONKRETE indhold af hver paragraf
- Inkludér tal: højder (m), procenter, antal, grænser
- Eksempel: "§ 6 Bebyggelsens omfang: Maks 22m højde i delområde I, 12m i delområde II. Bebyggelsesprocent maks 150."
`,
      dispensation: `
### For dispensationer:
- Find hvad der dispenseres FRA (den oprindelige regel)
- Find hvad der dispenseres TIL (den nye tilladelse)
- Identificér betingelser og vilkår
- Eksempel: "Dispensation fra § 6.2 om maks højde 8m. Tillades 10,5m mod at facade tilbagerykkes 2m."
`,
      partshoring: `
### For partshøringer:
- Find de faktiske forhold i sagen
- Identificér hvad der skal træffes afgørelse om
- Find relevante oplysninger og dokumentation
`,
      politik: `
### For politikker/strategier:
- Find konkrete mål og ambitioner
- Identificér foreslåede tiltag og prioriteringer
- Find målbare indikatorer hvis de findes
`,
      default: `
### For ukendt dokumenttype:
- Find alt der ligner regulering, bestemmelser eller forslag
- Se efter strukturerede afsnit med nummerering
- Identificér konkrete krav, grænser eller mål
- Hvis du finder et mønster, beskriv det i suggestedNewPatterns
`
    };

    return instructions[documentType] || instructions.default;
  }

  /**
   * Get learned patterns for a document type
   */
  getLearnedPatternsForType(documentType) {
    const learned = this.templates.learnedPatterns?.filter(p => 
      p.documentType === documentType || p.documentType === 'all'
    ) || [];

    if (learned.length === 0) return null;

    return learned.map(p => `- ${p.pattern}: ${p.description}`).join('\n');
  }

  /**
   * Enhance extraction result with template info
   */
  enhanceResult(result, documentType, template) {
    return {
      ...result,
      documentType: documentType,
      templateUsed: template.name || 'default',
      authorities: template.legalBasis?.authorities || [],
      limitations: template.legalBasis?.limitations || [],
      items: (result.items || []).map((item, idx) => ({
        ...item,
        id: item.id || `item_${idx + 1}`,
        category: item.category || 'regulation'
      }))
    };
  }

  /**
   * Extract the relevant section from material based on document type
   * 
   * STRATEGY:
   * - If material ≤ THRESHOLD: Use entire material (nothing to gain by cutting)
   * - If material > THRESHOLD: Smart extraction based on document type
   * 
   * This ensures small documents are processed completely while large documents
   * are trimmed to the most relevant "substance" sections.
   */
  extractRelevantSection(fullText, documentType) {
    // TESTING: Very high threshold to test without smart extraction
    const SMALL_DOCUMENT_THRESHOLD = 150000; // chars - TEST: set very high to skip smart extraction
    const MAX_EXTRACTED_LENGTH = 150000;     // chars - max output after extraction

    // Small documents (or test mode): use everything
    if (fullText.length <= SMALL_DOCUMENT_THRESHOLD) {
      console.log(`[SubstanceExtractor] Document (${fullText.length} chars) - using entire content (threshold: ${SMALL_DOCUMENT_THRESHOLD})`);
      return fullText;
    }

    console.log(`[SubstanceExtractor] Large document (${fullText.length} chars) - extracting substance for type: ${documentType}`);

    // Large documents: extract based on document type
    const extracted = this.extractByDocumentType(fullText, documentType, MAX_EXTRACTED_LENGTH);
    
    console.log(`[SubstanceExtractor] Extracted ${extracted.length} chars (${Math.round(extracted.length / fullText.length * 100)}% of original)`);
    return extracted;
  }

  /**
   * Document type-specific extraction strategies
   */
  extractByDocumentType(fullText, documentType, maxLength) {
    switch (documentType) {
      case 'lokalplan':
        return this.extractLokalplanSubstance(fullText, maxLength);
      
      case 'dispensation':
        return this.extractDispensationSubstance(fullText, maxLength);
      
      case 'partshoring':
        return this.extractPartshoringSubstance(fullText, maxLength);
      
      case 'politik':
        return this.extractPolitikSubstance(fullText, maxLength);
      
      default:
        return this.extractGenericSubstance(fullText, maxLength);
    }
  }

  /**
   * Identify and extract BESTEMMELSER section from lokalplan document.
   * Lokalplan structure: Forside -> Redegørelse -> BESTEMMELSER (§§) -> Tegninger
   *
   * CRITICAL: We must extract from BESTEMMELSER (the legally binding provisions),
   * NOT from REDEGØRELSE (the explanatory/descriptive section).
   *
   * @param {string} fullText - Full document text
   * @returns {Object} { found: boolean, text: string, paragraphCount: number }
   */
  identifyLokalplanBestemmelser(fullText) {
    // Strategy 1: Look for explicit section header (most reliable)
    const headerPatterns = [
      /(?:^|\n)(#+\s*(?:LOKALPLANENS\s+)?BESTEMMELSER\s*\n)/im,
      /(?:^|\n)((?:LOKALPLANENS\s+)?BESTEMMELSER\s*\n)/im,
      /(?:^|\n)(\*\*(?:LOKALPLANENS\s+)?BESTEMMELSER\*\*)/im,
      // Match "Bestemmelser" followed by page number pattern (common in PDFs)
      /(?:^|\n)(Bestemmelser\s*\n\s*\d+\s*\n)/im,
    ];

    let startPos = -1;
    let headerMatch = null;

    for (const pattern of headerPatterns) {
      const match = fullText.match(pattern);
      if (match) {
        startPos = match.index;
        headerMatch = match[1];
        console.log(`[SubstanceExtractor] Found BESTEMMELSER header: "${headerMatch.trim().slice(0, 50)}..."`);
        break;
      }
    }

    // Strategy 2: Find first "§ 1" with "Formål" (standard lokalplan structure)
    if (startPos === -1) {
      const firstParagraphPatterns = [
        /(?:^|\n)(§\s*1\.?\s*\n?\s*Formål)/im,
        /(?:^|\n)(§\s*1\.?\s*\n?\s*Lokalplanens formål)/im,
        /(?:^|\n)(§\s*1\s*\n\s*Formål)/im,
      ];

      for (const pattern of firstParagraphPatterns) {
        const match = fullText.match(pattern);
        if (match) {
          startPos = match.index;
          console.log(`[SubstanceExtractor] Found BESTEMMELSER via § 1 Formål at position ${startPos}`);
          break;
        }
      }
    }

    if (startPos === -1) {
      console.log('[SubstanceExtractor] Could not identify BESTEMMELSER section start');
      return { found: false, text: '', paragraphCount: 0 };
    }

    // Find end position - look for typical end markers
    const endPatterns = [
      /(?:^|\n)#+\s*Tegning/im,
      /(?:^|\n)Tegning\s+\d/im,
      /(?:^|\n)Tegning\s*1/im,
      /(?:^|\n)#+\s*Bilag/im,
      /(?:^|\n)Hvad er en lokalplan/im,
      /(?:^|\n)Praktiske oplysninger/im,
      /(?:^|\n)Kommentarer af generel karakter/im,
    ];

    let endPos = fullText.length;
    const textFromStart = fullText.slice(startPos);

    for (const pattern of endPatterns) {
      const match = textFromStart.match(pattern);
      if (match) {
        const candidateEnd = startPos + match.index;
        if (candidateEnd > startPos + 500) { // Ensure we have at least 500 chars
          endPos = Math.min(endPos, candidateEnd);
        }
      }
    }

    const bestemmelserText = fullText.slice(startPos, endPos).trim();

    // Validate: Should contain sequential § references (§ 1, § 2, etc.)
    const paragraphMatches = bestemmelserText.match(/§\s*\d+/g) || [];
    const paragraphCount = paragraphMatches.length;

    // Check for sequential structure (should have § 1, § 2, § 3, etc.)
    const paragraphNumbers = paragraphMatches
      .map(m => parseInt(m.match(/\d+/)[0]))
      .filter((v, i, a) => a.indexOf(v) === i) // unique
      .sort((a, b) => a - b);

    const hasSequentialParagraphs = paragraphNumbers.length >= 3 &&
      paragraphNumbers.includes(1) &&
      paragraphNumbers.includes(2);

    if (!hasSequentialParagraphs) {
      console.log(`[SubstanceExtractor] Warning: Found section has non-sequential § structure: [${paragraphNumbers.join(', ')}]`);
      // Still return it, but with lower confidence
    }

    console.log(`[SubstanceExtractor] BESTEMMELSER section: ${bestemmelserText.length} chars, ${paragraphCount} § refs, paragraphs: [${paragraphNumbers.slice(0, 5).join(', ')}${paragraphNumbers.length > 5 ? '...' : ''}]`);

    return {
      found: true,
      text: bestemmelserText,
      paragraphCount,
      paragraphNumbers
    };
  }

  /**
   * LOKALPLAN: Extract substance from BESTEMMELSER section (§ 1-13)
   * Structure: Redegørelse → Bestemmelser (§ 1-13) → Tegninger
   *
   * IMPORTANT: Must focus on BESTEMMELSER (legally binding), not REDEGØRELSE (descriptive)
   */
  extractLokalplanSubstance(fullText, maxLength) {
    // Use improved section identification
    const bestemmelser = this.identifyLokalplanBestemmelser(fullText);

    if (bestemmelser.found && bestemmelser.text.length > 500) {
      console.log(`[SubstanceExtractor] ✓ Using BESTEMMELSER section (${bestemmelser.paragraphCount} §§)`);
      return bestemmelser.text.slice(0, maxLength);
    }

    // Fallback Strategy: Collect all § sections directly
    console.log('[SubstanceExtractor] Fallback: Collecting individual § sections');
    const sectionMatches = fullText.match(/§\s*\d+\.?\s*[^\n]*[\s\S]*?(?=§\s*\d+|Tegning|Bilag|$)/g);
    if (sectionMatches && sectionMatches.length >= 3) {
      console.log(`[SubstanceExtractor] ✓ Found ${sectionMatches.length} § sections via fallback`);
      return sectionMatches.join('\n\n').slice(0, maxLength);
    }

    // Last resort: Generic extraction
    console.log('[SubstanceExtractor] ⚠ No BESTEMMELSER found, using generic extraction');
    return this.extractGenericSubstance(fullText, maxLength);
  }

  /**
   * DISPENSATION: Find what's being dispensed from/to
   */
  extractDispensationSubstance(fullText, maxLength) {
    const sections = [];
    
    // Find dispensation mentions with context
    const dispMatches = fullText.match(/(?:.{0,200})(?:dispensation|dispenseres|fravigelse|fraviges)(?:.{0,500})/gi);
    if (dispMatches) {
      sections.push(...dispMatches);
      console.log(`[SubstanceExtractor] ✓ Found ${dispMatches.length} dispensation mentions`);
    }

    // Find "vilkår" or "betingelser"
    const conditionMatches = fullText.match(/(?:.{0,100})(?:vilkår|betingelse|forudsætning)(?:.{0,300})/gi);
    if (conditionMatches) {
      sections.push(...conditionMatches.slice(0, 5));
    }

    if (sections.length > 0) {
      return [...new Set(sections)].join('\n\n---\n\n').slice(0, maxLength);
    }

    return this.extractGenericSubstance(fullText, maxLength);
  }

  /**
   * PARTSHØRING: Find case facts and decision points
   */
  extractPartshoringSubstance(fullText, maxLength) {
    const sections = [];

    // Find "sagens faktiske forhold" or similar
    const factsMatch = fullText.match(/(?:faktiske forhold|sagsfremstilling|baggrund)[\s\S]{0,3000}/gi);
    if (factsMatch) {
      sections.push(...factsMatch);
    }

    // Find "afgørelse" or "beslutning"
    const decisionMatch = fullText.match(/(?:afgørelse|beslutning|indstilling)[\s\S]{0,2000}/gi);
    if (decisionMatch) {
      sections.push(...decisionMatch);
    }

    if (sections.length > 0) {
      console.log(`[SubstanceExtractor] ✓ Found ${sections.length} partshøring sections`);
      return sections.join('\n\n---\n\n').slice(0, maxLength);
    }

    return this.extractGenericSubstance(fullText, maxLength);
  }

  /**
   * POLITIK: Find goals, proposals, priorities
   */
  extractPolitikSubstance(fullText, maxLength) {
    const sections = [];

    // Find "mål", "vision", "strategi"
    const goalMatches = fullText.match(/(?:^|\n)(?:#{1,3}\s*)?(?:mål|vision|strategi|prioritet|indsats)[\s\S]{0,2000}/gi);
    if (goalMatches) {
      sections.push(...goalMatches);
    }

    // Find numbered points (1., 2., etc.)
    const numberedMatches = fullText.match(/\n\d+\.\s+[^\n]+(?:\n(?!\d+\.)[^\n]+)*/g);
    if (numberedMatches) {
      sections.push(...numberedMatches.slice(0, 15));
    }

    if (sections.length > 0) {
      console.log(`[SubstanceExtractor] ✓ Found ${sections.length} politik sections`);
      return sections.join('\n\n').slice(0, maxLength);
    }

    return this.extractGenericSubstance(fullText, maxLength);
  }

  /**
   * GENERIC: For unknown document types - find structured content
   */
  extractGenericSubstance(fullText, maxLength) {
    console.log('[SubstanceExtractor] Using generic extraction strategy');
    
    const sections = [];
    
    // Take introduction (first 3000 chars usually has context)
    sections.push(fullText.slice(0, 3000));

    // Find any § sections
    const paragraphMatches = fullText.match(/§\s*\d+[\s\S]*?(?=§\s*\d+|$)/g);
    if (paragraphMatches) {
      sections.push(...paragraphMatches.slice(0, 10));
    }

    // Find numbered sections
    const numberedMatches = fullText.match(/\n\d+\.\s+[^\n]+(?:\n(?!\d+\.)[^\n]+)*/g);
    if (numberedMatches) {
      sections.push(...numberedMatches.slice(0, 10));
    }

    // Find headers with content
    const headerMatches = fullText.match(/(?:^|\n)#{1,3}\s+[^\n]+[\s\S]{0,1000}/gm);
    if (headerMatches) {
      sections.push(...headerMatches.slice(0, 5));
    }

    return [...new Set(sections)].join('\n\n').slice(0, maxLength);
  }

  /**
   * Learn from extraction - save new patterns if discovered
   */
  async learnFromExtraction(result, documentType, materialText) {
    if (!result.suggestedNewPatterns || result.suggestedNewPatterns.length === 0) {
      return;
    }

    console.log(`[SubstanceExtractor] Learning ${result.suggestedNewPatterns.length} new patterns for ${documentType}`);

    // Add to templates
    if (!this.templates.learnedPatterns) {
      this.templates.learnedPatterns = [];
    }

    const newPatterns = result.suggestedNewPatterns.map(p => ({
      documentType: documentType,
      pattern: p.pattern || p,
      description: p.description || 'Auto-learned pattern',
      learnedAt: new Date().toISOString(),
      confidence: result.confidence || 0.5
    }));

    // Avoid duplicates
    const existingPatterns = new Set(this.templates.learnedPatterns.map(p => p.pattern));
    const uniqueNewPatterns = newPatterns.filter(p => !existingPatterns.has(p.pattern));

    if (uniqueNewPatterns.length > 0) {
      this.templates.learnedPatterns.push(...uniqueNewPatterns);
      
      // Save updated templates
      try {
        writeFileSync(this.templatesPath, JSON.stringify(this.templates, null, 2), 'utf-8');
        console.log(`[SubstanceExtractor] Saved ${uniqueNewPatterns.length} new patterns to theme-templates.json`);
      } catch (error) {
        console.warn('[SubstanceExtractor] Could not save learned patterns:', error.message);
      }
    }
  }

  /**
   * Fallback extraction when LLM fails
   */
  fallbackExtraction(materialText, documentType) {
    console.log('[SubstanceExtractor] Using fallback regex extraction');

    const items = [];

    // Try to find § sections
    const sectionRegex = /§\s*(\d+)[.\s]*([^\n]+?)(?:\n|$)([\s\S]*?)(?=§\s*\d+|$)/g;
    let match;
    while ((match = sectionRegex.exec(materialText)) !== null) {
      const sectionNum = match[1];
      const title = match[2].trim();
      const content = match[3].trim().slice(0, 500);
      
      if (title && content) {
        items.push({
          id: `section_${sectionNum}`,
          reference: `§ ${sectionNum}`,
          title: title,
          content: content,
          keywords: this.extractKeywords(title + ' ' + content),
          category: 'regulation'
        });
      }
    }

    // If no sections found, try numbered items
    if (items.length === 0) {
      const numberedRegex = /(\d+)\.\s+([^\n]+)/g;
      let idx = 0;
      while ((match = numberedRegex.exec(materialText)) !== null && idx < 20) {
        items.push({
          id: `item_${match[1]}`,
          reference: `Punkt ${match[1]}`,
          title: match[2].trim(),
          content: match[2].trim(),
          keywords: this.extractKeywords(match[2]),
          category: 'other'
        });
        idx++;
      }
    }

    return {
      items,
      documentType,
      confidence: 0.3,
      fallbackUsed: true
    };
  }

  /**
   * Extract keywords from text
   */
  extractKeywords(text) {
    const stopwords = new Set(['og', 'i', 'at', 'er', 'det', 'en', 'af', 'til', 'på', 'for', 'med', 'som', 'den', 'de', 'et', 'om', 'kan', 'skal', 'må', 'ikke', 'eller', 'ved', 'fra']);
    
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopwords.has(word))
      .slice(0, 10);
  }

  /**
   * Get generic template for unknown document types
   */
  getGenericTemplate() {
    return {
      name: 'Ukendt dokumenttype',
      description: 'Generisk template for dokumenter der ikke matcher kendte typer',
      legalBasis: {
        authorities: [],
        limitations: []
      },
      commonThemes: []
    };
  }

  /**
   * Format substance for use in prompts
   * IMPORTANT: Must show IDs prominently for substanceRef anchoring
   * @param {Object} substance - Extracted substance
   * @returns {string} Formatted string for prompt inclusion
   */
  formatForPrompt(substance) {
    if (!substance || !substance.items || substance.items.length === 0) {
      return 'Ingen substans ekstraheret fra materialet.';
    }

    const header = `SUBSTANS (${substance.documentType || 'ukendt type'}):\n\n`;

    // Group items by § reference for better readability
    const groupedBySection = new Map();

    for (const item of substance.items) {
      const ref = item.reference || 'Andre emner';
      const sectionMatch = ref.match(/§\s*\d+/);
      const sectionKey = sectionMatch ? sectionMatch[0] : ref;

      if (!groupedBySection.has(sectionKey)) {
        groupedBySection.set(sectionKey, { fullRef: ref, items: [] });
      }
      groupedBySection.get(sectionKey).items.push(item);
    }

    // Format with PROMINENT IDs for LLM substanceRef anchoring
    const sections = [];
    for (const [sectionKey, group] of groupedBySection) {
      const sectionHeader = `**${sectionKey}** - ${group.fullRef}:`;
      const itemTexts = group.items.map(item => {
        const id = item.id || '';
        const title = item.title || '';
        const content = item.content || '';
        // CRITICAL: ID in brackets FIRST for easy LLM reference
        // Format: - **[LP-§5]** Titel: Indhold
        return `  - **[${id}]** ${title}: ${content}`.trim();
      });
      sections.push(`${sectionHeader}\n${itemTexts.join('\n')}`);
    }

    return header + sections.join('\n\n');
  }

  /**
   * Register a new document type pattern (for learning from UI/feedback)
   */
  registerNewDocumentType(typeName, typeConfig) {
    if (!this.templates.documentTypes) {
      this.templates.documentTypes = {};
    }

    this.templates.documentTypes[typeName] = {
      name: typeConfig.name || typeName,
      description: typeConfig.description || '',
      legalBasis: typeConfig.legalBasis || {},
      commonThemes: typeConfig.commonThemes || [],
      registeredAt: new Date().toISOString(),
      source: 'user-registered'
    };

    // Save
    try {
      writeFileSync(this.templatesPath, JSON.stringify(this.templates, null, 2), 'utf-8');
      console.log(`[SubstanceExtractor] Registered new document type: ${typeName}`);
    } catch (error) {
      console.warn('[SubstanceExtractor] Could not save new document type:', error.message);
    }
  }
}
