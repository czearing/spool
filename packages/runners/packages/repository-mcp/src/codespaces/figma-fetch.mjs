export function withFigmaVariableTimeout(fetch) {
  return (input, init) => {
    const url = typeof input === "string" ? input : input.url ?? input.href;
    if (!/^https:\/\/api\.figma\.com\/v1\/files\/[^/?#]+\/variables\/local(?:[?#]|$)/.test(url))
      return fetch(input, init);
    const existing = init?.signal ?? input.signal;
    const timeout = AbortSignal.timeout(15000);
    return fetch(input, { ...init, signal: existing ? AbortSignal.any([existing, timeout]) : timeout });
  };
}

globalThis.fetch = withFigmaVariableTimeout(globalThis.fetch);
