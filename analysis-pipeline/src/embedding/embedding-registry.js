/**
 * EmbeddingRegistry - Global singleton for tracking embedding usage across all EmbeddingService instances
 *
 * Problem: Previously only BatchEmbedder's usage was tracked, missing 11 other EmbeddingService instances.
 * Solution: Auto-register all EmbeddingService instances to this global registry for accurate cost tracking.
 */

class EmbeddingRegistry {
  constructor() {
    this.embedders = new Map();
  }

  /**
   * Register an embedder instance
   * @param {string} id - Unique identifier for this embedder
   * @param {Object} embedder - EmbeddingService instance with getUsage() method
   */
  register(id, embedder) {
    this.embedders.set(id, embedder);
  }

  /**
   * Unregister an embedder instance
   * @param {string} id - The embedder ID to remove
   */
  unregister(id) {
    this.embedders.delete(id);
  }

  /**
   * Get aggregated usage from all registered embedders
   * @returns {Object} Combined usage stats: totalTokens, totalCalls, totalTexts, model
   */
  getGlobalUsage() {
    let total = {
      totalTokens: 0,
      totalCalls: 0,
      totalTexts: 0,
      model: null,
      embedderCount: 0
    };

    for (const [id, embedder] of this.embedders) {
      const usage = embedder.getUsage?.() || {};
      total.totalTokens += usage.totalTokens || 0;
      total.totalCalls += usage.totalCalls || 0;
      total.totalTexts += usage.totalTexts || 0;
      if (usage.model) total.model = usage.model;
      if (usage.totalCalls > 0) total.embedderCount++;
    }

    return total;
  }

  /**
   * Get detailed usage breakdown per embedder (for debugging)
   * @returns {Array} Array of {id, ...usage} objects for each embedder with usage
   */
  getDetailedUsage() {
    const details = [];
    for (const [id, embedder] of this.embedders) {
      const usage = embedder.getUsage?.() || {};
      if (usage.totalCalls > 0) {
        details.push({ id, ...usage });
      }
    }
    return details;
  }

  /**
   * Reset the registry (call at pipeline start)
   */
  reset() {
    this.embedders.clear();
  }

  /**
   * Get count of registered embedders
   * @returns {number} Number of registered embedders
   */
  get size() {
    return this.embedders.size;
  }
}

// Export as singleton
export default new EmbeddingRegistry();
