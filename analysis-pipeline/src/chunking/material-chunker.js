/**
 * Material Chunker
 * 
 * Section-aware chunking for hearing materials (PDF/DOCX converted to markdown).
 * Respects markdown structure, preserves context, and uses dynamic chunk sizes.
 */

export class MaterialChunker {
  constructor(options = {}) {
    this.minChunkSize = options.minChunkSize || 400;
    this.maxChunkSize = options.maxChunkSize || 1500;
    this.headerDepthWeight = options.headerDepthWeight !== false;
    this.includeParentContext = options.includeParentContext !== false;
    this.chunkOverlap = options.chunkOverlap || 100;
  }

  /**
   * Chunk material content with section awareness
   * @param {string} content - Material content (markdown)
   * @param {Object} metadata - Material metadata
   * @returns {Array} Array of section-aware chunks
   */
  chunk(content, metadata = {}) {
    if (!content || typeof content !== 'string') {
      return [];
    }

    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return [];
    }

    // Parse into sections
    const sections = this.parseMarkdownSections(trimmedContent);
    
    // Create chunks from sections
    const chunks = this.createChunksFromSections(sections, metadata);

    return chunks;
  }

  /**
   * Parse markdown content into hierarchical sections
   * @private
   */
  parseMarkdownSections(content) {
    const lines = content.split('\n');
    const sections = [];
    let currentSection = null;
    let headerStack = []; // Track parent headers for context

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headerMatch) {
        // Save current section if exists
        if (currentSection && currentSection.content.trim()) {
          sections.push(currentSection);
        }

        const depth = headerMatch[1].length;
        const title = headerMatch[2].trim();

        // Update header stack for context
        while (headerStack.length >= depth) {
          headerStack.pop();
        }
        headerStack.push({ depth, title });

        // Create new section
        currentSection = {
          depth: depth,
          title: title,
          headerLine: line,
          content: line + '\n',
          parentContext: this.includeParentContext 
            ? headerStack.slice(0, -1).map(h => h.title).join(' > ')
            : null,
          startLine: i
        };
      } else if (currentSection) {
        currentSection.content += line + '\n';
      } else {
        // Content before any header - create implicit section
        if (line.trim()) {
          currentSection = {
            depth: 0,
            title: 'Indledning',
            headerLine: null,
            content: line + '\n',
            parentContext: null,
            startLine: i
          };
        }
      }
    }

    // Don't forget the last section
    if (currentSection && currentSection.content.trim()) {
      sections.push(currentSection);
    }

    return sections;
  }

  /**
   * Create chunks from parsed sections
   * @private
   */
  createChunksFromSections(sections, metadata) {
    const chunks = [];
    let chunkIndex = 0;

    for (const section of sections) {
      const sectionChunks = this.chunkSection(section, metadata, chunkIndex);
      chunks.push(...sectionChunks);
      chunkIndex += sectionChunks.length;
    }

    return chunks;
  }

  /**
   * Chunk a single section (may produce multiple chunks if section is large)
   * @private
   */
  chunkSection(section, metadata, startIndex) {
    const chunks = [];
    const content = section.content;
    
    // Calculate dynamic chunk size based on header depth
    const targetChunkSize = this.calculateTargetSize(section.depth);

    // If section fits in one chunk, return it directly
    if (content.length <= targetChunkSize) {
      chunks.push(this.createChunk(
        content.trim(),
        startIndex,
        metadata,
        section
      ));
      return chunks;
    }

    // Section is too large - split at paragraph boundaries
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim());
    let currentChunk = '';
    let chunkIdx = startIndex;

    // Always start with the header if present
    const headerPrefix = section.headerLine ? section.headerLine + '\n\n' : '';

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      const potentialChunk = currentChunk 
        ? currentChunk + '\n\n' + trimmedPara
        : headerPrefix + trimmedPara;

      if (potentialChunk.length > targetChunkSize && currentChunk) {
        // Save current chunk
        chunks.push(this.createChunk(
          currentChunk.trim(),
          chunkIdx++,
          metadata,
          section
        ));

        // Start new chunk with overlap context
        const overlapText = this.getOverlapText(currentChunk);
        currentChunk = headerPrefix + (overlapText ? overlapText + '\n\n' : '') + trimmedPara;
      } else {
        currentChunk = potentialChunk;
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(
        currentChunk.trim(),
        chunkIdx,
        metadata,
        section
      ));
    }

    return chunks;
  }

  /**
   * Calculate target chunk size based on header depth
   * Deeper sections get smaller chunks (more specific content)
   * @private
   */
  calculateTargetSize(depth) {
    if (!this.headerDepthWeight) {
      return this.maxChunkSize;
    }

    // h1 = max size, h6 = min size
    const range = this.maxChunkSize - this.minChunkSize;
    const depthFactor = Math.min(depth, 6) / 6; // 0 to 1
    return Math.round(this.maxChunkSize - (range * depthFactor * 0.5));
  }

  /**
   * Get overlap text from the end of a chunk
   * @private
   */
  getOverlapText(chunk) {
    if (!chunk || this.chunkOverlap <= 0) return '';

    // Get last N characters, but try to end at sentence boundary
    const endPortion = chunk.slice(-this.chunkOverlap * 2);
    const sentences = endPortion.split(/[.!?]\s+/);
    
    if (sentences.length > 1) {
      // Return the last complete sentence(s) that fit in overlap
      let overlap = '';
      for (let i = sentences.length - 1; i >= 0; i--) {
        const potential = sentences.slice(i).join('. ');
        if (potential.length <= this.chunkOverlap) {
          overlap = potential;
        } else {
          break;
        }
      }
      return overlap || sentences[sentences.length - 1].slice(-this.chunkOverlap);
    }

    return endPortion.slice(-this.chunkOverlap);
  }

  /**
   * Create a chunk object
   * @private
   */
  createChunk(content, chunkIndex, metadata, section) {
    const source = metadata.source || `material:${metadata.materialId || 'unknown'}`;
    
    // Optionally prepend parent context for better retrieval
    let finalContent = content;
    if (this.includeParentContext && section.parentContext && chunkIndex > 0) {
      finalContent = `[Kontekst: ${section.parentContext}]\n\n${content}`;
    }

    return {
      chunkId: `${source}:chunk:${chunkIndex}`,
      content: finalContent,
      chunkIndex: chunkIndex,
      source: source,
      documentType: 'material',
      chunkType: 'section',
      charOffset: 0,
      parentSection: section.title,
      sectionDepth: section.depth,
      tokenCount: this.estimateTokens(finalContent),
      metadata: {
        ...metadata,
        source: source,
        documentType: 'material',
        chunkType: 'section',
        sectionTitle: section.title,
        sectionDepth: section.depth,
        parentContext: section.parentContext,
        startLine: section.startLine
      }
    };
  }

  /**
   * Estimate token count
   * @private
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
}
