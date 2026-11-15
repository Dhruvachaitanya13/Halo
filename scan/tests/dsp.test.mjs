// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { estimateHeartRate, estimateBreathing, blinkStats, reactionStats, verticalShift, assess, bandpass, dominantFrequency } from "../js/dsp.js";

let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function faceSamples(bpm, seconds, { noise = 0.25, pulse = 0.6, jitter = true, drift = true } = {}) {
  const out = []; let t = 0;
  while (t < seconds) {
    const p = Math.sin(2 * Math.PI * (bpm / 60) * t), light = drift ? 6 * Math.sin(2 * Math.PI * 0.05 * t) + 0.3 * t : 0;
    out.push({ t, r: 150 + light + 0.25 * pulse * p + noise * rnd(), g: 110 + 0.8 * light + pulse * p + noise * rnd(), b: 90 + 0.7 * light + 0.45 * pulse * p + noise * rnd() });
    t += 1 / 30 + (jitter ? 0.006 * rnd() : 0);
  }
  return out;
}

test("heart rate: recovers known rates within 2 bpm under noise, lighting drift and frame jitter", () => {
  for (const bpm of [52, 64, 72, 88, 105, 130]) {
    const r = estimateHeartRate(faceSamples(bpm, 25));
    assert.ok(Math.abs(r.bpm - bpm) <= 2, `expected ${bpm}, got ${r.bpm}`);
    assert.ok(r.quality >= 0.35, `quality ${r.quality} at ${bpm}`);
  }
});

test("heart rate: noise only gives low quality", () => {
  const r = estimateHeartRate(faceSamples(70, 25, { pulse: 0, noise: 0.6 }));
  assert.ok(r.quality < 0.35, `quality ${r.quality}`);
});

test("heart rate: refuses short or dark recordings", () => {
  assert.equal(estimateHeartRate(faceSamples(70, 4)).reason, "need_more_time");
  const dark = faceSamples(70, 12).map((s) => ({ ...s, r: 1, g: 1, b: 1 }));
  assert.equal(estimateHeartRate(dark).reason, "too_dark");
});

test("breathing: recovers known rates within 1 per minute", () => {
  for (const brpm of [8, 12, 15, 20, 26]) {
    const t = [], d = [];
    for (let x = 0; x < 45; x += 0.1 + 0.01 * rnd()) { t.push(x); d.push(1.5 * Math.sin(2 * Math.PI * (brpm / 60) * x) + 0.02 * x + 0.3 * rnd()); }
    const r = estimateBreathing(t, d);
    assert.ok(Math.abs(r.brpm - brpm) <= 1, `expected ${brpm}, got ${r.brpm}`);
    assert.ok(r.quality >= 0.35, `quality ${r.quality}`);
  }
});

test("vertical shift: finds sub-pixel displacement of a row profile", () => {
  const prof = (s) => Array.from({ length: 80 }, (_, i) => 100 + 40 * Math.sin((i - s) / 6) + 15 * Math.cos((i - s) / 2.3));
  for (const s of [-3.4, -1, 0, 0.5, 2.25, 4]) assert.ok(Math.abs(verticalShift(prof(0), prof(s)) - s) < 0.2, `shift ${s} -> ${verticalShift(prof(0), prof(s))}`);
});

test("blinks: counts blinks, long closures and closed-eye share", () => {
  const t = [], c = [];
  for (let i = 0; i < 1800; i++) {                       // 60 s at 30 fps
    const x = i / 30; t.push(x);
    const blink = [5, 11, 17, 23, 29, 35, 41, 47].some((b) => x >= b && x < b + 0.2);   // 8 blinks of 200 ms
    const long = x >= 52 && x < 53.2;                    // one 1.2 s closure
    c.push(blink || long ? 0.9 : 0.05);
  }
  const s = blinkStats(t, c);
  assert.equal(s.blinks, 8); assert.equal(s.long_closures, 1);
  assert.ok(Math.abs(s.blink_rate_per_min - 8) < 0.2);
  assert.ok(Math.abs(s.mean_blink_ms - 200) <= 40, `mean ${s.mean_blink_ms}`);
  assert.ok(Math.abs(s.perclos_pct - ((8 * 0.2 + 1.2) / 60) * 100) < 0.6, `perclos ${s.perclos_pct}`);
});

