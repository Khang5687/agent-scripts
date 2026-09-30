/**
 * Client for pxpipe's loopback dashboard API (pxpipe-proxy 0.14.0, dist/dashboard.js route table).
 * Requests carry no Origin header, which pxpipe's same-origin guard accepts for mutations.
 */

const REQUEST_TIMEOUT_MS = 2_000;

async function request(
  port: number,
  pathname: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    return await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function getJson(port: number, pathname: string, signal?: AbortSignal): Promise<unknown> {
  const response = await request(port, pathname, {}, signal);
  if (!response.ok) throw new Error(`pxpipe ${pathname} returned ${response.status}`);
  return response.json();
}

export async function getOptionalJson(port: number, pathname: string): Promise<unknown | null> {
  const response = await request(port, pathname);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pxpipe ${pathname} returned ${response.status}`);
  return response.json();
}

export async function getBytes(port: number, pathname: string): Promise<Uint8Array | null> {
  const response = await request(port, pathname);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pxpipe ${pathname} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function postJson(port: number, pathname: string, body: unknown): Promise<void> {
  const response = await request(port, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`pxpipe ${pathname} returned ${response.status}`);
}

export function readNumber(record: unknown, key: string): number | null {
  const value = typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readString(record: unknown, key: string): string | null {
  const value = typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined;
  return typeof value === "string" ? value : null;
}

export function readBoolean(record: unknown, key: string): boolean | null {
  const value = typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined;
  return typeof value === "boolean" ? value : null;
}
