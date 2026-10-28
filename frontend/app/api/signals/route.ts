import { NextRequest, NextResponse } from 'next/server';
import { computeSignals } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const min_z = searchParams.get('min_z') ? parseFloat(searchParams.get('min_z')!) : 2;
  const eligible_only = searchParams.get('eligible_only') !== 'false';

  const signals = computeSignals(min_z, eligible_only);
  return NextResponse.json(signals);
}
