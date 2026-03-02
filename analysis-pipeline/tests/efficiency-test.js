import { EdgeCaseDetector } from '../src/analysis/edge-case-detector.js';
import { MicroSummarizer } from '../src/analysis/micro-summarizer.js';
import { OpenAIClientWrapper } from '../src/utils/openai-client.js';

// Mock OpenAI client to track calls
const originalCreateCompletion = OpenAIClientWrapper.prototype.createCompletion;
let callCount = 0;

OpenAIClientWrapper.prototype.createCompletion = async function (params) {
    callCount++;
    console.log(`[MockLLM] Call #${callCount} - Model: ${this.model}`);

    // Return mock response based on prompt content
    const prompt = params.messages[1].content;

    if (prompt.includes('Screen følgende høringssvar')) {
        // Batch screening - RETURN STRING IDs to test robustness
        return {
            choices: [{
                message: {
                    content: JSON.stringify({
                        results: [
                            { id: "1", analyzable: true, action: 'analyze-normally' },
                            { id: "2", analyzable: true, action: 'analyze-normally' }
                        ]
                    })
                }
            }]
        };
    } else if (prompt.includes('Analysér følgende høringssvar')) {
        // Batch summarization - RETURN STRING IDs to test robustness
        return {
            choices: [{
                message: {
                    content: JSON.stringify({
                        results: [
                            {
                                id: "1",
                                analyzable: true,
                                arguments: [{ what: "Test arg 1", why: "Reason 1" }]
                            },
                            {
                                id: "2",
                                analyzable: true,
                                arguments: [{ what: "Test arg 2", why: "Reason 2" }]
                            }
                        ]
                    })
                }
            }]
        };
    }

    return { choices: [{ message: { content: "{}" } }] };
};

async function runTest() {
    console.log('--- Starting Efficiency & Robustness Test ---');

    const responses = [
        { id: 1, text: "Dette er et kort svar som bør batches." },
        { id: 2, text: "Dette er også et kort svar som bør batches." }
    ];

    // Test EdgeCaseDetector
    console.log('\nTesting EdgeCaseDetector...');
    callCount = 0;
    const detector = new EdgeCaseDetector({ batchProcessing: true });
    const screened = await detector.screenBatch(responses, [], '', { batchSize: 10 });

    if (callCount === 1) {
        console.log('✅ EdgeCaseDetector used 1 call');
    } else {
        console.error(`❌ EdgeCaseDetector used ${callCount} calls`);
    }

    // Verify mapping worked (analyzable should be true)
    if (screened[0].analyzable === true && screened[1].analyzable === true) {
        console.log('✅ EdgeCaseDetector correctly mapped String IDs to Number IDs');
    } else {
        console.error('❌ EdgeCaseDetector FAILED to map String IDs (analyzable=false)');
        console.log('Result:', JSON.stringify(screened, null, 2));
    }

    // Test MicroSummarizer
    console.log('\nTesting MicroSummarizer...');
    callCount = 0;
    const summarizer = new MicroSummarizer({ batchProcessing: true });
    // Mock embedder for smart batching
    summarizer.embedder = {
        embedBatch: async (texts) => texts.map(() => new Array(1536).fill(0.1))
    };

    const summarized = await summarizer.summarizeBatchParallel(responses, [], [], { batchSize: 10 });

    if (callCount === 1) {
        console.log('✅ MicroSummarizer used 1 call');
    } else {
        console.error(`❌ MicroSummarizer used ${callCount} calls`);
    }

    // Verify mapping worked (analyzable should be true)
    if (summarized[0].analyzable === true && summarized[1].analyzable === true) {
        console.log('✅ MicroSummarizer correctly mapped String IDs to Number IDs');
    } else {
        console.error('❌ MicroSummarizer FAILED to map String IDs (analyzable=false)');
        console.log('Result:', JSON.stringify(summarized, null, 2));
    }

    // Test MicroSummarizer with Malformed JSON
    console.log('\nTesting MicroSummarizer JSON Repair...');

    // Mock LLM to return malformed JSON
    OpenAIClientWrapper.prototype.createCompletion = async function (params) {
        callCount++;
        return {
            choices: [{
                message: {
                    content: `\`\`\`json
                {
                    "results": [
                        { "id": "1", "analyzable": true, "arguments": [] },
                        { "id": "2", "analyzable": true, "arguments": [] }
                    ]
                }
                \`\`\`` // Markdown code blocks + trailing comma simulation
                }
            }]
        };
    };

    callCount = 0;
    const summarizerRepair = new MicroSummarizer({ batchProcessing: true });
    // Mock embedder
    summarizerRepair.embedder = {
        embedBatch: async (texts) => texts.map(() => new Array(1536).fill(0.1))
    };

    const summarizedRepair = await summarizerRepair.summarizeBatchParallel(responses, [], [], { batchSize: 10 });

    if (summarizedRepair[0].analyzable === true) {
        console.log('✅ MicroSummarizer correctly repaired malformed JSON');
    } else {
        console.error('❌ MicroSummarizer FAILED to repair JSON');
    }

    // Reset mock to original behavior for subsequent tests if any, or just clean up
    OpenAIClientWrapper.prototype.createCompletion = originalCreateCompletion;
}

runTest().catch(console.error);
