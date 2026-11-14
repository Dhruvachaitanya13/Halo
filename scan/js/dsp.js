// HALO signal processing core. Pure functions, no browser APIs, so it runs in Node tests and in the page.
// Heart rate: POS method (Wang et al., 2017). Breathing: vertical chest displacement. Blinks: eye-closure score.

export const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
export const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

/** Linear resampling of irregular (t in seconds, v) samples onto a uniform grid at fs Hz. */
export function resample(t, v, fs) {
  if (t.length < 2) return [];
  const n = Math.floor((t[t.length - 1] - t[0]) * fs) + 1, out = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[0] + i / fs;
    while (j < t.length - 2 && t[j + 1] < ti) j++;
    const span = t[j + 1] - t[j] || 1e-9, w = Math.min(1, Math.max(0, (ti - t[j]) / span));
    out[i] = v[j] + w * (v[j + 1] - v[j]);
  }
  return out;
}

function biquad(type, fc, fs) {            // 2nd-order Butterworth section (RBJ cookbook), Q = 1/sqrt(2)
  const w = (2 * Math.PI * fc) / fs, c = Math.cos(w), al = Math.sin(w) / Math.SQRT2, a0 = 1 + al;
  const b = type === "low" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  return { b: b.map((x) => x / a0), a: [1, (-2 * c) / a0, (1 - al) / a0] };
}
function run(x, { b, a }) {
  const y = new Array(x.length); let x1 = x[0], x2 = x[0], y1 = 0, y2 = 0;
  // start from steady state for a constant input so the filter does not ring at the edges
  const dc = (b[0] + b[1] + b[2]) / (1 + a[1] + a[2]); y1 = y2 = x[0] * dc;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/** Zero-phase band-pass (forward and backward pass). */
export function bandpass(x, fs, lo, hi) {
  if (x.length < 8) return [...x];
  const f = (s) => run(run(s, biquad("high", lo, fs)), biquad("low", hi, fs));
  return f(f(x).reverse()).reverse();
}

/** Strongest frequency in [fmin, fmax] Hz and how much of the band's power sits at it (0..1). */
export function dominantFrequency(x, fs, fmin, fmax, step = 0.5 / 60) {
  const n = x.length; if (n < 16) return { freq: NaN, quality: 0 };
  const m = mean(x), w = x.map((v, i) => (v - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  const freqs = [], pow = [];
  for (let f = fmin; f <= fmax + 1e-9; f += step) {
    let re = 0, im = 0; const k = (2 * Math.PI * f) / fs;
    for (let i = 0; i < n; i++) { re += w[i] * Math.cos(k * i); im -= w[i] * Math.sin(k * i); }
    freqs.push(f); pow.push(re * re + im * im);
  }
  let p = 0; for (let i = 1; i < pow.length; i++) if (pow[i] > pow[p]) p = i;
  const total = pow.reduce((s, v) => s + v, 0) || 1e-12;
  const half = Math.max(1, Math.round(1.2 / (n / fs) / step));          // main-lobe half width in grid steps
  let peak = 0; for (let i = Math.max(0, p - half); i <= Math.min(pow.length - 1, p + half); i++) peak += pow[i];
  return { freq: freqs[p], quality: Math.min(1, peak / total) };
}

/** POS pulse extraction from uniformly sampled mean skin colour. Returns the pulse waveform. */
export function pos(r, g, b, fs) {
  const n = r.length, l = Math.max(8, Math.round(1.6 * fs)), h = new Array(n).fill(0);
  for (let s = 0; s + l <= n; s++) {
    let mr = 0, mg = 0, mb = 0;
    for (let i = s; i < s + l; i++) { mr += r[i]; mg += g[i]; mb += b[i]; }
    mr /= l; mg /= l; mb /= l;
    const s1 = new Array(l), s2 = new Array(l);
    for (let i = 0; i < l; i++) {
      const rn = r[s + i] / mr, gn = g[s + i] / mg, bn = b[s + i] / mb;
      s1[i] = gn - bn; s2[i] = gn + bn - 2 * rn;
    }
    const alpha = std(s1) / (std(s2) || 1e-9), p = s1.map((v, i) => v + alpha * s2[i]), pm = mean(p);
    for (let i = 0; i < l; i++) h[s + i] += p[i] - pm;
  }
  return h;
}

/** Heart rate from samples [{t (s), r, g, b}]. quality is 0..1; treat below 0.35 as unreliable. */
export function estimateHeartRate(samples, { fs = 30, minSeconds = 8, lo = 0.7, hi = 3.0 } = {}) {
  const t = samples.map((s) => s.t), seconds = t.length ? t[t.length - 1] - t[0] : 0;
  if (seconds < minSeconds) return { bpm: null, quality: 0, seconds, reason: "need_more_time" };
  const [r, g, b] = ["r", "g", "b"].map((k) => resample(t, samples.map((s) => s[k]), fs));
  if (Math.min(mean(r), mean(g), mean(b)) < 5) return { bpm: null, quality: 0, seconds, reason: "too_dark" };
  const pulse = bandpass(pos(r, g, b, fs), fs, lo, hi);
  const { freq, quality } = dominantFrequency(pulse, fs, lo, hi);
  return { bpm: Math.round(freq * 600) / 10, quality: Math.round(quality * 100) / 100, seconds: Math.round(seconds * 10) / 10, pulse };
}

/** Sub-pixel vertical shift (in rows) of profile `cur` relative to `ref`, searched within +/- maxShift rows. */
export function verticalShift(ref, cur, maxShift = 6) {
  const n = ref.length, err = [];
  for (let d = -maxShift; d <= maxShift; d++) {
    let e = 0, c = 0;
    for (let i = maxShift; i < n - maxShift; i++) { const v = cur[i + d] - ref[i]; e += v * v; c++; }
    err.push(e / (c || 1));
  }
  let k = 0; for (let i = 1; i < err.length; i++) if (err[i] < err[k]) k = i;
  let frac = 0;
  if (k > 0 && k < err.length - 1) { const den = err[k - 1] - 2 * err[k] + err[k + 1]; if (den > 1e-12) frac = (0.5 * (err[k - 1] - err[k + 1])) / den; }
  return k - maxShift + frac;
}

/** Breathing rate from chest displacement samples (t in s, d in rows). quality 0..1; below 0.35 unreliable. */
export function estimateBreathing(t, d, { fs = 10, minSeconds = 20, lo = 0.1, hi = 0.6 } = {}) {
  const seconds = t.length ? t[t.length - 1] - t[0] : 0;
  if (seconds < minSeconds) return { brpm: null, quality: 0, seconds, reason: "need_more_time" };
  const x = bandpass(resample(t, d, fs), fs, lo, hi);
  const { freq, quality } = dominantFrequency(x, fs, lo, hi, 0.25 / 60);
  return { brpm: Math.round(freq * 600) / 10, quality: Math.round(quality * 100) / 100, seconds: Math.round(seconds * 10) / 10 };
}

/** Blink statistics from eye-closure scores (0 open .. 1 closed) sampled at times t (s). */
export function blinkStats(t, closure, { closed = 0.5, perclosLevel = 0.7, longMs = 500, minMs = 40 } = {}) {
  const seconds = t.length ? t[t.length - 1] - t[0] : 0;
  let blinks = 0, long = 0, start = null, closedTime = 0; const durations = [];
  for (let i = 0; i < t.length; i++) {
    if (i > 0 && closure[i] >= perclosLevel) closedTime += t[i] - t[i - 1];
    const isClosed = closure[i] >= closed;
    if (isClosed && start === null) start = t[i];
    if ((!isClosed || i === t.length - 1) && start !== null) {
      const ms = (t[i] - start) * 1000; start = null;
      if (ms >= longMs) long++; else if (ms >= minMs) { blinks++; durations.push(ms); }
    }
  }
  return {
    seconds: Math.round(seconds * 10) / 10, blinks, long_closures: long,
    blink_rate_per_min: seconds > 0 ? Math.round((blinks / seconds) * 600) / 10 : null,
    mean_blink_ms: durations.length ? Math.round(mean(durations)) : null,
    perclos_pct: seconds > 0 ? Math.round((closedTime / seconds) * 1000) / 10 : null,
  };
}

/** Reaction test summary. rts in ms. A lapse is a response slower than 500 ms (standard for this kind of test). */
export function reactionStats(rts, falseStarts = 0) {
  if (!rts.length) return { trials: 0, median_ms: null, mean_ms: null, lapses: 0, false_starts: falseStarts };
  return { trials: rts.length, median_ms: Math.round(median(rts)), mean_ms: Math.round(mean(rts)),
           fastest_ms: Math.round(Math.min(...rts)), slowest_ms: Math.round(Math.max(...rts)),
           lapses: rts.filter((v) => v > 500).length, false_starts: falseStarts };
}

/** Screening summary. These rules are experimental and not validated; they flag, they do not diagnose. */
export function assess({ heart, breathing, blink, reaction }, Q = 0.35) {
  const flags = [], notes = [];
  if (heart?.bpm && heart.quality >= Q) {
    if (heart.bpm > 100) flags.push("heart rate above 100 at rest");
    else if (heart.bpm < 50) flags.push("heart rate below 50 at rest");
  } else notes.push("heart rate not reliable enough to report");
  if (breathing?.brpm && breathing.quality >= Q) {
    if (breathing.brpm > 20) flags.push("breathing faster than 20 per minute");
    else if (breathing.brpm < 9) flags.push("breathing slower than 9 per minute");
  } else notes.push("breathing rate not reliable enough to report");
  if (blink?.seconds >= 20) {
    if (blink.perclos_pct > 15) flags.push("eyes closed more than 15% of the time");
    if (blink.long_closures > 0) flags.push(`${blink.long_closures} eye closure(s) longer than half a second`);
  }
  if (reaction?.trials >= 3) {
    if (reaction.lapses > 0) flags.push(`${reaction.lapses} slow response(s) over 500 ms`);
    if (reaction.false_starts > 1) flags.push(`${reaction.false_starts} early taps`);
  }
  const alertness = flags.filter((f) => /eye|slow|early/.test(f)).length;
  const verdict = flags.length === 0 ? "ready" : alertness >= 2 || flags.length >= 3 ? "rest" : "caution";
  return { verdict, flags, notes };
}

// =====================================================================================================================
// Advanced layer: several pulse methods and skin regions, windowed tracking, beat timing, breathing fusion,
// extra cognitive tests, personal baselines, scan quality and a transparent readiness score.
// =====================================================================================================================

function overlapAdd(r, g, b, fs, project) {
  const n = r.length, l = Math.max(8, Math.round(1.6 * fs)), h = new Array(n).fill(0);
  for (let s = 0; s + l <= n; s++) {
    let mr = 0, mg = 0, mb = 0;
    for (let i = s; i < s + l; i++) { mr += r[i]; mg += g[i]; mb += b[i]; }
    mr /= l; mg /= l; mb /= l;
    const rn = [], gn = [], bn = [];
    for (let i = 0; i < l; i++) { rn.push(r[s + i] / mr); gn.push(g[s + i] / mg); bn.push(b[s + i] / mb); }
    const p = project(rn, gn, bn), pm = mean(p);
    for (let i = 0; i < l; i++) h[s + i] += p[i] - pm;
  }
  return h;
}
/** CHROM (de Haan & Jeanne, 2013), windowed form. */
export const chrom = (r, g, b, fs) => overlapAdd(r, g, b, fs, (rn, gn, bn) => {
  const x = rn.map((v, i) => 3 * v - 2 * gn[i]), y = rn.map((v, i) => 1.5 * v + gn[i] - 1.5 * bn[i]), a = std(x) / (std(y) || 1e-9);
  return x.map((v, i) => v - a * y[i]);
});
/** Green channel only: simplest method, most sensitive to light changes. Sign flipped so beats point the same way as POS. */
export const green = (r, g, b, fs) => overlapAdd(r, g, b, fs, (rn, gn) => gn.map((v) => -v));
export const METHODS = { pos, chrom, green };

/** Band-passed pulse waveform from samples [{t,r,g,b}] with the chosen method. */
export function pulseFrom(samples, { fs = 30, method = "pos", lo = 0.7, hi = 3.0 } = {}) {
  const t = samples.map((s) => s.t);
  const [r, g, b] = ["r", "g", "b"].map((k) => resample(t, samples.map((s) => s[k]), fs));
  return bandpass(METHODS[method](r, g, b, fs), fs, lo, hi);
}

/** Heart rate in sliding windows. Returns the series and a summary of the windows with usable quality. */
export function trackHeartRate(pulse, fs, { win = 10, step = 1, lo = 0.7, hi = 3.0, Q = 0.35 } = {}) {
  const n = Math.round(win * fs), series = [];
  for (let s = 0; s + n <= pulse.length; s += Math.round(step * fs)) {
    const { freq, quality } = dominantFrequency(pulse.slice(s, s + n), fs, lo, hi, 1 / 60);
    series.push({ t: Math.round(((s + n / 2) / fs) * 10) / 10, bpm: Math.round(freq * 600) / 10, quality: Math.round(quality * 100) / 100 });
  }
  const good = series.filter((p) => p.quality >= Q).map((p) => p.bpm);
  if (!good.length) return { series, coverage: 0, median: null };
  const s = [...good].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const ts = series.filter((p) => p.quality >= Q).map((p) => p.t), mt = mean(ts), mb = mean(good);
  const den = ts.reduce((a, t) => a + (t - mt) ** 2, 0);
  const slope = den > 0 ? ts.reduce((a, t, i) => a + (t - mt) * (good[i] - mb), 0) / den : 0;      // bpm per second
  return { series, coverage: Math.round((good.length / series.length) * 100) / 100, median: median(good), min: s[0], max: s[s.length - 1],
           iqr: Math.round((q(0.75) - q(0.25)) * 10) / 10, trend_bpm_per_min: Math.round(slope * 600) / 10 };
}

/** Local maxima at least minDist samples apart and above `height`; positions refined to sub-sample precision. */
export function detectPeaks(x, minDist, height = 0) {
  const peaks = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > height && x[i] >= x[i - 1] && x[i] > x[i + 1]) {
      const den = x[i - 1] - 2 * x[i] + x[i + 1], pos_ = i + (den < -1e-12 ? (0.5 * (x[i - 1] - x[i + 1])) / den : 0);
      if (peaks.length && pos_ - peaks[peaks.length - 1].i < minDist) { if (x[i] > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { i: pos_, v: x[i] }; }
      else peaks.push({ i: pos_, v: x[i] });
    }
  }
  return peaks;
}

/** Beat-to-beat timing from the pulse waveform. Experimental: camera timing is coarse, so only trust it at high signal quality. */
export function beatMetrics(pulse, fs, bpmHint) {
  const period = (60 / (bpmHint || 70)) * fs, peaks = detectPeaks(pulse, 0.6 * period, 0.3 * std(pulse));
  const times = peaks.map((p) => p.i / fs), ibi = times.slice(1).map((t, i) => (t - times[i]) * 1000);
  if (ibi.length < 5) return { beats: peaks.length, valid: false, beat_times: times };
  const med = median(ibi), ok = ibi.filter((v) => Math.abs(v - med) <= 0.3 * med), diffs = [];
  for (let i = 1; i < ibi.length; i++) if (Math.abs(ibi[i] - med) <= 0.3 * med && Math.abs(ibi[i - 1] - med) <= 0.3 * med) diffs.push(ibi[i] - ibi[i - 1]);
  const r1 = (v) => Math.round(v * 10) / 10;
  return { beats: peaks.length, valid: ok.length >= 0.8 * ibi.length && ok.length >= 10, valid_fraction: r1(ok.length / ibi.length), beat_times: times,
           mean_ibi_ms: r1(mean(ok)), bpm_from_beats: r1(60000 / mean(ok)), sdnn_ms: r1(std(ok)),
           rmssd_ms: diffs.length ? r1(Math.sqrt(mean(diffs.map((d) => d * d)))) : null,
           pnn50_pct: diffs.length ? r1((diffs.filter((d) => Math.abs(d) > 50).length / diffs.length) * 100) : null,
           irregularity_pct: r1((std(ok) / mean(ok)) * 100) };
}

/**
 * Heart rate from several skin regions and methods. regions = { forehead: [{t,r,g,b}], left: [...], right: [...], all: [...] }.
 * method = "auto" tries POS, CHROM and green on every region, keeps the cleanest, and reports how many others agree.
 */
export function estimateHeartRateAdvanced(regions, { fs = 30, method = "auto", minSeconds = 8, Q = 0.35 } = {}) {
  const methods = method === "auto" ? Object.keys(METHODS) : [method], candidates = [];
  for (const [region, samples] of Object.entries(regions)) {
    if (!samples || samples.length < 2 || samples[samples.length - 1].t - samples[0].t < minSeconds) continue;
    if (mean(samples.map((s) => s.g)) < 5) continue;
    for (const m of methods) {
      const pulse = pulseFrom(samples, { fs, method: m }), { freq, quality } = dominantFrequency(pulse, fs, 0.7, 3.0);
      candidates.push({ region, method: m, bpm: Math.round(freq * 600) / 10, quality: Math.round(quality * 100) / 100, pulse });
    }
  }
  if (!candidates.length) return { bpm: null, quality: 0, confidence: 0, reason: "need_more_time_or_light", candidates: [] };
  const best = candidates.reduce((a, c) => (c.quality > a.quality ? c : a));
  const usable = candidates.filter((c) => c !== best && c.quality >= Q);
  const agreement = usable.length ? usable.filter((c) => Math.abs(c.bpm - best.bpm) <= 3).length / usable.length : 0;
  const track = trackHeartRate(best.pulse, fs, { Q }), stable = track.median !== null && track.coverage >= 0.5;
  const bpm = stable ? track.median : best.bpm, beats = beatMetrics(best.pulse, fs, bpm);
  const confidence = Math.round(Math.min(1, 0.55 * best.quality + 0.3 * agreement + 0.15 * (track.coverage || 0)) * 100) / 100;
  return { bpm: Math.round(bpm * 10) / 10, quality: best.quality, confidence, method: best.method, region: best.region, agreement: Math.round(agreement * 100) / 100,
           track, beats, pulse: best.pulse, candidates: candidates.map(({ pulse, ...c }) => c) };
}

/** Breathing rate from the natural speeding and slowing of the heartbeat with each breath (needs clean beat timing). */
export function estimateBreathingFromBeats(beatTimes, { fs = 4, lo = 0.1, hi = 0.6 } = {}) {
  if (!beatTimes || beatTimes.length < 15) return { brpm: null, quality: 0, reason: "too_few_beats" };
  const t = beatTimes.slice(1), ibi = t.map((v, i) => v - beatTimes[i]);
  if (t[t.length - 1] - t[0] < 20) return { brpm: null, quality: 0, reason: "need_more_time" };
  const { freq, quality } = dominantFrequency(bandpass(resample(t, ibi, fs), fs, lo, hi), fs, lo, hi, 0.25 / 60);
  return { brpm: Math.round(freq * 600) / 10, quality: Math.round(quality * 100) / 100 };
}

/** Combine chest-movement and heartbeat-based breathing estimates. Agreement between them is the strongest evidence. */
export function fuseBreathing(chest, beats, Q = 0.35) {
  const a = chest?.brpm && chest.quality >= Q ? chest : null, b = beats?.brpm && beats.quality >= Q ? beats : null;
  if (a && b) {
    if (Math.abs(a.brpm - b.brpm) <= 3) { const w = a.quality + b.quality; return { brpm: Math.round(((a.brpm * a.quality + b.brpm * b.quality) / w) * 10) / 10, quality: Math.min(1, Math.max(a.quality, b.quality) + 0.15), source: "chest+heartbeat", agree: true }; }
    const k = a.quality >= b.quality ? a : b; return { brpm: k.brpm, quality: Math.round(k.quality * 0.7 * 100) / 100, source: k === a ? "chest" : "heartbeat", agree: false };
  }
  if (a) return { brpm: a.brpm, quality: a.quality, source: "chest", agree: null };
  if (b) return { brpm: b.brpm, quality: b.quality, source: "heartbeat", agree: null };
  return { brpm: null, quality: Math.max(chest?.quality || 0, beats?.quality || 0), source: null, agree: null };
}

/** Breath-by-breath regularity from chest displacement. */
export function breathStats(t, d, { fs = 10 } = {}) {
  if (t.length < 2 || t[t.length - 1] - t[0] < 20) return { breaths: 0 };
  const x = bandpass(resample(t, d, fs), fs, 0.1, 0.6), pk = detectPeaks(x, 1.5 * fs, 0.3 * std(x)).map((p) => p.i / fs);
  const iv = pk.slice(1).map((v, i) => v - pk[i]);
  return iv.length < 2 ? { breaths: pk.length } : { breaths: pk.length, interval_cv_pct: Math.round((std(iv) / mean(iv)) * 1000) / 10, longest_gap_s: Math.round(Math.max(...iv) * 10) / 10 };
}

/** Count events where a 0..1 score stays above a level for at least minMs (yawns from jaw opening, for example). */
export function countEvents(t, v, level, minMs) {
  let n = 0, start = null;
  for (let i = 0; i < t.length; i++) {
    const on = v[i] >= level;
    if (on && start === null) start = t[i];
    if ((!on || i === t.length - 1) && start !== null) { if ((t[i] - start) * 1000 >= minMs) n++; start = null; }
  }
  return n;
}

/** Go/no-go test: trials = [{ type: "go" | "nogo", responded: bool, rt: ms | null }]. */
export function goNoGoStats(trials) {
  const go = trials.filter((x) => x.type === "go"), nogo = trials.filter((x) => x.type === "nogo"), rts = go.filter((x) => x.responded && x.rt).map((x) => x.rt);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return { trials: trials.length, hits: go.filter((x) => x.responded).length, misses: go.filter((x) => !x.responded).length,
           false_alarms: nogo.filter((x) => x.responded).length, hit_rate_pct: pct(go.filter((x) => x.responded).length, go.length),
           false_alarm_rate_pct: pct(nogo.filter((x) => x.responded).length, nogo.length), median_rt_ms: rts.length ? Math.round(median(rts)) : null,
           rt_variability_ms: rts.length > 2 ? Math.round(std(rts)) : null };
}

/** Memory span: attempts = [{ length, correct }]. Span is the longest sequence repeated correctly. */
export function memoryStats(attempts) {
  const ok = attempts.filter((a) => a.correct).map((a) => a.length);
  return { attempts: attempts.length, span: ok.length ? Math.max(...ok) : 0, correct: ok.length };
}

/** Personal baseline from earlier values, and how far a new value sits from it (robust z-score; needs 3 earlier values). */
export function baselineStats(values) {
  const v = values.filter((x) => typeof x === "number" && isFinite(x));
  if (!v.length) return { n: 0, median: null, mad: null };
  const m = median(v); return { n: v.length, median: m, mad: median(v.map((x) => Math.abs(x - m))) };
}
export function deviation(value, base, minN = 3) {
  if (typeof value !== "number" || !base || base.n < minN || base.median === null) return null;
  const spread = Math.max(base.mad * 1.4826, 0.03 * Math.abs(base.median), 1e-9);      // floor: 3% of the baseline
  return Math.round(((value - base.median) / spread) * 10) / 10;
}

/** Grade the recording itself, so a weak scan is reported as weak rather than as a health finding. */
export function scanQuality({ fps, motion_pct, brightness, face_frac, heart_quality }) {
  const issues = [];
  if (fps !== null && fps < 20) issues.push(`low frame rate (${Math.round(fps)} per second)`);
  if (motion_pct !== null && motion_pct > 15) issues.push(`movement in ${Math.round(motion_pct)}% of frames`);
  if (brightness !== null && brightness < 60) issues.push("dim lighting"); else if (brightness !== null && brightness > 225) issues.push("overexposed");
  if (face_frac !== null && face_frac < 0.25) issues.push("face small in the frame");
  if (heart_quality !== null && heart_quality < 0.35) issues.push("weak pulse signal");
  return { grade: ["A", "B", "C", "D"][Math.min(3, issues.length)], issues };
}

/** Transparent 0-100 readiness score. Weights and penalties are experimental starting values, not validated. */
export function readinessScore({ heart_bpm, breathing_brpm, perclos_pct, long_closures, yawns, reaction_median_ms, reaction_lapses, false_starts, false_alarms, memory_span, sleep_hours }) {
  const c = (v) => Math.max(0, Math.min(100, Math.round(v))), has = (v) => typeof v === "number" && isFinite(v), parts = {};
  if (has(heart_bpm)) parts.cardio = c(100 - 2 * Math.max(0, heart_bpm - 90, 55 - heart_bpm));
  if (has(breathing_brpm)) parts.respiratory = c(100 - 8 * Math.max(0, breathing_brpm - 20, 12 - breathing_brpm));
  if (has(perclos_pct)) parts.alertness = c(100 - 2 * Math.max(0, perclos_pct - 5) - 15 * (long_closures || 0) - 10 * (yawns || 0));
  if (has(reaction_median_ms)) parts.cognitive = c(100 - Math.max(0, reaction_median_ms - 300) / 3 - 10 * (reaction_lapses || 0) - 7 * (false_starts || 0) - 10 * (false_alarms || 0) - (has(memory_span) && memory_span < 4 ? 15 : 0));
  if (has(sleep_hours)) parts.sleep = c(100 - 15 * Math.max(0, 7 - sleep_hours));
  const W = { cardio: 0.2, respiratory: 0.15, alertness: 0.3, cognitive: 0.25, sleep: 0.1 }, keys = Object.keys(parts);
  if (!keys.length) return { score: null, parts, weights: W };
  const wsum = keys.reduce((s, k) => s + W[k], 0);
  return { score: Math.round(keys.reduce((s, k) => s + parts[k] * W[k], 0) / wsum), parts, weights: W };
}

// =====================================================================================================================
// Version 0.3: facial expression summary, docking task scoring, trend labels, and an isolation forest (unsupervised
// machine learning, Liu et al. 2008) for unusual moments within a scan and unusual checks against a person's history.
// =====================================================================================================================

/** Expression summary from per-frame scores {smile, frown, furrow, raise, press} in 0..1. Describes the face, not the mood. */
export function expressionStats(frames) {
  if (!frames.length) return { frames: 0, label: null };
  const col = (k) => frames.map((f) => f[k] || 0), pct = (a, lvl) => Math.round((a.filter((v) => v >= lvl).length / a.length) * 1000) / 10, r2 = (v) => Math.round(v * 100) / 100;
  const smile = col("smile"), furrow = col("furrow"), press = col("press"), frown = col("frown"), raise = col("raise");
  const out = { frames: frames.length, smile_pct: pct(smile, 0.4), brow_furrow_pct: pct(furrow, 0.4), lip_press_pct: pct(press, 0.4), frown_pct: pct(frown, 0.3), brow_raise_pct: pct(raise, 0.4),
                mean_smile: r2(mean(smile)), mean_furrow: r2(mean(furrow)), expressiveness: r2(mean([smile, furrow, press, frown, raise].map(std))) };
  const tense = Math.max(out.brow_furrow_pct, out.lip_press_pct, out.frown_pct);
  out.label = out.smile_pct >= 20 && out.smile_pct >= tense ? "mostly positive" : tense >= 25 ? "tense or concentrated" : "neutral";
  return out;
}

/** Docking task: samples = [{t (s), err}] with err = distance between reticle and port as a fraction of the field (0..1). */
export function dockingStats(samples, radius = 0.08) {
  if (samples.length < 5) return { samples: samples.length, mean_error_pct: null };
  const e = samples.map((s) => s.err), on = e.filter((v) => v <= radius).length / e.length, tail = e.slice(-Math.max(3, Math.round(e.length * 0.1)));
  let first = null; for (const s of samples) if (s.err <= radius) { first = s.t - samples[0].t; break; }
  const r1 = (v) => Math.round(v * 10) / 10;
  return { samples: e.length, mean_error_pct: r1(mean(e) * 100), time_on_target_pct: r1(on * 100), final_error_pct: r1(mean(tail) * 100),
           time_to_first_lock_s: first === null ? null : r1(first), steadiness_pct: r1(std(e) * 100), docked: mean(tail) <= radius };
}

/** Is a series of check results stable, improving or declining? Needs minN values; compares the fitted change with the median. */
export function trendLabel(values, { higherIsBetter = true, minN = 4, threshold = 0.08 } = {}) {
  const v = values.filter((x) => typeof x === "number" && isFinite(x)).slice(-8);
  if (v.length < minN) return { label: "not enough checks yet", n: v.length, change_pct: null };
  const xs = v.map((_, i) => i), mx = mean(xs), my = mean(v), den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (v[i] - my), 0) / den, change = (slope * (v.length - 1)) / (Math.abs(median(v)) || 1e-9);
  const good = higherIsBetter ? change > 0 : change < 0;
  return { label: Math.abs(change) < threshold ? "stable" : good ? "improving" : "declining", n: v.length, change_pct: Math.round(change * 1000) / 10 };
}

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cFactor = (n) => (n <= 1 ? 0 : n === 2 ? 1 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n);

/** Isolation forest. fit(X) with X = rows of numbers; score(x) is 0..1, where values near 1 are unusual and near 0.5 are ordinary. */
export class IsolationForest {
  constructor({ trees = 100, sample = 64, seed = 7 } = {}) { this.nTrees = trees; this.sample = sample; this.rand = rng(seed); this.trees = []; }
  fit(X) {
    const psi = Math.min(this.sample, X.length), limit = Math.ceil(Math.log2(Math.max(2, psi))); this.psi = psi; this.trees = [];
    const build = (rows, depth) => {
      if (depth >= limit || rows.length <= 1) return { size: rows.length };
      const dims = rows[0].length; let q = -1, lo = 0, hi = 0;
      for (let tries = 0; tries < dims * 2; tries++) { const k = Math.floor(this.rand() * dims); lo = Infinity; hi = -Infinity; for (const r of rows) { if (r[k] < lo) lo = r[k]; if (r[k] > hi) hi = r[k]; } if (hi > lo) { q = k; break; } }
      if (q < 0) return { size: rows.length };
      const p = lo + this.rand() * (hi - lo);
      return { q, p, left: build(rows.filter((r) => r[q] < p), depth + 1), right: build(rows.filter((r) => r[q] >= p), depth + 1) };
    };
    for (let i = 0; i < this.nTrees; i++) {
      const idx = X.map((_, j) => j); for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(this.rand() * (j + 1)); [idx[j], idx[k]] = [idx[k], idx[j]]; }
      this.trees.push(build(idx.slice(0, psi).map((j) => X[j]), 0));
    }
    return this;
  }
  score(x) {
    const path = (node, depth) => (node.q === undefined ? depth + cFactor(node.size) : path(x[node.q] < node.p ? node.left : node.right, depth + 1));
    return Math.pow(2, -mean(this.trees.map((t) => path(t, 0))) / (cFactor(this.psi) || 1));
  }
}

