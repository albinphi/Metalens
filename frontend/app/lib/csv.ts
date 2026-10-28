export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = vals[idx] ?? '';
    });
    rows.push(obj);
  }

  return { headers, rows };
}

const ALIASES: Record<string, string[]> = {
  trade_date: ['date', 'trade date', 'trade_date', 'tradedate'],
  symbol: ['symbol', 'commodity', 'contract', 'instrument name', 'commodity name'],
  expiry_date: ['expiry', 'expiry date', 'expiry_date', 'expirydate'],
  open: ['open', 'open price'],
  high: ['high', 'high price'],
  low: ['low', 'low price'],
  close: ['close', 'close price', 'settlement price', 'settlement'],
  volume: ['volume', 'vol', 'volume lots', 'volume units'],
  open_interest: ['open interest', 'oi', 'open interest lots'],
  turnover: ['turnover', 'value'],
};

export function autoMap(headers: string[]): Record<string, string | null> {
  const normMap = new Map<string, string>();
  for (const h of headers) {
    const norm = h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    normMap.set(norm, h);
  }
  const mapping: Record<string, string | null> = {};
  for (const [key, alts] of Object.entries(ALIASES)) {
    let matched: string | null = null;
    for (const alt of alts) {
      const altNorm = alt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (normMap.has(altNorm)) {
        matched = normMap.get(altNorm)!;
        break;
      }
    }
    mapping[key] = matched;
  }
  return mapping;
}
