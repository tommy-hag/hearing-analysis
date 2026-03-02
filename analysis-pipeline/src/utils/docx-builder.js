/**
 * DOCX Builder
 *
 * Wraps the Python build_docx.py script to generate DOCX files
 * from markdown with CriticMarkup formatting.
 *
 * When used with RunDirectoryManager, DOCX is saved to:
 *   output/runs/{hearingId}/{label}/hearing-{hearingId}-analysis.docx
 *
 * When used standalone (legacy mode), DOCX is saved to:
 *   output/checkpoints/{hearingId}/{label}/hearing-{hearingId}-analysis.docx
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { StepLogger } from './step-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class DocxBuilder {
  constructor(options = {}) {
    this.log = new StepLogger('DocxBuilder');
    // Resolve paths relative to pipeline root
    const pipelineRoot = resolve(__dirname, '../..');
    
    this.pythonBin = options.pythonBin || process.env.PYTHON_BIN || 'python3';
    this.scriptPath = options.scriptPath || join(pipelineRoot, 'src/utils/build-docx.py');
    this.templatePath = options.templatePath || join(pipelineRoot, 'templates/template.docx');
    this.templateBlockPath = options.templateBlockPath || join(pipelineRoot, 'templates/blok.md');
    
    // Verify required files exist
    if (!existsSync(this.scriptPath)) {
      throw new Error(`Python script not found: ${this.scriptPath}`);
    }
    if (!existsSync(this.templatePath)) {
      throw new Error(`DOCX template not found: ${this.templatePath}`);
    }
    if (!existsSync(this.templateBlockPath)) {
      throw new Error(`Template block not found: ${this.templateBlockPath}`);
    }
  }

  /**
   * Build DOCX file from markdown
   * @param {string} markdown - Markdown content with CriticMarkup
   * @param {number} hearingId - Hearing ID for output filename
   * @param {string} outputDir - Output directory (defaults to checkpoints directory)
   * @param {string} checkpointLabel - Checkpoint label for subdirectory
   * @returns {Promise<string>} Path to generated DOCX file
   */
  async buildDocx(markdown, hearingId, outputDir = null, checkpointLabel = 'default') {
    if (!markdown || typeof markdown !== 'string') {
      throw new Error('Markdown content is required');
    }
    if (!hearingId) {
      throw new Error('Hearing ID is required');
    }

    this.log.start({ hearingId, markdownChars: markdown.length });

    // Determine output directory
    const pipelineRoot = resolve(__dirname, '../..');
    if (!outputDir) {
      outputDir = join(pipelineRoot, 'output/checkpoints', String(hearingId), checkpointLabel);
    }
    
    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });
    
    // Generate output filename
    const outputPath = join(outputDir, `hearing-${hearingId}-analysis.docx`);
    
    // Build command arguments
    const args = [
      this.scriptPath,
      '--markdown', '-',  // Read from stdin
      '--out', outputPath,
      '--template', this.templatePath,
      '--template-block', this.templateBlockPath
    ];

    return new Promise((resolve, reject) => {
      // Spawn Python process
      const pythonProcess = spawn(this.pythonBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: resolve(__dirname, '../..')
      });

      let stdout = '';
      let stderr = '';

      // Collect stdout
      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Write markdown to stdin
      pythonProcess.stdin.write(markdown, 'utf-8');
      pythonProcess.stdin.end();

      // Handle process completion
      pythonProcess.on('close', (code) => {
        if (code === 0) {
          // Success - verify file was created
          if (existsSync(outputPath)) {
            this.log.info(`DOCX generated: ${outputPath}`);
            this.log.complete({ output: outputPath });
            resolve(outputPath);
          } else {
            this.log.warn('DOCX file was not created', { path: outputPath });
            reject(new Error(`DOCX file was not created at ${outputPath}`));
          }
        } else {
          // Error
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          this.log.warn('DOCX build failed', { code, error: errorMsg.substring(0, 200) });
          reject(new Error(`DOCX build failed: ${errorMsg}`));
        }
      });

      // Handle process errors
      pythonProcess.on('error', (error) => {
        this.log.warn('Failed to spawn Python', { error: error.message });
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });
    });
  }

  /**
   * Check if Python and required dependencies are available
   * @returns {Promise<boolean>} True if available, false otherwise
   */
  async checkDependencies() {
    return new Promise((resolve) => {
      const checkProcess = spawn(this.pythonBin, ['-c', 'import docx; print("OK")'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      checkProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      checkProcess.on('close', (code) => {
        resolve(code === 0 && stdout.trim() === 'OK');
      });

      checkProcess.on('error', () => {
        resolve(false);
      });
    });
  }
}








