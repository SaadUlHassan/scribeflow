import { API_URL, apiHeaders, passthrough } from '@/lib/api';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const upstream = await fetch(
    `${API_URL}/v1/transcriptions/${encodeURIComponent(id)}`,
    { headers: apiHeaders(), cache: 'no-store' },
  );
  return passthrough(upstream);
}