function standardise(rows) {            // median/MAD scaling per column; missing values become the column median
  const dims = rows[0].length, med = [], scale = [];
  for (let k = 0; k < dims; k++) { const c = rows.map((r) => r[k]).filter((v) => typeof v === "number" && isFinite(v)); med.push(c.length ? median(c) : 0); scale.push(Math.max(c.length ? median(c.map((v) => Math.abs(v - med[k]))) * 1.4826 : 0, 0.03 * Math.abs(med[k]), 1e-6)); }
  const z = (r) => r.map((v, k) => (typeof v === "number" && isFinite(v) ? (v - med[k]) / scale[k] : 0));
  return { z, med, scale };
}

/** Unusual moments within one scan. windows = [{t, v: number[]}], names label the columns. Flags windows scoring >= level. */
export function unusualMoments(windows, names, { level = 0.65, minWindows = 20 } = {}) {
  if (windows.length < minWindows) return { trained_on: windows.length, moments: [], reason: "scan too short for the model" };
  const st = standardise(windows.map((w) => w.v)), Z = windows.map((w) => st.z(w.v)), forest = new IsolationForest({ sample: Math.min(64, Z.length) }).fit(Z);
  const moments = windows.map((w, i) => ({ t: w.t, score: Math.round(forest.score(Z[i]) * 100) / 100, i })).filter((m) => m.score >= level)
    .map((m) => { const z = Z[m.i]; let k = 0; for (let j = 1; j < z.length; j++) if (Math.abs(z[j]) > Math.abs(z[k])) k = j; return { t: m.t, score: m.score, driver: names[k], direction: z[k] > 0 ? "high" : "low" }; });
  return { trained_on: windows.length, moments };
}

