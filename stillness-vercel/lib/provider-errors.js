function boundedSeconds(seconds) {
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(1, Math.ceil(seconds))) : undefined;
}

async function retryAfterSeconds(providerResponse) {
  const header = providerResponse.headers?.get?.('Retry-After')?.trim();
  if (header) {
    if (/^\d+$/.test(header)) {
      const seconds = boundedSeconds(Number(header));
      if (seconds !== undefined) return seconds;
    } else if (/^[A-Za-z]/.test(header)) {
      // Retry-After also permits an HTTP date, not just a delay in seconds.
      const seconds = boundedSeconds((Date.parse(header) - Date.now()) / 1000);
      if (seconds !== undefined) return seconds;
    }
  }

  const data = await providerResponse.json().catch(() => ({}));
  const details = data?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo' ||
          typeof detail.retryDelay !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(detail.retryDelay)) continue;
      const seconds = boundedSeconds(Number(detail.retryDelay.slice(0, -1)));
      if (seconds !== undefined) return seconds;
    }
  }
  return 60;
}

export async function respondToProviderRateLimit(providerResponse, res, { model, service }) {
  const delay = await retryAfterSeconds(providerResponse);
  const voice = service === 'voice';
  // These are the complete diagnostics: never log the upstream body, note, or key.
  console.warn({ event: 'provider_rate_limited', model, status: 429, retryAfterSeconds: delay });
  if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(delay));
  return res.status(429).json({
    error: `${voice ? 'Studio voice' : 'Meditation writing'} has reached its usage limit. Please wait before trying again.`,
    code: voice ? 'VOICE_RATE_LIMITED' : 'SCRIPT_RATE_LIMITED',
    retryAfterSeconds: delay
  });
}
