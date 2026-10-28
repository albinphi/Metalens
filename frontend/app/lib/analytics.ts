import { getObservationsStore, getHistoryStore, SPECS, Observation } from './store';

export interface PairParams {
  symbol_a: string;
  expiry_a: string;
  symbol_b: string;
  expiry_b: string;
  window?: number;
  minimum?: number;
  entry?: number;
  exit?: number;
  expiry_gap?: number;
}

export interface BacktestParams extends PairParams {
  slippage_bps?: number;
  fee_bps?: number;
  split?: number;
}

export function getDatasetStatus() {
  const obs = getObservationsStore();
  const hist = getHistoryStore();
  if (!obs.length) {
    return { latest_date: null, rows: 0, symbols: [], warnings: 0, imports: hist.length };
  }
  let latest = obs[0].trade_date;
  for (const o of obs) {
    if (o.trade_date > latest) latest = o.trade_date;
  }
  const symbols = Array.from(new Set(obs.map(o => o.symbol))).sort();
  const warnings = obs.filter(o => o.warnings && o.warnings.trim().length > 0).length;
  return {
    latest_date: latest,
    rows: obs.length,
    symbols,
    warnings,
    imports: hist.length,
  };
}

export function getContracts() {
  const obs = getObservationsStore();
  const symbols = Array.from(new Set(obs.map(o => o.symbol))).sort();
  const map = new Map<string, { symbol: string; expiry_date: string }>();
  for (const o of obs) {
    const k = `${o.symbol}|${o.expiry_date}`;
    if (!map.has(k)) {
      map.set(k, { symbol: o.symbol, expiry_date: o.expiry_date });
    }
  }
  const contracts = Array.from(map.values()).sort((a, b) => {
    const cmp = a.symbol.localeCompare(b.symbol);
    return cmp !== 0 ? cmp : a.expiry_date.localeCompare(b.expiry_date);
  });
  const specs: Record<string, any> = {};
  for (const [k, v] of Object.entries(SPECS)) {
    specs[k] = {
      quoted_weight_grams: v[0],
      purity_per_thousand: v[1],
      lot_size_grams: v[2],
      verified: false,
    };
  }
  return { symbols, contracts, specs };
}

