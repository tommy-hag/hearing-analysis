/**
 * PositionGrouper
 * 
 * Identifies master positions and groups related sub-positions hierarchically.
 * Applied after consolidation to create better overview for highly focused hearings.
 */

import { EmbeddingService } from '../embedding/embedding-service.js';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';

export class PositionGrouper {
  constructor(options = {}) {
    this.embedder = new EmbeddingService(options);

    // LLM for master/sub identification
    try {
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
        timeout: options.timeout || 60000
      });
    } catch (error) {
      console.warn('[PositionGrouper] Failed to initialize LLM client:', error.message);
      this.client = null;
    }

    // Configuration
    this.masterSimilarityThreshold = options.masterSimilarityThreshold || 0.85;
    this.minSubPositions = options.minSubPositions || 2; // Minimum sub-positions to create hierarchy
    this.enabled = true; // Will be set dynamically
  }

  /**
   * Set dynamic parameters
   * @param {Object} params - Dynamic parameters from calculator
   */
  setDynamicParameters(params) {
    // Enable hierarchical grouping for high object concentration + low diversity
    const objectConcentration = params.objectConcentration?.concentration || 0;
    const semanticDiversity = params._stats?.semanticDiversity || 0.5;

    // Enable if:
    // - High object concentration (>0.6) + low diversity (<0.4) → focused hearing like Palads
    // - OR very high object concentration (>0.8) regardless of diversity
    if ((objectConcentration > 0.6 && semanticDiversity < 0.4) || objectConcentration > 0.8) {
      this.enabled = true;
      console.log(`[PositionGrouper] Hierarchical grouping ENABLED (objConc=${objectConcentration.toFixed(2)}, div=${semanticDiversity.toFixed(2)})`);
    } else {
      this.enabled = false;
      console.log(`[PositionGrouper] Hierarchical grouping DISABLED (objConc=${objectConcentration.toFixed(2)}, div=${semanticDiversity.toFixed(2)})`);
    }
  }

  /**
   * Group positions hierarchically per theme
   * @param {Array} themes - Themes with consolidated positions
   * @returns {Promise<Array>} Themes with hierarchical position structure
   */
  async groupPositions(themes) {
    if (!this.enabled) {
      console.log('[PositionGrouper] Hierarchical grouping disabled, returning themes unchanged');
      return themes;
    }

    console.log(`[PositionGrouper] Starting hierarchical grouping for ${themes.length} themes...`);

    const groupedThemes = [];

    for (const theme of themes) {
      const positions = theme.positions || [];

      if (positions.length < 3) {
        // Too few to group hierarchically
        groupedThemes.push(theme);
        continue;
      }

      console.log(`[PositionGrouper] Processing theme "${theme.name}" with ${positions.length} positions`);

      try {
        const hierarchicalPositions = await this.identifyHierarchy(positions, theme.name);

        groupedThemes.push({
          ...theme,
          positions: hierarchicalPositions,
          _hierarchical: hierarchicalPositions.some(p => p.subPositions?.length > 0)
        });

        const masterCount = hierarchicalPositions.filter(p => p.subPositions?.length > 0).length;
        if (masterCount > 0) {
          console.log(`[PositionGrouper] Created ${masterCount} master positions in theme "${theme.name}"`);
        }
      } catch (error) {
        console.warn(`[PositionGrouper] Hierarchy identification failed for theme "${theme.name}":`, error.message);
        groupedThemes.push(theme); // Fallback to original
      }
    }

    return groupedThemes;
  }

  /**
   * Identify master/sub hierarchy for positions
   * @param {Array} positions - Positions to analyze
   * @param {string} themeName - Theme name for context
   * @returns {Promise<Array>} Positions with hierarchical structure
   */
  async identifyHierarchy(positions, themeName) {
    // Stage 1: Generate embeddings for all positions
    console.log(`[PositionGrouper] Generating embeddings for ${positions.length} positions...`);

    const embeddingTexts = positions.map(pos =>
      `${pos.title}\n\n${(pos.summary || '').slice(0, 500)}`
    );
    const embeddings = await this.embedder.embedBatch(embeddingTexts);

    // Stage 2: Find candidate master positions (largest, most central)
    const candidates = this.findMasterCandidates(positions, embeddings);

    if (candidates.length === 0) {
      console.log(`[PositionGrouper] No master candidates found, returning flat structure`);
      return positions;
    }

    console.log(`[PositionGrouper] Found ${candidates.length} master candidates`);

    // Stage 3: Use LLM to validate and assign sub-positions
    const hierarchy = await this.buildHierarchy(positions, candidates, embeddings, themeName);

    return hierarchy;
  }

  /**
   * Find master position candidates
   * Criteria: large position + high centrality in embedding space
   */
  findMasterCandidates(positions, embeddings) {
    const candidates = [];

    // Calculate centrality (average similarity to all other positions)
    const centrality = positions.map((pos, i) => {
      let totalSim = 0;
      let count = 0;

      for (let j = 0; j < positions.length; j++) {
        if (i === j) continue;
        if (!embeddings[i] || !embeddings[j]) continue;

        const sim = this.cosineSimilarity(embeddings[i], embeddings[j]);
        totalSim += sim;
        count++;
      }

      return count > 0 ? totalSim / count : 0;
    });

    // Find positions with high response count + high centrality
    const avgResponses = positions.reduce((sum, p) => sum + (p.responseNumbers?.length || 0), 0) / positions.length;

    positions.forEach((pos, idx) => {
      const responseCount = pos.responseNumbers?.length || 0;
      const cent = centrality[idx];

      // Master candidate if:
      // - Above average response count
      // - High centrality (>0.75)
      if (responseCount >= avgResponses && cent > 0.75) {
        candidates.push({
          position: pos,
          index: idx,
          responseCount,
          centrality: cent,
          score: responseCount * cent // Combined score
        });
      }
    });

    // Sort by score (descending)
    candidates.sort((a, b) => b.score - a.score);

    // Iteratively select distinct masters
    const finalCandidates = [];
    const distinctThreshold = 0.70; // If similarity > 0.70, it's too similar to be a separate master

    for (const candidate of candidates) {
      if (finalCandidates.length >= 5) break; // Max 5 masters per theme

      let isDistinct = true;
      for (const existing of finalCandidates) {
        const sim = this.cosineSimilarity(embeddings[candidate.index], embeddings[existing.index]);
        if (sim > distinctThreshold) {
          isDistinct = false;
          break;
        }
      }

      if (isDistinct) {
        finalCandidates.push(candidate);
      }
    }

    return finalCandidates;
  }

  /**
   * Build hierarchy using LLM validation
   */
  async buildHierarchy(positions, candidates, embeddings, themeName) {
    if (!this.client) {
      console.warn('[PositionGrouper] No LLM client, returning flat structure');
      return positions;
    }

    // For each candidate, find potential sub-positions
    const masterGroups = [];
    const assignedIndices = new Set();

    for (const candidate of candidates) {
      const masterIdx = candidate.index;
      const masterPos = candidate.position;

      // Find similar positions (potential sub-positions)
      const potentialSubs = [];

      for (let i = 0; i < positions.length; i++) {
        if (i === masterIdx) continue;
        if (assignedIndices.has(i)) continue; // Already assigned
        if (!embeddings[masterIdx] || !embeddings[i]) continue;

        const sim = this.cosineSimilarity(embeddings[masterIdx], embeddings[i]);

        if (sim >= this.masterSimilarityThreshold) {
          potentialSubs.push({
            position: positions[i],
            index: i,
            similarity: sim
          });
        }
      }

      // Need at least minSubPositions to create hierarchy
      if (potentialSubs.length < this.minSubPositions) {
        continue;
      }

      console.log(`[PositionGrouper] Master candidate "${masterPos.title}" has ${potentialSubs.length} potential sub-positions`);

      // LLM validation: should these be sub-positions?
      const validatedSubs = await this.validateSubPositions(
        masterPos,
        potentialSubs.map(s => s.position),
        themeName
      );

      if (validatedSubs.length >= this.minSubPositions) {
        // Mark as assigned
        validatedSubs.forEach(subIdx => {
          const originalIdx = potentialSubs[subIdx].index;
          assignedIndices.add(originalIdx);
        });
        assignedIndices.add(masterIdx);

        masterGroups.push({
          masterIndex: masterIdx,
          subIndices: validatedSubs.map(subIdx => potentialSubs[subIdx].index)
        });

        console.log(`[PositionGrouper] Created master group: 1 master + ${validatedSubs.length} subs`);
      }
    }

    // Build final hierarchy
    const result = [];

    positions.forEach((pos, idx) => {
      // Check if this is a master
      const masterGroup = masterGroups.find(g => g.masterIndex === idx);

      if (masterGroup) {
        // This is a master position
        const subPositions = masterGroup.subIndices.map(subIdx => positions[subIdx]);

        result.push({
          ...pos,
          isMaster: true,
          subPositions: subPositions
        });
      } else if (!assignedIndices.has(idx)) {
        // This is a standalone position (not master, not sub)
        result.push(pos);
      }
      // Skip positions that are subs (they're included in master's subPositions)
    });

    return result;
  }

  /**
   * Use LLM to validate sub-positions
   * @returns {Promise<Array<number>>} Indices of validated sub-positions
   */
  async validateSubPositions(masterPos, potentialSubs, themeName) {
    try {
      const prompt = `Du vurderer om holdninger skal grupperes hierarkisk i et høringssvar-bilag.

**Tema:** ${themeName}

**MASTER HOLDNING:**
Titel: ${masterPos.title}
Opsummering: ${(masterPos.summary || '').slice(0, 600)}
Respondenter: ${masterPos.responseNumbers?.length || 0}

**POTENTIELLE SUB-HOLDNINGER:**
${potentialSubs.map((sub, idx) => `
[${idx}] Titel: ${sub.title}
    Opsummering: ${(sub.summary || '').slice(0, 300)}
    Respondenter: ${sub.responseNumbers?.length || 0}
`).join('\n')}

**Opgave:** 
Identificér hvilke sub-holdninger der er NUANCER/VARIATIONER af master-holdningen.

**Kriterier for SUB-HOLDNING:**
✅ INCLUDE hvis:
  - Samme GRUNDHOLDNING men forskellig detalje (fx "bevar bygning" → "bevar facade", "bevar foyer")
  - Samme ØNSKE men forskellig begrundelse (fx "bevar pga. kultur" vs "bevar pga. klima")
  - Specifik ASPEKT af en bredere holdning

❌ EXCLUDE hvis:
  - Helt FORSKELLIG grundholdning (fx "bevar" ≠ "nedrive")
  - Forskellige OBJEKTER (fx "Bygning A" ≠ "Bygning B")
  - Kun SVAG semantisk relation
  - Holdningen er et SELVSTÆNDIGT hovedemne (fx trafik vs. støj vs. arkitektur) - disse skal IKKE grupperes sammen, selvom det er samme respondent.
  - "Meta"-holdninger (fx "Høringsproces") skal IKKE inkludere specifikke faglige emner (fx "Højde").

**Output:** JSON array med indices af sub-holdninger der skal inkluderes, fx: [0, 2, 4]`;

      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du identificerer hierarkiske relationer mellem holdninger i høringssvar.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: getResponseFormat('hierarchyValidation')
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in LLM response');
      }

      const parsed = JSON.parse(content);
      return parsed.subPositionIndices || [];
    } catch (error) {
      console.warn('[PositionGrouper] LLM validation failed:', error.message);
      return []; // Conservative: no subs if validation fails
    }
  }

  /**
   * Cosine similarity between two vectors
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      mag1 += vec1[i] * vec1[i];
      mag2 += vec2[i] * vec2[i];
    }

    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);

    if (mag1 === 0 || mag2 === 0) return 0;

    return dotProduct / (mag1 * mag2);
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

