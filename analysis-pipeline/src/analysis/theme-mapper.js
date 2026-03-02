/**
 * Theme Mapper
 * 
 * Maps micro-summaries to themes from hearing materials.
 */

import { ThemeExtractor } from './theme-extractor.js';
import { EmbeddingService } from '../embedding/embedding-service.js';

export class ThemeMapper {
  constructor(options = {}) {
    this.themeExtractor = new ThemeExtractor(options);
    this.embedder = new EmbeddingService(options.embedding);
    this.deduplicationThreshold = 0.92; // Default, will be set dynamically
    this.deduplicationEnabled = false; // Default, will be set dynamically
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.themeExtractor) this.themeExtractor.setJobId(jobId);
  }

  /**
   * Set dynamic parameters for theme mapping
   * Called by pipeline orchestrator
   */
  setDynamicParameters(params) {
    if (params.themeMapping) {
      this.deduplicationEnabled = params.themeMapping.deduplicationEnabled !== false;
      this.deduplicationThreshold = params.themeMapping.deduplicationThreshold || 0.92;
      console.log(`[ThemeMapper] Dynamic parameters set: deduplication=${this.deduplicationEnabled}, threshold=${this.deduplicationThreshold.toFixed(3)}`);
    }
  }

  /**
   * Set embedded substance for RAG-based theme correction
   * @param {Array} embeddedItems - Substance items with embeddings
   * @param {Object} embedder - SubstanceEmbedder for retrieval
   */
  setEmbeddedSubstance(embeddedItems, embedder) {
    this.embeddedSubstance = embeddedItems;
    this.substanceEmbedder = embedder;
    this.useRAGSubstance = embeddedItems && embeddedItems.length > 0 && embedder;
    
    if (this.useRAGSubstance) {
      console.log(`[ThemeMapper] RAG mode enabled: ${embeddedItems.length} substance items available`);
    }
  }

  /**
   * Map micro-summaries to themes
   * @param {Array} microSummaries - Array of micro-summaries
   * @param {Array} materials - Hearing materials
   * @param {Array} preExtractedThemes - Optional pre-extracted themes from analyze-material step
   * @returns {Promise<Object>} Theme mapping with summaries grouped by theme
   */
  async mapToThemes(microSummaries, materials, preExtractedThemes = null) {
    // Use pre-extracted themes if available, otherwise extract via LLM
    let themes;
    if (preExtractedThemes && preExtractedThemes.length > 0) {
      themes = preExtractedThemes;
      console.log(`[ThemeMapper] Using ${themes.length} pre-extracted themes from analyze-material`);
    } else {
      themes = await this.themeExtractor.extractThemes(materials);
      console.log(`[ThemeMapper] Extracted ${themes.length} themes via LLM (no pre-extracted themes available)`);
    }

    // Group micro-summaries by theme
    const themeMap = new Map();

    // Initialize theme map
    themes.forEach(theme => {
      themeMap.set(theme.name, {
        theme: theme,
        summaries: [],
        arguments: []
      });
    });

    // Add "Andre emner" as the ONLY fallback theme for:
    // - Out-of-scope arguments
    // - Unmapped content that doesn't fit any specific theme
    // - noComments/unanalyzable responses
    // NOTE: "Generelt" is intentionally NOT created - "Andre emner" is the sole catch-all
    themeMap.set('Andre emner', {
      theme: { 
        name: 'Andre emner', 
        level: 0, 
        category: 'out-of-scope',
        description: 'Bemærkninger om emner uden for dokumentets juridiske beføjelser eller uden specifik tematisk tilknytning'
      },
      summaries: [],
      arguments: []
    });

    // Track out-of-scope statistics
    let outOfScopeCount = 0;

    // Track fuzzy match statistics for aggregated logging
    const fuzzyMatchCounts = new Map();

    // Map each micro-summary to themes (async for RAG lookup)
    for (const summary of microSummaries) {
      // Check if this is a "no comments" response
      if (summary.edgeCaseFlags?.noComments) {
        // Mark it specially for grouping in aggregator - goes to "Andre emner"
        themeMap.get('Andre emner').summaries.push({
          ...summary,
          isNoComments: true
        });
        continue;
      }

      if (!summary.analyzable || !summary.arguments || summary.arguments.length === 0) {
        // Unanalyzable summaries go to "Andre emner" (the sole catch-all theme)
        themeMap.get('Andre emner').summaries.push(summary);
        continue;
      }

      for (let argIndex = 0; argIndex < summary.arguments.length; argIndex++) {
        const arg = summary.arguments[argIndex];
        
        // Check if argument is marked as out-of-scope
        if (arg.outOfScope === true) {
          // Out-of-scope arguments go to "Andre emner"
          themeMap.get('Andre emner').arguments.push({
            ...arg,
            responseNumber: summary.responseNumber,
            argumentIndex: argIndex
          });
          outOfScopeCount++;
          continue;
        }

        const relevantThemes = arg.relevantThemes || [];

        // Check if relevantThemes contains "Andre emner" (LLM marked as out-of-scope)
        if (relevantThemes.includes('Andre emner') || relevantThemes.includes('Andet')) {
          // RESCUE ATTEMPT: Try content-based matching before assigning to "Andre emner"
          // Sometimes LLM incorrectly marks arguments as "Andre emner" when they match existing themes
          const rescuedTheme = await this.matchThemeByContent(arg, themes);
          
          if (rescuedTheme && rescuedTheme.name !== 'Andre emner') {
            // Successfully rescued - use the matched theme instead
            const themeEntry = themeMap.get(rescuedTheme.name);
            if (themeEntry) {
              const alreadyExists = themeEntry.arguments.some(
                existing => existing.responseNumber === summary.responseNumber 
                         && existing.argumentIndex === argIndex
              );
              if (!alreadyExists) {
                themeEntry.arguments.push({
                  ...arg,
                  responseNumber: summary.responseNumber,
                  argumentIndex: argIndex,
                  _rescuedFrom: 'Andre emner'
                });
                console.log(`[ThemeMapper] Rescued from "Andre emner" to "${rescuedTheme.name}": ${(arg.what || arg.coreContent || '').slice(0, 50)}...`);
                continue;
              }
            }
          }
          
          // No rescue possible - assign to "Andre emner"
          themeMap.get('Andre emner').arguments.push({
            ...arg,
            responseNumber: summary.responseNumber,
            argumentIndex: argIndex
          });
          outOfScopeCount++;
          continue;
        }

        if (relevantThemes.length === 0) {
          // No theme specified, try to match based on content
          const matchedTheme = await this.matchThemeByContent(arg, themes);
          if (matchedTheme) {
            const themeEntry = themeMap.get(matchedTheme.name) || themeMap.get('Andre emner');
            // Check if argument already exists in this theme (prevent duplicates)
            const alreadyExists = themeEntry.arguments.some(
              existing => existing.responseNumber === summary.responseNumber 
                       && existing.argumentIndex === argIndex
            );
            if (!alreadyExists) {
              themeEntry.arguments.push({
                ...arg,
                responseNumber: summary.responseNumber,
                argumentIndex: argIndex
              });
            }
          } else {
            // No theme match - goes to "Andre emner" (the sole catch-all)
            themeMap.get('Andre emner').arguments.push({
              ...arg,
              responseNumber: summary.responseNumber,
              argumentIndex: argIndex
            });
          }
        } else {
          // FIX: Deduplicate relevantThemes to prevent argument explosion
          const uniqueThemes = [...new Set(relevantThemes)];

          // CRITICAL FIX: Use only the FIRST (most relevant) theme to prevent duplicates
          // Micro-summarizer is instructed to list most relevant theme first
          let primaryThemeName = uniqueThemes[0];

          // PRIORITY CORRECTION: substanceRefs override relevantThemes
          // substanceRefs contains direct § references (e.g., "LP-§5") which are more reliable
          // than the LLM-generated relevantThemes which can conflate process-words like "dispensation"
          const substanceTheme = this.matchThemeBySubstanceRefs(arg, themes);
          if (substanceTheme && substanceTheme.name !== primaryThemeName) {
            console.log(`[ThemeMapper] SubstanceRef correction: "${primaryThemeName}" → "${substanceTheme.name}" (refs: ${(arg.substanceRefs || []).join(', ')})`);
            primaryThemeName = substanceTheme.name;
          }

          // SECONDARY CORRECTION: Check if argument mentions physical elements that are regulated
          // by a DIFFERENT theme than what micro-summarizer assigned.
          // E.g., "boldbane" should map to "Ubebyggede arealer", not "Støj"
          // Uses RAG to look up what the hearing material says
          const correctedTheme = await this.matchThemeByRegulates(arg, themes);
          if (correctedTheme && correctedTheme.name !== primaryThemeName) {
            console.log(`[ThemeMapper] Theme correction: "${primaryThemeName}" → "${correctedTheme.name}" (object: "${arg._matchedRegulates || 'unknown'}")`);
            primaryThemeName = correctedTheme.name;
          }
          
          // Try exact match first
          let themeEntry = themeMap.get(primaryThemeName);

          // If no exact match, try fuzzy match
          if (!themeEntry) {
            const closestTheme = this.findClosestTheme(primaryThemeName, themes);
            if (closestTheme) {
              // Track fuzzy matches for aggregated logging
              const fuzzyKey = `${primaryThemeName} -> ${closestTheme.name}`;
              if (!fuzzyMatchCounts.has(fuzzyKey)) {
                fuzzyMatchCounts.set(fuzzyKey, 0);
              }
              fuzzyMatchCounts.set(fuzzyKey, fuzzyMatchCounts.get(fuzzyKey) + 1);
              themeEntry = themeMap.get(closestTheme.name);
            }
          }

          // Fallback to "Andre emner" (the sole catch-all theme)
          themeEntry = themeEntry || themeMap.get('Andre emner');

          // Check if argument already exists in this theme (prevent duplicates)
          const alreadyExists = themeEntry.arguments.some(
            existing => existing.responseNumber === summary.responseNumber 
                     && existing.argumentIndex === argIndex
          );
          
          if (!alreadyExists) {
            themeEntry.arguments.push({
              ...arg,
              responseNumber: summary.responseNumber,
              argumentIndex: argIndex,
              _originalThemes: uniqueThemes // Keep all themes for debugging
            });
          }
          // Log if additional themes were ignored
          if (uniqueThemes.length > 1) {
            console.log(`[ThemeMapper] Using primary theme "${primaryThemeName}" for response ${summary.responseNumber} arg ${argIndex} (ignored: ${uniqueThemes.slice(1).join(', ')})`);
          }
        }
      }
    }

    // Log aggregated fuzzy match statistics
    if (fuzzyMatchCounts.size > 0) {
      console.log(`[ThemeMapper] Fuzzy theme matching summary:`);
      for (const [match, count] of fuzzyMatchCounts.entries()) {
        console.log(`[ThemeMapper]   "${match}" (${count}x)`);
      }
    }

    // Log out-of-scope statistics
    if (outOfScopeCount > 0) {
      console.log(`[ThemeMapper] Mapped ${outOfScopeCount} out-of-scope arguments to "Andre emner"`);
    }

    // Convert map to array, filter empty themes (except "Andre emner" which is the sole catch-all)
    let mappedThemes = Array.from(themeMap.values())
      .filter(entry => 
        entry.arguments.length > 0 || 
        entry.summaries.length > 0 ||
        entry.theme.name === 'Andre emner'
      )
      .map(entry => ({
        name: entry.theme.name,
        level: entry.theme.level || 0,
        category: entry.theme.category || 'regulation',
        description: entry.theme.description || '',
        arguments: entry.arguments,
        summaries: entry.summaries
      }));

    // OPTIMIZATION: Apply cross-theme argument deduplication if enabled
    // Skip for small hearings (<100 arguments) to save cost - explosion unlikely
    const totalArgs = mappedThemes.reduce((sum, t) => sum + t.arguments.length, 0);
    const shouldDeduplicate = this.deduplicationEnabled && totalArgs >= 100;

    if (shouldDeduplicate) {
      console.log(`[ThemeMapper] Running deduplication: ${totalArgs} arguments across themes`);
      const deduplicationResult = await this.deduplicateCrossThemeArguments(mappedThemes);
      mappedThemes = deduplicationResult.themes;

      if (deduplicationResult.deduplicatedCount > 0) {
        console.log(`[ThemeMapper] Deduplicated ${deduplicationResult.deduplicatedCount} cross-theme arguments (threshold=${this.deduplicationThreshold.toFixed(3)})`);
      }
    } else if (this.deduplicationEnabled && totalArgs < 100) {
      console.log(`[ThemeMapper] Skipping deduplication for small hearing: ${totalArgs} arguments (threshold: 100)`);
    }

    // Build responseToThemes mapping for patch mode support
    // Maps response ID to list of theme names where that response has arguments
    const responseToThemes = {};
    for (const theme of mappedThemes) {
      for (const arg of theme.arguments) {
        const responseId = arg.responseNumber;
        if (responseId !== undefined) {
          if (!responseToThemes[responseId]) {
            responseToThemes[responseId] = [];
          }
          if (!responseToThemes[responseId].includes(theme.name)) {
            responseToThemes[responseId].push(theme.name);
          }
        }
      }
    }

    return {
      themes: mappedThemes,
      unmappedSummaries: themeMap.get('Andre emner')?.summaries || [],
      outOfScopeCount: outOfScopeCount,
      outOfScopeSummaries: themeMap.get('Andre emner')?.summaries || [],
      responseToThemes // NEW: Mapping for patch mode to identify touched themes
    };
  }

  /**
   * Deduplicate arguments that appear in multiple themes
   * Keep only in PRIMARY theme (first appearance) if similarity is high
   * 
   * @param {Array} themes - Themes with arguments
   * @returns {Promise<Object>} Deduplicated themes and statistics
   */
  async deduplicateCrossThemeArguments(themes) {
    console.log(`[ThemeMapper] Starting cross-theme argument deduplication...`);

    // Build argument-to-themes map (which arguments appear in which themes)
    const argumentSignatureMap = new Map(); // signature -> {themes: [], argumentInstances: []}

    themes.forEach((theme, themeIdx) => {
      theme.arguments.forEach((arg, argIdx) => {
        // Create signature for argument (use coreContent + responseNumber)
        const signature = `${arg.responseNumber}:${(arg.coreContent || '').substring(0, 100)}`;

        if (!argumentSignatureMap.has(signature)) {
          argumentSignatureMap.set(signature, {
            themes: [],
            argumentInstances: [],
            primaryTheme: theme.name, // First theme where this argument appears
            primaryThemeIdx: themeIdx,
            primaryArgIdx: argIdx
          });
        }

        const entry = argumentSignatureMap.get(signature);
        entry.themes.push(theme.name);
        entry.argumentInstances.push({ theme: theme.name, themeIdx, argIdx, arg });
      });
    });

    // Find arguments that appear in multiple themes
    const crossThemeArguments = Array.from(argumentSignatureMap.entries())
      .filter(([sig, entry]) => entry.themes.length > 1);

    if (crossThemeArguments.length === 0) {
      console.log(`[ThemeMapper] No cross-theme arguments found, skipping deduplication`);
      return { themes, deduplicatedCount: 0, duplicatePairs: [] };
    }

    console.log(`[ThemeMapper] Found ${crossThemeArguments.length} arguments appearing in multiple themes`);

    // Optimization: Batch embedding requests
    const uniqueTexts = new Set();
    const textToEmbeddingMap = new Map();

    // 1. Collect all unique texts needed
    for (const [signature, entry] of crossThemeArguments) {
      const instances = entry.argumentInstances;
      for (const inst of instances) {
        const text = this.createArgumentEmbeddingText(inst.arg);
        if (text) uniqueTexts.add(text);
      }
    }

    console.log(`[ThemeMapper] Batch embedding ${uniqueTexts.size} unique argument texts...`);

    // 2. Embed all texts in batches
    if (uniqueTexts.size > 0) {
      const textsArray = Array.from(uniqueTexts);
      try {
        const embeddings = await this.embedder.embedBatch(textsArray);
        textsArray.forEach((text, idx) => {
          if (embeddings[idx]) {
            textToEmbeddingMap.set(text, embeddings[idx]);
          }
        });
      } catch (error) {
        console.error(`[ThemeMapper] Failed to generate embeddings for deduplication:`, error);
        // Continue with empty map, effectively skipping deduplication that requires embeddings
      }
    }

    // For each cross-theme argument, calculate embedding similarity using cached embeddings
    const deduplicationDecisions = [];

    for (const [signature, entry] of crossThemeArguments) {
      const instances = entry.argumentInstances;

      // Compare all pairs of instances
      for (let i = 0; i < instances.length; i++) {
        for (let j = i + 1; j < instances.length; j++) {
          const inst1 = instances[i];
          const inst2 = instances[j];

          // Create embedding texts
          const text1 = this.createArgumentEmbeddingText(inst1.arg);
          const text2 = this.createArgumentEmbeddingText(inst2.arg);

          // Get pre-calculated embeddings
          const emb1 = textToEmbeddingMap.get(text1);
          const emb2 = textToEmbeddingMap.get(text2);

          if (!emb1 || !emb2) {
            // Skip if embeddings are missing
            continue;
          }

          // Calculate cosine similarity
          const similarity = this.cosineSimilarity(emb1, emb2);

          if (similarity >= this.deduplicationThreshold) {
            // CHANGED: Instead of removing, mark for MERGING responseNumbers
            // This preserves attribution - both respondents said similar things
            deduplicationDecisions.push({
              signature,
              keepTheme: entry.primaryTheme,
              keepThemeIdx: entry.primaryThemeIdx,
              keepArgIdx: entry.primaryArgIdx,
              removeTheme: inst2.theme,
              removeThemeIdx: inst2.themeIdx,
              removeArgIdx: inst2.argIdx,
              removeResponseNumber: inst2.arg.responseNumber,
              similarity,
              // Check if both are in same copy/paste group
              sameGroup: inst1.arg._copyPasteGroupId !== undefined &&
                        inst1.arg._copyPasteGroupId === inst2.arg._copyPasteGroupId
            });
          }
        }
      }
    }

    // CHANGED: Apply deduplication by MERGING responseNumbers, not removing
    // Build maps for merging and removing
    const mergeInstructions = new Map(); // keepKey -> Set of responseNumbers to merge
    const themesToRemove = new Map(); // themeIdx -> Set of argIdx to remove

    deduplicationDecisions.forEach(decision => {
      // Key for the argument we're keeping
      const keepKey = `${decision.keepThemeIdx}:${decision.keepArgIdx}`;

      // Track responseNumbers to merge into the kept argument
      if (!mergeInstructions.has(keepKey)) {
        mergeInstructions.set(keepKey, new Set());
      }
      mergeInstructions.get(keepKey).add(decision.removeResponseNumber);

      // Still track removal of the duplicate
      if (!themesToRemove.has(decision.removeThemeIdx)) {
        themesToRemove.set(decision.removeThemeIdx, new Set());
      }
      themesToRemove.get(decision.removeThemeIdx).add(decision.removeArgIdx);

      // Log merge (not removal)
      const sameGroupNote = decision.sameGroup ? ' (same copy/paste group)' : '';
      console.log(`[ThemeMapper] Dedup: merging response ${decision.removeResponseNumber} into ${decision.keepTheme} argument${sameGroupNote}`);
    });

    // Apply merges and removals
    const deduplicatedThemes = themes.map((theme, themeIdx) => {
      const updatedArguments = theme.arguments.map((arg, argIdx) => {
        const key = `${themeIdx}:${argIdx}`;

        // Check if we need to merge responseNumbers into this argument
        if (mergeInstructions.has(key)) {
          const mergeSet = mergeInstructions.get(key);
          const existingNumbers = arg.responseNumbers || [arg.responseNumber];
          const mergedNumbers = [...new Set([...existingNumbers, ...mergeSet])];

          return {
            ...arg,
            responseNumbers: mergedNumbers,
            _deduplicatedFrom: [...mergeSet] // Track which responses were merged
          };
        }
        return arg;
      });

      // Filter out arguments marked for removal (their responseNumbers are now merged elsewhere)
      const indicesToRemove = themesToRemove.get(themeIdx) || new Set();
      const filteredArguments = updatedArguments.filter((arg, argIdx) =>
        !indicesToRemove.has(argIdx)
      );

      return {
        ...theme,
        arguments: filteredArguments
      };
    });

    const mergedCount = deduplicationDecisions.length;
    console.log(`[ThemeMapper] Deduplication complete: merged ${mergedCount} duplicate arguments (attribution preserved)`);

    return {
      themes: deduplicatedThemes,
      deduplicatedCount: deduplicationDecisions.length,
      duplicatePairs: deduplicationDecisions
    };
  }

  /**
   * Create embedding text for an argument
   * @private
   */
  createArgumentEmbeddingText(arg) {
    const parts = [];
    if (arg.coreContent) parts.push(arg.coreContent);
    if (arg.concern) parts.push(arg.concern);
    if (arg.desiredAction) parts.push(arg.desiredAction);
    return parts.join(' ');
  }

  /**
   * Calculate cosine similarity between two vectors
   * @private
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  // extractThemes moved to ThemeExtractor class

  /**
   * Find closest theme by name similarity
   * Uses alias mapping first, then falls back to Jaccard similarity
   */
  findClosestTheme(targetName, themes) {
    if (!targetName) return null;

    const target = targetName.toLowerCase().trim();
    
    // THEME ALIASES: Map common LLM-generated theme names to actual lokalplan themes
    // This fixes the issue where "Trafik og vejintegration" doesn't match "Veje"
    // NOTE: These should map TO the ACTUAL § overskrifter from høringsmaterialet
    const THEME_ALIASES = {
      // § 4 - Veje (NOT "Trafik og adgange")
      'trafik og vejintegration': ['veje'],
      'trafik og adgange (veje og stier)': ['veje'],
      'trafik og adgange': ['veje'],
      'trafik og forbindelser': ['veje'],
      'trafik': ['veje'],
      'vejforhold': ['veje'],
      'trafikforhold': ['veje'],
      'trafikale forhold': ['veje'],
      
      // § 5 - Bil- og cykelparkering (the FULL name)
      'parkering': ['bil- og cykelparkering'],
      'bilparkering': ['bil- og cykelparkering'],
      'cykelparkering': ['bil- og cykelparkering'],
      
      // § 8 - Ubebyggede arealer
      'ubebyggede arealer og byrum': ['ubebyggede arealer'],
      'byrum': ['ubebyggede arealer'],
      'friarealer': ['ubebyggede arealer'],
      'byrum og kantzoner': ['ubebyggede arealer'],
      
      // § 5 - Bebyggelsens omfang og placering (includes bevaringsværdige bygninger)
      'bebyggelse': ['bebyggelsens omfang og placering'],
      'bygningshøjde': ['bebyggelsens omfang og placering'],
      'højde': ['bebyggelsens omfang og placering'],
      'etager': ['bebyggelsens omfang og placering'],
      // CRITICAL: Bevarings-argumenter skal tematiseres til § 5, ikke § 1 (Formål)
      'bevaring': ['bebyggelsens omfang og placering'],
      'bevaringsværdig': ['bebyggelsens omfang og placering'],
      'bevaringsværdige bygninger': ['bebyggelsens omfang og placering'],
      'nedrivning': ['bebyggelsens omfang og placering'],
      'fredning': ['bebyggelsens omfang og placering'],
      
      // § 7 - Bebyggelsens ydre fremtræden
      'facade': ['bebyggelsens ydre fremtræden'],
      'arkitektur': ['bebyggelsens ydre fremtræden'],
      'udseende': ['bebyggelsens ydre fremtræden'],
      'materialer': ['bebyggelsens ydre fremtræden'],
      
      // § 9 - Støj og anden forurening
      'støjforhold': ['støj og anden forurening'],
      'støj': ['støj og anden forurening'],
      'forurening': ['støj og anden forurening'],
      'akustik': ['støj og anden forurening'],
      
      // Non-existent themes → Andre emner
      'miljø': ['andre emner'],
      'miljøforhold': ['andre emner'],
      'miljø og risiko': ['andre emner'],
      'kulturmiljø': ['andre emner'],
      'kulturmiljø og omkringliggende områder': ['andre emner'],
      
      // Other standard mappings
      'grundejer': ['grundejerforening'],
      'matrikel': ['matrikulære forhold'],
      'servitut': ['ophævelse af lokalplaner og servitutter']
    };
    
    // Check alias mapping FIRST (highest priority)
    if (THEME_ALIASES[target]) {
      for (const alias of THEME_ALIASES[target]) {
        const aliasMatch = themes.find(t => 
          t.name.toLowerCase().includes(alias)
        );
        if (aliasMatch) {
          console.log(`[ThemeMapper] Alias match: "${targetName}" → "${aliasMatch.name}"`);
          return aliasMatch;
        }
      }
    }
    
    // Also check partial alias matches (e.g., "trafik og sikkerhed" contains "trafik")
    for (const [aliasKey, aliasTargets] of Object.entries(THEME_ALIASES)) {
      if (target.includes(aliasKey) || aliasKey.includes(target)) {
        for (const alias of aliasTargets) {
          const aliasMatch = themes.find(t => 
            t.name.toLowerCase().includes(alias)
          );
          if (aliasMatch) {
            console.log(`[ThemeMapper] Partial alias match: "${targetName}" (via "${aliasKey}") → "${aliasMatch.name}"`);
            return aliasMatch;
          }
        }
      }
    }
    
    // Fallback to original Jaccard similarity matching
    let bestMatch = null;
    let maxSimilarity = 0;

    for (const theme of themes) {
      const current = theme.name.toLowerCase().trim();

      // Check for substring match
      if (current.includes(target) || target.includes(current)) {
        // Prefer the one with higher Jaccard similarity to avoid "Plan" matching "Lokalplan" too easily
        const sim = this.calculateJaccardSimilarity(target, current);
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
          bestMatch = theme;
        }
      } else {
        // Check Jaccard similarity (token overlap)
        const sim = this.calculateJaccardSimilarity(target, current);
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
          bestMatch = theme;
        }
      }
    }

    // Threshold for acceptance
    if (maxSimilarity > 0.25) { // Low threshold because we want to catch paraphrasing
      return bestMatch;
    }

    return null;
  }

  /**
   * Calculate Jaccard similarity between two strings (token based)
   */
  calculateJaccardSimilarity(str1, str2) {
    const tokens1 = new Set(str1.split(/\s+/).filter(t => t.length > 2));
    const tokens2 = new Set(str2.split(/\s+/).filter(t => t.length > 2));

    if (tokens1.size === 0 || tokens2.size === 0) return 0;

    let intersection = 0;
    for (const token of tokens1) {
      if (tokens2.has(token)) intersection++;
    }

    const union = tokens1.size + tokens2.size - intersection;
    return intersection / union;
  }

  /**
   * Match argument to theme based on substanceRefs (§-references).
   * substanceRefs directly reference lokalplan paragraphs which are more reliable
   * than LLM-generated relevantThemes that can conflate generic process-words.
   *
   * @param {Object} argument - The argument with substanceRefs
   * @param {Array} themes - Available themes
   * @returns {Object|null} Matched theme or null
   */
  matchThemeBySubstanceRefs(argument, themes) {
    const substanceRefs = argument.substanceRefs || [];
    if (substanceRefs.length === 0) {
      return null;
    }

    // PRIORITY 1: Check if any substanceRef contains a direct theme name match
    // E.g., "LP_§6_ydre_fremtræden" should match "Bebyggelsens ydre fremtræden"
    // This is more reliable than generic § number mapping
    for (const ref of substanceRefs) {
      const refLower = ref.toLowerCase().replace(/_/g, ' ');

      // Keywords that indicate specific themes (extracted from substanceRef descriptive part)
      const themeIndicators = [
        { keywords: ['ydre fremtræden', 'ydre_fremtrædne', 'facade'], theme: 'ydre fremtræden' },
        { keywords: ['omfang og placering', 'hoejde', 'højde', 'bebyggelsesprocent'], theme: 'omfang' },
        { keywords: ['anvendelse'], theme: 'anvendelse' },
        { keywords: ['parkering', 'cykelparkering', 'bilparkering'], theme: 'parkering' },
        { keywords: ['ubebyggede arealer', 'friarealer', 'byrum'], theme: 'ubebyggede' },
        { keywords: ['veje', 'stier', 'adgang'], theme: 'veje' },
        { keywords: ['støj', 'forurening'], theme: 'støj' }
      ];

      for (const indicator of themeIndicators) {
        if (indicator.keywords.some(kw => refLower.includes(kw))) {
          // Find matching theme
          for (const theme of themes) {
            const themeLower = theme.name.toLowerCase();
            if (themeLower.includes(indicator.theme)) {
              return theme;
            }
          }
        }
      }
    }

    // PRIORITY 2: Fall back to § number based matching
    // Only used if no descriptive match was found
    const paragraphNumbers = new Set();

    for (const ref of substanceRefs) {
      // Match patterns like "LP-§5", "PALADS-§5", "LP_§6_"
      // But SKIP refs that had descriptive content (already handled above)
      if (ref.match(/_(ydre|omfang|anvendelse|parkering|ubebyggede|veje|støj)/i)) {
        continue; // Skip - should have been matched by priority 1
      }

      const match = ref.match(/[§_-](\d+)/);
      if (match) {
        paragraphNumbers.add(parseInt(match[1], 10));
      }
    }

    if (paragraphNumbers.size === 0) {
      return null;
    }

    // Map § numbers to standard theme names
    // This is a FALLBACK - descriptive refs are more reliable
    const PARAGRAPH_TO_THEME = {
      1: ['formål'],
      2: ['område', 'områdets afgrænsning'],
      3: ['anvendelse'],
      4: ['veje', 'vej', 'adgange', 'stier'],
      5: ['bebyggelsens omfang', 'omfang og placering'],
      6: ['bebyggelsens ydre fremtræden', 'ydre fremtræden', 'facade'],
      7: ['ubebyggede arealer', 'friarealer', 'byrum'],
      8: ['støj', 'forurening', 'miljø'],
      9: ['grundejerforening', 'grundejer'],
      10: ['ophævelse', 'servitutter'],
      11: ['forudsætninger', 'betingelser'],
      12: ['retsvirkninger']
    };

    // Use the LOWEST § number (most fundamental theme)
    const sortedParagraphs = Array.from(paragraphNumbers).sort((a, b) => a - b);

    for (const paragraphNum of sortedParagraphs) {
      const themeKeywords = PARAGRAPH_TO_THEME[paragraphNum];
      if (!themeKeywords) continue;

      for (const theme of themes) {
        const themeLower = theme.name.toLowerCase();
        for (const keyword of themeKeywords) {
          if (themeLower.includes(keyword)) {
            return theme;
          }
        }
      }
    }

    return null;
  }

  /**
   * Match argument to theme by physical elements mentioned in argument.
   * Uses RAG to look up what the hearing material says about physical elements.
   *
   * DISABLED: Theme correction has been removed because:
   * 1. RAG context is already provided to the LLM in micro-summarizer
   * 2. The LLM makes the theme decision based on that context
   * 3. Overriding the LLM's decision here caused more problems than it solved
   *
   * The RAG substance is still used - but as INPUT to the LLM, not as a post-hoc override.
   * See micro-summarizer.js lines 180-206 where RAG context is injected.
   */
  async matchThemeByRegulates(argument, themes) {
    // DISABLED: Let the LLM's theme assignment stand
    // RAG context is already provided to the LLM during micro-summarization
    // Overriding here caused incorrect theme mappings
    return null;
  }

  /**
   * Match argument to theme by content analysis.
   * Priority: 1. physical elements (via RAG), 2. bevarings-specific rescue, 3. name keywords
   */
  async matchThemeByContent(argument, themes) {
    // First try physical element matching (uses RAG)
    const regulatesMatch = await this.matchThemeByRegulates(argument, themes);
    if (regulatesMatch) {
      return regulatesMatch;
    }

    // Build content for keyword fallback
    const contentParts = [
      argument.what || '',
      argument.coreContent || '',
      argument.concern || '',
      argument.desiredAction || ''
    ];
    const content = contentParts.join(' ').toLowerCase();
    
    if (!content.trim()) return null;

    // BEVARINGS-SPECIFIC RESCUE: Arguments about "bevaring", "bevaringsværdig", "nedrivning", "fredning"
    // should be placed in "Bebyggelsens omfang og placering" (§5), not "Formål" (§1)
    // This is because § 5 is where building preservation is actually regulated
    const bevaringsKeywords = ['bevar', 'bevaring', 'bevaringsværdig', 'nedriv', 'nedrivning', 'frede', 'fredning', 'kulturarv'];
    const hasBevaringsContent = bevaringsKeywords.some(keyword => content.includes(keyword));
    
    if (hasBevaringsContent) {
      // Look for "Bebyggelsens omfang og placering" theme
      const omfangTheme = themes.find(t => 
        t.name.toLowerCase().includes('bebyggelsens omfang') || 
        t.name.toLowerCase().includes('omfang og placering')
      );
      if (omfangTheme) {
        console.log(`[ThemeMapper] Bevarings-rescue: matched to "${omfangTheme.name}" based on content keywords`);
        return omfangTheme;
      }
    }

    // Fallback to keyword matching from theme name
    for (const theme of themes) {
      const themeKeywords = theme.name.toLowerCase().split(/\s+/);
      const matches = themeKeywords.filter(keyword =>
        keyword.length > 3 && content.includes(keyword)
      ).length;

      if (matches >= Math.min(2, themeKeywords.length)) {
        return theme;
      }
    }

    return null;
  }
}
