import { LocalInference, InferenceQueue } from './inference.js';
const requests = new InferenceQueue(
  new LocalInference(),
  (response) => {
    process.send?.(response, (error) => {
      if (error) {
        process.stderr.write('Local inference IPC: ' + error.message + '\n');
      }
    });
  },
  (error) => {
    process.stderr.write('Local inference IPC: ' + String(error) + '\n');
  },
);
process.on('message', (message: unknown) => {
  void requests.submit(message);
});
process.on('disconnect', () => {
  process.exit(0);
});
