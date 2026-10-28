import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const key = process.env.GEMINI_API_KEY;
  return NextResponse.json({
    configured: Boolean(key && key.trim()),
    provider: 'Google Gemini API',
  });
}
