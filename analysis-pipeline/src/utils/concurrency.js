/**
 * Concurrency Utilities
 * 
 * Helpers for managing async concurrency and rate limits.
 */

/**
 * Run async tasks with limited concurrency
 * @param {Array<Function>} tasks - Array of functions that return promises
 * @param {number} limit - Maximum number of concurrent tasks
 * @returns {Promise<Array>} Array of results in same order as tasks
 */
export async function limitConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  const executing = new Set();
  let currentIndex = 0;
  
  // Helper to execute next task
  const enqueue = async () => {
    if (currentIndex >= tasks.length) {
      return;
    }
    
    const index = currentIndex++;
    const task = tasks[index];
    
    // Create promise for this task
    const promise = Promise.resolve().then(() => task());
    
    // Add to executing set
    executing.add(promise);
    
    // Handle completion
    try {
      results[index] = await promise;
    } catch (error) {
      // We don't stop other tasks on error, but we reject the main promise?
      // Or we store the error? Usually Promise.all behavior is desired (fail fast)
      // But for batch processing often we want settled.
      // Let's stick to Promise.all behavior (throw on first error) to be safe,
      // but since the aggregator catches errors inside the loop, the tasks themselves 
      // should probably handle their own errors if they want to continue.
      // The aggregator implementation catches errors inside the loop.
      // So here we just propagate rejection.
      throw error;
    } finally {
      executing.delete(promise);
    }
  };
  
  // Start initial batch
  const workers = [];
  
  // We can't just map the workers because we need to keep replenishing
  // A simple way is to have 'limit' number of long-lived "worker" loops
  // But a cleaner way often used is recursion or a queue.
  
  // Let's use a simple pool approach
  const runPool = async () => {
    while (currentIndex < tasks.length) {
      await enqueue();
    }
  };
  
  // Start 'limit' number of parallel workers
  for (let i = 0; i < limit; i++) {
    workers.push(runPool());
  }
  
  await Promise.all(workers);
  return results;
}



