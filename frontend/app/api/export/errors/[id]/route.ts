import { NextRequest, NextResponse } from 'next/server';
import { getHistoryStore } from '@/app/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const history = getHistoryStore();
  const item = history.find(h => h.id === params.id);
  const errors = item?.errors || [];

  const csvRows = ['row,symbol,issues', ...errors.map((e: any) => `${e.row},"${e.symbol}","${e.issues}"`)];

  return new NextResponse(csvRows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename=import-errors.csv',
    },
  });
}
