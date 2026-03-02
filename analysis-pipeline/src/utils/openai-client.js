/**
 * OpenAI Client Wrapper
 * 
 * Wrapper for OpenAI client that handles responses API vs chat completions API
 * based on model type and configuration.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { LLMTracer } from './llm-tracer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try multiple paths for .env
const envPaths = [
  join(__dirname, '../../config/.env'),
  join(__dirname, '../../../.env'),
  join(process.cwd(), 'config/.env'),
  join(process.cwd(), '.env')
];

// Load from multiple possible locations
for (const envPath of envPaths) {
  try {
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
    }
  } catch (e) {
    // Continue to next path
  }
}

// Also try default .env in current directory (non-override)
dotenv.config({ override: false });

/**
 * Get LLM configuration for a complexity level
 * @param {string} level - Complexity level: 'light', 'medium', 'heavy', 'ultra'
 * @returns {Object} Configuration object with model, verbosity, reasoningEffort
 */
export function getComplexityConfig(level = 'medium') {
  const levelLower = String(level || 'medium').trim().toLowerCase();
  
  let model, verbosity, reasoningEffort;
  
  switch (levelLower) {
    case 'light':
      model = process.env.LLM_LIGHT_MODEL || process.env.LLM_MODEL || 'gpt-5-nano';
      verbosity = process.env.LLM_LIGHT_VERBOSITY || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'low';
      reasoningEffort = process.env.LLM_LIGHT_REASONING_LEVEL || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'low';
      break;
    case 'light-plus':
      model = process.env.LLM_LIGHT_PLUS_MODEL || process.env.LLM_MODEL || 'gpt-5-nano';
      verbosity = process.env.LLM_LIGHT_PLUS_VERBOSITY || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'medium';
      reasoningEffort = process.env.LLM_LIGHT_PLUS_REASONING_LEVEL || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'high';
      break;
    case 'medium':
      model = process.env.LLM_MEDIUM_MODEL || process.env.LLM_MODEL || 'gpt-5-mini';
      verbosity = process.env.LLM_MEDIUM_VERBOSITY || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'medium';
      reasoningEffort = process.env.LLM_MEDIUM_REASONING_LEVEL || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'medium';
      break;
    case 'medium-plus':
      // NEW: Quality (mini) with conciseness (medium verbosity) - the sweet spot!
      model = process.env.LLM_MEDIUM_PLUS_MODEL || process.env.LLM_MODEL || 'gpt-5-mini';
      verbosity = process.env.LLM_MEDIUM_PLUS_VERBOSITY || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'medium';
      reasoningEffort = process.env.LLM_MEDIUM_PLUS_REASONING_LEVEL || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'medium';
      break;
    case 'heavy':
      model = process.env.LLM_HEAVY_MODEL || process.env.LLM_MODEL || 'gpt-5-mini';
      verbosity = process.env.LLM_HEAVY_VERBOSITY || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'high';
      reasoningEffort = process.env.LLM_HEAVY_REASONING_LEVEL || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'high';
      break;
    case 'ultra':
      model = process.env.LLM_ULTRA_MODEL || process.env.LLM_MODEL || 'gpt-5-mini';
      verbosity = process.env.LLM_ULTRA_VERBOSITY || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'high';
      reasoningEffort = process.env.LLM_ULTRA_REASONING_LEVEL || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'high';
      break;
    default:
      model = process.env.LLM_MODEL || 'gpt-5-mini';
      verbosity = process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'medium';
      reasoningEffort = process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'medium';
  }
  
  return { model, verbosity, reasoningEffort };
}

// Normalize verbosity
function normalizeVerbosity(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return null;
  if (['low', 'minimal', 'min'].includes(v)) return 'low';
  if (['medium', 'med', 'normal', 'default'].includes(v)) return 'medium';
  if (['high', 'verbose', 'max'].includes(v)) return 'high';
  if (v === 'none' || v === 'off' || v === 'false') return null;
  return v;
}

// Normalize reasoning effort
function normalizeReasoningEffort(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return null;
  if (['minimal', 'low', 'min'].includes(v)) return 'low';
  if (['medium', 'med', 'normal', 'default'].includes(v)) return 'medium';
  if (['high', 'max'].includes(v)) return 'high';
  // IMPORTANT: Return 'none' explicitly instead of null - Responses API behaves
  // differently when reasoning is omitted vs explicitly set to 'none'
  if (v === 'none' || v === 'off' || v === 'false') return 'none';
  return v;
}