test("reaction: median, lapses and false starts", () => {
  const s = reactionStats([250, 310, 280, 620, 295], 1);
  assert.deepEqual([s.trials, s.median_ms, s.lapses, s.false_starts], [5, 295, 1, 1]);
  assert.equal(reactionStats([]).median_ms, null);
});

test("assessment: ready, caution and rest", () => {
  const ok = { heart: { bpm: 68, quality: 0.6 }, breathing: { brpm: 14, quality: 0.6 }, blink: { seconds: 40, perclos_pct: 3, long_closures: 0 }, reaction: { trials: 5, lapses: 0, false_starts: 0 } };
  assert.equal(assess(ok).verdict, "ready");
  assert.equal(assess({ ...ok, heart: { bpm: 112, quality: 0.6 } }).verdict, "caution");
  assert.equal(assess({ ...ok, blink: { seconds: 40, perclos_pct: 22, long_closures: 2 }, reaction: { trials: 5, lapses: 2, false_starts: 0 } }).verdict, "rest");
  const poor = assess({ ...ok, heart: { bpm: 180, quality: 0.1 } });
  assert.equal(poor.verdict, "ready"); assert.ok(poor.notes.some((n) => n.includes("heart rate")));
});

test("filter: band-pass keeps the band and removes drift", () => {
  const fs = 30, x = Array.from({ length: 600 }, (_, i) => 50 + 0.2 * i + Math.sin((2 * Math.PI * 1.2 * i) / fs));
  const y = bandpass(x, fs, 0.7, 3), mid = y.slice(100, 500);
  assert.ok(Math.abs(mid.reduce((a, b) => a + b, 0) / mid.length) < 0.05);
  assert.ok(Math.abs(dominantFrequency(y, fs, 0.7, 3).freq - 1.2) < 0.02);
});

// ------------------------------------------------------------------ advanced layer
import { chrom, green, pulseFrom, trackHeartRate, beatMetrics, estimateHeartRateAdvanced, estimateBreathingFromBeats, fuseBreathing, breathStats,
         countEvents, goNoGoStats, memoryStats, baselineStats, deviation, scanQuality, readinessScore, detectPeaks } from "../js/dsp.js";

test("methods: POS, CHROM and green each recover the rate", () => {
  for (const method of ["pos", "chrom", "green"]) for (const bpm of [60, 84, 118]) {
    const p = pulseFrom(faceSamples(bpm, 25, { drift: method !== "green" }), { method }), f = dominantFrequency(p, 30, 0.7, 3).freq * 60;
    assert.ok(Math.abs(f - bpm) <= 2, `${method} ${bpm} -> ${f.toFixed(1)}`);
  }
});

test("advanced: picks a clean region over a noisy one and reports agreement and tracking", () => {
  const clean = faceSamples(76, 30), noisy = faceSamples(76, 30, { pulse: 0, noise: 1.2 });
  const r = estimateHeartRateAdvanced({ forehead: noisy, left: clean, right: faceSamples(76, 30) });
  assert.ok(Math.abs(r.bpm - 76) <= 2, `bpm ${r.bpm}`); assert.notEqual(r.region, "forehead");
  assert.ok(r.agreement >= 0.5 && r.confidence >= 0.5, `agreement ${r.agreement} confidence ${r.confidence}`);
  assert.ok(r.track.coverage >= 0.8 && r.track.iqr <= 3, `coverage ${r.track.coverage} iqr ${r.track.iqr}`);
  assert.ok(r.candidates.length === 9 && !("pulse" in r.candidates[0]));
  const none = estimateHeartRateAdvanced({ all: faceSamples(70, 3) });
  assert.equal(none.bpm, null);
});

