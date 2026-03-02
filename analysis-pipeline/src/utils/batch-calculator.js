/**
 * Batch Size Calculator
 * 
 * Automatically calculates safe batch sizes based on OpenAI RPM/TPM limits
 * and content characteristics.
 */

/**
 * Calculate safe batch size based on RPM and TPM limits
 * @param {Object} options - Configuration options
 * @param {number} options.rpmLimit - Requests per minute limit (default: 10000)
 * @param {number} options.tpmLimit - Tokens per minute limit (default: 200000)
 * @param {number} options.safetyPercentage - Percentage of limit to use (default: 0.6)
 * @param {number} options.estimatedDurationSeconds - Estimated duration of each request (default: 1)
 * @param {number} options.avgTokensPerRequest - Average estimated tokens (input + output) per request
 * @param {number} options.maxBatchSize - Hard cap on batch size (default: 75)
 * @returns {number} Safe batch size
 */
export function calculateBatchSize(options = {}) {
  const rpmLimit = options.rpmLimit || parseInt(process.env.OPENAI_RPM_LIMIT || '10000', 10);
  // Default TPM limit of 200k (Tier 2 standard), can be overridden
  const tpmLimit = options.tpmLimit || parseInt(process.env.OPENAI_TPM_LIMIT || '200000', 10);
  const safetyPercentage = options.safetyPercentage || parseFloat(process.env.BATCH_SIZE_PERCENTAGE || '0.6');
  
  // 1. Calculate based on RPM (Requests Per Minute)
  const requestsPerSecond = (rpmLimit / 60) * safetyPercentage;
  const estimatedDurationSeconds = options.estimatedDurationSeconds || 1;
  const batchSizeByRPM = Math.floor(requestsPerSecond * estimatedDurationSeconds);
  
  // 2. Calculate based on TPM (Tokens Per Minute) if token info provided
  let batchSizeByTPM = Infinity;
  if (options.avgTokensPerRequest > 0) {
    // Tokens per second allowed
    const tokensPerSecond = (tpmLimit / 60) * safetyPercentage;
    // How many concurrent requests can we sustain given avg token usage?
    // If each request takes 'estimatedDurationSeconds', then in 1 second, 
    // we consume (AvgTokens / estimatedDurationSeconds) tokens per active request.
    // So: SafeConcurrency * (AvgTokens / Duration) = TokensPerSecond
    // SafeConcurrency = (TokensPerSecond * Duration) / AvgTokens
    batchSizeByTPM = Math.floor((tokensPerSecond * estimatedDurationSeconds) / options.avgTokensPerRequest);
  }
  
  // 3. Determine limit based on Node.js concurrent connection stability
  // We trust the dynamic calculation, but keep a very high safety net (500) to prevent 
  // OS-level resource exhaustion (file descriptors/DNS), not to limit API throughput.
  // Allow override via MAX_CONCURRENT_BATCH_SIZE if user wants to go even higher.
  const systemStabilityLimit = parseInt(process.env.MAX_CONCURRENT_BATCH_SIZE || '500', 10);
  
  // 4. Take the calculated limit based on API tiers
  const optimalBatchSize = Math.min(batchSizeByRPM, batchSizeByTPM, systemStabilityLimit);

  // Warn if limited by default TPM
  if (process.env.DEBUG && batchSizeByTPM < Math.min(batchSizeByRPM, systemStabilityLimit) && !process.env.OPENAI_TPM_LIMIT) {
    console.warn(`[BatchCalculator] Batch size limited to ${batchSizeByTPM} by default TPM limit (200k). Set OPENAI_TPM_LIMIT in .env to increase.`);
  }
  
  // Ensure minimum of 5 for efficiency
  return Math.max(5, optimalBatchSize);
}

/**
 * Get batch size for specific pipeline steps with content awareness
 * @param {string} step - Pipeline step name
 * @param {Array} items - Optional array of items to process (for calculating stats)
 * @returns {number} Recommended batch size
 */
export function getBatchSizeForStep(step, items = [], options = {}) {
  // Base durations for short/empty content
  const baseDurations = {
    'edge-case-screening': 8,  
    'micro-summarize': 3,      
    'aggregate': 15,           
    'consolidate': 8,          
    'hybrid-writing': 5,       
    'considerations': 30,      
    'theme-extraction': 30     
  };

  // Calculate content stats if items provided
  let estimatedDuration = baseDurations[step] || 1;
  let avgTokensPerRequest = 0;
  
  // Add context overhead if provided (e.g. materials, prompt templates)
  const additionalContextTokens = options.additionalContextTokens || 0;
  
  if (Array.isArray(items) && items.length > 0) {
    // Calculate average char length
    const totalChars = items.reduce((sum, item) => {
      const text = item.text || item.content || (typeof item === 'string' ? item : '');
      return sum + text.length;
    }, 0);
    const avgChars = totalChars / items.length;
    
    // Estimate tokens (approx 4 chars per token)
    const avgInputTokens = Math.ceil(avgChars / 4);
    
    // Estimate output tokens based on step
    let estimatedOutputTokens = 0;
    if (step === 'micro-summarize') estimatedOutputTokens = 300;
    else if (step === 'edge-case-screening') estimatedOutputTokens = 100;
    else if (step === 'hybrid-writing') estimatedOutputTokens = 800;
    
    avgTokensPerRequest = avgInputTokens + estimatedOutputTokens + additionalContextTokens;
    
    // Adjust duration based on length (longer text = longer processing)
    // Rough heuristic: +1 second per 1000 chars of input
    const lengthPenalty = Math.floor(avgChars / 1000);
    estimatedDuration += lengthPenalty;
  }

  // Special handling for embedding: High payload size risks timeouts
  if (step === 'embedding') {
    // Force more conservative duration for embedding to reduce batch size
    // Embedding calls with large payloads (e.g. 20 chunks) take significantly longer
    // and are more prone to timeouts/network errors than simple completion calls.
    estimatedDuration = Math.max(estimatedDuration, 5); 
  }

  const size = calculateBatchSize({
    estimatedDurationSeconds: estimatedDuration,
    avgTokensPerRequest: avgTokensPerRequest
  });
  
  if (process.env.DEBUG) {
    console.log(`[BatchCalculator] Step: ${step}, AvgChars: ${avgTokensPerRequest * 4}, Duration: ${estimatedDuration}s -> BatchSize: ${size}`);
  }
  
  return size;
}

/**
 * Calculate optimal batch configuration for a dataset
 * @param {number} itemCount - Number of items to process
 * @param {number} maxBatchSize - Maximum batch size
 * @returns {Object} { batchSize, batchCount, itemsPerBatch }
 */
export function calculateBatchConfig(itemCount, maxBatchSize) {
  if (itemCount <= maxBatchSize) {
    return {
      batchSize: itemCount,
      batchCount: 1,
      itemsPerBatch: [itemCount]
    };
  }

  const batchCount = Math.ceil(itemCount / maxBatchSize);
  const itemsPerBatch = [];
  
  for (let i = 0; i < batchCount; i++) {
    const start = i * maxBatchSize;
    const end = Math.min(start + maxBatchSize, itemCount);
    itemsPerBatch.push(end - start);
  }

  return {
    batchSize: maxBatchSize,
    batchCount,
    itemsPerBatch
  };
}
