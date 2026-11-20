import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const DAY_MS = 86_400_000;
const TREND_WINDOW_DAYS = 2;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface HistoryRead {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game?: { release_date?: string };
  trophies: Trophy[];
  history: HistoryRead[];
}

interface State {
  tAbs: number;
  D: number;
  p: number;
}

interface Interval {
  dT: number;
  dU: number;
  dZ: number;
}

interface TrackForecast {
  center: number;
  kSd: number;
  shock: number;
  shockProb: number;
}

interface GlobalTrend {
  alpha: number;
  beta: number;
  identified: boolean;
}

const clamp = (x: number, lo = 0.01, hi = 99.99): number => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const logit = (pct: number): number => {
  const p = clamp(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (x: number): number => {
  const z = Math.min(30, Math.max(-30, x));
  return 100 / (1 + Math.exp(-z));
};
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ph = 1 - pl;
  const q = clamp01(p);
  if (q < pl) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > ph) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  const r = q - 0.5;
  const s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

function priorSlope(t: Trophy): number {
  const d = t.description.toLowerCase();
  if (t.tier === 'platinum') return 0.06;
  if (/attain 100%|100% completion|complete the final mission/.test(d)) return 0.13;
  if (/chapter 1|gone fishing/.test(d)) return 0.38;
  if (/chapter 2/.test(d)) return 0.32;
  if (/chapter 3/.test(d)) return 0.27;
  if (/chapter 4/.test(d)) return 0.22;
  if (/complete chapter/.test(d)) return 0.24;
  if (t.tier === 'gold') return 0.16;
  if (t.tier === 'silver') return 0.20;
  if (/collect|all |every |250 |100 |50 |8 mission/.test(d)) return 0.22;
  return 0.26;
}

function solve2(a: number, b: number, c: number, y0: number, y1: number): [number, number] | null {
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-12) return null;
  return [(y0 * c - b * y1) / det, (a * y1 - y0 * b) / det];
}

function statesFor(c: Case, index: number): State[] {
  const out: State[] = [];
  let previous = Number.NaN;
  for (const r of c.history) {
    const tAbs = Date.parse(r.slot ?? r.at);
    const raw = r.rates[index];
    const D = Number(r.players_tracked);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !(D > 0) || !Number.isFinite(tAbs)) continue;
    const p = clamp(raw) / 100;
    if (out.length === 0 || Math.abs(p - previous) > 1e-9) {
      out.push({ tAbs, D, p });
      previous = p;
    }
  }
  return out;
}

function intervalsFor(states: State[], startT: number): Interval[] {
  const out: Interval[] = [];
  for (let k = 1; k < states.length; k += 1) {
    const a = states[k - 1];
    const b = states[k];
    if (a.tAbs < startT || b.tAbs < startT) continue;
    const dT = (b.tAbs - a.tAbs) / DAY_MS;
    if (!(dT > 0)) continue;
    const dU = Math.log(b.D / a.D);
    const dZ = Math.log(b.p / a.p) + dU;
    if (Number.isFinite(dU) && Number.isFinite(dZ)) out.push({ dT, dU, dZ });
  }
  return out;
}

function estimateGlobal(allStates: State[][], startT: number, alphaPrior: number): GlobalTrend {
  let s00 = 0;
  let s01 = 0;
  let s11 = 0;
  let y0 = 0;
  let y1 = 0;
  let withDenominator = 0;
  for (const states of allStates) {
    for (const q of intervalsFor(states, startT)) {
      s00 += q.dU * q.dU;
      s01 += q.dU * q.dT;
      s11 += q.dT * q.dT;
      y0 += q.dU * q.dZ;
      y1 += q.dT * q.dZ;
      if (Math.abs(q.dU) > 1e-6) withDenominator += 1;
    }
  }
  const solved = solve2(s00, s01, s11, y0, y1);
  if (solved === null || withDenominator < 3) {
    const betaTime = s11 > 0 ? Math.max(0, Math.min(3, y1 / s11)) : 0.3;
    return { alpha: alphaPrior, beta: betaTime, identified: false };
  }
  const ridge = 0.5;
  const alpha = Math.max(-0.1, Math.min(1.25, (s00 * solved[0] + ridge * alphaPrior) / (s00 + ridge)));
  const beta = Math.max(0, Math.min(3, solved[1]));
  return { alpha, beta, identified: true };
}