test("tracking: follows a heart rate that rises during the recording", () => {
  const s = []; let t = 0, ph = 0;
  while (t < 40) { const f = (65 + 0.5 * t) / 60; ph += 2 * Math.PI * f / 30; const p = Math.sin(ph); s.push({ t, r: 150 + 0.15 * p + 0.2 * rnd(), g: 110 + 0.6 * p + 0.2 * rnd(), b: 90 + 0.27 * p + 0.2 * rnd() }); t += 1 / 30; }
  const tr = trackHeartRate(pulseFrom(s), 30);
  assert.ok(tr.trend_bpm_per_min > 15 && tr.trend_bpm_per_min < 45, `trend ${tr.trend_bpm_per_min}`);
  assert.ok(tr.max - tr.min >= 8, `range ${tr.min}-${tr.max}`);
});

function beatPulse(seconds, bpm, { breathHz = 0, depth = 0, fs = 30 } = {}) {
  const x = []; let ph = 0;
  for (let i = 0; i < seconds * fs; i++) { const t = i / fs, f = (bpm / 60) * (1 + depth * Math.sin(2 * Math.PI * breathHz * t)); ph += (2 * Math.PI * f) / fs; x.push(Math.sin(ph) + 0.03 * rnd()); }
  return x;
}

test("beats: counts beats, mean interval and low variability for a steady pulse", () => {
  const m = beatMetrics(beatPulse(40, 72), 30, 72);
  assert.ok(Math.abs(m.beats - 48) <= 1, `beats ${m.beats}`); assert.ok(m.valid);
  assert.ok(Math.abs(m.mean_ibi_ms - 833.3) < 4, `ibi ${m.mean_ibi_ms}`); assert.ok(m.sdnn_ms < 12 && m.irregularity_pct < 1.5, `sdnn ${m.sdnn_ms}`);
  const v = beatMetrics(beatPulse(40, 72, { breathHz: 0.25, depth: 0.08 }), 30, 72);
  assert.ok(v.sdnn_ms > 3 * m.sdnn_ms, `varied sdnn ${v.sdnn_ms} vs ${m.sdnn_ms}`);
});

test("breathing from beats, fusion and regularity", () => {
  const b = estimateBreathingFromBeats(beatMetrics(beatPulse(60, 70, { breathHz: 0.25, depth: 0.08 }), 30, 70).beat_times);
  assert.ok(Math.abs(b.brpm - 15) <= 1.5 && b.quality >= 0.35, `brpm ${b.brpm} q ${b.quality}`);
  assert.deepEqual(fuseBreathing({ brpm: 15, quality: 0.6 }, { brpm: 16, quality: 0.5 }).source, "chest+heartbeat");
  const dis = fuseBreathing({ brpm: 15, quality: 0.6 }, { brpm: 24, quality: 0.5 });
  assert.equal(dis.agree, false); assert.equal(dis.source, "chest"); assert.ok(dis.quality < 0.6);
  assert.equal(fuseBreathing({ brpm: 15, quality: 0.2 }, null).brpm, null);
  const t = [], d = []; for (let x = 0; x < 60; x += 0.1) { t.push(x); d.push(Math.sin(2 * Math.PI * 0.25 * x)); }
  const bs = breathStats(t, d); assert.ok(Math.abs(bs.breaths - 15) <= 1 && bs.interval_cv_pct < 5, JSON.stringify(bs));
});

test("events, go/no-go and memory", () => {
  const t = Array.from({ length: 600 }, (_, i) => i / 30), jaw = t.map((x) => ((x > 3 && x < 5.5) || (x > 12 && x < 12.4) ? 0.8 : 0.1));
  assert.equal(countEvents(t, jaw, 0.55, 1200), 1);
  const g = goNoGoStats([{ type: "go", responded: true, rt: 320 }, { type: "go", responded: true, rt: 380 }, { type: "go", responded: false, rt: null }, { type: "nogo", responded: true, rt: 300 }, { type: "nogo", responded: false, rt: null }]);
  assert.deepEqual([g.hits, g.misses, g.false_alarms, g.median_rt_ms, g.false_alarm_rate_pct], [2, 1, 1, 350, 50]);
  assert.deepEqual(memoryStats([{ length: 3, correct: true }, { length: 4, correct: true }, { length: 5, correct: false }, { length: 5, correct: false }]), { attempts: 4, span: 4, correct: 2 });
  assert.equal(detectPeaks([0, 1, 0, 2, 0, 1.5, 0], 1).length, 3);
});