/**
 * Check if an error is a retryable network/socket error
 * These are transient errors that may succeed on retry
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableNetworkError(error) {
  if (!error) return false;
  
  const message = error.message?.toLowerCase() || '';
  const code = error.code || error.cause?.code || '';
  
  // Socket/connection errors
  const retryableCodes = [
    'UND_ERR_SOCKET',      // undici socket error (the one we saw)
    'ECONNRESET',          // Connection reset by peer
    'ECONNREFUSED',        // Connection refused
    'ETIMEDOUT',           // Connection timed out
    'EPIPE',               // Broken pipe
    'ENOTFOUND',           // DNS lookup failed (transient)
    'EAI_AGAIN',           // DNS lookup timed out
    'EHOSTUNREACH',        // Host unreachable
    'ENETUNREACH',         // Network unreachable
  ];
  
  if (retryableCodes.includes(code)) return true;
  
  // Message-based detection for wrapped errors
  const retryablePatterns = [
    'terminated',
    'socket',
    'other side closed',
    'connection reset',
    'network',
    'econnreset',
    'etimedout',
    'fetch failed',
    'aborted',
  ];
  
  if (retryablePatterns.some(pattern => message.includes(pattern))) return true;
  
  // Check nested cause
  if (error.cause && isRetryableNetworkError(error.cause)) return true;
  
  return false;
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class OpenAIClientWrapper {
  constructor(options = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required');
    }

    // Configure OpenAI client with automatic retry logic
    // OpenAI SDK automatically handles rate limits with exponential backoff (default: maxRetries: 2)
    // We can increase this for better resilience, and SDK will handle retries automatically
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 
      (process.env.OPENAI_MAX_RETRIES ? parseInt(process.env.OPENAI_MAX_RETRIES, 10) : 3);
    
    this.client = new OpenAI({ 
      apiKey,
      maxRetries: maxRetries, // Automatic exponential backoff for rate limits
      timeout: options.timeout || 90000 // 90 second timeout - API calls can take ~56-70 seconds
    });
    this.model = options.model || process.env.LLM_MODEL || 'gpt-5-mini';
    this.verbosity = normalizeVerbosity(options.verbosity || process.env.LLM_VERBOSITY || process.env.VERBOSITY || 'high');
    this.reasoningEffort = normalizeReasoningEffort(options.reasoningEffort || process.env.LLM_REASONING_LEVEL || process.env.REASONING_EFFORT || 'high');
    
    // Configurable timeout settings for Responses API
    // responseTimeout: base timeout in ms (default 3 min - most requests complete in 1-2 min)
    // timeoutRetryMultiplier: each retry gets this much more time (default 1.5x)
    // maxTimeout: absolute maximum timeout cap (default 10 min)
    this.responseTimeout = options.responseTimeout || 180000; // 3 minutes base
    this.timeoutRetryMultiplier = options.timeoutRetryMultiplier || 1.5;
    this.maxTimeout = options.maxTimeout || 600000; // 10 minutes max
    
    // Network error retry configuration for streaming
    // streamRetries: number of retries for socket/network errors during streaming (default 3)
    // Uses exponential backoff: 2s, 4s, 8s delays between retries
    this.streamRetries = options.streamRetries !== undefined ? options.streamRetries :
      (process.env.OPENAI_STREAM_RETRIES ? parseInt(process.env.OPENAI_STREAM_RETRIES, 10) : 3);
    
    // Determine if model uses responses API
    this.useResponsesAPI = /^(gpt-5|o3|o4)/i.test(this.model);
    
    // Current pipeline step for LLM tracing (set by orchestrator)
    this._currentStep = null;
    
    // Initialize tracer if jobId is provided in env or options
    const traceJobId = options.jobId || process.env.TRACE_JOB_ID;
    if (traceJobId) {
      this.setJobId(traceJobId);
    }
  }

  /**
   * Set the current pipeline step for LLM call labeling
   * Called by the pipeline orchestrator before each step runs
   * @param {string} stepName - The pipeline step name (e.g., 'micro-summarize', 'aggregate')
   */
  setCurrentStep(stepName) {
    this._currentStep = stepName;
  }

  /**
   * Set Job ID for tracing (can be called after initialization)
   */
  setJobId(jobId) {
    if (jobId && (!this.tracer || this.tracer.jobId !== jobId)) {
      const tracer = new LLMTracer({ jobId: jobId });

      // If a run directory is already known, configure it before any init
      if (this._pendingRunDirectory) {
        tracer.setRunDirectory(this._pendingRunDirectory);
        this._pendingRunDirectory = null;
      } else {
        tracer.init().catch(e => console.warn('[OpenAIClientWrapper] Tracer init failed', e));
      }

      this.tracer = tracer;
    }
  }

  /**
   * Set run directory for LLM tracing (consolidated output)
   * @param {string} runLLMCallsDir - The directory to save LLM call logs to
   */
  setRunDirectory(runLLMCallsDir) {
    if (this.tracer) {
      this.tracer.setRunDirectory(runLLMCallsDir);
    } else {
      // Store for later when tracer is created via setJobId()
      this._pendingRunDirectory = runLLMCallsDir;
    }
  }

  /**
   * Create a chat completion (handles both responses API and chat completions)
   */
  async createCompletion(params, traceOptions = {}) {
    const {
      messages,
      model = this.model,
      temperature = 0.2,
      response_format = null,
      ...otherParams
    } = params;

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    // Prepare request payload for logging
    const logPayload = {
      messages,
      model,
      temperature,
      response_format,
      ...otherParams
    };

    // Use explicit traceOptions.step if provided, otherwise fall back to _currentStep
    const effectiveStep = traceOptions.step || this._currentStep;

    if (this.tracer) {
      await this.tracer.logEvent('llm_request', logPayload, {
        requestId,
        step: effectiveStep,
        context: traceOptions.context
      });
    }

    try {
      // Check if model uses responses API
      const useResponsesAPI = /^(gpt-5|o3|o4)/i.test(model);
      let result;

      if (useResponsesAPI) {
      // Use responses API
      // Convert messages format: responses API uses input array with role and content array
      const inputMessages = (messages || []).map(msg => ({
        role: msg.role,
        content: [{ type: 'input_text', text: msg.content }]
      }));

      const requestParams = {
        model: model,
        input: inputMessages
        // Note: NOT spreading otherParams here - it can cause issues with Responses API
      };
      
      // Add verbosity and reasoning for gpt-5 models
      if (/^gpt-5/i.test(model)) {
        if (this.verbosity) {
          requestParams.text = { ...(requestParams.text || {}), verbosity: this.verbosity };
        }
        // Always send reasoning effort for gpt-5 models (including 'none')
        // Responses API behaves differently when reasoning is omitted vs explicit
        if (this.reasoningEffort !== null && this.reasoningEffort !== undefined) {
          requestParams.reasoning = { ...(requestParams.reasoning || {}), effort: this.reasoningEffort };
        }
      }

      // Handle structured output (response_format)
      if (response_format) {
        requestParams.text = requestParams.text || {};
        if (response_format.type === 'json_object') {
          // For simple json_object, Responses API requires a complete schema
          // Since we can't know all properties in advance, we'll skip format enforcement
          // and rely on the prompt to ensure JSON output
          // Note: Responses API doesn't support flexible json_object like chat completions
          // So we'll just not enforce format and parse JSON from the response
          // (Format will be handled by prompt instructions)
        } else if (response_format.json_schema) {
          // For structured output with schema
          // Ensure additionalProperties is set (default to false if not specified)
          const schema = { ...response_format.json_schema.schema };
          if (schema.additionalProperties === undefined) {
            schema.additionalProperties = false;
          }
          
          requestParams.text.format = {
            type: 'json_schema',
            name: response_format.json_schema.name || 'response',
            schema: schema
          };
          if (response_format.json_schema.strict !== undefined) {
            requestParams.text.format.strict = response_format.json_schema.strict;
          }
        }
      }

      // Set temperature only for non-reasoning models
      if (!/^(gpt-5|o3|o4)/i.test(model) && Number.isFinite(temperature)) {
        requestParams.temperature = temperature;
      }

      // CRITICAL: Set max_output_tokens to prevent runaway generation
      // 16K tokens (~64K chars) is more than enough for any position summary
      // This prevents the 258K+ char outputs that caused 25+ minute hangs
      requestParams.max_output_tokens = 16000;

      // Use STREAMING mode to avoid timeout issues
      // Streaming keeps the connection alive with continuous data flow
      requestParams.stream = true;
      requestParams.background = false;

      const inputSize = JSON.stringify(requestParams.input).length;
      
      // Retry configuration for network errors
      const maxStreamRetries = this.streamRetries || 3;
      const baseRetryDelayMs = 2000; // Start with 2 seconds
      let lastError = null;
      
      // Accumulate streamed text (declared outside retry loop)
      let outputText = '';
      let usage = null;
      
      for (let attempt = 0; attempt < maxStreamRetries; attempt++) {
        const streamStartTime = Date.now();
        let lastEventTime = Date.now();
        let eventCount = 0;
        
        // Reset output for retry (fresh start each attempt)
        outputText = '';
        usage = null;
        
        try {
          const stream = await this.client.responses.create(requestParams);
          
          // Safety limits to prevent runaway streaming
          const MAX_OUTPUT_CHARS = 100000; // 100K chars (~25K tokens) - safety net
          const MAX_STREAMING_TIME_MS = 600000; // 10 minutes max - safety net

          // Process streaming events
          for await (const event of stream) {
            lastEventTime = Date.now();
            eventCount++;

            // Handle different event types
            if (event.type === 'response.output_text.delta') {
              // Accumulate text deltas
              outputText += event.delta || '';

              // SAFETY: Check if output is getting too large
              if (outputText.length > MAX_OUTPUT_CHARS) {
                console.warn(`[OpenAIClientWrapper] ⚠️ Output exceeded ${MAX_OUTPUT_CHARS} chars - stopping stream to prevent runaway`);
                break;
              }
            } else if (event.type === 'response.completed') {
              // Final event - extract usage if available
              usage = event.response?.usage || null;
              if (event.response?.output_text && !outputText) {
                outputText = event.response.output_text;
              }
            } else if (event.type === 'response.failed') {
              const errorMsg = event.response?.error?.message || 'Response generation failed';
              throw new Error(`Streaming response failed: ${errorMsg}`);
            }

            // Log progress periodically (every 30 seconds)
            const elapsed = Date.now() - streamStartTime;
            if (elapsed > 30000 && eventCount % 100 === 0) {
              const charsReceived = outputText.length;
              console.log(`[OpenAIClientWrapper] Streaming progress: ${charsReceived} chars, ${(elapsed/1000).toFixed(0)}s elapsed`);
            }

            // SAFETY: Check if streaming is taking too long
            if (elapsed > MAX_STREAMING_TIME_MS) {
              console.warn(`[OpenAIClientWrapper] ⚠️ Streaming exceeded ${MAX_STREAMING_TIME_MS/60000} minutes - stopping to prevent hang`);
              break;
            }
          }
          
          const totalTime = Date.now() - streamStartTime;
          if (totalTime > 60000) {
            console.log(`[OpenAIClientWrapper] Streaming completed: ${outputText.length} chars in ${(totalTime/1000).toFixed(1)}s`);
          }

          // Check for empty response - this is a retryable condition
          if (!outputText && attempt < maxStreamRetries - 1) {
            const retryDelay = baseRetryDelayMs * Math.pow(2, attempt);
            console.warn(
              `[OpenAIClientWrapper] ⚠️ Empty streaming response after ${(totalTime/1000).toFixed(1)}s. ` +
              `Retrying in ${(retryDelay/1000).toFixed(1)}s (attempt ${attempt + 1}/${maxStreamRetries})...`
            );
            await sleep(retryDelay);
            continue;
          }

          // Success! Break out of retry loop
          lastError = null;
          break;
          
        } catch (streamError) {
          const elapsed = Date.now() - streamStartTime;
          lastError = streamError;
          
          // Check if this is a retryable network error
          if (isRetryableNetworkError(streamError) && attempt < maxStreamRetries - 1) {
            const retryDelay = baseRetryDelayMs * Math.pow(2, attempt); // Exponential backoff: 2s, 4s, 8s
            console.warn(
              `[OpenAIClientWrapper] ⚠️ Network error after ${(elapsed/1000).toFixed(1)}s: ${streamError.message}. ` +
              `Retrying in ${(retryDelay/1000).toFixed(1)}s (attempt ${attempt + 1}/${maxStreamRetries})...`
            );
            await sleep(retryDelay);
            continue;
          }
          
          // Non-retryable error or max retries exceeded
          console.error(`[OpenAIClientWrapper] Streaming error after ${(elapsed/1000).toFixed(1)}s: ${streamError.message}`);
          throw streamError;
        }
      }
      
      // If we exited the loop with an error, throw it
      if (lastError) {
        throw lastError;
      }
      
      if (!outputText) {
        throw new Error('No output received from streaming response');
      }
      
      result = {
        choices: [{
          message: {
            content: outputText
          }
        }],
        usage: usage
      };
    } else {
      // Use standard chat completions API
      const requestParams = {
        model: model,
        messages: messages || [],
        temperature: Number.isFinite(temperature) ? temperature : undefined,
        ...otherParams
      };

      if (response_format) {
        requestParams.response_format = response_format;
      }

      result = await this.client.chat.completions.create(requestParams);
    }

    // Log success
    if (this.tracer) {
      const duration = Date.now() - startTime;
      const content = result.choices?.[0]?.message?.content;
      await this.tracer.logEvent('llm_response', {
        model, // Include model for cost calculation
        content,
        usage: result.usage
      }, {
        requestId,
        duration,
        step: effectiveStep,
        context: traceOptions.context
      });
    }

    return result;

    } catch (error) {
      // Log error
      if (this.tracer) {
        const duration = Date.now() - startTime;
        await this.tracer.logEvent('llm_error', {
          message: error.message,
          code: error.code,
          type: error.type
        }, {
          requestId,
          duration,
          step: effectiveStep,
          context: traceOptions.context
        });
      }
      throw error;
    }
  }

  /**
   * Poll for response completion (for responses API background jobs)
   */
  async pollResponse(responseId, maxAttempts = 30, intervalMs = 1000) {
    const startTime = Date.now();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.client.responses.retrieve(responseId);
        const status = String(response?.status || 'unknown').toLowerCase();

        if (status === 'completed' || status === 'succeeded' || status === 'done') {
          // Extract output_text
          let outputText = response.output_text;
          if (!outputText && response.output) {
            // Try to extract from output array
            try {
              outputText = response.output.map(o => (o?.content || []).map(c => (c?.text || '')).join('')).join('\n');
            } catch (e) {
              // Ignore
            }
          }
          
          if (outputText) {
            const duration = Date.now() - startTime;
            if (duration > 5000) {
              console.log(`[OpenAIClientWrapper] Polling completed after ${(duration / 1000).toFixed(1)}s (${attempt + 1} attempts)`);
            }
            return {
              choices: [{
                message: {
                  content: typeof outputText === 'string'
                    ? outputText
                    : JSON.stringify(outputText)
                }
              }],
              usage: response.usage // Include usage data for cost tracking
            };
          }
        }

        if (status === 'failed' || status === 'cancelled' || status === 'expired' || status === 'incomplete') {
          throw new Error(`Response failed with status: ${status}`);
        }

        // Log progress every 5 attempts
        if ((attempt + 1) % 5 === 0) {
          const elapsed = Date.now() - startTime;
          console.log(`[OpenAIClientWrapper] Polling response ${responseId}: attempt ${attempt + 1}/${maxAttempts}, status: ${status}, elapsed: ${(elapsed / 1000).toFixed(1)}s`);
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      } catch (error) {
        // If it's a network error, retry
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
          if (attempt < maxAttempts - 1) {
            console.warn(`[OpenAIClientWrapper] Network error during polling (attempt ${attempt + 1}/${maxAttempts}), retrying...`);
            await new Promise(resolve => setTimeout(resolve, intervalMs));
            continue;
          }
        }
        throw error;
      }
    }

    const duration = Date.now() - startTime;
    throw new Error(`Response polling timeout after ${maxAttempts} attempts (${(duration / 1000).toFixed(1)}s)`);
  }

  /**
   * Stream response (for responses API)
   */
  async streamResponse(responseId) {
    return await this.client.responses.stream({ response_id: responseId });
  }
}

