// Independent verification of ema / sma / wma against arithmetic that does not
// reuse the implementation's own reasoning: hand-computed values, invariants
// that must hold for ANY weighted mean, and lag ordering that follows from the
// weights alone.
import { ema, sma, wma } from "../src/indicators.mjs";

let bad = 0;
const ok = (name, cond, got, want) => {
  if (cond) console.log("  ok   " + name);
  else { bad++; console.log("  FAIL " + name + "   got " + got + "  want " + want); }
};
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

console.log("\n1. HAND-COMPUTED VALUES");
// SMA(3) of [2,4,6,8]: windows [2,4,6]=4, [4,6,8]=6
{ const o = sma([2,4,6,8], 3);
  ok("sma [2,4,6] = 4", near(o[2], 4), o[2], 4);
  ok("sma [4,6,8] = 6", near(o[3], 6), o[3], 6); }
// WMA(3) of [2,4,6,8]: (1*2+2*4+3*6)/6 = 28/6 ; (1*4+2*6+3*8)/6 = 40/6
{ const o = wma([2,4,6,8], 3);
  ok("wma [2,4,6] = 28/6", near(o[2], 28/6), o[2], 28/6);
  ok("wma [4,6,8] = 40/6", near(o[3], 40/6), o[3], 40/6); }
// EMA(4): alpha = 2/5 = 0.4, seeded at x[0]
{ const o = ema([10, 20, 30], 4);
  const e1 = 0.4*20 + 0.6*10, e2 = 0.4*30 + 0.6*e1;
  ok("ema seed = x[0]", near(o[0], 10), o[0], 10);
  ok("ema step 1", near(o[1], e1), o[1], e1);
  ok("ema step 2", near(o[2], e2), o[2], e2); }

console.log("\n2. INVARIANTS ANY WEIGHTED MEAN MUST SATISFY");
const K = 7.25, flat = new Array(80).fill(K);
for (const [n, f] of [["ema", ema], ["sma", sma], ["wma", wma]]) {
  const o = f(flat, 12);
  ok(n + " of a constant returns that constant", near(o[79], K), o[79], K);
}
// Bounded by the window's own min and max.
const xs = Array.from({ length: 200 }, (_, i) => Math.sin(i / 9) * 30 + 100);
for (const [n, f] of [["ema", ema], ["sma", sma], ["wma", wma]]) {
  const o = f(xs, 10);
  let viol = 0;
  for (let i = 30; i < xs.length; i++) {
    const w = xs.slice(i - 9, i + 1);
    if (o[i] < Math.min(...w) - 1e-9 || o[i] > Math.max(...w) + 1e-9) viol++;
  }
  // EMA has infinite memory so it is only bounded by the GLOBAL range.
  const lo = Math.min(...xs), hi = Math.max(...xs);
  if (n === "ema") {
    let g = 0; for (let i = 0; i < xs.length; i++) if (o[i] < lo - 1e-9 || o[i] > hi + 1e-9) g++;
    ok("ema stays inside the global range", g === 0, g + " outside", 0);
  } else ok(n + " stays inside its own window's range", viol === 0, viol + " outside", 0);
}

console.log("\n3. LAG ORDERING, which follows from the weights alone");
// On a rising ramp a trailing average sits BELOW the current value, and the
// more front-weighted it is the closer it sits. WMA must beat SMA; both trail.
{ const ramp = Array.from({ length: 120 }, (_, i) => i);
  const p = 10, i = 100;
  const s = sma(ramp, p)[i], w = wma(ramp, p)[i], e = ema(ramp, p)[i];
  // SMA of a ramp lags by (p-1)/2 = 4.5 ; WMA lags by (p-1)/3 = 3
  ok("sma lags a ramp by (p-1)/2", near(i - s, (p - 1) / 2), i - s, (p - 1) / 2);
  ok("wma lags a ramp by (p-1)/3", near(i - w, (p - 1) / 3), i - w, (p - 1) / 3);
  ok("wma leads sma", w > s, w + " vs " + s, "wma > sma");
  ok("all three trail a rising ramp", s < i && w < i && e < i, [s, w, e], "< " + i); }

console.log("\n4. WEIGHTS SUM TO ONE (probe with a unit impulse)");
// Feeding a series of zeros with a single 1 recovers each weight directly.
for (const [n, f, len] of [["sma", sma, 8], ["wma", wma, 8]]) {
  const N = 400, x = new Array(N).fill(0); x[100] = 1;
  const o = f(x, len);
  let tot = 0; for (let i = 100; i < 100 + len; i++) tot += o[i];
  ok(n + " weights sum to 1", near(tot, 1), tot, 1);
}
{ const N = 4000, x = new Array(N).fill(0); x[10] = 1;
  const o = ema(x, 12); let tot = 0; for (let i = 10; i < N; i++) tot += o[i];
  ok("ema weights sum to 1 (to convergence)", near(tot, 1, 1e-6), tot, 1); }

console.log("\n5. WMA IS MORE FRONT-WEIGHTED THAN SMA, POINT BY POINT");
{ const N = 300, x = new Array(N).fill(0); x[50] = 1;
  const p = 9, w = wma(x, p), s = sma(x, p);
  // At the impulse's own bar WMA gives it the top weight p/(p(p+1)/2).
  ok("wma newest weight = p / (p(p+1)/2)", near(w[50], p / ((p * (p + 1)) / 2)),
     w[50], p / ((p * (p + 1)) / 2));
  ok("sma newest weight = 1/p", near(s[50], 1 / p), s[50], 1 / p);
  ok("wma weights the newest bar above sma", w[50] > s[50], w[50] + " vs " + s[50], ">"); }

console.log("\n" + (bad ? "  " + bad + " FAILED" : "  all checks passed"));
process.exit(bad ? 1 : 0);
