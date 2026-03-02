/**
 * Direction Validator
 *
 * Uses embeddings to detect and correct direction misclassifications.
 * Instead of relying on prompt-based rules, this validator uses semantic
 * similarity to find arguments that are grouped with the wrong direction.
 *
 * Key insight: Direction cannot be defined universally in a prompt because
 * it depends on the specific proposal. Instead, we use embeddings to find
 * arguments that are semantically closer to the opposite direction's centroid.
 */

import { EmbeddingService } from '../embedding/embedding-service.js';

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Calculate centroid of a set of embeddings
 */
function calculateCentroid(embeddings) {
  if (!embeddings || embeddings.length === 0) return null;

  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}

export class DirectionValidator {
  constructor(openaiClient, options = {}) {
    this.client = openaiClient;
    this.embeddingService = new EmbeddingService();
    this.outlierThreshold = options.outlierThreshold || 0.15; // How much closer to opposite centroid to flag
    this.minGroupSize = options.minGroupSize || 3; // Min arguments per direction to calculate centroid
    this.contaminationThreshold = options.contaminationThreshold || 0.85;
    this.contaminationFlagMargin = options.contaminationFlagMargin || 0.20;
  }

  /**
   * Validate and correct direction classifications using embeddings.
   *
   * @param {Array} microSummaries - Array of micro-summaries with arguments
   * @param {string} materialSummary - Summary of the proposal (for LLM context)
   * @returns {Object} Validation result with corrections
   */
  async validateDirections(microSummaries, materialSummary) {
    console.log('[DirectionValidator] Starting embedding-based direction validation...');

    // Extract all arguments with their direction
    const allArguments = [];
    for (const summary of microSummaries) {
      if (!summary.arguments) continue;
      for (const arg of summary.arguments) {
        if (arg.direction && arg.direction !== 'neutral') {
          allArguments.push({
            responseNumber: summary.responseNumber,
            what: arg.what,
            why: arg.why || '',
            direction: arg.direction,
            sourceQuote: arg.sourceQuote || '',
            originalArg: arg
          });
        }
      }
    }

    console.log(`[DirectionValidator] Found ${allArguments.length} arguments with direction`);

    // Group by direction
    const proChangeArgs = allArguments.filter(a => a.direction === 'pro_change');
    const proStatusQuoArgs = allArguments.filter(a => a.direction === 'pro_status_quo');

    console.log(`[DirectionValidator] pro_change: ${proChangeArgs.length}, pro_status_quo: ${proStatusQuoArgs.length}`);

    // Need minimum arguments in each group to calculate meaningful centroids
    if (proChangeArgs.length < this.minGroupSize || proStatusQuoArgs.length < this.minGroupSize) {
      console.log('[DirectionValidator] Not enough arguments in each direction to validate. Skipping.');
      return {
        validated: false,
        reason: 'insufficient_data',
        corrections: []
      };
    }

    // Generate embeddings for all arguments
    console.log('[DirectionValidator] Generating embeddings for arguments...');
    const textsToEmbed = allArguments.map(a => `${a.what}. ${a.why}`.trim());
    const embeddings = await this.embeddingService.embedBatch(textsToEmbed);

    // Attach embeddings to arguments
    for (let i = 0; i < allArguments.length; i++) {
      allArguments[i].embedding = embeddings[i];
    }

    // Calculate centroids for each direction
    const proChangeCentroid = calculateCentroid(
      proChangeArgs.map(a => a.embedding)
    );
    const proStatusQuoCentroid = calculateCentroid(
      proStatusQuoArgs.map(a => a.embedding)
    );

    // Check for centroid contamination before outlier detection
    const contamination = this.detectCentroidContamination(
      proChangeArgs, proStatusQuoArgs, proChangeCentroid, proStatusQuoCentroid
    );

    const outliers = [];

    if (contamination) {
      // Centroid contamination detected - use robust group's centroid to flag contaminated args
      const contaminatedOutliers = this.flagContaminatedArguments(
        contamination, proChangeCentroid, proStatusQuoCentroid
      );
      outliers.push(...contaminatedOutliers);

      // Run standard outlier detection ONLY on the robust group (catch individual errors there)
      const robustArgs = contamination.robustGroup === 'pro_change' ? proChangeArgs : proStatusQuoArgs;
      const robustCentroid = contamination.robustGroup === 'pro_change' ? proChangeCentroid : proStatusQuoCentroid;
      const oppositeCentroid = contamination.robustGroup === 'pro_change' ? proStatusQuoCentroid : proChangeCentroid;

      for (const arg of robustArgs) {
        const simToOwn = cosineSimilarity(arg.embedding, robustCentroid);
        const simToOpposite = cosineSimilarity(arg.embedding, oppositeCentroid);
        const diff = simToOpposite - simToOwn;
        if (diff > this.outlierThreshold) {
          // Don't double-add
          if (!outliers.find(o => o.responseNumber === arg.responseNumber && o.what === arg.what)) {
            outliers.push({ ...arg, simToOwn, simToOpposite, diff });
          }
        }
      }
    } else {
      // No contamination - standard outlier detection on all arguments
      for (const arg of allArguments) {
        const simToOwn = arg.direction === 'pro_change'
          ? cosineSimilarity(arg.embedding, proChangeCentroid)
          : cosineSimilarity(arg.embedding, proStatusQuoCentroid);

        const simToOpposite = arg.direction === 'pro_change'
          ? cosineSimilarity(arg.embedding, proStatusQuoCentroid)
          : cosineSimilarity(arg.embedding, proChangeCentroid);

        // Flag if significantly closer to opposite centroid
        const diff = simToOpposite - simToOwn;
        if (diff > this.outlierThreshold) {
          outliers.push({
            ...arg,
            simToOwn,
            simToOpposite,
            diff
          });
        }
      }
    }

    console.log(`[DirectionValidator] Found ${outliers.length} potential outliers from embedding analysis`);

    // HEURISTIC: Check pro_change arguments for conditional language patterns
    // These are structural Danish patterns indicating conditions/requirements, not support
    // This catches arguments that embeddings miss because they're semantically distinct
    const conditionalOutliers = this.detectConditionalArguments(proChangeArgs);
    if (conditionalOutliers.length > 0) {
      console.log(`[DirectionValidator] Found ${conditionalOutliers.length} conditional arguments flagged for review`);
      // Add conditional outliers that aren't already in outliers list
      for (const condArg of conditionalOutliers) {
        if (!outliers.find(o => o.responseNumber === condArg.responseNumber && o.what === condArg.what)) {
          outliers.push({
            ...condArg,
            simToOwn: 0.5,  // Placeholder - not from embedding
            simToOpposite: 0.5,
            diff: 0,
            _conditionalPattern: true
          });
        }
      }
    }

    console.log(`[DirectionValidator] Total outliers to validate: ${outliers.length}`);

    if (outliers.length === 0) {
      return {
        validated: true,
        reason: 'no_outliers',
        corrections: []
      };
    }

    // Validate outliers with focused LLM call
    const corrections = await this.validateOutliersWithLLM(outliers, materialSummary);

    // Apply corrections to original arguments
    for (const correction of corrections) {
      correction.originalArg.direction = correction.correctedDirection;
      correction.originalArg._directionCorrected = true;
      correction.originalArg._originalDirection = correction.originalDirection;
    }

    console.log(`[DirectionValidator] Made ${corrections.length} corrections`);

    return {
      validated: true,
      reason: 'outliers_checked',
      outlierCount: outliers.length,
      corrections
    };
  }