test("baseline, scan quality and readiness score", () => {
  const base = baselineStats([62, 64, 63, 65, 61]);
  assert.equal(base.median, 63); assert.ok(deviation(75, base) > 3); assert.ok(Math.abs(deviation(63.5, base)) < 1);
  assert.equal(deviation(70, baselineStats([60, 62])), null);
  assert.equal(scanQuality({ fps: 30, motion_pct: 2, brightness: 140, face_frac: 0.4, heart_quality: 0.7 }).grade, "A");
  assert.equal(scanQuality({ fps: 12, motion_pct: 30, brightness: 40, face_frac: 0.1, heart_quality: 0.1 }).grade, "D");
  const good = readinessScore({ heart_bpm: 68, breathing_brpm: 14, perclos_pct: 3, long_closures: 0, yawns: 0, reaction_median_ms: 280, reaction_lapses: 0, false_starts: 0, false_alarms: 0, memory_span: 6, sleep_hours: 8 });
  assert.equal(good.score, 100);
  const tired = readinessScore({ heart_bpm: 68, breathing_brpm: 14, perclos_pct: 20, long_closures: 2, yawns: 2, reaction_median_ms: 450, reaction_lapses: 2, false_starts: 0, false_alarms: 1, memory_span: 3, sleep_hours: 4 });
  assert.ok(tired.score < 60 && tired.parts.alertness < 30 && tired.parts.cardio === 100, JSON.stringify(tired));
  assert.equal(readinessScore({}).score, null);
  assert.equal(readinessScore({ sleep_hours: 5 }).score, 70);
});

// ------------------------------------------------------------------ version 0.3
import { expressionStats, dockingStats, trendLabel, IsolationForest, unusualMoments, checkAnomaly, slicePhase } from "../js/dsp.js";
const gauss = () => (rnd() + rnd() + rnd() + rnd()) * 0.87;

test("expression: labels a smiling, a tense and a neutral face", () => {
  const f = (o, n = 100) => Array.from({ length: n }, () => ({ smile: 0.05, frown: 0.02, furrow: 0.05, raise: 0.05, press: 0.05, ...o }));
  assert.equal(expressionStats(f({ smile: 0.7 })).label, "mostly positive");
  assert.equal(expressionStats(f({ furrow: 0.6 })).label, "tense or concentrated");
  const n = expressionStats(f({})); assert.equal(n.label, "neutral"); assert.equal(n.smile_pct, 0);
  assert.equal(expressionStats([]).label, null);
});

test("docking: error, time on target, lock time and docked", () => {
  const good = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, err: i < 20 ? 0.3 - i * 0.012 : 0.03 }));
  const g = dockingStats(good); assert.ok(g.docked && g.time_on_target_pct >= 80 && Math.abs(g.time_to_first_lock_s - 1.9) < 0.2, JSON.stringify(g));
  const bad = dockingStats(Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, err: 0.25 + 0.05 * Math.sin(i) })));
  assert.ok(!bad.docked && bad.time_on_target_pct === 0 && bad.time_to_first_lock_s === null && bad.mean_error_pct > g.mean_error_pct);
});

test("trend: stable, improving, declining, and direction of 'better'", () => {
  assert.equal(trendLabel([300, 305, 298, 302, 301]).label, "stable");
  assert.equal(trendLabel([340, 320, 305, 290, 270], { higherIsBetter: false }).label, "improving");
  assert.equal(trendLabel([270, 290, 305, 320, 340], { higherIsBetter: false }).label, "declining");
  assert.equal(trendLabel([60, 68, 75, 82]).label, "improving");
  assert.equal(trendLabel([300, 310]).label, "not enough checks yet");
});

