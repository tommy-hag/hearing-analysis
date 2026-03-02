#!/usr/bin/env node

/**
 * Minimal test of SubPositionExtractor to debug hanging
 */

import { OpenAIClientWrapper } from '../src/utils/openai-client.js';

async function testMinimalLLM() {
  console.log('Testing minimal LLM call...');
  
  const client = new OpenAIClientWrapper({
    model: 'gpt-5-mini',
    verbosity: 'medium',
    reasoningEffort: 'medium',
    timeout: 10000 // 10 seconds
  });
  
  try {
    console.log('Calling LLM with simple prompt...');
    const startTime = Date.now();
    
    const response = await client.createCompletion({
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.'
        },
        {
          role: 'user',
          content: 'Say "hello" and nothing else.'
        }
      ]
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`✓ LLM responded in ${elapsed}ms`);
    console.log(`Response: ${response.choices[0]?.message?.content}`);
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    process.exit(1);
  }
}

// Run test
testMinimalLLM().catch(console.error);
