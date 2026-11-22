import { workerData, parentPort } from 'node:worker_threads';
import { runArtifact } from './research-artifact.mjs';
try {
  parentPort.postMessage({ result: runArtifact(workerData) });
} catch (error) {
  parentPort.postMessage({ error: /^[A-Z_]+$/.test(error.message) ? error.message : 'RESEARCH_FAILED' });
}