export function getObservations(filters?: {
  symbol?: string;
  expiry?: string;
  start?: string;
  end?: string;
}) {
  let list = [...getObservationsStore()];
  if (filters?.symbol) {
    const sym = filters.symbol.toUpperCase();
    list = list.filter(o => o.symbol.toUpperCase() === sym);
  }
  if (filters?.expiry) {
    const exp = filters.expiry.slice(0, 10);
    list = list.filter(o => o.expiry_date.slice(0, 10) === exp);
  }
  if (filters?.start) {
    list = list.filter(o => o.trade_date >= filters.start!);
  }
  if (filters?.end) {
    list = list.filter(o => o.trade_date <= filters.end!);
  }
  return list.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

export function computePair(q: PairParams) {
  const obs = getObservationsStore();
  const sa = q.symbol_a.toUpperCase();
  const sb = q.symbol_b.toUpperCase();
  const ea = q.expiry_a.slice(0, 10);
  const eb = q.expiry_b.slice(0, 10);

  const mapA = new Map<string, Observation>();
  const mapB = new Map<string, Observation>();

  for (const o of obs) {
    if (o.symbol.toUpperCase() === sa && o.expiry_date.slice(0, 10) === ea) {
      mapA.set(o.trade_date, o);
    }
    if (o.symbol.toUpperCase() === sb && o.expiry_date.slice(0, 10) === eb) {
      mapB.set(o.trade_date, o);
    }
  }

  const commonDates: string[] = [];
  for (const date of Array.from(mapA.keys())) {
    if (mapB.has(date)) {
      commonDates.push(date);
    }
  }
  commonDates.sort();

  if (!commonDates.length) return [];

  const windowSize = q.window ?? 60;
  const minPeriods = q.minimum ?? 30;
  const entryThresh = q.entry ?? 2;
  const expiryGapLimit = q.expiry_gap ?? 7;

  const rawRows = commonDates.map(date => {
    const a = mapA.get(date)!;
    const b = mapB.get(date)!;
    const spread_pct = 100 * (a.normalized_close / b.normalized_close - 1);
    const spread_inr_per_fine_gram = a.normalized_close - b.normalized_close;
    const msA = new Date(a.expiry_date).getTime();
    const msB = new Date(b.expiry_date).getTime();
    const expiry_gap = Math.round(Math.abs(msA - msB) / (1000 * 60 * 60 * 24));

    return {
      trade_date: date,
      a,
      b,
      spread_pct,
      spread_inr_per_fine_gram,
      expiry_gap,
    };
  });

  const spreadSeries = rawRows.map(r => r.spread_pct);

  return rawRows.map((r, i) => {
    // Current rolling window including current observation i
    const startW = Math.max(0, i - windowSize + 1);
    const wSlice = spreadSeries.slice(startW, i + 1);
    let z_score: number | null = null;
    if (wSlice.length >= minPeriods) {
      const mean = wSlice.reduce((s, v) => s + v, 0) / wSlice.length;
      const variance = wSlice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (wSlice.length - 1);
      const std = variance > 0 ? Math.sqrt(variance) : 0;
      z_score = std > 0 ? (r.spread_pct - mean) / std : null;
    }

    // Prior rolling window strictly before current observation i (shift(1))
    let decision_z: number | null = null;
    if (i >= 1) {
      const startPrior = Math.max(0, i - windowSize);
      const priorSlice = spreadSeries.slice(startPrior, i);
      if (priorSlice.length >= minPeriods) {
        const pMean = priorSlice.reduce((s, v) => s + v, 0) / priorSlice.length;
        const pVariance = priorSlice.reduce((s, v) => s + Math.pow(v - pMean, 2), 0) / (priorSlice.length - 1);
        const pStd = pVariance > 0 ? Math.sqrt(pVariance) : 0;
        decision_z = pStd > 0 ? (r.spread_pct - pMean) / pStd : null;
      }
    }

    const eligible = r.expiry_gap <= expiryGapLimit;
    let signal = '';
    if (
      eligible &&
      r.a.days_to_expiry > 3 &&
      r.b.days_to_expiry > 3 &&
      decision_z !== null &&
      Math.abs(decision_z) >= entryThresh
    ) {
      signal = decision_z > 0 ? 'Short A / Long B' : 'Long A / Short B';
    }

    return {
      trade_date: r.trade_date,
      a_normalized_close: r.a.normalized_close,
      a_close: r.a.close,
      a_volume: r.a.volume,
      a_open_interest: r.a.open_interest,
      a_days_to_expiry: r.a.days_to_expiry,
      a_expiry_date: r.a.expiry_date,
      b_normalized_close: r.b.normalized_close,
      b_close: r.b.close,
      b_volume: r.b.volume,
      b_open_interest: r.b.open_interest,
      b_days_to_expiry: r.b.days_to_expiry,
      b_expiry_date: r.b.expiry_date,
      spread_pct: r.spread_pct,
      spread_inr_per_fine_gram: r.spread_inr_per_fine_gram,
      expiry_gap: r.expiry_gap,
      z_score,
      decision_z,
      eligible,
      signal,
    };
  });
}

export function computeSignals(min_z: number = 2, eligible_only: boolean = true) {
  const { contracts } = getContracts();
  const out: any[] = [];

  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const sa = contracts[i].symbol;
      const ea = contracts[i].expiry_date;
      const sb = contracts[j].symbol;
      const eb = contracts[j].expiry_date;

      if (sa === sb) continue;

      const x = computePair({
        symbol_a: sa,
        expiry_a: ea,
        symbol_b: sb,
        expiry_b: eb,
        entry: min_z,
      });

      if (!x.length) continue;

      for (const r of x) {
        if (r.decision_z !== null && Math.abs(r.decision_z) >= min_z) {
          if (eligible_only && r.expiry_gap > 7) continue;
          out.push({
            trade_date: r.trade_date,
            symbol_a: sa,
            expiry_a: ea,
            symbol_b: sb,
            expiry_b: eb,
            spread_pct: r.spread_pct,
            z_score: r.decision_z,
            expiry_gap: r.expiry_gap,
            direction: r.decision_z > 0 ? 'Short A / Long B' : 'Long A / Short B',
            eligible: r.expiry_gap <= 7,
            explanation: `Z-score ${r.decision_z.toFixed(2)}; threshold ±${min_z.toFixed(2)}; expiry gap ${r.expiry_gap} days. Historical candidate, not recommendation.`,
          });
        }
      }
    }
  }

  return out.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
}

