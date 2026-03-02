/**
 * Model Reranker
 * 
 * Node.js wrapper for Python-based BGE reranker model.
 * Uses a persistent server to avoid ~40s model loading per request.
 * 
 * Architecture:
 * - Primary: HTTP calls to persistent reranker-server.py
 * - Auto-start: Server is started automatically if not running
 * - Fallback: Returns original chunks if server unavailable
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Server configuration
const DEFAULT_PORT = 5050;
const DEFAULT_HOST = '127.0.0.1';

export class ModelReranker {
  constructor(options = {}) {
    this.modelName = options.modelName || 'BAAI/bge-reranker-v2-m3';
    // Use venv Python by default (FlagEmbedding is installed there)
    const venvPython = join(__dirname, '../../venv/bin/python3');
    this.pythonPath = options.pythonPath || process.env.RERANKER_PYTHON_PATH || venvPython;
    this.serverScript = join(__dirname, 'reranker-server.py');
    this.enabled = options.enabled !== false;
    this.useFp16 = options.useFp16 === true;
    
    // Server settings
    this.port = options.port || parseInt(process.env.RERANKER_PORT) || DEFAULT_PORT;
    this.host = options.host || process.env.RERANKER_HOST || DEFAULT_HOST;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.timeout = options.timeout || 30000; // 30s timeout for HTTP calls (inference can take 5-15s with multiple passages)
    
    // Server process management
    this._serverProcess = null;
    this._serverStarting = false;
    this._serverReady = false;
  }

  /**
   * Get the PID file path for the server
   */
  _getPidFile() {
    return `/tmp/reranker-server-${this.port}.pid`;
  }

  /**
   * Check if server is running by checking PID file and process
   */
  _isServerRunning() {
    const pidFile = this._getPidFile();
    if (!existsSync(pidFile)) {
      return false;
    }
    
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim());
      // Check if process exists
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // Process doesn't exist, clean up stale PID file
      try { unlinkSync(pidFile); } catch {}
      return false;
    }
  }

  /**
   * Start the reranker server as a background process
   */
  async _startServer() {
    if (this._serverStarting) {
      // Wait for existing start attempt
      await this._waitForServer(60000);
      return;
    }
    
    if (this._isServerRunning()) {
      this._serverReady = true;
      return;
    }
    
    this._serverStarting = true;
    
    console.log('[ModelReranker] Starting persistent reranker server...');
    
    const args = [
      this.serverScript,
      '--port', String(this.port),
      '--host', this.host,
      '--model', this.modelName
    ];
    
    if (!this.useFp16) {
      args.push('--no-fp16');
    }
    
    this._serverProcess = spawn(this.pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: '',
        TORCH_DEVICE: 'cpu'
      }
    });
    
    // Don't let server process prevent Node from exiting
    this._serverProcess.unref();
    
    // Log server output for debugging
    this._serverProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[RerankerServer] ${msg}`);
    });
    
    this._serverProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('werkzeug')) {
        console.error(`[RerankerServer] ${msg}`);
      }
    });
    
    this._serverProcess.on('error', (err) => {
      console.error('[ModelReranker] Failed to start server:', err.message);
      this._serverStarting = false;
    });
    
    this._serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[ModelReranker] Server exited with code ${code}`);
      }
      this._serverReady = false;
      this._serverStarting = false;
    });
    
    // Wait for server to be ready
    try {
      await this._waitForServer(90000); // 90s timeout for initial model loading
      console.log('[ModelReranker] ✅ Server ready');
    } catch (e) {
      console.warn('[ModelReranker] Server failed to start:', e.message);
      this._serverStarting = false;
      throw e;
    }
  }

  /**
   * Wait for server to become ready
   */
  async _waitForServer(timeoutMs = 60000) {
    const startTime = Date.now();
    const checkInterval = 1000;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await this._httpGet('/health');
        if (response.status === 'ready') {
          this._serverReady = true;
          this._serverStarting = false;
          return true;
        }
      } catch (e) {
        // Server not ready yet
      }
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    throw new Error(`Server did not become ready within ${timeoutMs}ms`);
  }

  /**
   * Make HTTP GET request
   */
  async _httpGet(path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return await response.json();
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  /**
   * Make HTTP POST request
   */
  async _httpPost(path, data) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return await response.json();
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  /**
   * Ensure server is running, start if needed
   */
  async _ensureServer() {
    if (this._serverReady) {
      // Quick health check
      try {
        const health = await this._httpGet('/health');
        if (health.status === 'ready') {
          return true;
        }
      } catch (e) {
        this._serverReady = false;
      }
    }
    
    // Start or wait for server
    await this._startServer();
    return true;
  }

  /**
   * Rerank chunks using BGE cross-encoder model
   * 
   * @param {string} query - Search query
   * @param {Array} chunks - Array of chunk objects with content
   * @returns {Promise<Array>} Chunks with rerank scores
   */
  async rerank(query, chunks) {
    if (!this.enabled || !chunks || chunks.length === 0) {
      return chunks;
    }

    try {
      // Ensure server is running
      await this._ensureServer();
      
      // Extract passage texts
      const passages = chunks.map(item => {
        const chunk = item.chunk || item;
        return (chunk.content || '').substring(0, 512); // Limit length for performance
      });

      // Call server
      const result = await this._httpPost('/rerank', { query, passages });
      
      if (!result.success) {
        throw new Error(result.error || 'Reranking failed');
      }

      // Combine with original chunks
      return chunks.map((item, idx) => ({
        ...item,
        rerankScore: result.scores[idx] || 0,
        score: result.scores[idx] || item.score || 0
      }));

    } catch (error) {
      console.warn('[ModelReranker] Reranking failed, returning original chunks:', error.message);
      return chunks;
    }
  }

  /**
   * Warm up the model by running a test query
   * @returns {Promise<boolean>} Success status
   */
  async warmup() {
    try {
      console.log('[ModelReranker] Warming up (ensuring server is ready)...');
      await this._ensureServer();
      
      // Run a test rerank
      const result = await this._httpPost('/rerank', {
        query: 'test query',
        passages: ['test passage']
      });
      
      if (result.success) {
        console.log('[ModelReranker] ✅ Warmup complete');
        return true;
      }
      
      throw new Error(result.error || 'Warmup failed');
    } catch (error) {
      console.warn('[ModelReranker] Warmup failed:', error.message);
      this.enabled = false;
      return false;
    }
  }

  /**
   * Check if the server is available
   * @returns {Promise<boolean>} Availability status
   */
  async checkAvailability() {
    try {
      await this._ensureServer();
      const health = await this._httpGet('/health');
      return health.status === 'ready';
    } catch (error) {
      console.warn('[ModelReranker] Not available:', error.message);
      return false;
    }
  }

  /**
   * Gracefully shutdown the server
   */
  async shutdown() {
    if (!this._serverReady && !this._isServerRunning()) {
      return;
    }
    
    try {
      await this._httpPost('/shutdown', {});
    } catch (e) {
      // Server might already be shutting down
    }
    
    this._serverReady = false;
  }
}
