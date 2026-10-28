import { NextRequest, NextResponse } from 'next/server';
import { getObservations } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || undefined;
  const obs = getObservations({ symbol });

  if (!obs.length) {
    return new NextResponse('', {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename=observations.csv',
      },
    });
  }

  const keys = Object.keys(obs[0]);
  const csvRows = [
    keys.join(','),
    ...obs.map(row => keys.map(k => JSON.stringify((row as any)[k] ?? '')).join(',')),
  ];

  return new NextResponse(csvRows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename=observations.csv',
    },
  });
}
