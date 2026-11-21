import { experiment } from './experiment.mjs';
self.onmessage = ({ data }) => {
  const stdout = [];
  try {
    self.postMessage(experiment(data.code, data.bars, stdout));
  } catch (error) {
    self.postMessage({ authority: false, stdout, stderr: [error.message], signals: [], report: null });
  }
};
