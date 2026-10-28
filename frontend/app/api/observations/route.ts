import { NextRequest, NextResponse } from 'next/server';
import { getObservations } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || undefined;
  const expiry = searchParams.get('expiry') || undefined;
  const start = searchParams.get('start') || undefined;
  const end = searchParams.get('end') || undefined;

  const obs = getObservations({ symbol, expiry, start, end });
  return NextResponse.json(obs);
}