/**
 * How unusual is today's check against this person's earlier checks? Needs minN earlier checks.
 * With little history the raw scores sit close together, so "unusual" means scoring above every earlier check (and at least 0.55).
 */
export function checkAnomaly(history, current, { minN = 8, floor = 0.55 } = {}) {
  if (history.length < minN) return { score: null, n: history.length, needed: minN };
  const st = standardise(history), Z = history.map(st.z), zc = st.z(current);
  const forest = new IsolationForest({ sample: Math.min(64, history.length + 1) }).fit([...Z, zc]);        // today's check is part of the fit, so it can be isolated
  const past = Z.map((z) => forest.score(z)), score = forest.score(zc), r2 = (v) => Math.round(v * 100) / 100;
  return { score: r2(score), n: history.length, highest_earlier_score: r2(Math.max(...past)), unusual: score >= floor && score > Math.max(...past) };
}

/** Keep only the samples of every region that fall between t0 and t1 seconds. */
export const slicePhase = (regions, t0, t1) => Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, v.filter((s) => s.t >= t0 && s.t < t1)]));

// =====================================================================================================================
// Version 0.6: breathing from several independent sources, and a mood estimate from facial expression.
// =====================================================================================================================

/**
 * Breathing rate from several sources: [{ name, t, v, fs }] signals (chest rows, head movement) and/or ready estimates
 * [{ name, estimate: { brpm, quality } }] (from beat timing). Sources that agree within 3 breaths/min are averaged.
 */
