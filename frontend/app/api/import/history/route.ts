import { NextResponse } from 'next/server';
import { getHistoryStore } from '@/app/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const history = getHistoryStore();
  return NextResponse.json(history);
}
