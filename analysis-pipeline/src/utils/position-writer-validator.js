import { ModelReranker } from '../retrieval/model-reranker.js';

export class PositionWriterValidator {
  constructor() {
    // Lazy-initialized reranker for semantic validation
    this._reranker = null;
  }

  /**
   * Validate linguistic constraints that are not covered by reference-structure validation.
   *
   * Goals:
   * - Prevent actor-subject + passive (-s / -es) constructions like:
   *   "Én borger<<REF_1>> fremhæves ..."
   * - Enforce mega-position master-holdning:
   *   summary must start with "Der<<REF_1>>" and REF_1 must cover ALL respondents.
   * - Detect likely overlap between master-holdning and sub-positions (warning-level).
   *
   * @param {Object} positionInput - Writer input (includes respondents + position metadata)
   * @param {Object|string} hybridOutput - Parsed LLM output
   * @returns {Object} { valid, errors, warnings, stats }
   */
  validateLinguisticConsistency(positionInput, hybridOutput) {
    const errors = [];
    const warnings = [];
    const stats = {};

    let summary = '';
    let references = [];

    if (typeof hybridOutput === 'string') {
      summary = hybridOutput || '';
    } else if (hybridOutput && typeof hybridOutput === 'object') {
      summary = hybridOutput.summary || '';
      references = Array.isArray(hybridOutput.references) ? hybridOutput.references : [];
    }

    if (!summary || typeof summary !== 'string' || !summary.trim()) {
      // Let structure validation handle this; don't double-report.
      return { valid: true, errors: [], warnings: [], stats: { skipped: 'empty-summary' } };
    }

    // --- 1) Grammar: actor-subject + passive (-s / -es) ---
    // We intentionally keep this conservative with a verb allowlist to avoid false positives.
    // IMPORTANT: Do NOT use \b for Danish letters like "én" (é is not \w in JS),
    // otherwise we miss exactly the patterns we need to catch.
    const actorPassiveVerbPattern =
      /(^|[^\p{L}\p{N}_])((?:én|Én|to|To|tre|Tre|fire|Fire|fem|Fem|seks|Seks|syv|Syv|otte|Otte|ni|Ni|ti|Ti|elleve|Elleve|tolv|Tolv|\d+)\s+borgere?\s*<<REF_\d+>>\s+)(udtrykkes|fremhæves|anføres|påpeges|vurderes|kritiseres|foreslås|bemærkes|gøres|skønnes|peges)\b/gu;

    const actorPassiveMatches = [];
    let m;
    while ((m = actorPassiveVerbPattern.exec(summary)) !== null) {
      actorPassiveMatches.push(`${m[2]}${m[3]}`.trim());
      // Safety against zero-width loops (shouldn't happen, but defensive)
      if (m.index === actorPassiveVerbPattern.lastIndex) actorPassiveVerbPattern.lastIndex++;
      if (actorPassiveMatches.length >= 10) break;
    }

    if (actorPassiveMatches.length > 0) {
      stats.actorPassiveMatches = actorPassiveMatches.length;
      errors.push(
        `Grammatikfejl: aktør-subjekt kombineret med passiv (-s) fundet (fx "${actorPassiveMatches[0]}").`
      );
    }

    // --- 2) Mega-position master-holdning must be Der<<REF_1>> covering ALL respondents ---
    const hasSubPositions =
      !!(positionInput?.position?.subPositionsRequired) ||
      (Array.isArray(positionInput?.position?.subPositions) && positionInput.position.subPositions.length > 0);

    if (hasSubPositions) {
      const expected = new Set((positionInput?.respondents || []).map(r => r.responseNumber).filter(Boolean));
      stats.expectedRespondentCount = expected.size;

      // Require summary to start with Der<<REF_1>> (allow leading whitespace/newlines)
      const startsWithDerRef1 = /^\s*Der<<REF_1>>(?:\s|$)/.test(summary);
      if (!startsWithDerRef1) {
        errors.push(`Master-holdning fejl: summary skal starte med "Der<<REF_1>>" når der er sub-positioner.`);
      }

      const ref1 = references.find(r => r && r.id === 'REF_1');
      if (!ref1) {
        errors.push(`Master-holdning fejl: references mangler REF_1.`);
      } else {
        if ((ref1.label || '').trim() !== 'Der') {
          errors.push(`Master-holdning fejl: REF_1.label skal være "Der" (var "${ref1.label || ''}").`);
        }

        const actualNums = new Set((ref1.respondents || []).map(x => (typeof x === 'object' && x ? x.responseNumber : x)).filter(Boolean));
        stats.ref1RespondentCount = actualNums.size;

        if (expected.size > 0) {
          // Must match EXACTLY (no missing, no extra)
          const missing = [...expected].filter(n => !actualNums.has(n));
          const extra = [...actualNums].filter(n => !expected.has(n));

          if (missing.length > 0) {
            errors.push(`Master-holdning fejl: REF_1 dækker ikke alle respondenter (mangler ${missing.length}).`);
          }
          if (extra.length > 0) {
            errors.push(`Master-holdning fejl: REF_1 indeholder ukendte respondenter (ekstra ${extra.length}).`);
          }
        }
      }

      // --- 3) Overlap master/sub-position (warning) ---
      // Heuristic: look at master segment before first non-REF_1 placeholder.
      const otherRefMatch = summary.match(/<<REF_(?!1\b)\d+>>/);
      const masterSegment = (otherRefMatch ? summary.slice(0, otherRefMatch.index) : summary).slice(0, 1500);

      const subPositions = Array.isArray(positionInput?.position?.subPositions) ? positionInput.position.subPositions : [];
      if (subPositions.length > 0 && masterSegment.trim().length > 0) {
        const normalizedMaster = this._normalizeForOverlap(masterSegment);
        for (const sp of subPositions.slice(0, 15)) { // cap for speed
          const hint = [sp?.title, sp?.what, sp?.why, sp?.how, sp?.summary].filter(Boolean).join(' ');
          const normalizedHint = this._normalizeForOverlap(hint).slice(0, 300);
          if (normalizedHint.length < 60) continue;

          // Warning if a long phrase from sub-position appears verbatim in master segment
          const needle = normalizedHint.slice(0, 80);
          if (needle.length >= 60 && normalizedMaster.includes(needle)) {
            warnings.push(`Muligt overlap: master-holdning indeholder tekst der ligner sub-position "${(sp?.title || '').slice(0, 60)}..."`);
            break;
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings, stats };
  }

  /**
   * Normalize text for overlap heuristics (not for display).
   * @private
   */
  _normalizeForOverlap(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, '') // keep letters+digits+space (unicode)
      .trim();
  }

  /**
   * Get or create the ModelReranker instance
   * @private
   */
  _getReranker() {
    if (!this._reranker) {
      this._reranker = new ModelReranker({ enabled: true });
    }
    return this._reranker;
  }

  /**
   * Validate hybrid output structure and citation coverage
   * @param {Object} positionInput - Input containing respondents list
   * @param {Object|string} hybridOutput - Output from LLM (object or string)
   */
  validateHybridOutput(positionInput, hybridOutput) {
    const errors = [];
    const warnings = [];
    
    let summary = '';
    let references = [];

    // Handle both object and string input
    if (typeof hybridOutput === 'string') {
      summary = hybridOutput;
    } else if (hybridOutput && typeof hybridOutput === 'object') {
      summary = hybridOutput.summary || '';
      references = hybridOutput.references || [];
    }

    // 1. Validate summary existence
    if (!summary || typeof summary !== 'string' || !summary.trim()) {
      errors.push('Summary missing or empty');
      return { valid: false, errors, warnings };
    }

    // 2. Validate citation coverage
    const expected = new Set(positionInput.respondents.map(r => r.responseNumber));
    const cited = new Set();

    // Check for new format: <<REF_ID>>
    const refMatches = summary.match(/<<REF_([a-zA-Z0-9_]+)>>/g) || [];
    
    if (refMatches.length > 0) {
      // Verify against references array
      refMatches.forEach(tag => {
        // Extract ID from tag (<<REF_1>> -> REF_1)
        const idMatch = tag.match(/<<(.+)>>/);
        const refId = idMatch ? idMatch[1] : null;
        
        if (refId) {
          // Find in references
          const refDef = references.find(r => r.id === refId);
          if (refDef && Array.isArray(refDef.respondents)) {
             refDef.respondents.forEach(r => {
               // Handle both simple numbers and objects (defensive)
               const rNum = (typeof r === 'object' && r !== null) ? r.responseNumber : r;
               if (rNum) cited.add(parseInt(rNum, 10));
             });
          } else {
             // Reference found in text but not defined in array
             // We can't count this as a valid citation for a specific respondent
             // But we acknowledge the tag exists.
          }
        }
      });
    } 
    
    // Fallback: Check for legacy format **Henvendelse X** if no REF tags found
    // (Or if we want to support mixed usage, though unlikely)
    if (cited.size === 0) {
      const legacyMatches = summary.match(/\*\*Henvendelse (\d+)\*\*/g) || [];
      legacyMatches.forEach(match => {
        const numMatch = match.match(/\d+/);
        if (numMatch) {
          cited.add(parseInt(numMatch[0], 10));
        }
      });
    }

    // Check if all expected respondents are cited
    expected.forEach(responseNumber => {
      if (!cited.has(responseNumber)) {
        errors.push(`Manglende citation for henvendelse ${responseNumber}`);
      }
    });

    if (cited.size === 0) {
      warnings.push('Ingen citationer fundet i opsummeringen');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      citedResponseNumbers: Array.from(cited).sort((a, b) => a - b)
    };
  }

  /**
   * Validate title/content coherence using BGE cross-encoder reranker.
   * Detects when position titles don't match the actual respondent content.
   * 
   * @param {Object} position - Position with title
   * @param {Object} writerInput - Writer input containing respondents
   * @returns {Promise<Object>} Validation result with { valid, avgScore, issue }
   */
  async validateTitleContentCoherence(position, writerInput) {
    const title = position?.title || '';
    
    if (!title || !writerInput?.respondents?.length) {
      return { valid: true, avgScore: null, issue: null };
    }

    try {
      const reranker = this._getReranker();
      
      // Sample up to 10 respondent excerpts for scoring
      const contents = writerInput.respondents
        .slice(0, 10)
        .map(r => r.excerpt || r.snippets?.[0]?.text || '')
        .filter(Boolean);
      
      if (contents.length === 0) {
        return { valid: true, avgScore: null, issue: null };
      }
      
      // Use reranker to score title against content
      const chunks = contents.map(content => ({ content }));
      const scores = await reranker.rerank(title, chunks);
      
      // Calculate average score
      const validScores = scores
        .map(s => s.rerankScore || 0)
        .filter(s => s > 0);
      
      if (validScores.length === 0) {
        return { valid: true, avgScore: 0, issue: null };
      }
      
      const avgScore = validScores.reduce((sum, s) => sum + s, 0) / validScores.length;
      
      // Threshold: if average relevance score is < 0.3, flag as potential mismatch
      if (avgScore < 0.3) {
        return {
          valid: false,
          avgScore: avgScore,
          issue: `Title/content mismatch detected (avg relevance score: ${avgScore.toFixed(2)}). Title "${title.substring(0, 50)}..." may not accurately represent respondent content.`
        };
      }
      
      return { valid: true, avgScore: avgScore, issue: null };
      
    } catch (error) {
      // If reranker fails (e.g., Python not available), don't block validation
      console.warn(`[PositionWriterValidator] Title coherence validation skipped: ${error.message}`);
      return { valid: true, avgScore: null, issue: null, skipped: true };
    }
  }

  /**
   * Validate quote coverage for small groups (<=15 respondents).
   * Ensures each respondent in a small group has a quote.
   * 
   * @param {Object} hybridOutput - The hybrid output with references
   * @returns {Object} Validation result with { valid, issues }
   */
  validateQuoteCoverage(hybridOutput) {
    const issues = [];
    
    if (!hybridOutput?.references) {
      return { valid: true, issues };
    }
    
    hybridOutput.references.forEach(ref => {
      const groupSize = ref.respondents?.length || 0;
      
      if (groupSize > 0 && groupSize <= 15) {
        // Small group: each respondent should have a quote
        const quotedRespondents = new Set(
          (ref.quotes || []).map(q => q.responseNumber)
        );
        
        const missingQuotes = ref.respondents.filter(r => !quotedRespondents.has(r));
        
        if (missingQuotes.length > 0) {
          issues.push({
            refId: ref.id,
            groupSize: groupSize,
            missingQuotes: missingQuotes,
            message: `REF ${ref.id}: Missing quotes for ${missingQuotes.length}/${groupSize} respondents: ${missingQuotes.join(', ')}`
          });
        }
      } else if (groupSize > 15) {
        // Large group: should have NO quotes (only list)
        if (ref.quotes && ref.quotes.length > 0) {
          issues.push({
            refId: ref.id,
            groupSize: groupSize,
            message: `REF ${ref.id}: Large group (${groupSize}) should not have quotes, but has ${ref.quotes.length}`
          });
        }
      }
    });
    
    return {
      valid: issues.length === 0,
      issues
    };
  }
}
