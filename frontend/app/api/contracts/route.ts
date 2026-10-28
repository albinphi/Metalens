import { NextResponse } from 'next/server';
import { getContracts } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = getContracts();
  return NextResponse.json(data);
}
