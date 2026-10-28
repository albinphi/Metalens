import rawObservations from '../data/observations.json';

export interface Observation {
  trade_date: string;
  symbol: string;
  expiry_date: string;
  close: number;
  normalized_close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  open_interest: number | null;
  days_to_expiry: number;
  source_file: string;
  import_id: string;
  warnings?: string;
  normalized_open?: number | null;
  normalized_high?: number | null;
  normalized_low?: number | null;
}

export interface ImportRecord {
  id: string;
  filename: string;
  uploaded_at: string;
  rows: number;
  rejected: number;
  warnings: number;
  status: string;
  date_from: string | null;
  date_to: string | null;
  errors: any[];
}

export const SPECS: Record<string, [number, number, number]> = {
  GOLDM: [10, 995, 100],
  GOLDTEN: [10, 999, 10],
  GOLDGUINEA: [8, 999, 8],
  GOLDPETAL: [1, 999, 1],
};

const observationsStore: Observation[] = [...(rawObservations as Observation[])];

const historyStore: ImportRecord[] = [
  {
    id: '02f20656-3115-4b8f-acd5-03141ee65586',
    filename: 'BhavCopyDateWise_09092026.csv',
    uploaded_at: '2026-10-20T21:49:00',
    rows: (rawObservations as Observation[]).length,
    rejected: 0,
    warnings: (rawObservations as Observation[]).length,
    status: 'completed',
    date_from: '2026-09-09',
    date_to: '2026-10-19',
    errors: [],
  },
];

const previewsStore = new Map<string, any>();

export function getObservationsStore(): Observation[] {
  return observationsStore;
}

export function addObservations(newRows: Observation[]) {
  // deduplicate and update
  const keyMap = new Map<string, Observation>();
  for (const o of observationsStore) {
    keyMap.set(`${o.trade_date}|${o.symbol}|${o.expiry_date}`, o);
  }
  for (const o of newRows) {
    keyMap.set(`${o.trade_date}|${o.symbol}|${o.expiry_date}`, o);
  }
  observationsStore.length = 0;
  observationsStore.push(...Array.from(keyMap.values()).sort((a, b) => a.trade_date.localeCompare(b.trade_date)));
}

export function getHistoryStore(): ImportRecord[] {
  return historyStore;
}

export function addHistoryRecord(item: ImportRecord) {
  historyStore.unshift(item);
}

export function getPreview(token: string) {
  return previewsStore.get(token);
}

export function savePreview(token: string, preview: any) {
  previewsStore.set(token, preview);
}
