import { NextResponse } from 'next/server';
import { computeSignals } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sigs = computeSignals(2, true);

  if (!sigs.length) {
    return new NextResponse('', {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename=candidate-signals.csv',
      },
    });
  }

  const keys = Object.keys(sigs[0]);
  const csvRows = [
    keys.join(','),
    ...sigs.map(row => keys.map(k => JSON.stringify((row as any)[k] ?? '')).join(',')),
  ];

  return new NextResponse(csvRows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename=candidate-signals.csv',
    },
  });
}
