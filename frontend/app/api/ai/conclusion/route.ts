import { NextRequest, NextResponse } from 'next/server';
import { getObservationsStore } from '@/app/lib/store';
import { computePair, computeSignals } from '@/app/lib/analytics';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const scope: 'dataset' | 'pair' = body.scope || 'dataset';
    const pairParams = body.pair;

    const obs = getObservationsStore();
    if (!obs.length) {
      return NextResponse.json(
        { detail: 'Import historical observations before requesting a data conclusion.' },
        { status: 422 }
      );
    }

    let latestDate = obs[0].trade_date;
    for (const o of obs) {
      if (o.trade_date > latestDate) latestDate = o.trade_date;
    }

    const recent = obs.filter(o => o.trade_date === latestDate);
    const symbols = Array.from(new Set(obs.map(o => o.symbol))).sort();
    const warningCount = obs.filter(o => o.warnings && o.warnings.trim().length > 0).length;

    const facts: any = {
      scope,
      data_as_of: latestDate,
      valid_rows: obs.length,
      symbols_present: symbols,
      rows_on_latest_date: recent.map(r => ({
        symbol: r.symbol,
        expiry_date: r.expiry_date,
        normalized_close: r.normalized_close,
        days_to_expiry: r.days_to_expiry,
        volume: r.volume,
        open_interest: r.open_interest,
      })),
      quality_warning_rows: warningCount,
      specification_caveat:
        'Contract purity and quotation metadata are starting values and are not historically verified.',
    };

    if (scope === 'pair') {
      if (!pairParams || !pairParams.symbol_a || !pairParams.symbol_b) {
        return NextResponse.json({ detail: 'Provide the selected symbol and expiry pair.' }, { status: 422 });
      }
      const pairRows = computePair(pairParams);
      if (!pairRows.length) {
        return NextResponse.json(
          { detail: 'No overlapping observations exist for the selected pair.' },
          { status: 422 }
        );
      }
      const r = pairRows[pairRows.length - 1];
      const expiryGapLimit = pairParams.expiry_gap ?? 7;
      const minObs = pairParams.minimum ?? 30;
      const entryThresh = pairParams.entry ?? 2;

      facts.pair = {
        symbol_a: pairParams.symbol_a,
        expiry_a: pairParams.expiry_a,
        symbol_b: pairParams.symbol_b,
        expiry_b: pairParams.expiry_b,
        paired_observations: pairRows.length,
        latest_date: r.trade_date,
        normalized_close_a_inr_per_fine_gram: r.a_normalized_close,
        normalized_close_b_inr_per_fine_gram: r.b_normalized_close,
        spread_pct: r.spread_pct,
        display_z_score: r.z_score,
        decision_z_score_using_prior_data: r.decision_z,
        expiry_gap_days: r.expiry_gap,
        days_to_expiry_a: r.a_days_to_expiry,
        days_to_expiry_b: r.b_days_to_expiry,
        eligible_under_configured_expiry_gap: r.expiry_gap <= expiryGapLimit,
        candidate_signal: r.signal || null,
        window: pairParams.window ?? 60,
        minimum_observations: minObs,
        entry_threshold: entryThresh,
        configured_expiry_gap_days: expiryGapLimit,
      };

      const spreadRead =
        r.spread_pct > 0
          ? `${pairParams.symbol_a} is about ${Math.abs(r.spread_pct).toFixed(2)}% more expensive than ${pairParams.symbol_b} on the latest matched date, after normalization.`
          : `${pairParams.symbol_a} is about ${Math.abs(r.spread_pct).toFixed(2)}% cheaper than ${pairParams.symbol_b} on the latest matched date, after normalization.`;

      const eligible = r.expiry_gap <= expiryGapLimit && r.a_days_to_expiry > 3 && r.b_days_to_expiry > 3;

      let opportunity: any;
      if (pairRows.length < minObs || r.decision_z === null) {
        opportunity = {
          status: 'INSUFFICIENT_HISTORY',
          label: 'Too little history to judge an opportunity',
          reason: `${spreadRead} This is a price gap, not evidence that it will close. Only ${pairRows.length} matched date(s) are available; the rule needs ${minObs} prior matched observations to calculate an entry score.`,
          next_step:
            'Import more historical data for both exact contracts, then run this pair again. Until then, treat it as a watch item, not a trading setup.',
        };
      } else if (!eligible) {
        opportunity = {
          status: 'NOT_ELIGIBLE',
          label: 'This pair does not pass the current eligibility rules',
          reason: `The pair fails the configured expiry-gap or days-to-expiry filter (expiry gap limit: ${expiryGapLimit} days; each leg must have more than 3 days remaining).`,
          next_step: 'Choose a pair that meets the expiry rules or review the rules before interpreting a signal.',
        };
      } else if (r.signal) {
        opportunity = {
          status: 'CANDIDATE_SIGNAL',
          label: 'Candidate relative-value signal — review before acting',
          reason: `The prior-data Z-score crossed the configured entry threshold of ${entryThresh}. The rule-based direction is ${r.signal}; this is a historical research flag, not a forecast.`,
          next_step:
            'Check current bid/ask prices, liquidity, contract specifications, fees and slippage. Review the held-out backtest before deciding whether the setup is worth further study.',
        };
      } else {
        opportunity = {
          status: 'NO_ENTRY_SIGNAL',
          label: 'No entry signal under the current rules',
          reason: `The latest prior-data Z-score has not crossed the entry threshold of ${entryThresh}, or the score is otherwise unavailable.`,
          next_step:
            'Keep the pair on watch and import more observations if needed. Do not force a trade by lowering the threshold just to create a signal.',
        };
      }
      facts.opportunity_read = opportunity;
    } else {
      const allCandidates = computeSignals(2, true);
      facts.latest_candidate_signals = allCandidates.slice(0, 5);
      facts.latest_normalized_prices_are_observations_not_live_quotes = true;
      facts.opportunity_read = allCandidates.length
        ? {
            status: 'CANDIDATES_TO_REVIEW',
            label: `${allCandidates.length} candidate signal(s) to review`,
            reason: 'These are historical rule-based flags from the imported data, not live quotes or predictions.',
            next_step:
              'Open Signal Monitor, verify each pair’s current prices and liquidity, and review its held-out backtest before considering any live position.',
          }
        : {
            status: 'NO_CURRENT_CANDIDATE',
            label: 'No candidate opportunity flagged in the latest imported data',
            reason: 'The current dataset contains no eligible signal that meets the selected screening threshold.',
            next_step:
              'Import more matched history and review the Signal Monitor later; do not lower thresholds solely to force a candidate.',
          };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const system =
          'You explain commodity relative-value metrics to a non-specialist trader. Use plain, concise language and only the supplied facts. Never invent or recalculate metrics, market context, or forecasts. Explain whether the current figures show a meaningful opportunity under the app rules, or why they do not. Treat opportunity_read as the authoritative rule-based assessment; do not upgrade it into a stronger signal. Explain any candidate direction only if candidate_signal is present. Give the next step from opportunity_read. Do not tell the user to place a live trade or present this as personalized investment advice. Mention data limitations and that normalized settlement prices are not executable quotes. Output plain text only: no Markdown, no # headings, no asterisks, no backticks, and no Markdown bullets. Use these section labels on separate lines: Plain-language reading; Opportunity read; What to do next; Important limits.';

        const userPrompt = `Explain the metrics and opportunity_read below for a simple trader. Keep it short, translate percentages and scores into ordinary language, and clearly distinguish a research flag from a live trading opportunity. If a metric is null or unavailable, say so. Supplied facts: ${JSON.stringify(
          facts
        )}`;

        const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        const geminiRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\n${userPrompt}` }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 350,
            },
          }),
        });

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const rawText =
            geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (rawText.trim()) {
            let cleaned = rawText.trim();
            cleaned = cleaned.replace(/^[*+-]\s+/gm, '• ');
            cleaned = cleaned.replace(/[#*`_]/g, '');

            return NextResponse.json({
              analysis: cleaned,
              opportunity: facts.opportunity_read,
              source: 'gemini',
              data_as_of: facts.data_as_of,
              scope,
              facts,
              notice:
                'Historical research interpretation only. Settlement prices are not executable quotes; verify live prices, liquidity, contract terms and costs before making any decision.',
            });
          }
        }
      } catch {
        // Fall back to rule-based summary
      }
    }

    // High quality deterministic rule-based synthesis matching required format
    const opp = facts.opportunity_read;
    const analysisText = [
      'Plain-language reading',
      scope === 'pair'
        ? `Comparing ${facts.pair?.symbol_a} against ${facts.pair?.symbol_b} on ${facts.data_as_of}. Spread is ${facts.pair?.spread_pct != null ? facts.pair.spread_pct.toFixed(2) + '%' : 'unavailable'}.`
        : `Historical dataset covering ${facts.valid_rows} observations across ${facts.symbols_present.join(', ')} up to ${facts.data_as_of}.`,
      '',
      'Opportunity read',
      `${opp.label}. ${opp.reason}`,
      '',
      'What to do next',
      opp.next_step,
      '',
      'Important limits',
      'Historical research interpretation only. Normalized settlement prices are not executable trading fills. Verify bid-ask spreads, contract specifications, and transaction fees.',
    ].join('\n');

    return NextResponse.json({
      analysis: analysisText,
      opportunity: facts.opportunity_read,
      source: apiKey ? 'gemini-fallback' : 'rule-based',
      data_as_of: facts.data_as_of,
      scope,
      facts,
      notice:
        'Historical research interpretation only. Settlement prices are not executable quotes; verify live prices, liquidity, contract terms and costs before making any decision.',
    });
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Could not generate conclusion' }, { status: 500 });
  }
}
