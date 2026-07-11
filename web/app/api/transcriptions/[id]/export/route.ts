import { API_URL, apiHeaders, passthrough } from '@/lib/api';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const format = new URL(request.url).searchParams.get('format') ?? 'srt';
  const upstream = await fetch(
    `${API_URL}/v1/transcriptions/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,
    { headers: apiHeaders(), cache: 'no-store' },
  );
  return passthrough(upstream);
}
