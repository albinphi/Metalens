import { NextRequest, NextResponse } from 'next/server';
import { computePair, PairParams } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body: PairParams = await req.json();
    if (!body.symbol_a || !body.expiry_a || !body.symbol_b || !body.expiry_b) {
      return NextResponse.json({ detail: 'Missing symbol or expiry parameters' }, { status: 400 });
    }

    const data = computePair(body);
    const expiryGapLimit = body.expiry_gap ?? 7;
    const eligible = data.some(r => r.expiry_gap <= expiryGapLimit);

    return NextResponse.json({
      data,
      eligible,
      observations: data.length,
      warning: data.length ? null : 'No paired observations for selected contracts.',
    });
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Error running pair comparison' }, { status: 500 });
  }
}
