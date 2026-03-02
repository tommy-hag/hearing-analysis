/**
 * PDF Converter
 * 
 * Converts PDF files to markdown using lptomd.py
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PDFConverter {
  constructor(options = {}) {
    // Path to pdf-to-markdown.py script
    this.scriptPath = options.scriptPath || resolve(__dirname, '../../scripts/pdf-to-markdown.py');
    // Try to use venv Python if available, otherwise system Python
    const venvPath = resolve(__dirname, '../../venv/bin/python');
    this.pythonCommand = existsSync(venvPath) ? venvPath : (options.pythonCommand || 'python3');
    // No content length limit - we need the full PDF including all § sections
    this.maxContentLength = options.maxContentLength || Infinity;
  }

  /**
   * Convert PDF to markdown
   * @param {string} pdfPath - Path to PDF file
   * @returns {Promise<string>} Converted markdown content
   */
  async convertToMarkdown(pdfPath) {
    if (!existsSync(pdfPath)) {
      console.warn(`[PDFConverter] PDF file not found: ${pdfPath}`);
      return '';
    }

    if (!existsSync(this.scriptPath)) {
      console.warn(`[PDFConverter] lptomd.py script not found: ${this.scriptPath}`);
      return '';
    }

    // Generate output path
    const outputPath = pdfPath.replace(/\.pdf$/i, '.md');
    
    try {
      // Check if already converted
      if (existsSync(outputPath)) {
        console.log(`[PDFConverter] Using existing markdown file: ${outputPath}`);
        const content = readFileSync(outputPath, 'utf-8');
        return content; // No truncation - we need full content including all § sections
      }

      // Check for placeholder text file
      const placeholderPath = pdfPath.replace(/\.pdf$/i, '_placeholder.txt');
      if (existsSync(placeholderPath)) {
        console.log(`[PDFConverter] Using placeholder text file: ${placeholderPath}`);
        const content = readFileSync(placeholderPath, 'utf-8');
        return content; // No truncation
      }

      // Check if PyMuPDF is available
      const checkProcess = spawn(this.pythonCommand, ['-c', 'import fitz']);
      const checkResult = await new Promise((resolve) => {
        checkProcess.on('close', (code) => resolve(code === 0));
      });

      if (!checkResult) {
        console.warn('[PDFConverter] PyMuPDF (fitz) not installed. PDF conversion requires: pip install PyMuPDF');
        return '';
      }

      console.log(`[PDFConverter] Converting PDF: ${pdfPath}`);
      
      // Run lptomd.py
      const process = spawn(this.pythonCommand, [
        this.scriptPath,
        '-i', pdfPath,
        '-o', outputPath
      ]);

      let stderr = '';
      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const exitCode = await new Promise((resolve, reject) => {
        process.on('close', (code) => resolve(code));
        process.on('error', (err) => reject(err));
      });

      if (exitCode !== 0) {
        console.error(`[PDFConverter] Conversion failed with exit code ${exitCode}`);
        if (stderr) console.error(`[PDFConverter] Error: ${stderr}`);
        return '';
      }

      // Read converted content
      if (existsSync(outputPath)) {
        const content = readFileSync(outputPath, 'utf-8');
        console.log(`[PDFConverter] Successfully converted ${pdfPath} (${content.length} chars)`);

        return content; // No truncation - full PDF content needed
      } else {
        console.error('[PDFConverter] Output file not created');
        return '';
      }

    } catch (error) {
      console.error(`[PDFConverter] Error converting PDF: ${error.message}`);
      return '';
    }
  }

  /**
   * Check if content has proper markdown headers
   * @private
   */
  hasMarkdownHeaders(content) {
    if (!content) return false;
    // Check for markdown headers (# ## ### etc. at start of line)
    return /^#{1,6}\s+.+$/m.test(content);
  }

  /**
   * Convert multiple PDFs
   * @param {Array} materials - Array of material objects with filePath
   * @param {Object} options - Options
   * @param {boolean} options.forceConvert - Force conversion even if contentMd exists
   * @returns {Promise<Array>} Materials with contentMd populated
   */
  async convertMaterials(materials, options = {}) {
    const converted = [];
    
    for (const material of materials) {
      const convertedMaterial = { ...material };
      const existingContent = material.contentMd || '';
      const hasHeaders = this.hasMarkdownHeaders(existingContent);
      
      // Convert if:
      // 1. contentMd is empty, OR
      // 2. contentMd exists but has no markdown headers (database content without structure), OR
      // 3. forceConvert is true
      // AND filePath exists
      const shouldConvert = material.filePath && (
        !existingContent.trim() || 
        !hasHeaders ||
        options.forceConvert
      );
      
      if (shouldConvert) {
        const markdown = await this.convertToMarkdown(material.filePath);
        if (markdown && this.hasMarkdownHeaders(markdown)) {
          console.log(`[PDFConverter] Using converted markdown (${markdown.length} chars, has headers)`);
          convertedMaterial.contentMd = markdown;
          convertedMaterial.content = markdown;
        } else if (!existingContent.trim() && markdown) {
          // Fallback: use converted content even without headers if no existing content
          convertedMaterial.contentMd = markdown;
          convertedMaterial.content = markdown;
        }
        // else: keep existing contentMd (better than nothing)
      }
      
      converted.push(convertedMaterial);
    }
    
    return converted;
  }
}
