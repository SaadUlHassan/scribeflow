/** Server-side only: proxy configuration for the ScribeFlow API. */

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';

export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.API_KEY;
  if (!key) {
    throw new Error('API_KEY is not set for the web proxy');
  }
  return { 'x-api-key': key, ...extra };
}

/** Re-wrap an upstream response, forwarding status and selected headers. */
export function passthrough(upstream: Response): Response {
  const headers = new Headers();
  for (const name of ['content-type', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
