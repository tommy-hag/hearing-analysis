import { mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class FlightRecorder {
  constructor() {
    this.jobId = null;
    this.baseDir = join(__dirname, '../../output/flight-logs');
    this.initialized = false;
    this.jobDir = null;
    this.logFile = null;
  }

  initialize(jobId) {
    this.jobId = jobId;
    this.jobDir = join(this.baseDir, `job_${jobId}`);
    
    try {
      mkdirSync(this.jobDir, { recursive: true });
      this.logFile = join(this.jobDir, 'llm_trace.jsonl');
      this.initialized = true;
      console.log(`[FlightRecorder] ✈️  Recording flight data to ${this.jobDir}`);
    } catch (error) {
      console.error(`[FlightRecorder] ❌ Failed to initialize: ${error.message}`);
    }
  }

  logInteraction(type, context, input, output, metadata = {}) {
    if (!this.initialized || !this.logFile) return;

    const entry = {
      timestamp: new Date().toISOString(),
      type,
      context,
      input,
      output,
      metadata: {
        ...metadata,
        jobId: this.jobId
      }
    };

    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (error) {
      // Silent fail to not break pipeline
      console.error(`[FlightRecorder] Write error: ${error.message}`);
    }
  }

  logFailure(context, identifier, data) {
    if (!this.initialized || !this.jobDir) return;

    // Sanitize identifier for filename
    const safeId = String(identifier).replace(/[^a-z0-9-_]/gi, '_').substring(0, 50);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${context}_${safeId}_failure.json`;
    const filePath = join(this.jobDir, filename);

    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2));
      this.logInteraction('failure_artifact', context, identifier, `Saved to ${filename}`, { filePath });
      console.log(`[FlightRecorder] 📸 Saved failure snapshot to ${filename}`);
    } catch (error) {
      console.error(`[FlightRecorder] Failed to save failure artifact: ${error.message}`);
    }
  }
}

export const flightRecorder = new FlightRecorder();