export function computeBacktest(q: BacktestParams) {
  const rows = computePair(q);
  const n = rows.length;
  const minimumHistory = 5;

  if (n < minimumHistory) {
    return {
      status: 'insufficient_history',
      message: `Backtesting needs at least ${minimumHistory} matched trading-date observations for this pair. Current history: ${n}.`,
      observations: n,
      minimum_observations: minimumHistory,
      trades: [],
    };
  }

  const splitRatio = q.split ?? 0.7;
  const cut = Math.floor(n * splitRatio);
  const dates = rows.map(r => r.trade_date);
  let position: { entry: number; direction: 'short' | 'long' } | null = null;
  const trades: any[] = [];
  const skipped: any[] = [];
  let i = 0;

  const entryThresh = q.entry ?? 2;
  const exitThresh = q.exit ?? 0.5;
  const slippageBps = q.slippage_bps ?? 2;
  const feeBps = q.fee_bps ?? 2;

  while (i < n - 1) {
    const r = rows[i];
    if (dates[i] < dates[cut]) {
      i++;
      continue;
    }

    if (
      position === null &&
      r.eligible &&
      r.a_days_to_expiry > 3 &&
      r.b_days_to_expiry > 3 &&
      r.decision_z !== null &&
      Math.abs(r.decision_z) >= entryThresh
    ) {
      position = {
        entry: i + 1,
        direction: r.decision_z > 0 ? 'short' : 'long',
      };
      i++;
      continue;
    }

    if (
      position !== null &&
      ((r.z_score !== null && Math.abs(r.z_score) <= exitThresh) ||
        r.a_days_to_expiry <= 3 ||
        r.b_days_to_expiry <= 3)
    ) {
      const j = Math.min(i + 1, n - 1);
      const en = rows[position.entry];
      const ex = rows[j];
      const es = 100 * (en.a_normalized_close / en.b_normalized_close - 1);
      const xs = 100 * (ex.a_normalized_close / ex.b_normalized_close - 1);
      const gross = position.direction === 'short' ? es - xs : xs - es;
      const cost = (4 * (slippageBps + feeBps)) / 100;

      trades.push({
        number: trades.length + 1,
        entry_date: dates[position.entry],
        exit_date: dates[j],
        direction: position.direction === 'short' ? 'Short A / Long B' : 'Long A / Short B',
        gross_pp: gross,
        estimated_cost_pp: cost,
        net_pp: gross - cost,
        holding_sessions: j - position.entry,
      });

      position = null;
      i = j + 1;
      continue;
    }

    i++;
  }

  if (position) {
    skipped.push({ reason: 'Position open at end of available history' });
  }

  let cumul = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    cumul += t.net_pp;
    peak = Math.max(peak, cumul);
    dd = Math.min(dd, cumul - peak);
    t.cumulative_net_pp = cumul;
  }

  const vals = trades.map(t => t.net_pp);
  const sumNet = vals.reduce((a, b) => a + b, 0);
  const grossSum = trades.reduce((a, t) => a + t.gross_pp, 0);
  const costSum = trades.reduce((a, t) => a + t.estimated_cost_pp, 0);

  return {
    status: 'complete',
    mode: 'normalized spread-return proxy',
    units: 'percentage points',
    config: q,
    development: {
      start: dates[0],
      end: dates[cut - 1],
      observations: cut,
    },
    test: {
      start: dates[cut],
      end: dates[n - 1],
      observations: n - cut,
    },
    trades,
    skipped,
    metrics: {
      completed_trades: vals.length,
      win_rate_pct: vals.length ? (100 * vals.filter(v => v > 0).length) / vals.length : null,
      gross_pp: grossSum,
      estimated_costs_pp: costSum,
      net_pp: sumNet,
      average_net_pp: vals.length ? sumNet / vals.length : null,
      max_drawdown_pp: dd,
      average_holding_sessions: trades.length
        ? trades.reduce((a, t) => a + t.holding_sessions, 0) / trades.length
        : null,
    },
    warning: vals.length < 10 ? 'Small sample: fewer than 10 test trades.' : null,
  };
}
