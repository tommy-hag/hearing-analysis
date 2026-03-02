/**
 * Theme Template Analyzer
 * 
 * Analyzes documents to automatically update and improve theme templates.
 * Can use web search and legal documentation to understand document purposes
 * and legal basis.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class ThemeTemplateAnalyzer {
  constructor(options = {}) {
    // Use HEAVY complexity level for theme template analysis (requires deep understanding)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'heavy');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    
    this.templatePath = options.templatePath || join(__dirname, '../../config/theme-templates.json');
    
    // Load prompt templates
    try {
      const docAnalysisPath = join(__dirname, '../../prompts/document-type-analysis-prompt.md');
      this.documentAnalysisPrompt = readFileSync(docAnalysisPath, 'utf-8');
    } catch (error) {
      console.warn('[ThemeTemplateAnalyzer] Could not load document analysis prompt');
      this.documentAnalysisPrompt = null;
    }
    
    try {
      const batchAnalysisPath = join(__dirname, '../../prompts/batch-document-analysis-prompt.md');
      this.batchAnalysisPrompt = readFileSync(batchAnalysisPath, 'utf-8');
    } catch (error) {
      console.warn('[ThemeTemplateAnalyzer] Could not load batch analysis prompt');
      this.batchAnalysisPrompt = null;
    }
    
    // Load existing templates
    this.loadTemplates();
  }

  /**
   * Load theme templates from file
   */
  loadTemplates() {
    try {
      const content = readFileSync(this.templatePath, 'utf-8');
      this.templates = JSON.parse(content);
    } catch (error) {
      console.warn('[ThemeTemplateAnalyzer] Could not load templates:', error.message);
      this.templates = {
        documentTypes: {},
        themeCategories: {},
        mappingStrategy: {}
      };
    }
  }

  /**
   * Save theme templates to file
   */
  saveTemplates() {
    try {
      writeFileSync(this.templatePath, JSON.stringify(this.templates, null, 2), 'utf-8');
      return true;
    } catch (error) {
      console.error('[ThemeTemplateAnalyzer] Could not save templates:', error.message);
      return false;
    }
  }

  /**
   * Analyze a single document to understand its type, purpose, and legal basis
   * @param {Array} materials - Hearing materials
   * @param {Object} options - Options for analysis
   * @returns {Promise<Object>} Analysis result with recommendations
   */
  async analyzeDocument(materials, options = {}) {
    if (!materials || materials.length === 0) {
      throw new Error('Materials are required for analysis');
    }

    // Combine material content
    const materialText = materials
      .map((m, idx) => {
        const title = m.title || `Materiale ${idx + 1}`;
        const content = m.contentMd || m.content || '';
        return `## ${title}\n\n${content}`;
      })
      .join('\n\n')
      .slice(0, 20000); // More content for analysis

    // Get existing templates as reference
    const existingTemplates = JSON.stringify(this.templates.documentTypes, null, 2);

    // Build prompt
    const prompt = this.documentAnalysisPrompt
      ? this.documentAnalysisPrompt
          .replace('{materialText}', materialText)
          .replace('{existingTemplates}', existingTemplates)
      : `Analysér følgende dokument og identificer dets formål, lovgivningsmæssig hjemmel og strukturelle temaer.

Dokument:
${materialText}

Eksisterende skabeloner:
${existingTemplates}

Returnér JSON med dokumenttype, formål, lovgivningsmæssig hjemmel og temaer.`;

    try {
      // Use tools if available (for legal research)
      const messages = [
        {
          role: 'system',
          content: 'Du er en specialist i at analysere danske planlægnings- og bygningsdokumenter. Brug web-søgning eller dokumentation hvis du har adgang til det, for at verificere lovgivningsmæssig information.'
        },
        {
          role: 'user',
          content: prompt
        }
      ];

      const response = await this.client.createCompletion({
        messages: messages,
        response_format: { type: 'json_object' }
        // Note: GPT-5 models control temperature via verbosity/reasoning parameters
      });

      const content = response.choices[0]?.message?.content || '';
      const parsed = JSON.parse(content);

      return {
        success: true,
        analysis: parsed,
        recommendations: parsed.recommendations || {}
      };
    } catch (error) {
      console.error('[ThemeTemplateAnalyzer] Failed to analyze document:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Analyze multiple documents of the same type to extract common themes
   * @param {Array} documents - Array of document arrays (each is materials array)
   * @param {string} documentType - Document type to analyze
   * @returns {Promise<Object>} Batch analysis result
   */
  async analyzeBatch(documents, documentType) {
    if (!documents || documents.length === 0) {
      throw new Error('Documents are required for batch analysis');
    }

    // Limit to 10 documents for analysis
    const docsToAnalyze = documents.slice(0, 10);

    // Format documents for prompt
    const formattedDocs = docsToAnalyze.map((materials, idx) => {
      const combined = materials
        .map(m => {
          const title = m.title || 'Materiale';
          const content = (m.contentMd || m.content || '').slice(0, 5000);
          return `## ${title}\n\n${content}`;
        })
        .join('\n\n');
      
      return `--- Dokument ${idx + 1} ---\n${combined}`;
    }).join('\n\n');

    // Get existing template
    const existingTemplate = this.templates.documentTypes[documentType] || {};
    const existingTemplateStr = JSON.stringify(existingTemplate, null, 2);

    // Build prompt
    const prompt = this.batchAnalysisPrompt
      ? this.batchAnalysisPrompt
          .replace('{documentType}', documentType)
          .replace('{existingTemplate}', existingTemplateStr)
          .replace('{documents}', formattedDocs)
      : `Analysér følgende ${docsToAnalyze.length} dokumenter af typen "${documentType}" og ekstraher fælles temaer.

Eksisterende skabelon:
${existingTemplateStr}

Dokumenter:
${formattedDocs}

Returnér JSON med fælles temaer og skabelon-opdateringer.`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at analysere flere dokumenter og ekstrahere fælles temaer og strukturer.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
        // Note: GPT-5 models control temperature via verbosity/reasoning parameters
      });

      const content = response.choices[0]?.message?.content || '';
      const parsed = JSON.parse(content);

      return {
        success: true,
        analysis: parsed,
        templateUpdates: parsed.templateUpdates || {},
        recommendations: parsed.recommendations || {}
      };
    } catch (error) {
      console.error('[ThemeTemplateAnalyzer] Failed to analyze batch:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Apply template updates to existing templates
   * @param {Object} updates - Template updates from analysis
   * @param {string} documentType - Document type to update
   * @param {Object} options - Options (dryRun, mergeStrategy)
   * @returns {Object} Result of update
   */
  applyTemplateUpdates(updates, documentType, options = {}) {
    const { dryRun = false, mergeStrategy = 'merge' } = options;

    if (!this.templates.documentTypes[documentType]) {
      // Create new document type
      this.templates.documentTypes[documentType] = {
        name: documentType,
        description: '',
        commonThemes: [],
        outOfScopeIndicators: [],
        generalPurposeKeywords: []
      };
    }

    const template = this.templates.documentTypes[documentType];
    const changes = {
      added: [],
      updated: [],
      removed: []
    };

    // Apply theme updates
    if (updates.commonThemes && Array.isArray(updates.commonThemes)) {
      updates.commonThemes.forEach(newTheme => {
        const existingIndex = template.commonThemes.findIndex(
          t => t.name.toLowerCase() === newTheme.name.toLowerCase()
        );

        if (existingIndex >= 0) {
          // Update existing theme
          if (mergeStrategy === 'merge') {
            // Merge keywords and sections
            const existing = template.commonThemes[existingIndex];
            template.commonThemes[existingIndex] = {
              ...existing,
              keywords: [...new Set([...existing.keywords || [], ...newTheme.keywords || []])],
              typicalSections: [...new Set([...existing.typicalSections || [], ...newTheme.typicalSections || []])],
              description: newTheme.description || existing.description,
              category: newTheme.category || existing.category
            };
            changes.updated.push(newTheme.name);
          } else {
            // Replace
            template.commonThemes[existingIndex] = newTheme;
            changes.updated.push(newTheme.name);
          }
        } else {
          // Add new theme
          template.commonThemes.push(newTheme);
          changes.added.push(newTheme.name);
        }
      });
    }

    // Apply out-of-scope indicators
    if (updates.outOfScopeIndicators && Array.isArray(updates.outOfScopeIndicators)) {
      updates.outOfScopeIndicators.forEach(indicator => {
        if (!template.outOfScopeIndicators.includes(indicator)) {
          template.outOfScopeIndicators.push(indicator);
          changes.added.push(`out-of-scope: ${indicator}`);
        }
      });
    }

    // Apply general purpose keywords
    if (updates.generalPurposeKeywords && Array.isArray(updates.generalPurposeKeywords)) {
      updates.generalPurposeKeywords.forEach(keyword => {
        if (!template.generalPurposeKeywords.includes(keyword)) {
          template.generalPurposeKeywords.push(keyword);
          changes.added.push(`general-purpose: ${keyword}`);
        }
      });
    }

    if (!dryRun) {
      this.saveTemplates();
    }

    return {
      success: true,
      changes: changes,
      template: template
    };
  }

  /**
   * Analyze and update template from a single document
   * @param {Array} materials - Hearing materials
   * @param {Object} options - Options
   * @returns {Promise<Object>} Update result
   */
  async analyzeAndUpdate(materials, options = {}) {
    const analysis = await this.analyzeDocument(materials, options);
    
    if (!analysis.success) {
      return analysis;
    }

    const docType = analysis.analysis.documentType || 'default';
    const recommendations = analysis.recommendations || {};

    if (recommendations.shouldAddToTemplate && recommendations.templateUpdates) {
      const updateResult = this.applyTemplateUpdates(
        recommendations.templateUpdates,
        docType,
        options
      );

      return {
        success: true,
        analysis: analysis.analysis,
        updateResult: updateResult
      };
    }

    return {
      success: true,
      analysis: analysis.analysis,
      updateResult: { message: 'No updates recommended' }
    };
  }

  /**
   * Analyze multiple documents and update template
   * @param {Array} documents - Array of document arrays
   * @param {string} documentType - Document type
   * @param {Object} options - Options
   * @returns {Promise<Object>} Update result
   */
  async analyzeBatchAndUpdate(documents, documentType, options = {}) {
    const analysis = await this.analyzeBatch(documents, documentType);
    
    if (!analysis.success) {
      return analysis;
    }

    if (analysis.templateUpdates) {
      const updateResult = this.applyTemplateUpdates(
        analysis.templateUpdates,
        documentType,
        options
      );

      return {
        success: true,
        analysis: analysis.analysis,
        updateResult: updateResult
      };
    }

    return {
      success: true,
      analysis: analysis.analysis,
      updateResult: { message: 'No updates recommended' }
    };
  }

  /**
   * Set Job ID for LLM tracing
   * @param {string} jobId - The job ID to set on the LLM client
   */
  setJobId(jobId) {
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }
}
