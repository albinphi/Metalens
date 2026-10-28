import { NextRequest, NextResponse } from 'next/server';
import { getPreview, addObservations, addHistoryRecord, SPECS, Observation } from '@/app/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { token, filename, mapping, date_format } = await req.json();
    const preview = getPreview(token);

    if (!preview) {
      return NextResponse.json({ detail: 'Preview expired. Upload again.' }, { status: 404 });
    }

    const rows = preview.rows || [];
    const missing = ['trade_date', 'symbol', 'expiry_date', 'close'].filter(
      k => !mapping[k] || !preview.headers.includes(mapping[k])
    );

    if (missing.length) {
      return NextResponse.json({ detail: 'Map required columns: ' + missing.join(', ') }, { status: 422 });
    }

    const accepted: Observation[] = [];
    const errors: any[] = [];

    const parseDateStr = (val: string) => {
      const s = String(val).trim();
      const parts = s.split(/[/-]/);
      if (parts.length === 3) {
        if (parts[2].length === 4) {
          const [d, m, y] = date_format === 'MDY' ? [parts[1], parts[0], parts[2]] : [parts[0], parts[1], parts[2]];
          return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
      }
      return new Date(s).toISOString().slice(0, 10);
    };

    rows.forEach((r: Record<string, string>, idx: number) => {
      const sym = (r[mapping.symbol] || '').trim().toUpperCase();
      const tStr = parseDateStr(r[mapping.trade_date]);
      const eStr = parseDateStr(r[mapping.expiry_date]);
      const close = parseFloat((r[mapping.close] || '').replace(/,/g, ''));

      if (!sym || !SPECS[sym] || isNaN(close) || close <= 0 || !tStr || !eStr) {
        errors.push({ row: idx + 2, symbol: sym, issues: 'Invalid row or unsupported symbol' });
        return;
      }

      const spec = SPECS[sym];
      const den = (spec[0] * spec[1]) / 1000;
      const msT = new Date(tStr).getTime();
      const msE = new Date(eStr).getTime();
      const daysToExpiry = Math.max(0, Math.round((msE - msT) / (1000 * 60 * 60 * 24)));

      const numVal = (k: string) => {
        const col = mapping[k];
        if (!col || !r[col]) return null;
        const v = parseFloat(r[col].replace(/,/g, ''));
        return isNaN(v) ? null : v;
      };

      accepted.push({
        trade_date: tStr,
        symbol: sym,
        expiry_date: eStr,
        close,
        normalized_close: close / den,
        open: numVal('open'),
        high: numVal('high'),
        low: numVal('low'),
        volume: numVal('volume'),
        open_interest: numVal('open_interest'),
        days_to_expiry: daysToExpiry,
        source_file: filename,
        import_id: token,
        warnings: 'Contract spec is starting value; historical validity unverified',
      });
    });

    if (accepted.length) {
      addObservations(accepted);
    }

    const item = {
      id: token,
      filename,
      uploaded_at: new Date().toISOString(),
      rows: accepted.length,
      rejected: errors.length,
      warnings: 0,
      status: errors.length ? 'completed with rejected rows' : 'completed',
      date_from: accepted.length ? accepted[0].trade_date : null,
      date_to: accepted.length ? accepted[accepted.length - 1].trade_date : null,
      errors,
    };

    addHistoryRecord(item);

    return NextResponse.json(item);
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Import failed' }, { status: 500 });
  }
}