export function estimateBreathingMulti(sources, { Q = 0.35, minSeconds = 15 } = {}) {
  const est = sources.map((s) => ({ name: s.name, ...(s.estimate || estimateBreathing(s.t || [], s.v || [], { fs: s.fs || 10, minSeconds })) })).filter((e) => e.brpm)
    .map(({ name, brpm, quality }) => ({ name, brpm, quality }));
  const good = est.filter((e) => e.quality >= Q).sort((a, b) => b.quality - a.quality), r1 = (v) => Math.round(v * 10) / 10;
  if (!good.length) return { brpm: null, quality: est.length ? Math.max(...est.map((e) => e.quality)) : 0, source: null, agree: null, estimates: est };
  const best = good[0], mates = good.filter((e) => e !== best && Math.abs(e.brpm - best.brpm) <= 3);
  if (mates.length) {
    const all = [best, ...mates], w = all.reduce((s, e) => s + e.quality, 0);
    return { brpm: r1(all.reduce((s, e) => s + e.brpm * e.quality, 0) / w), quality: Math.min(1, r1(best.quality + 0.15)), source: all.map((e) => e.name).join(" + "), agree: true, estimates: est };
  }
  return { brpm: best.brpm, quality: good.length > 1 ? Math.round(best.quality * 80) / 100 : best.quality, source: best.name, agree: good.length > 1 ? false : null, estimates: est };
}