function logisticLogK(history: HistoryRead[], targetT: number, nowD: number): number | null {
  const unique: Array<{ t: number; d: number }> = [];
  for (const r of history) {
    const t = Date.parse(r.slot ?? r.at);
    const d = Number(r.players_tracked);
    if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) continue;
    if (unique.length === 0 || Math.abs(d - unique[unique.length - 1].d) > 1e-9) unique.push({ t, d });
  }
  if (unique.length < 3) return null;

  const baseT = unique[0].t;
  const rows = unique.map((o) => ({ t: (o.t - baseT) / DAY_MS, d: o.d }));
  const maxD = Math.max(...rows.map((r) => r.d));
  const target = (targetT - baseT) / DAY_MS;
  let best: { dmax: number; k: number; sse: number } | null = null;
  for (let i = 0; i <= 90; i += 1) {
    const dmax = maxD * Math.pow(60, i / 90);
    if (dmax <= maxD * 1.000001) continue;
    const z0 = Math.log(dmax / rows[0].d - 1);
    let num = 0;
    let den = 0;
    for (const r of rows) {
      if (r.t <= 0) continue;
      const z = Math.log(dmax / r.d - 1);
      num += r.t * (z0 - z);
      den += r.t * r.t;
    }
    if (!(den > 0)) continue;
    const k = num / den;
    if (!(k > 0)) continue;
    let sse = 0;
    for (const r of rows) {
      const z = Math.log(dmax / r.d - 1);
      const e = z - (z0 - k * r.t);
      sse += e * e;
    }
    if (best === null || sse < best.sse) best = { dmax, k, sse };
  }
  if (best === null || best.dmax >= maxD * Math.pow(60, 0.985)) return null;
  const z0 = Math.log(best.dmax / rows[0].d - 1);
  const zTarget = z0 - best.k * target;
  const dTarget = best.dmax / (1 + Math.exp(zTarget));
  if (!Number.isFinite(dTarget) || !(dTarget > 0)) return null;
  return Math.log(dTarget / nowD);
}

function trackForecast(history: HistoryRead[], targetT: number, denominatorChanges: number): TrackForecast {
  const lastT = Date.parse(history[history.length - 1].slot ?? history[history.length - 1].at);
  const nowD = Number(history[history.length - 1].players_tracked);
  const horizonDays = Math.max(0, (targetT - lastT) / DAY_MS);
  if (!(nowD > 0)) return { center: Math.log(3), kSd: 0.65, shock: 1.0, shockProb: 0.10 };

  if (denominatorChanges < 2) {
    const expected = Math.min(10, Math.max(1.4, 4000 / nowD));
    return { center: Math.log(expected), kSd: 0.60, shock: 0.95, shockProb: 0.10 };
  }

  const logistic = logisticLogK(history, targetT, nowD);
  const unique: Array<{ t: number; d: number }> = [];
  for (const r of history) {
    const t = Date.parse(r.slot ?? r.at);
    const d = Number(r.players_tracked);
    if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) continue;
    if (unique.length === 0 || Math.abs(d - unique[unique.length - 1].d) > 1e-9) unique.push({ t, d });
  }
  const ref = unique[Math.max(0, unique.length - 4)] ?? { t: lastT, d: nowD };
  const dt = (lastT - ref.t) / DAY_MS;
  const recentRate = dt > 0.05 ? Math.max(0, Math.log(nowD / ref.d) / dt) : 0;
  const damped = Math.max(0, Math.min(Math.log(15), recentRate * horizonDays * 0.62));
  let center: number;
  let disagreement = 0.2;
  if (logistic !== null && Number.isFinite(logistic)) {
    const lo = Math.max(0, Math.min(Math.log(15), logistic));
    center = 0.8 * lo + 0.2 * damped;
    disagreement = Math.min(0.5, 0.4 * Math.abs(lo - damped));
  } else {
    center = damped;
  }
  if (!Number.isFinite(center)) center = Math.log(1.5);
  const kSd = Math.min(1.0, Math.max(0.40, 0.38 + disagreement + (unique.length < 6 ? 0.12 : 0)));
  return { center: Math.max(0, Math.min(Math.log(15), center)), kSd, shock: Math.max(0.55, 1.45 * kSd), shockProb: 0.10 };
}

function kScenarios(track: TrackForecast): Array<{ k: number; w: number }> {
  const n = 15;
  const out: Array<{ k: number; w: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const p = (i + 0.5) / n;
    out.push({ k: track.center + track.kSd * normalQuantile(p), w: (1 - track.shockProb) / n });
  }
  out.push({ k: track.center + track.shock, w: track.shockProb });
  return out;
}

function componentCenter(baseLogP: number, alpha: number, beta: number, horizonDays: number, logK: number): number {
  const logRate = baseLogP + (alpha - 1) * logK + beta * horizonDays;
  const fraction = Math.max(1e-8, Math.min(0.9999, Math.exp(logRate)));
  return Math.log(fraction / (1 - fraction));
}

