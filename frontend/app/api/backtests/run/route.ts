import { NextRequest, NextResponse } from 'next/server';
import { computeBacktest, BacktestParams } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body: BacktestParams = await req.json();
    if (!body.symbol_a || !body.expiry_a || !body.symbol_b || !body.expiry_b) {
      return NextResponse.json({ detail: 'Missing symbol or expiry parameters' }, { status: 400 });
    }

    const res = computeBacktest(body);
    return NextResponse.json(res);
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Error running backtest' }, { status: 500 });
  }
}
