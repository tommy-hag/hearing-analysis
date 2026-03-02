const fs = require('fs');
const readline = require('readline');

const traceFile = 'output/llm-traces/job_223_1764278578860.jsonl';

async function analyze() {
  const fileStream = fs.createReadStream(traceFile);

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const modelStats = {}; // Key: requestId, Value: { model, usage, promptSignature }
  const stepStats = {};

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const type = entry.type;

      if (!stepStats[type]) stepStats[type] = 0;
      stepStats[type]++;

      if (type === 'llm_request') {
        // Store model info
        const payload = entry.payload || {};
        const requestId = entry.requestId;

        let promptSignature = "unknown";
        if (payload.messages && payload.messages.length > 0) {
          // Find the last user message or system message
          const lastMsg = payload.messages[payload.messages.length - 1];
          if (lastMsg.content) {
            promptSignature = lastMsg.content.substring(0, 50).replace(/\n/g, ' ');
          }
        }

        if (requestId) {
          if (!modelStats[requestId]) modelStats[requestId] = {};
          modelStats[requestId].model = payload.model || 'unknown';
          modelStats[requestId].promptSignature = promptSignature;
        }
      } else if (type === 'llm_response') {
        // Store usage info
        const payload = entry.payload || {};
        const requestId = entry.requestId;
        const usage = payload.usage || { prompt_tokens: 0, completion_tokens: 0 };

        if (requestId) {
          if (!modelStats[requestId]) modelStats[requestId] = {};
          modelStats[requestId].usage = usage;
        }
      }

    } catch (e) {
      console.error("Error parsing line:", e);
    }
  }

  // Aggregate stats
  const finalStats = {};
  const signatureStats = {};

  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalReqs = 0;

  for (const reqId in modelStats) {
    const data = modelStats[reqId];
    const model = data.model || 'unknown';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const sig = data.promptSignature || 'unknown';

    if (!finalStats[model]) {
      finalStats[model] = { calls: 0, promptTokens: 0, completionTokens: 0 };
    }
    finalStats[model].calls++;
    finalStats[model].promptTokens += usage.prompt_tokens || 0;
    finalStats[model].completionTokens += usage.completion_tokens || 0;

    if (!signatureStats[sig]) {
      signatureStats[sig] = { count: 0, model: model };
    }
    signatureStats[sig].count++;

    totalPrompt += usage.prompt_tokens || 0;
    totalCompletion += usage.completion_tokens || 0;
    totalReqs++;
  }

  console.log("--- Analysis Result ---");
  console.log(`Total Requests: ${totalReqs}`);
  console.log(`Total Prompt Tokens: ${totalPrompt}`);
  console.log(`Total Completion Tokens: ${totalCompletion}`);
  console.log("\nBy Model:");
  console.table(finalStats);

  console.log("\nTop 20 Prompt Signatures:");
  const sortedSigs = Object.entries(signatureStats).sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  sortedSigs.forEach(([sig, data]) => {
    console.log(`[${data.count}] (${data.model}) ${sig}...`);
  });
}

analyze();
