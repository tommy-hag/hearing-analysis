/**
 * Feedback Orchestrator
 * Handles intelligent classification, routing, and validation of user feedback
 * for re-analysis runs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Feedback categories and their pipeline routing
 */
const FEEDBACK_ROUTE_MAP = {
    context_note: {
        resumeFrom: 'micro-summarize',
        injectIn: ['micro-summarize', 'hybrid-position-writing'],
        promptKey: 'contextNotes',
        description: 'Specific context that should be added (e.g., "NF means Nordisk Film")'
    },
    citation_problem: {
        resumeFrom: 'extract-citations',
        injectIn: ['extract-citations', 'hybrid-position-writing'],
        promptKey: 'citationCorrections',
        description: 'Citation taken out of context or misrepresenting the source'
    },
    missing_content: {
        resumeFrom: 'micro-summarize',
        injectIn: ['micro-summarize', 'aggregate'],
        promptKey: 'highlightedContent',
        description: 'Important content that was overlooked in the analysis'
    },
    irrelevant_position: {
        resumeFrom: 'consolidate-positions',
        injectIn: ['consolidate-positions', 'sort-positions'],
        promptKey: 'excludePositions',
        description: 'Position that should be removed from the analysis'
    },
    structure_change: {
        resumeFrom: 'theme-mapping',
        injectIn: ['theme-mapping', 'aggregate'],
        promptKey: 'structureChanges',
        description: 'Structural changes like merging themes'
    },
    factual_error: {
        resumeFrom: 'hybrid-position-writing',
        injectIn: ['hybrid-position-writing'],
        promptKey: 'corrections',
        description: 'Factual errors in summaries that need correction'
    }
};

export class FeedbackOrchestrator {
    constructor(options = {}) {
        this.hearingId = options.hearingId;
        this.baseDir = options.baseDir || path.join(__dirname, '../../output/runs');
        const config = getComplexityConfig('light');
        this.client = new OpenAIClientWrapper({
            model: config.model,
            verbosity: config.verbosity,
            reasoningEffort: config.reasoningEffort
        });
        this.maxIterations = options.maxIterations || 3;
    }

    /**
     * Classify feedback using LLM
     */
    async classifyFeedback(feedbackText, context = {}) {
        const prompt = `Klassificér denne bruger-feedback til en høringsanalyse:

"${feedbackText}"

${context.responseNumber ? `Kontekst: Feedback er givet på høringssvar nr. ${context.responseNumber}` : ''}
${context.positionTitle ? `Kontekst: Feedback er givet på position "${context.positionTitle}"` : ''}

Kategorier:
- context_note: Specifik kontekst (fx "NF betyder Nordisk Film", "Palads er byggefelt 3")
- citation_problem: Problem med citat (fx "taget ud af kontekst", "misvisende")
- missing_content: Indhold der mangler (fx "vigtig pointe overset")
- irrelevant_position: Position der bør fjernes (fx "ikke relevant for høringen")
- structure_change: Strukturændring (fx "slå temaer sammen", "opdel position")
- factual_error: Faktuel fejl i opsummering (fx "opsummeringen er forkert")

Returnér JSON:
{
  "category": "context_note|citation_problem|missing_content|irrelevant_position|structure_change|factual_error",
  "confidence": 0.0-1.0,
  "isSpecific": true/false,
  "target": {
    "responseNumber": null eller nummer,
    "positionTitle": null eller titel
  },
  "action": "add_context|remove_citation|highlight_content|remove_position|merge_themes|rewrite",
  "suggestion": "kort forklaring på dansk"
}`;

        try {
            const response = await this.client.createCompletion({
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' }
            });

            return JSON.parse(response);
        } catch (e) {
            console.error('[FeedbackOrchestrator] Classification failed:', e);
            // Fallback classification
            return this.fallbackClassify(feedbackText, context);
        }
    }

    /**
     * Fallback keyword-based classification
     */
    fallbackClassify(feedbackText, context = {}) {
        const lower = feedbackText.toLowerCase();
        let category = 'context_note';
        let confidence = 0.5;
        let isSpecific = true;

        if (lower.includes('slå sammen') || lower.includes('merge') || lower.includes('tema')) {
            category = 'structure_change';
            isSpecific = false;
            confidence = 0.6;
        } else if (lower.includes('citat') || lower.includes('kontekst') || lower.includes('misvisende')) {
            category = 'citation_problem';
            confidence = 0.6;
        } else if (lower.includes('mangler') || lower.includes('overset') || lower.includes('vigtig')) {
            category = 'missing_content';
            confidence = 0.6;
        } else if (lower.includes('forkert') || lower.includes('fejl') || lower.includes('opsummering')) {
            category = 'factual_error';
            confidence = 0.6;
        } else if (lower.includes('irrelevant') || lower.includes('slet') || lower.includes('fjern')) {
            category = 'irrelevant_position';
            confidence = 0.6;
        } else if (lower.includes('betyder') || lower.includes('er lig med') || lower.includes('=')) {
            category = 'context_note';
            confidence = 0.7;
        }

        return {
            category,
            confidence,
            isSpecific,
            target: {
                responseNumber: context.responseNumber || null,
                positionTitle: context.positionTitle || null
            },
            action: this.getDefaultAction(category),
            suggestion: `Klassificeret som ${category} baseret på nøgleord`
        };
    }

