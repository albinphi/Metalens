import { NextRequest, NextResponse } from 'next/server';
import { parseCsv, autoMap } from '@/app/lib/csv';
import { savePreview } from '@/app/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ detail: 'No file provided' }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith('.csv')) {
      return NextResponse.json({ detail: 'CSV supported. XLSX import is not enabled.' }, { status: 415 });
    }

    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    const token = crypto.randomUUID();
    const mapping = autoMap(headers);

    const dateRegex = /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/;
    let ambiguous = false;
    for (const r of rows.slice(0, 50)) {
      const tCol = mapping.trade_date;
      const eCol = mapping.expiry_date;
      const tVal = tCol ? (r[tCol] || '').trim() : '';
      const eVal = eCol ? (r[eCol] || '').trim() : '';
      if (dateRegex.test(tVal)) {
        const parts = tVal.split(/[/-]/);
        if (parseInt(parts[0], 10) <= 12 && parseInt(parts[1], 10) <= 12) {
          ambiguous = true;
          break;
        }
      }
      if (dateRegex.test(eVal)) {
        const parts = eVal.split(/[/-]/);
        if (parseInt(parts[0], 10) <= 12 && parseInt(parts[1], 10) <= 12) {
          ambiguous = true;
          break;
        }
      }
    }

    const previewData = {
      token,
      filename: file.name,
      headers,
      mapping,
      sample: rows.slice(0, 5),
      row_count: rows.length,
      ambiguous_dates: ambiguous,
      rows,
    };

    savePreview(token, previewData);

    return NextResponse.json({
      token,
      filename: file.name,
      headers,
      mapping,
      sample: previewData.sample,
      row_count: previewData.row_count,
      ambiguous_dates: ambiguous,
    });
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Error processing preview' }, { status: 500 });
  }
}