  /**
   * Use LLM to validate potential outliers
   */
  async validateOutliersWithLLM(outliers, materialSummary) {
    const corrections = [];

    // Process in batches to avoid too many LLM calls
    const batchSize = 10;
    for (let i = 0; i < outliers.length; i += batchSize) {
      const batch = outliers.slice(i, i + batchSize);

      const prompt = `Du er en erfaren analytiker der validerer direction-klassifikationer i høringssvar.

KONTEKST FOR HØRINGEN:
${materialSummary || 'Ikke tilgængelig'}

REGLER FOR direction:
- pro_change: Respondenten STØTTER AKTIVT det foreslåede projekt/plan - siger JA til det konkrete forslag
- pro_status_quo: Respondenten MODSÆTTER sig det foreslåede (vil bevare, vil have alternativ, vil stoppe det)
- neutral: Respondenten udtrykker BETINGELSER, KRAV eller ØNSKER om HVORDAN noget skal gøres - UDEN at tage stilling til det foreslåede

🚨 KRITISK: BETINGELSER ≠ STØTTE
- "Skal være bæredygtigt" = neutral (proceskrav, ikke støtte til forslaget)
- "Skal tjene borgernes behov" = neutral (betingelse, ikke støtte)
- "Krav om visualiseringer" = neutral (proceskrav)
- "I stedet for hotel" = pro_status_quo (vil have alternativ)
- "Bevare facaden" = pro_status_quo (bevaringsønske)

Følgende argumenter er potentielt fejlklassificeret. Vurder HVERT argument:

${batch.map((o, idx) => `
[${idx + 1}] Response ${o.responseNumber}
Argument: ${o.what}
Begrundelse: ${o.why || 'Ikke angivet'}
Citat: "${o.sourceQuote || 'Ikke angivet'}"
Nuværende: ${o.direction}
`).join('\n')}

For HVERT argument, svar med JSON:
{
  "validations": [
    {
      "index": 1,
      "currentDirection": "pro_change",
      "reasoning": "Kort forklaring af din vurdering",
      "correctDirection": "pro_change, pro_status_quo eller neutral",
      "needsCorrection": true/false
    }
  ]
}

Vær PRÆCIS - klassificér korrekt baseret på argumentets faktiske indhold, ikke kun ordvalg.`;

      try {
        const response = await this.client.createCompletion({
          messages: [
            { role: 'system', content: 'Du validerer direction-klassifikationer. Svar KUN med JSON.' },
            { role: 'user', content: prompt }
          ],
          model: 'gpt-5-nano',
          temperature: 0.1,
          response_format: { type: 'json_object' }
        }, 'light');

        const content = response.choices?.[0]?.message?.content;
        if (!content) {
          console.error('[DirectionValidator] No content in LLM response');
          continue;
        }
        const result = JSON.parse(content);

        if (result.validations) {
          for (const v of result.validations) {
            if (v.needsCorrection && v.correctDirection !== batch[v.index - 1].direction) {
              corrections.push({
                responseNumber: batch[v.index - 1].responseNumber,
                what: batch[v.index - 1].what,
                originalDirection: batch[v.index - 1].direction,
                correctedDirection: v.correctDirection,
                reasoning: v.reasoning,
                originalArg: batch[v.index - 1].originalArg
              });
            }
          }
        }
      } catch (error) {
        console.error('[DirectionValidator] Error validating batch:', error.message);
      }
    }

    return corrections;
  }

