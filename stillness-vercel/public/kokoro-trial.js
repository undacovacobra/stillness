(() => {
  async function render(text, signal) {
    signal.throwIfAborted();
    const request = new AbortController();
    const cancel = () => request.abort(signal.reason);
    const timeout = setTimeout(() => request.abort(), 40_000);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch('/api/kokoro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: request.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/wav')) {
        throw new Error('Kokoro Heart is temporarily unavailable. Tap Retry Kokoro Heart to try again.');
      }
      return { blob: await response.blob(), mimeType: 'audio/wav' };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (request.signal.aborted) throw new Error('Kokoro Heart took too long to respond. Tap Retry Kokoro Heart to try again.');
      if (error instanceof TypeError) throw new Error('The voice connection dropped. Tap Retry Kokoro Heart to try again.');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }

  window.StillnessKokoro = { render };
})();
