import { API_URL, apiHeaders, passthrough } from '@/lib/api';

/** Stream the multipart upload through to the API without buffering. */
export async function POST(request: Request): Promise<Response> {
  const upstream = await fetch(`${API_URL}/v1/transcriptions`, {
    method: 'POST',
    headers: apiHeaders({
      'content-type': request.headers.get('content-type') ?? '',
    }),
    body: request.body,
    duplex: 'half',
  } as RequestInit);
  return passthrough(upstream);
}
