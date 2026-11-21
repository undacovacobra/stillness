(() => {
  let worker;

  async function render(text, signal) {
    signal.throwIfAborted();
    const current = worker ??= new Worker('/kokoro-worker.js', { type: 'module' });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => fail(new Error('Kokoro took too long to prepare this clip.')), 180_000);

      function cleanup() {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        current.removeEventListener('message', receive);
        current.removeEventListener('error', workerFailed);
      }

      function fail(error) {
        cleanup();
        current.terminate();
        worker = undefined;
        reject(error);
      }

      function abort() { fail(signal.reason); }
      function workerFailed() { fail(new Error('Kokoro could not load on this device.')); }

      function receive({ data }) {
        if (data.error) {
          fail(new Error(data.error));
          return;
        }
        cleanup();
        resolve({ blob: new Blob([data.wav], { type: 'audio/wav' }), mimeType: 'audio/wav' });
      }

      signal.addEventListener('abort', abort, { once: true });
      current.addEventListener('message', receive);
      current.addEventListener('error', workerFailed);
      current.postMessage(text);
    });
  }

  window.StillnessKokoro = { render };
})();
