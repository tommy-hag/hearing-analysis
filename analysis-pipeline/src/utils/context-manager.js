/**
 * Context Manager
 * 
 * Pre-computes and shares common context across multiple LLM calls to reduce redundancy.
 * OPTIMIZATION: Avoid repeating theme context, respondent metadata, etc. in every request.
 */

export class ContextManager {
  constructor(options = {}) {
    this.contextCache = new Map();
    this.enabled = options.enabled !== false;
  }

  /**
   * Pre-compute theme context to reuse across all positions in that theme
   * @param {string} themeName - Theme name
   * @param {Array} materials - Hearing materials
   * @returns {string} Formatted theme context
   */
  getThemeContext(themeName, materials = []) {
    if (!this.enabled) return '';
    
    const cacheKey = `theme:${themeName}`;
    if (this.contextCache.has(cacheKey)) {
      return this.contextCache.get(cacheKey);
    }
    
    // Build concise theme context
    const context = `Tema: ${themeName}`;
    
    // Add relevant material info if available (concise)
    const materialContext = materials.length > 0 
      ? `\nMaterialer: ${materials.length} dokumenter` 
      : '';
    
    const fullContext = context + materialContext;
    this.contextCache.set(cacheKey, fullContext);
    
    console.log(`[ContextManager] Cached theme context for "${themeName}"`);
    return fullContext;
  }

  /**
   * Get compact respondent metadata summary
   * OPTIMIZATION: Instead of repeating full respondent details in every chunk,
   * provide a compact reference
   * @param {Array} respondents - Respondent objects
   * @returns {Object} Compact metadata mapping
   */
  getRespondentMetadata(respondents) {
    if (!this.enabled) return null;
    
    const metadata = {};
    
    respondents.forEach(r => {
      const id = r.responseNumber;
      metadata[id] = {
        label: r.respondentLabel || `Henvendelse ${id}`,
        type: r.respondentType || 'Borger'
      };
    });
    
    return metadata;
  }

  /**
   * Compress respondent data for prompt by removing redundancy
   * @param {Array} respondents - Respondent objects with full data
   * @param {boolean} includeMetadata - Whether to include basic metadata
   * @returns {Array} Compressed respondent data
   */
  compressRespondentData(respondents, includeMetadata = false) {
    if (!this.enabled) return respondents;
    
    return respondents.map(r => {
      const compressed = {
        responseNumber: r.responseNumber
      };
      
      // Include minimal metadata only if requested
      if (includeMetadata) {
        compressed.label = r.respondentLabel;
        compressed.type = r.respondentType;
      }
      
      // Always include core content (arguments, excerpts)
      if (r.summary?.arguments) {
        compressed.arguments = r.summary.arguments;
      }
      
      if (r.excerpt && r.excerpt.trim()) {
        compressed.excerpt = r.excerpt;
      }
      
      if (r.snippets && r.snippets.length > 0) {
        compressed.snippets = r.snippets;
      }
      
      return compressed;
    });
  }

  /**
   * Get shared context template that can be reused
   * @param {string} type - Context type ('position', 'stitch', etc.)
   * @returns {string} Shared context template
   */
  getSharedTemplate(type) {
    const cacheKey = `template:${type}`;
    if (this.contextCache.has(cacheKey)) {
      return this.contextCache.get(cacheKey);
    }
    
    let template = '';
    
    switch (type) {
      case 'position':
        template = 'Du skriver en tematisk opsummering af høringssvar.';
        break;
      case 'stitch':
        template = 'Du sammenskriver delvise opsummeringer til en sammenhængende helhed.';
        break;
      default:
        template = '';
    }
    
    this.contextCache.set(cacheKey, template);
    return template;
  }

  /**
   * Pre-compute material reference context
   * @param {Array} materials - Material objects
   * @returns {Object} Indexed material references
   */
  getMaterialReferences(materials) {
    const cacheKey = 'materials';
    if (this.contextCache.has(cacheKey)) {
      return this.contextCache.get(cacheKey);
    }
    
    const references = {};
    materials.forEach((mat, idx) => {
      references[mat.materialId || idx] = {
        title: mat.title || `Materiale ${idx + 1}`,
        type: mat.type || 'dokument'
      };
    });
    
    this.contextCache.set(cacheKey, references);
    return references;
  }

  /**
   * Clear cached contexts
   */
  clear() {
    this.contextCache.clear();
    console.log('[ContextManager] Context cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      cachedContexts: this.contextCache.size,
      enabled: this.enabled
    };
  }
}

/**
 * Create a shared context manager instance for a pipeline run
 * @param {Object} options - Configuration options
 * @returns {ContextManager} Context manager instance
 */
export function createContextManager(options = {}) {
  return new ContextManager(options);
}