test("isolation forest: an outlier scores clearly higher than ordinary points, and results are repeatable", () => {
  const X = Array.from({ length: 200 }, () => [gauss(), gauss(), gauss()]), f = new IsolationForest().fit(X);
  const inl = X.map((x) => f.score(x)).sort((a, b) => a - b), out = f.score([6, 6, 6]);
  assert.ok(out > 0.65 && inl[100] < 0.55 && out > inl[199], `outlier ${out.toFixed(2)} median ${inl[100].toFixed(2)} p99 ${inl[197].toFixed(2)}`);
  assert.equal(new IsolationForest().fit(X).score([6, 6, 6]), out);
});

test("unusual moments: finds the disturbed windows and names what drove them", () => {
  const w = Array.from({ length: 50 }, (_, i) => ({ t: i, v: [0.05 + 0.01 * gauss(), 1 + 0.1 * gauss(), 0.5 + 0.05 * gauss()] }));
  w[20].v[0] = 0.9; w[37].v[1] = 6;
  const r = unusualMoments(w, ["eye closure", "chest movement", "pulse strength"]), ts = r.moments.map((m) => m.t);
  assert.ok(ts.includes(20) && ts.includes(37) && r.moments.length <= 6, JSON.stringify(r.moments));
  assert.equal(r.moments.find((m) => m.t === 20).driver, "eye closure"); assert.equal(r.moments.find((m) => m.t === 37).driver, "chest movement");
  assert.equal(unusualMoments(w.slice(0, 10), ["a", "b", "c"]).moments.length, 0);
});

test("check anomaly: needs history, then separates an ordinary check from an unusual one", () => {
  const hist = Array.from({ length: 20 }, () => [65 + 2 * gauss(), 14 + gauss(), 15 + 2 * gauss(), 3 + gauss(), 290 + 15 * gauss()]);
  assert.equal(checkAnomaly(hist.slice(0, 5), hist[0]).score, null);
  const ordinary = checkAnomaly(hist, [66, 14, 16, 3, 295]), odd = checkAnomaly(hist, [98, 24, 4, 22, 520]);
  assert.ok(!ordinary.unusual && odd.unusual && odd.score > ordinary.score + 0.1, `${ordinary.score} vs ${odd.score}`);
  assert.equal(typeof checkAnomaly(hist, [66, null, 16, 3, 295]).score, "number");
  const s = slicePhase({ a: [{ t: 1 }, { t: 5 }, { t: 9 }] }, 4, 9); assert.deepEqual(s.a, [{ t: 5 }]);
});

// ------------------------------------------------------------------ version 0.6
import { estimateBreathingMulti, moodEstimate } from "../js/dsp.js";

test("breathing from several sources: agreement, disagreement, weak signals, ready estimates", () => {
  const sig = (brpm, amp, noise, secs = 40, step = 0.1) => { const t = [], v = []; for (let x = 0; x < secs; x += step) { t.push(x); v.push(amp * Math.sin(2 * Math.PI * (brpm / 60) * x) + noise * rnd()); } return { t, v }; };
  const agree = estimateBreathingMulti([{ name: "chest", ...sig(14, 1.5, 0.3) }, { name: "head", ...sig(14, 0.4, 0.1, 40, 1 / 30) }]);
  assert.ok(Math.abs(agree.brpm - 14) <= 1 && agree.agree === true && agree.source === "chest + head" || agree.source === "head + chest", JSON.stringify(agree));
  const dis = estimateBreathingMulti([{ name: "chest", ...sig(12, 1.5, 0.2) }, { name: "head", ...sig(22, 1.5, 0.2) }]);
  assert.equal(dis.agree, false); assert.ok([12, 22].some((v) => Math.abs(dis.brpm - v) <= 1));
  const weak = estimateBreathingMulti([{ name: "chest", ...sig(14, 0, 1) }, { name: "head", t: [], v: [] }]);
  assert.equal(weak.brpm, null); assert.equal(weak.source, null);
  const one = estimateBreathingMulti([{ name: "chest", t: [], v: [] }, { name: "heartbeat", estimate: { brpm: 16, quality: 0.5 } }]);
  assert.deepEqual([one.brpm, one.source, one.agree], [16, "heartbeat", null]);
  assert.ok(estimateBreathingMulti([{ name: "head", ...sig(15, 1, 0.1, 17) }]).brpm !== null, "works from 15 seconds");
});

