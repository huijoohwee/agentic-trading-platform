import { parentPort, workerData } from 'node:worker_threads';
import { experiment } from '../src/experiment.mjs';
const stdout = [];
try {
  parentPort.postMessage(experiment(workerData.code, workerData.bars, stdout));
} catch (error) {
  parentPort.postMessage({ stdout, stderr: [error.message], signals: [], report: null, authority: false });
}
