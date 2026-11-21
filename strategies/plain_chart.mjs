// A plain chart: no strategy at all. Nothing fires, nothing trades and nothing is drawn but
// the candles, so the chart is a clean slate for the indicators added under Indicators (and
// the Tradovate indicators): to look at the market through them and try an idea by eye.
//
// `chartOnly` tells the page so: no P&L panes, no sweep, no trade figures. The strategy table
// (research/strategy_table.mjs) skips it. An indicator's gate has nothing to refuse here; to
// see how a strategy's trades did in an indicator's states, or to gate them, pick that strategy.

export default {
  id: "plain_chart",
  name: "Plain chart (no strategy)",
  description: "The price alone: no signals, no trades, and nothing drawn but the candles. Add your own indicators under Indicators.",
  chartOnly: true,

  // The signal timeframe is what an indicator set to "the signal's" timeframe is read on.
  timeframeMin: 1,
  warmupBars: 0,
  params: [],

  compute(tf) {
    const n = tf.close.length;
    return {
      sig: new Int8Array(n),
      atr: new Float64Array(n).fill(NaN),
      overlays: [],
      explain: () => ({ dir: 0, checks: [], marks: [], title: "A plain chart: no strategy, so no signal" }),
    };
  },
};