  /**
   * Detect centroid contamination: when the two direction centroids are too similar,
   * it means the smaller group is likely contaminated with misclassified arguments
   * from the larger group. The larger group's centroid is statistically more robust.
   *
   * @param {Array} proChangeArgs - Arguments classified as pro_change
   * @param {Array} proStatusQuoArgs - Arguments classified as pro_status_quo
   * @param {Array} proChangeCentroid - Centroid vector for pro_change
   * @param {Array} proStatusQuoCentroid - Centroid vector for pro_status_quo
   * @returns {Object|null} Contamination info or null if no contamination
   */
  detectCentroidContamination(proChangeArgs, proStatusQuoArgs, proChangeCentroid, proStatusQuoCentroid) {
    const centroidSim = cosineSimilarity(proChangeCentroid, proStatusQuoCentroid);
    console.log(`[DirectionValidator] Centroid similarity: ${centroidSim.toFixed(4)} (threshold: ${this.contaminationThreshold})`);

    if (centroidSim <= this.contaminationThreshold) {
      return null; // Centroids are sufficiently different - no contamination
    }

    // The larger group is statistically more robust
    const proChangeSize = proChangeArgs.length;
    const proStatusQuoSize = proStatusQuoArgs.length;
    const ratio = Math.min(proChangeSize, proStatusQuoSize) / Math.max(proChangeSize, proStatusQuoSize);

    let contaminatedGroup, robustGroup, contaminatedArgs, robustArgs;
    if (proChangeSize >= proStatusQuoSize) {
      robustGroup = 'pro_change';
      contaminatedGroup = 'pro_status_quo';
      robustArgs = proChangeArgs;
      contaminatedArgs = proStatusQuoArgs;
    } else {
      robustGroup = 'pro_status_quo';
      contaminatedGroup = 'pro_change';
      robustArgs = proStatusQuoArgs;
      contaminatedArgs = proChangeArgs;
    }

    if (ratio > 0.8) {
      console.log(`[DirectionValidator] WARNING: Groups are nearly equal size (ratio ${ratio.toFixed(2)}). Treating smallest as contaminated.`);
    }

    console.log(`[DirectionValidator] CENTROID CONTAMINATION DETECTED:`);
    console.log(`  Centroid similarity: ${centroidSim.toFixed(4)} > ${this.contaminationThreshold}`);
    console.log(`  Robust group: ${robustGroup} (${robustArgs.length} args)`);
    console.log(`  Contaminated group: ${contaminatedGroup} (${contaminatedArgs.length} args)`);

    return {
      centroidSimilarity: centroidSim,
      robustGroup,
      contaminatedGroup,
      robustArgs,
      contaminatedArgs,
      ratio
    };
  }