    /**
     * Get default action for category
     */
    getDefaultAction(category) {
        const actions = {
            context_note: 'add_context',
            citation_problem: 'remove_citation',
            missing_content: 'highlight_content',
            irrelevant_position: 'remove_position',
            structure_change: 'merge_themes',
            factual_error: 'rewrite'
        };
        return actions[category] || 'add_context';
    }

    /**
     * Determine the scope of changes needed
     */
    async determineFeedbackScope(feedback, incrementalManager) {
        const classified = Array.isArray(feedback)
            ? feedback
            : [await this.classifyFeedback(feedback.text, feedback)];

        // Check if any feedback requires full re-run
        const requiresFullRun = classified.some(f =>
            f.category === 'structure_change' ||
            (f.category === 'missing_content' && !f.target?.responseNumber)
        );

        if (requiresFullRun) {
            return {
                type: 'full_rerun',
                reason: 'Strukturelle ændringer kræver fuld re-analyse',
                affectedResponses: 'all',
                resumeFrom: null
            };
        }

        // Collect affected responses
        const affectedResponses = new Set();
        const affectedPositions = new Set();
        let earliestResumeStep = null;

        for (const fb of classified) {
            if (fb.target?.responseNumber) {
                affectedResponses.add(fb.target.responseNumber);
            }
            if (fb.target?.positionTitle) {
                affectedPositions.add(fb.target.positionTitle);
            }

            const route = FEEDBACK_ROUTE_MAP[fb.category];
            if (route && (!earliestResumeStep || this.stepOrder(route.resumeFrom) < this.stepOrder(earliestResumeStep))) {
                earliestResumeStep = route.resumeFrom;
            }
        }

        if (affectedResponses.size === 1) {
            return {
                type: 'single_response',
                reason: 'Kun ét høringssvar påvirket',
                affectedResponses: [...affectedResponses],
                affectedPositions: [...affectedPositions],
                resumeFrom: earliestResumeStep
            };
        } else if (affectedResponses.size > 0 && affectedResponses.size <= 5) {
            return {
                type: 'position_group',
                reason: `${affectedResponses.size} høringssvar påvirket`,
                affectedResponses: [...affectedResponses],
                affectedPositions: [...affectedPositions],
                resumeFrom: earliestResumeStep
            };
        }

        return {
            type: 'incremental',
            reason: 'Inkrementel opdatering mulig',
            affectedResponses: [...affectedResponses],
            affectedPositions: [...affectedPositions],
            resumeFrom: earliestResumeStep || 'aggregate'
        };
    }

    /**
     * Get step order for comparison
     */
    stepOrder(stepName) {
        const order = [
            'load-data', 'material-summary', 'edge-case-screening', 'enrich-responses',
            'chunking', 'embedding', 'calculate-dynamic-parameters',
            'micro-summarize', 'theme-mapping', 'aggregate',
            'consolidate-positions', 'extract-sub-positions', 'validate-positions', 'sort-positions',
            'extract-citations', 'validate-citations', 'hybrid-position-writing',
            'validate-writer-output', 'validate-coverage', 'considerations',
            'format-output', 'build-docx'
        ];
        return order.indexOf(stepName);
    }

    /**
     * Build prompt injection context from feedback
     */
    buildPromptContext(feedback) {
        const context = {
            contextNotes: [],
            citationCorrections: [],
            highlightedContent: [],
            excludePositions: [],
            structureChanges: [],
            corrections: []
        };

        const feedbackArray = Array.isArray(feedback) ? feedback : [feedback];

        for (const fb of feedbackArray) {
            const route = FEEDBACK_ROUTE_MAP[fb.category];
            if (!route) continue;

            const entry = {
                text: fb.text,
                responseNumber: fb.target?.responseNumber || fb.responseNumber,
                positionTitle: fb.target?.positionTitle || fb.positionTitle,
                action: fb.action
            };

            context[route.promptKey]?.push(entry);
        }

        return context;
    }

