/**
 * Query Generator
 * 
 * Generates query intents from prompt requirements and hearing material themes.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class QueryGenerator {
  constructor(options = {}) {
    // Use MEDIUM complexity level for query generation (structured extraction)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort
    });
    this.model = this.client.model;
    
    // Load prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/query-generation-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[QueryGenerator] Could not load prompt template');
      this.promptTemplate = null;
    }
  }

  /**
   * Generate query intents from materials and prompt requirements
   * @param {Array} materials - Hearing materials
   * @param {string} promptRequirements - Prompt requirements text
   * @returns {Promise<Array>} Array of query intent objects
   */
  async generateIntents(materials, promptRequirements) {
    // Extract themes from materials
    const themes = this.extractThemes(materials);

    // Generate query intents per theme
    const intents = await this.generateIntentsForThemes(themes, promptRequirements);

    return intents;
  }

  /**
   * Extract themes from materials (simple extraction from headers)
   */
  extractThemes(materials) {
    const themes = [];

    materials.forEach(material => {
      const content = material.contentMd || material.content || '';
      if (!content) return;

      // Extract markdown headers (# ## ###)
      const headerRegex = /^(#{1,6})\s+(.+)$/gm;
      let match;
      while ((match = headerRegex.exec(content)) !== null) {
        const level = match[1].length;
        const title = match[2].trim();
        
        // Remove document-specific parts (§ 1, Kapitel 3, etc.)
        const cleanTitle = title
          .replace(/^§\s*\d+\s*/, '')
          .replace(/^Kapitel\s*\d+\s*/, '')
          .replace(/^KAPITEL\s*\d+\s*/, '')
          .trim();

        if (cleanTitle && !themes.find(t => t.name === cleanTitle)) {
          themes.push({
            name: cleanTitle,
            level: level,
            originalTitle: title,
            materialId: material.materialId
          });
        }
      }
    });

    return themes;
  }

  /**
   * Generate query intents for themes using LLM
   */
  async generateIntentsForThemes(themes, promptRequirements) {
    if (themes.length === 0) {
      // Fallback: generate generic queries from prompt
      return this.generateGenericQueries(promptRequirements);
    }

    const themesList = themes.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
    const prompt = this.promptTemplate
      ? this.promptTemplate
          .replace('{themes}', themesList)
          .replace('{promptRequirements}', promptRequirements || 'Analysér høringssvar og gruppér holdninger per tema')
      : `Du skal generere søgeforespørgsler (query intents) for hvert tema fra høringsmaterialet.

Høringsmaterialets temaer:
${themesList}

Prompt krav:
${promptRequirements || 'Analysér høringssvar og gruppér holdninger per tema'}

Generér 2-3 søgeforespørgsler per tema der kan bruges til at finde relevante høringssvar. Forespørgslerne skal være specifikke og fokuserede.

Returnér JSON array:
[
  {
    "theme": "Temanavn",
    "queries": ["query 1", "query 2", "query 3"]
  }
]`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at generere præcise søgeforespørgsler baseret på temaer og krav.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
        // Note: GPT-5 models control temperature via verbosity/reasoning parameters
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return this.generateGenericQueries(promptRequirements);
      }

      const parsed = JSON.parse(content);
      const intents = Array.isArray(parsed) ? parsed : (parsed.intents || []);

      // Flatten to array of query strings
      const queries = [];
      intents.forEach(intent => {
        if (intent.queries && Array.isArray(intent.queries)) {
          intent.queries.forEach(query => {
            queries.push({
              query: query,
              theme: intent.theme || 'Andre emner',
              source: 'theme-based'
            });
          });
        }
      });

      return queries.length > 0 ? queries : this.generateGenericQueries(promptRequirements);
    } catch (error) {
      console.error('[QueryGenerator] Failed to generate intents:', error);
      return this.generateGenericQueries(promptRequirements);
    }
  }

  /**
   * Generate generic queries from prompt requirements
   */
  generateGenericQueries(promptRequirements) {
    const lower = (promptRequirements || '').toLowerCase();
    const queries = [];

    // Extract key terms
    if (lower.includes('trafik') || lower.includes('parkering')) {
      queries.push({ query: 'trafik bekymringer parkering', theme: 'Andre emner', source: 'generic' });
    }
    if (lower.includes('støj') || lower.includes('larm')) {
      queries.push({ query: 'støj bekymringer larm', theme: 'Andre emner', source: 'generic' });
    }
    if (lower.includes('højde') || lower.includes('bygning')) {
      queries.push({ query: 'byggehøjde bekymringer', theme: 'Andre emner', source: 'generic' });
    }
    if (lower.includes('klima') || lower.includes('grøn')) {
      queries.push({ query: 'klima grønne områder', theme: 'Andre emner', source: 'generic' });
    }

    // Default queries
    if (queries.length === 0) {
      queries.push(
        { query: 'høringssvar analyser temaer', theme: 'Andre emner', source: 'generic' },
        { query: 'holdninger bekymringer ønsker', theme: 'Andre emner', source: 'generic' }
      );
    }

    return queries;
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