test("mood: positive, tense, low and neutral faces, relative to the person's resting face", () => {
  const rest = { smile: 0.05, frown: 0.03, furrow: 0.1, raise: 0.05, press: 0.05, squint: 0.1, wide: 0.05, jaw: 0.02 };
  const run = (later, n = 300) => Array.from({ length: n }, (_, i) => ({ t: i / 30, ...rest, ...(i >= 60 ? later : {}) }));
  const pos = moodEstimate(run({ smile: 0.45 })); assert.equal(pos.label, "positive"); assert.equal(pos.now, "smiling"); assert.ok(pos.valence > 20 && pos.shares.smiling >= 70);
  const tense = moodEstimate(run({ furrow: 0.4, press: 0.3 })); assert.equal(tense.label, "tense"); assert.ok(tense.valence < 0);
  const low = moodEstimate(run({ frown: 0.3 })); assert.equal(low.label, "low"); assert.equal(low.now, "frowning");
  const neu = moodEstimate(run({})); assert.equal(neu.label, "neutral"); assert.equal(neu.now, "neutral"); assert.equal(neu.valence, 0);
  const stern = moodEstimate(Array.from({ length: 300 }, (_, i) => ({ t: i / 30, ...rest, furrow: 0.28 })));       // resting face with lowered brows
  assert.equal(stern.label, "neutral");
  assert.equal(moodEstimate([]).label, null);
});

import * as D from "../js/dsp.js";
test("heart rate: a peak on the edge of the search band is rejected", () => {
  const mk = (hz) => Array.from({ length: 30 * 30 }, (_, i) => { const t = i / 30, p = Math.sin(2 * Math.PI * hz * t); return { t, r: 150 + 0.15 * p, g: 110 + 0.6 * p, b: 90 + 0.27 * p }; });
  const drift = D.estimateHeartRateAdvanced({ all: mk(0.7) }), real = D.estimateHeartRateAdvanced({ all: mk(1.2) });
  assert.equal(drift.quality, 0);
  assert.ok(Math.abs(real.bpm - 72) < 2 && real.quality > 0.6);
});

test("breathing: too few readings per second gives no value", () => {
  const t = Array.from({ length: 20 }, (_, i) => i * 1.5), d = t.map((v) => Math.sin(2 * Math.PI * 0.13 * v));
  const b = D.estimateBreathing(t, d);
  assert.equal(b.brpm, null); assert.equal(b.reason, "too_few_samples");
});

test("breathing: noise on a still chest is not reported as a breathing rate", () => {
  let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  let reported = 0;
  for (let k = 0; k < 40; k++) { const t = Array.from({ length: 180 }, (_, i) => i * 0.1), d = t.map(() => Math.round(rnd() * 2 - 1) * 0.5); const b = D.estimateBreathing(t, d, { minSeconds: 15 }); if (b.brpm !== null && b.quality >= 0.35) reported++; }
  assert.ok(reported <= 4, `noise passed the quality bar in ${reported} of 40 runs`);
  const t = Array.from({ length: 300 }, (_, i) => i * 0.1), real = D.estimateBreathing(t, t.map((v) => Math.sin(2 * Math.PI * 0.25 * v) + 0.3 * (rnd() - 0.5)));
  assert.ok(Math.abs(real.brpm - 15) < 1 && real.quality >= 0.6);
});
