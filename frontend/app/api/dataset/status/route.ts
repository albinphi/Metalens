import { NextResponse } from 'next/server';
import { getDatasetStatus } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = getDatasetStatus();
  return NextResponse.json(status);
}