function mixtureQuantile(tau: number, centers: number[], weights: number[], sigma: number): number {
  const s = Math.max(0.03, sigma);
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    let cdf = 0;
    for (let j = 0; j < centers.length; j += 1) cdf += weights[j] * normalCdf((mid - centers[j]) / s);
    if (cdf < tau) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function trophyRow(
  trophy: Trophy,
  index: number,
  states: State[],
  globals: GlobalTrend,
  track: TrackForecast,
  kScenariosList: Array<{ k: number; w: number }>,
  targetT: number,
  startT: number,
): { id: number; q: number[] } {
  const last = states[states.length - 1];
  if (last === undefined) return { id: trophy.id, q: [0.01, 0.01, 0.01, 0.01, 0.01] };
  if (last.p >= 0.9995) return { id: trophy.id, q: [100, 100, 100, 100, 100] };

  const horizonDays = Math.max(0, (targetT - last.tAbs) / DAY_MS);
  let intervals = intervalsFor(states, startT);
  if (intervals.length < 2) intervals = intervalsFor(states, -Infinity);

  let beta = priorSlope(trophy);
  let trendResidual = 0.30;
  if (intervals.length > 0) {
    let num = 0;
    let den = 0;
    let activity = 0;
    for (const q of intervals) {
      const e = q.dZ - globals.alpha * q.dU;
      num += q.dT * e;
      den += q.dT * q.dT;
      activity += Math.abs(e);
    }
    if (den > 0 && activity > 0.02) {
      const betaData = Math.max(-0.5, Math.min(4, num / den));
      const span = intervals.reduce((s, q) => s + q.dT, 0);
      const weight = Math.min(0.80, span / (span + 0.8));
      const target = globals.beta > 0.02 ? globals.beta : priorSlope(trophy);
      beta = weight * betaData + (1 - weight) * target;
      const residuals = intervals.map((q) => q.dZ - globals.alpha * q.dU - beta * q.dT);
      trendResidual = Math.min(0.55, Math.max(0.10, 1.4826 * median(residuals.map((e) => Math.abs(e)))));
    }
  }
  beta = Math.max(0, Math.min(3, beta));

  const baseLogP = Math.log(Math.max(1e-8, Math.min(0.9999, last.p)));
  const centers = kScenariosList.map((s) => componentCenter(baseLogP, globals.alpha, beta, horizonDays, s.k));
  const weights = kScenariosList.map((s) => s.w);
  const randomWalk = 0.34 * Math.sqrt(Math.max(0.02, horizonDays));
  const sigma = Math.min(1.5, Math.max(0.18, Math.sqrt(randomWalk * randomWalk + trendResidual * trendResidual + 0.10 * 0.10)));

  const q: number[] = [];
  for (const level of LEVELS) {
    const x = mixtureQuantile(level, centers, weights, sigma);
    q.push(round4(Math.min(100, Math.max(0.01, invLogit(x)))));
  }
  for (let i = 1; i < q.length; i += 1) q[i] = Math.max(q[i], q[i - 1]);
  return { id: trophy.id, q };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of files) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!Array.isArray(c.trophies) || c.trophies.length === 0) throw new Error(`${file} lists no trophies`);
  if (!Array.isArray(c.history) || c.history.length === 0) throw new Error(`${file} has no history`);
  const targetT = Date.parse(c.target);
  if (!Number.isFinite(targetT)) throw new Error(`${file} has no target`);
  const lastRead = c.history[c.history.length - 1];
  const lastT = Date.parse(lastRead.slot ?? lastRead.at);
  const startT = lastT - TREND_WINDOW_DAYS * DAY_MS;

  let denominatorChanges = 0;
  let previousD = Number.NaN;
  for (const r of c.history) {
    const d = Number(r.players_tracked);
    if (!Number.isFinite(d) || d <= 0) continue;
    if (Number.isFinite(previousD) && Math.abs(d - previousD) > 1e-9) denominatorChanges += 1;
    previousD = d;
  }

  const states = c.trophies.map((_, i) => statesFor(c, i));
  const alphaPrior = denominatorChanges < 2 ? 0.20 : 0.55;
  const globals = estimateGlobal(states, startT, alphaPrior);
  const track = trackForecast(c.history, targetT, denominatorChanges);
  const ks = kScenarios(track);
  const trophies = c.trophies.map((t, i) => trophyRow(t, i, states[i], globals, track, ks, targetT, startT));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
