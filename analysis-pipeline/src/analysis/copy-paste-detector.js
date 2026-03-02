/**
 * CopyPasteDetector
 *
 * Detects copy/paste and near-duplicate responses at TEXT level BEFORE micro-summarization.
 * Creates metadata about response groups without forcing identical treatment.
 *
 * Key principle: Detect and ANNOTATE, don't force-merge.
 * Downstream steps can use the metadata to ensure attribution.
 */
export class CopyPasteDetector {
  constructor(options = {}) {
    this.jaccardThreshold = options.jaccardThreshold || 0.80;
    this.ngramSize = options.ngramSize || 4;
    this.minResponseLength = options.minResponseLength || 100;
    this.preserveVariations = options.preserveVariations !== false;
  }

  /**
   * Detect copy/paste groups in responses
   * @param {Array} responses - Array of response objects with .text and .responseNumber (or .id)
   * @returns {Object} { groups: [...], metadata: {...} }
   */
  detectCopyPasteGroups(responses) {
    const startTime = Date.now();

    // Filter to responses with enough text
    const eligibleResponses = responses.filter(r => {
      const text = r.text || r.textMd || '';
      return text.length >= this.minResponseLength;
    });

    if (eligibleResponses.length < 2) {
      return {
        groups: [],
        metadata: {
          skipped: true,
          reason: 'insufficient_eligible_responses',
          eligibleCount: eligibleResponses.length
        }
      };
    }

    // Build fingerprints
    const fingerprints = eligibleResponses.map(r => ({
      responseNumber: r.responseNumber || r.id,
      fingerprint: this.buildFingerprint(r.text || r.textMd || ''),
      respondentType: r.respondentType || r.senderType || 'unknown',
      organizationName: r.organizationName || r.senderName || null,
      textLength: (r.text || r.textMd || '').length
    }));

    // Find groups using union-find approach
    const groups = this.findGroups(fingerprints);

    // Filter to groups with 2+ members
    const significantGroups = groups.filter(g => g.members.length >= 2);

    const analysisTime = Date.now() - startTime;

    if (significantGroups.length > 0) {
      console.log(`[CopyPasteDetector] Found ${significantGroups.length} copy/paste groups in ${analysisTime}ms`);
      significantGroups.forEach((g, idx) => {
        const responseNums = g.members.map(m => m.responseNumber).join(', ');
        const orgs = g.members.filter(m => m.organizationName).map(m => m.organizationName);
        console.log(`[CopyPasteDetector]   Group ${idx + 1}: responses [${responseNums}] (similarity: ${(g.avgSimilarity * 100).toFixed(1)}%)${orgs.length > 0 ? ` - orgs: ${orgs.join(', ')}` : ''}`);
      });
    } else {
      console.log(`[CopyPasteDetector] No copy/paste groups found (checked ${eligibleResponses.length} responses in ${analysisTime}ms)`);
    }

    return {
      groups: significantGroups.map(g => ({
        responseNumbers: g.members.map(m => m.responseNumber),
        similarity: g.avgSimilarity,
        organizations: g.members.filter(m => m.organizationName).map(m => m.organizationName),
        representative: g.members[0].responseNumber,
        memberDetails: g.members.map(m => ({
          responseNumber: m.responseNumber,
          respondentType: m.respondentType,
          organizationName: m.organizationName,
          textLength: m.textLength
        }))
      })),
      metadata: {
        analysisTime,
        eligibleResponses: eligibleResponses.length,
        totalGroups: significantGroups.length,
        totalGroupedResponses: significantGroups.reduce((sum, g) => sum + g.members.length, 0),
        threshold: this.jaccardThreshold
      }
    };
  }

  /**
   * Build an n-gram fingerprint from text
   * @param {string} text - The text to fingerprint
   * @returns {Set} Set of n-grams
   */
  buildFingerprint(text) {
    // Normalize: lowercase, remove special chars, keep Danish letters
    const normalized = text.toLowerCase()
      .replace(/[^\wæøåé\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = normalized.split(' ').filter(w => w.length > 2);

    // Build n-gram set
    const ngrams = new Set();
    for (let i = 0; i <= words.length - this.ngramSize; i++) {
      ngrams.add(words.slice(i, i + this.ngramSize).join(' '));
    }
    return ngrams;
  }

  /**
   * Calculate Jaccard similarity between two sets
   * @param {Set} set1 - First set
   * @param {Set} set2 - Second set
   * @returns {number} Jaccard similarity (0-1)
   */
  jaccardSimilarity(set1, set2) {
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersectionSize = 0;
    for (const item of set1) {
      if (set2.has(item)) intersectionSize++;
    }

    const unionSize = set1.size + set2.size - intersectionSize;
    return intersectionSize / unionSize;
  }

  /**
   * Find groups of similar responses using union-find
   * @param {Array} fingerprints - Array of fingerprint objects
   * @returns {Array} Array of groups with members and similarity
   */
  findGroups(fingerprints) {
    const n = fingerprints.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const similarities = [];

    // Union-find helpers
    const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (x, y) => { parent[find(x)] = find(y); };

    // Compare all pairs (O(n^2) but n is typically small for responses)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.jaccardSimilarity(
          fingerprints[i].fingerprint,
          fingerprints[j].fingerprint
        );

        if (sim >= this.jaccardThreshold) {
          union(i, j);
          similarities.push({ i, j, similarity: sim });
        }
      }
    }

    // Group by root
    const groupMap = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groupMap.has(root)) {
        groupMap.set(root, { members: [], similarities: [] });
      }
      groupMap.get(root).members.push(fingerprints[i]);
    }

    // Calculate average similarity for each group
    for (const { i, j, similarity } of similarities) {
      const root = find(i);
      groupMap.get(root).similarities.push(similarity);
    }

    return Array.from(groupMap.values()).map(g => ({
      members: g.members,
      avgSimilarity: g.similarities.length > 0
        ? g.similarities.reduce((a, b) => a + b, 0) / g.similarities.length
        : 1.0
    }));
  }

  /**
   * Annotate responses with their copy/paste group information
   * @param {Array} responses - Array of response objects
   * @param {Array} groups - Groups from detectCopyPasteGroups
   * @returns {Array} Responses with _copyPasteGroupId and _copyPasteGroup annotations
   */
  annotateResponses(responses, groups) {
    // Build lookup map: responseNumber -> group index
    const responseToGroup = new Map();
    groups.forEach((group, idx) => {
      group.responseNumbers.forEach(rn => responseToGroup.set(rn, idx));
    });

    // Annotate each response
    return responses.map(r => {
      const responseNumber = r.responseNumber || r.id;
      if (responseToGroup.has(responseNumber)) {
        const groupIdx = responseToGroup.get(responseNumber);
        return {
          ...r,
          _copyPasteGroupId: groupIdx,
          _copyPasteGroup: groups[groupIdx]
        };
      }
      return r;
    });
  }
}