    /**
     * Validate that feedback was addressed in new analysis
     */
    async validateFeedbackAddressed(feedback, oldAnalysis, newAnalysis) {
        const feedbackArray = Array.isArray(feedback) ? feedback : [feedback];
        const results = [];

        for (const fb of feedbackArray) {
            const oldSection = this.extractRelevantSection(oldAnalysis, fb);
            const newSection = this.extractRelevantSection(newAnalysis, fb);

            const validationPrompt = `Bruger gav denne feedback: "${fb.text}"
Kategori: ${fb.category}

GAMMEL analyse-uddrag:
${JSON.stringify(oldSection, null, 2)}

NY analyse-uddrag:
${JSON.stringify(newSection, null, 2)}

Er feedback adresseret? Returnér JSON:
{
  "addressed": true/false,
  "explanation": "...",
  "improvement_score": 0-100,
  "remaining_issues": ["..."]
}`;

            try {
                const result = await callLLM(validationPrompt, {
                    complexity: 'light',
                    jsonMode: true,
                    client: this.openaiClient
                });

                results.push({
                    feedback: fb,
                    validation: JSON.parse(result)
                });
            } catch (e) {
                console.error('[FeedbackOrchestrator] Validation failed:', e);
                results.push({
                    feedback: fb,
                    validation: {
                        addressed: false,
                        explanation: 'Validering fejlede',
                        improvement_score: 0,
                        remaining_issues: ['Kunne ikke validere']
                    }
                });
            }
        }

        return results;
    }

    /**
     * Extract relevant section from analysis based on feedback target
     */
    extractRelevantSection(analysis, feedback) {
        if (!analysis || !feedback) return null;

        // If feedback targets a specific position
        if (feedback.target?.positionTitle) {
            for (const topic of (analysis.topics || [])) {
                for (const position of (topic.positions || [])) {
                    if (position.title === feedback.target.positionTitle) {
                        return {
                            topic: topic.name,
                            position: position.title,
                            summary: position.summary,
                            responseNumbers: position.responseNumbers
                        };
                    }
                }
            }
        }

        // If feedback targets a specific response
        if (feedback.target?.responseNumber) {
            const references = [];
            for (const topic of (analysis.topics || [])) {
                for (const position of (topic.positions || [])) {
                    if (position.responseNumbers?.includes(feedback.target.responseNumber)) {
                        references.push({
                            topic: topic.name,
                            position: position.title,
                            summary: position.summary?.substring(0, 200)
                        });
                    }
                }
            }
            return { responseNumber: feedback.target.responseNumber, references };
        }

        // Return general overview
        return {
            topicCount: analysis.topics?.length || 0,
            positionCount: analysis.topics?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0
        };
    }

    /**
     * Select best iteration from multiple re-analysis runs
     */
    async selectBestIteration(iterations) {
        if (iterations.length === 0) return null;
        if (iterations.length === 1) return iterations[0];

        const evalPrompt = `Sammenlign disse ${iterations.length} analyse-versioner:

${iterations.map((it, i) => `
VERSION ${i + 1}:
- Forbedringsscore: ${it.validation?.improvement_score || 'N/A'}
- Feedback adresseret: ${it.validation?.addressed || 'N/A'}
- Resterende issues: ${it.validation?.remaining_issues?.join(', ') || 'Ingen'}
`).join('\n')}

Hvilken version er bedst? Returnér JSON:
{
  "best_version": 1-${iterations.length},
  "reasoning": "..."
}`;

        try {
            const result = await callLLM(evalPrompt, {
                complexity: 'light',
                jsonMode: true,
                client: this.openaiClient
            });

            const parsed = JSON.parse(result);
            return iterations[parsed.best_version - 1];
        } catch (e) {
            console.error('[FeedbackOrchestrator] Selection failed:', e);
            // Return the one with highest improvement score
            return iterations.reduce((best, current) =>
                (current.validation?.improvement_score || 0) > (best.validation?.improvement_score || 0)
                    ? current
                    : best
            );
        }
    }

    /**
     * Load feedback from file
     */
    loadFeedbackFile(feedbackPath) {
        if (!fs.existsSync(feedbackPath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(feedbackPath, 'utf-8');
            return JSON.parse(content);
        } catch (e) {
            console.error('[FeedbackOrchestrator] Failed to load feedback file:', e);
            return null;
        }
    }

    /**
     * Save orchestration result
     */
    saveResult(runDir, result) {
        const resultPath = path.join(runDir, 'feedback-orchestration-result.json');
        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
        return resultPath;
    }
}

export default FeedbackOrchestrator;