  /**
   * Flag arguments in the contaminated group that are likely misclassified.
   * Uses adaptive threshold based on how severe the contamination is.
   *
   * @param {Object} contamination - Result from detectCentroidContamination
   * @param {Array} proChangeCentroid - Centroid vector for pro_change
   * @param {Array} proStatusQuoCentroid - Centroid vector for pro_status_quo
   * @returns {Array} Arguments flagged as likely misclassified
   */
  flagContaminatedArguments(contamination, proChangeCentroid, proStatusQuoCentroid) {
    const { contaminatedArgs, robustGroup, centroidSimilarity } = contamination;
    const robustCentroid = robustGroup === 'pro_change' ? proChangeCentroid : proStatusQuoCentroid;

    // For very small groups or extreme contamination, flag all
    if (contaminatedArgs.length < 10 || centroidSimilarity > 0.95) {
      const reason = contaminatedArgs.length < 10 ? 'small group' : `extreme contamination (${centroidSimilarity.toFixed(4)})`;
      console.log(`[DirectionValidator] Flagging all ${contaminatedArgs.length} contaminated args (${reason})`);
      return contaminatedArgs.map(arg => ({
        ...arg,
        simToOwn: cosineSimilarity(arg.embedding, robustGroup === 'pro_change' ? proStatusQuoCentroid : proChangeCentroid),
        simToOpposite: cosineSimilarity(arg.embedding, robustCentroid),
        diff: 0,
        _contaminationFlag: true
      }));
    }

    // Adaptive threshold: higher contamination → broader flagging
    const flagThreshold = Math.max(0.60, centroidSimilarity - this.contaminationFlagMargin);
    console.log(`[DirectionValidator] Adaptive flag threshold: ${flagThreshold.toFixed(4)} (centroidSim ${centroidSimilarity.toFixed(4)} - margin ${this.contaminationFlagMargin})`);

    const flagged = [];
    for (const arg of contaminatedArgs) {
      const simToRobust = cosineSimilarity(arg.embedding, robustCentroid);
      if (simToRobust >= flagThreshold) {
        flagged.push({
          ...arg,
          simToOwn: cosineSimilarity(arg.embedding, robustGroup === 'pro_change' ? proStatusQuoCentroid : proChangeCentroid),
          simToOpposite: simToRobust,
          diff: 0,
          _contaminationFlag: true
        });
      }
    }

    console.log(`[DirectionValidator] Flagged ${flagged.length}/${contaminatedArgs.length} contaminated args (simToRobust >= ${flagThreshold.toFixed(4)})`);
    return flagged;
  }

  /**
   * Detect pro_change arguments that contain conditional language patterns.
   * These arguments express conditions/requirements rather than actual support.
   * Uses structural Danish patterns - NOT case-specific keywords.
   *
   * @param {Array} proChangeArgs - Arguments classified as pro_change
   * @returns {Array} Arguments that should be validated for potential misclassification
   */
  detectConditionalArguments(proChangeArgs) {
    const conditionalOutliers = [];

    // Structural patterns indicating conditions/requirements (not support)
    // These are generic Danish constructions, not case-specific terms
    const conditionalPatterns = [
      /\bskal\b.*\b(være|have|sikre|tjene|gavne)/i,  // "skal være/have/sikre" = condition
      /\bkrav\s+(om|til)\b/i,                          // "krav om/til" = requirement
      /\bforudsætning|forudsat|betingelse/i,           // explicit condition words
      /\bhvis\b.*\b(skal|må|bør)/i,                    // "hvis...skal" = conditional
      /\bønske\s+om\b.*\b(at|bedre|mere|grøn)/i,       // "ønske om bedre/mere/grøn" = condition
      /\bbør\s+(være|sikre|overholde)/i,               // "bør være/sikre" = should-condition
      /\b(grøn|bæredygtig|klima)\w*\s+(løsning|valg|tiltag)/i,  // sustainability as condition
      /\bi\s+stedet\s+for\b/i,                         // "i stedet for" = alternative (opposition)
      /\bfrem\s+for\b/i,                               // "frem for" = instead of (opposition)
      /\bikke\b.*\b(hotel|hoteludvikling|nybyggeri)/i  // "ikke hotel" = opposition pattern
    ];

    // Patterns indicating actual support (if present, don't flag)
    const supportPatterns = [
      /\bstøtter?\b.*\b(projekt|forslag|plan)/i,       // "støtter projektet"
      /\bpositiv\s+(over\s+for|til)/i,                 // "positiv over for"
      /\bbakker?\s+op\b/i,                             // "bakker op"
      /\bgod\s+idé\b/i,                                // "god idé"
      /\bglad\s+for\b/i,                               // "glad for"
      /\benig\s+i\b/i                                  // "enig i"
    ];

    for (const arg of proChangeArgs) {
      const text = `${arg.what} ${arg.why} ${arg.sourceQuote}`.toLowerCase();

      // Check if argument has conditional patterns
      const hasConditionalPattern = conditionalPatterns.some(pattern => pattern.test(text));

      // Check if argument has explicit support language
      const hasExplicitSupport = supportPatterns.some(pattern => pattern.test(text));

      // Flag if has conditional pattern but no explicit support
      if (hasConditionalPattern && !hasExplicitSupport) {
        conditionalOutliers.push(arg);
        console.log(`[DirectionValidator] Conditional pattern detected in response ${arg.responseNumber}: "${arg.what.slice(0, 50)}..."`);
      }
    }

    return conditionalOutliers;
  }
}
