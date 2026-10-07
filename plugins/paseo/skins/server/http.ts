export const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export function requireHttps(url: URL): URL {
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS URL: ${url.origin}`);
  if (url.username || url.password) throw new Error("Refusing URL with credentials");
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
  const body = response.body;
  if (!body) throw new Error("Response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * GETs an HTTPS URL with a hard deadline and size cap. Redirects are followed manually and must
 * stay on HTTPS and on the original host.
 */
export async function fetchBytes(
  input: URL,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = requireHttps(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(url.href, { redirect: "manual", signal: signal as RequestInit["signal"] });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`Redirect without location from ${url.host}`);
      const next = requireHttps(new URL(location, url));
      if (next.host !== input.host) throw new Error(`Refusing redirect to ${next.host}`);
      url = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${url.host} responded ${response.status}`);
    }
    return readCapped(response, maxBytes);
  }
  throw new Error("Too many redirects");
}