const EXPR_KEYS = ["smile", "frown", "furrow", "raise", "press", "squint", "wide", "jaw"];
/**
 * Mood estimate from facial expression. frames = [{ t, smile, frown, furrow, raise, press, squint, wide, jaw }] in 0..1.
 * Each frame is compared with the person's own resting face (the first two seconds), so a naturally stern or smiley face is not
 * misread. Returns a label, a valence from -100 to 100, the share of time in each expression, and the expression right now.
 * This reads the face. It is an estimate of expressed mood, not a measurement of how the person feels.
 */
export function moodEstimate(frames) {
  if (!frames.length) return { frames: 0, label: null, now: null, valence: null, shares: {} };
  const t0 = frames[0].t ?? 0, first = frames.filter((f) => (f.t ?? 0) - t0 <= 2), ref = first.length >= 5 ? first : frames.slice(0, Math.max(1, Math.round(frames.length * 0.2)));
  const base = Object.fromEntries(EXPR_KEYS.map((k) => [k, median(ref.map((f) => f[k] || 0))]));
  const rel = (f, k) => Math.max(0, (f[k] || 0) - base[k]), abs = (f, k) => f[k] || 0;
  const classify = (f) =>
    rel(f, "smile") >= 0.15 || abs(f, "smile") >= 0.3 ? "smiling"
    : rel(f, "frown") >= 0.1 || abs(f, "frown") >= 0.2 ? "frowning"
    : rel(f, "furrow") >= 0.15 || abs(f, "furrow") >= 0.35 || rel(f, "press") >= 0.2 ? "tense"
    : rel(f, "raise") >= 0.25 && (rel(f, "wide") >= 0.1 || rel(f, "jaw") >= 0.2) ? "surprised" : "neutral";
  const cls = frames.map(classify), share = (c) => Math.round((cls.filter((x) => x === c).length / cls.length) * 1000) / 10;
  const shares = { smiling: share("smiling"), tense: share("tense"), frowning: share("frowning"), surprised: share("surprised"), neutral: share("neutral") };
  const m = (k) => mean(frames.map((f) => rel(f, k)));
  const valence = Math.max(-100, Math.min(100, Math.round(100 * (2.2 * m("smile") - 3 * m("frown") - 1.5 * m("furrow") - m("press")))));
  const label = shares.smiling >= 15 && valence > 5 ? "positive" : shares.tense + shares.frowning >= 25 ? (shares.frowning > shares.tense ? "low" : "tense") : "neutral";
  const tail = cls.slice(-Math.min(cls.length, 45)), counts = {}; for (const c of tail) counts[c] = (counts[c] || 0) + 1;
  const now = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return { frames: frames.length, label, now, valence, shares, expressiveness: Math.round(mean(EXPR_KEYS.map((k) => std(frames.map((f) => f[k] || 0)))) * 100) / 100 };
}
