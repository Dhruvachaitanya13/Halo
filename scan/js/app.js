// HALO live health check: settings + consent -> camera scan -> cognitive tests -> sleep log -> results.
// Video never leaves the device and is never stored. Only the numbers on the results screen are saved.
import { CONFIG } from "./config.js?v=0.15.0";
import * as D from "./dsp.js?v=0.15.0";
import { runMission } from "./mission.js?v=0.15.0";
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(); // theme colours for the canvases

const VISION = CONFIG.VISION_URL || "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3";
const MODEL = CONFIG.MODEL_URL || "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const Q = CONFIG.QUALITY_MIN, APP_VERSION = "0.15.0";
const SAFARI = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
// run-time diagnostics, shown under the event log so a screenshot is enough to see what the scanner is doing
const dbg = { src: SAFARI ? "canvas" : "video", ms: 0, frames: 0, faces: 0, errors: 0, errRun: 0, lastFrame: 0, lastErr: "", switched: false, delegate: "?" };
const $ = (id) => document.getElementById(id);
const STAGE = { consent: 0, scan: 1, game: 2, recovery: 2, finger: 2, sleep: 3, results: 4, error: -1 };
const show = (id) => {
  document.querySelectorAll("section").forEach((s) => (s.hidden = s.id !== id));
  [...document.querySelectorAll("#stepper li")].forEach((li, i) => (li.className = i < STAGE[id] ? "done" : i === STAGE[id] ? "now" : ""));
  window.scrollTo({ top: 0 });
};
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const params = new URLSearchParams(location.search);
const sessionId = params.get("s") || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
const settings = { ...CONFIG.DEFAULTS, ...store.get("halo_settings", {}) };
const state = { roi: { forehead: [], left: [], right: [], all: [] }, blinkT: [], blinkC: [], jaw: [], chestT: [], chestD: [], light: [], frameT: [],
                frames: 0, faceFrames: 0, motionFrames: 0, faceFrac: [], tests: {}, headT: [], headY: [], expr: [], phase: "scan", lastT: 0, tScanEnd: null, tTestsEnd: null, blinkFrom: null, phased: false };
const live = { blinks: 0, closed: false, jaw: false, locked: false, said: {} };
let stream = null, landmarker = null, running = false, mode = CONFIG.MODES[settings.mode] || CONFIG.MODES.standard;

// ------------------------------------------------------------------ settings and consent
$("mode").innerHTML = Object.entries(CONFIG.MODES).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join("");
for (const k of ["mode", "method", "camera"]) { $(k).value = settings[k]; $(k).addEventListener("change", (e) => { settings[k] = e.target.value; store.set("halo_settings", settings); mode = CONFIG.MODES[settings.mode]; }); }
for (const k of ["overlay", "validation", "keepCamera", "finger_step"]) { $(k).checked = !!settings[k]; $(k).addEventListener("change", (e) => { settings[k] = e.target.checked; store.set("halo_settings", settings); }); }
$("agree").addEventListener("change", (e) => ($("start").disabled = !e.target.checked));
$("start").addEventListener("click", startScan);

const breathSources = (end = Infinity) => {        // two independent movement signals; beat timing joins them in the final result
  const cut = (ta, va) => { const n = end === Infinity ? ta.length : ta.filter((t) => t < end).length; return { t: ta.slice(0, n), v: va.slice(0, n) }; };
  return [{ name: "chest", ...cut(state.chestT, state.chestD), fs: 10 }, { name: "head", ...cut(state.headT, state.headY), fs: 10 }];
};

// ------------------------------------------------------------------ live display
const ui = {
  set(id, v) { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = v; },
  step(name, cls, text) { const el = $("st-" + name); if (!el) return; el.className = "step " + cls; if (text) el.textContent = text; },
  log(msg) { const t = Math.round(state.lastT), li = document.createElement("li"); li.innerHTML = `<time>${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}</time><span></span>`; li.lastChild.textContent = msg; $("feed").prepend(li); while ($("feed").children.length > 40) $("feed").lastChild.remove(); },
  once(key, msg) { if (!live.said[key]) { live.said[key] = true; ui.log(msg); } },
  ring(frac, secs) { $("ringfg").style.strokeDashoffset = String(94.25 * (1 - Math.min(1, Math.max(0, frac)))); ui.set("timer", `${secs} s`); },
  wave(p) { const c = $("wave"), x = c.getContext("2d"), W = c.width, H = c.height; x.clearRect(0, 0, W, H); if (!p || p.length < 10) return; const m = Math.max(...p.map(Math.abs)) || 1; x.strokeStyle = cssv("--blue"); x.lineWidth = 3; x.lineJoin = "round"; x.beginPath(); p.forEach((v, i) => { const px = (i / (p.length - 1)) * W, py = H / 2 - (v / m) * (H / 2 - 10); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); },
  live(t) {                                         // once a second during the scan
    const recent = state.roi.all.filter((s) => s.t >= t - 15), h = recent.length > 90 ? D.estimateHeartRate(recent) : { bpm: null, quality: 0 }, good = h.bpm && h.quality >= Q;
    ui.set("hrLive", good ? Math.round(h.bpm) : "--"); $("hrQ").style.width = `${Math.round(Math.min(1, h.quality) * 100)}%`; $("hrQ").style.background = good ? cssv("--green") : cssv("--amber"); ui.wave(h.pulse ? h.pulse.slice(-240) : null);
    if (good && !live.locked) { live.locked = true; ui.log(`Pulse signal locked: about ${Math.round(h.bpm)} bpm`); } else if (!good && live.locked && h.quality < Q * 0.7) { live.locked = false; ui.log("Pulse signal lost, re-acquiring"); }
    if (t >= 15 && Math.round(t) % 2 === 0) {
      const b = D.estimateBreathingMulti(breathSources(), { Q }), ok = b.brpm !== null;
      ui.set("brLive", ok ? Math.round(b.brpm) : "--"); ui.set("brSrc", ok ? `breaths per minute (${b.source})` : "breaths per minute"); $("brQ").style.width = `${Math.round(Math.min(1, b.quality) * 100)}%`; $("brQ").style.background = ok ? cssv("--green") : cssv("--amber");
      if (ok) ui.once("br", `Breathing rhythm found: about ${Math.round(b.brpm)} per minute, from ${b.source}`);
    }
    ui.set("blLive", live.blinks); ui.set("pcLive", D.blinkStats(state.blinkT, state.blinkC).perclos_pct ?? "--"); ui.set("exLive", D.moodEstimate(state.expr).now ?? "--");
    const n = state.frameT.length; ui.set("fpsLive", n > 31 ? Math.round(30 / (state.frameT[n - 1] - state.frameT[n - 31])) : "--");
    if (t >= 8) ui.once("hr8", "Enough video for a first heart-rate estimate"); if (t >= mode.scan / 2) ui.once("half", "Halfway through the scan");
  },
};

// ------------------------------------------------------------------ face tracker: starts downloading as soon as the page opens
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
async function loadTracker() {
  const { FaceLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true });
  // some phones stall on the graphics-chip path instead of failing, so give it 12 seconds and then use the processor path
  if (SAFARI) { dbg.delegate = "cpu"; return FaceLandmarker.createFromOptions(files, opts("CPU")); }        // Safari can hang on the graphics-chip path
  try { const fl = await withTimeout(FaceLandmarker.createFromOptions(files, opts("GPU")), 12000); dbg.delegate = "gpu"; return fl; }
  catch { dbg.delegate = "cpu"; return await FaceLandmarker.createFromOptions(files, opts("CPU")); }
}
const tracker = params.get("demo") ? Promise.reject(new Error("demo")) : loadTracker();
tracker.then(() => ($("prep").textContent = "Scanner ready."), () => { if (!params.get("demo")) $("prep").textContent = "Scanner could not be prepared. Check the connection and reload."; });

// ------------------------------------------------------------------ camera scan
let started = false, watch = null;
const waitFor = (test, ms) => new Promise((res) => { const t0 = performance.now(), iv = setInterval(() => { if (test()) { clearInterval(iv); res(true); } else if (performance.now() - t0 > ms) { clearInterval(iv); res(false); } }, 100); });
function showDiag(video) {
  $("diag").textContent = `v${APP_VERSION} | frames ${dbg.frames} | faces ${dbg.faces} | ${Math.round(dbg.ms)} ms per frame | colour samples ${dbg.samples || 0} | video ${video?.videoWidth || 0}x${video?.videoHeight || 0} ready ${video?.readyState ?? "-"} | source ${dbg.src} | ${dbg.delegate} | errors ${dbg.errors}${dbg.lastErr ? " (" + dbg.lastErr + ")" : ""}`;
}
window.addEventListener("error", (e) => { dbg.errors++; dbg.lastErr = String(e.message || e).slice(0, 80); showDiag($("video")); });
window.addEventListener("unhandledrejection", (e) => { if (e.reason?.message === "demo") return; dbg.errors++; dbg.lastErr = String(e.reason?.message || e.reason).slice(0, 80); showDiag($("video")); });

async function startScan() {
  if (started) return; started = true; $("start").disabled = true;        // a second click must not start a second scan
  show("scan"); setStatus("Starting the camera..."); ui.step("camera", "wait", "Starting camera"); ui.log("Scan started");
  if (!navigator.mediaDevices?.getUserMedia) return fail("This page cannot use the camera. Open it over https (a deployed link), not http.");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: settings.camera, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
  } catch { return fail("Camera access was not granted. Allow the camera for this page and reload."); }
  const video = $("video"); video.srcObject = stream; try { await video.play(); } catch {}
  if (!(await waitFor(() => video.videoWidth > 0 && video.readyState >= 2, 8000))) { showDiag(video); stopCamera(); return fail("The camera opened but sent no picture. Close other apps using the camera, then reload."); }
  ui.step("camera", "ok", `Camera on (${video.videoWidth}x${video.videoHeight})`); ui.log("Camera on"); ui.step("tracker", "wait", "Loading face tracker");
  const began = performance.now(), tickLoad = setInterval(() => setStatus(`Preparing the face tracker... ${Math.round((performance.now() - began) / 1000)} s (first time only; faster on Wi-Fi)`), 500);
  try { landmarker = await withTimeout(tracker, 60000); }
  catch (e) { clearInterval(tickLoad); stopCamera(); return fail(e.message === "timeout" ? "The face tracker took more than a minute to download. Try Wi-Fi, then reload." : "The face tracker could not be loaded. Check the connection and reload."); }
  clearInterval(tickLoad);
  if (state.phase !== "scan") { try { landmarker?.close(); } catch {} landmarker = null; return; }        // the scan was skipped while loading
  ui.step("tracker", "ok", `Face tracker ready (${Math.round((performance.now() - began) / 1000)} s)`); ui.log("Face tracker ready"); ui.step("face", "wait", "Looking for your face");
  $("rec").hidden = false; $("skip").textContent = "Finish the scan early";

  const work = document.createElement("canvas"), wctx = work.getContext("2d", { willReadFrequently: true });
  const W = 320, H = Math.round((W * video.videoHeight) / video.videoWidth) || 240; work.width = W; work.height = H;
  const view = $("roicanvas"), vctx = view.getContext("2d"); view.width = W; view.height = H;
  let t0 = null, lastT = 0, lastCy = null, chestRef = null, chestBase = 0, lastChest = -1, lastEst = 0;
  let box = null, boxAt = 0, holdUntil = 0, lastMedia = -1, pulseFirst = false;          // smoothed face box from the tracker, used by the per-frame colour sampler
  running = true; setStatus("Looking for your face..."); showDiag(video);
  await new Promise(requestAnimationFrame);                                   // let the screen update before the first, slowest detection
  const onErr = (e) => {                                                       // a failed frame must never stop the scan silently
    dbg.errors++; dbg.errRun++; dbg.lastErr = String(e?.message || e).slice(0, 80);
    if (dbg.errRun === 3 && !dbg.switched) { dbg.switched = true; dbg.src = dbg.src === "video" ? "canvas" : "video"; ui.log(`Tracker error, switching to the ${dbg.src} source`); }
    if (dbg.errRun >= 12) { showDiag(video); stopCamera(); fail(`The face tracker failed on this browser: ${dbg.lastErr}. Try Chrome, or reload.`); }
  };
  watch = setInterval(() => {                                                  // once a second: diagnostics, stall detection, no-face help
    showDiag(video); if (state.phase !== "scan" || !running) return;
    const idle = performance.now() - dbg.lastFrame;
    if (dbg.frames === 0 && idle > 4000 && dbg.lastFrame === 0 && performance.now() - startedAt > 6000) setStatus("Still starting the tracker on this device. If this lasts more than 30 seconds, press Skip and try Chrome.");
    else if (dbg.frames > 3 && idle > Math.max(3000, 4 * dbg.ms)) { setStatus("The camera picture stopped. Check that no other app is using the camera."); ui.once("stall", "Camera picture stalled"); }
    else if (dbg.frames > 45 && dbg.faces === 0) {
      setStatus("The tracker is running but sees no face. Face the camera, add light in front of you, and remove bright light behind you.");
      if (dbg.frames > 120 && !dbg.switched) { dbg.switched = true; dbg.src = dbg.src === "video" ? "canvas" : "video"; ui.log(`No face found, trying the ${dbg.src} source`); }
    }
    if (dbg.ms > 250) ui.once("slow", `Face tracking is slow on this device (${Math.round(dbg.ms)} ms per frame); readings will be coarser`);
  }, 1000);
  const startedAt = performance.now();

  // Skin colour is read from a second canvas at the camera's own resolution (up to 640 wide), not from the 320-wide tracking canvas:
  // four times the pixels in each region, so less camera noise in the average. Coordinates arrive in tracking-canvas units.
  const samp = document.createElement("canvas"), sctx = samp.getContext("2d", { willReadFrequently: true });
  const SW = Math.min(640, video.videoWidth || W), SH = Math.round((SW * H) / W), SK = SW / W; samp.width = SW; samp.height = SH;
  const avg = (x, y, w, h, fine = false) => {
    const c = fine ? sctx : wctx, k = fine ? SK : 1, CW = fine ? SW : W, CH = fine ? SH : H;
    x = Math.max(0, Math.round(x * k)); y = Math.max(0, Math.round(y * k)); w = Math.min(CW - x, Math.round(w * k)); h = Math.min(CH - y, Math.round(h * k));
    if (w < 4 || h < 4) return null;
    const d = c.getImageData(x, y, w, h).data; let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return { r: r / n, g: g / n, b: b / n, n };
  };
  const rowProfile = (x, y, w, h, rows = 32) => {
    x = Math.max(0, Math.round(x)); y = Math.round(y); w = Math.min(W - x, Math.round(w)); h = Math.min(H - y, Math.round(h));
    if (w < 24 || h < 16) return null;
    const d = wctx.getImageData(x, y, w, h).data, out = new Array(rows).fill(0), cnt = new Array(rows).fill(0);
    for (let j = 0; j < h; j++) { const k = Math.min(rows - 1, Math.floor((j * rows) / h)); let s = 0; for (let i = 0; i < w; i += 2) { const p = (j * w + i) * 4; s += d[p] + d[p + 1] + d[p + 2]; } out[k] += s; cnt[k] += Math.ceil(w / 2) * 3; }
    return { p: out.map((v, i) => v / (cnt[i] || 1)), scale: h / rows };
  };

  // ---- Skin colour is sampled on EVERY camera frame, not only on frames the face tracker has finished.
  // The tracker can take 50-150 ms per frame (Safari runs it on the CPU), which used to leave the pulse
  // signal with 7-15 samples a second. The pulse is a brightness change of well under 1%, so it needs every frame.
  const regionsOf = (b) => ({ forehead: [b.x + 0.28 * b.w, b.y + 0.07 * b.h, 0.44 * b.w, 0.16 * b.h], left: [b.x + 0.13 * b.w, b.y + 0.49 * b.h, 0.24 * b.w, 0.2 * b.h], right: [b.x + 0.63 * b.w, b.y + 0.49 * b.h, 0.24 * b.w, 0.2 * b.h] });
  const sampleSkin = (now) => {
    if (!running || t0 === null || !box || now - boxAt > 1200) return;                          // no recent face
    wctx.drawImage(video, 0, 0, W, H);
    const t = (now - t0) / 1000; let R = 0, G = 0, B = 0, N = 0;
    if (t - lastChest >= 0.1) {                                     // chest rows below the chin, about 10 times a second
      lastChest = t;
      const prof = rowProfile(box.x - 0.3 * box.w, box.y + 1.12 * box.h, 1.6 * box.w, 0.9 * box.h);        // neck, shoulders and upper chest
      if (prof) {
        if (!chestRef) chestRef = prof.p;
        const sft = D.verticalShift(chestRef, prof.p, 4), big = Math.abs(sft) > 3;
        if (big) { chestBase += sft; chestRef = prof.p; }           // re-anchor after a large movement
        state.chestT.push(t); state.chestD.push((chestBase + (big ? 0 : sft)) * prof.scale);
      }
    }
    if (now < holdUntil) return;                                     // the head just moved: skip skin colour for a moment
    sctx.drawImage(video, 0, 0, SW, SH);
    for (const [name, q] of Object.entries(regionsOf(box))) {
      const a = avg(...q, true); if (!a) continue;
      R += a.r * a.n; G += a.g * a.n; B += a.b * a.n; N += a.n; state.roi[name].push({ t, r: a.r, g: a.g, b: a.b });
    }
    if (N) { state.roi.all.push({ t, r: R / N, g: G / N, b: B / N }); state.light.push(G / N); dbg.samples = (dbg.samples || 0) + 1; }
  };
  if (video.requestVideoFrameCallback) {                                     // one call per new camera frame, with no duplicates
    const onFrame = (now) => { if (!running) return; try { sampleSkin(now); } catch (e) { onErr(e); } video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  } else {
    const onRaf = (now) => { if (!running) return; if (video.currentTime !== lastMedia) { lastMedia = video.currentTime; try { sampleSkin(now); } catch (e) { onErr(e); } } requestAnimationFrame(onRaf); };
    requestAnimationFrame(onRaf);
  }

  const tick = () => {
    if (!running) return;
    const now = performance.now();
    // A slow face tracker (over about 28 ms a frame, typical for Safari) blocks camera frames while it runs. On such devices the first 70% of the scan
    // gives the pulse priority: the tracker only refreshes the face position 2.5 times a second and every camera frame goes to the colour sampler.
    // The rest of the scan runs the tracker at full speed to time blinks. Fast devices do both throughout.
    if (dbg.frames === 8 && state.phase === "scan" && dbg.ms > 28 && !pulseFirst) { pulseFirst = true; state.phased = true; ui.log("Slow face tracking on this device: measuring pulse first, then blinks"); }
    const tNow = t0 === null ? 0 : (now - t0) / 1000, pulsePhase = pulseFirst && state.phase === "scan" && tNow < 0.7 * mode.scan;
    if (pulseFirst && !pulsePhase && state.blinkFrom === null) { state.blinkFrom = tNow; ui.log("Pulse captured. Now timing blinks."); }
    if (now - lastT >= (pulsePhase ? 400 : Math.max(45, 2 * dbg.ms)) && video.readyState >= 2 && video.videoWidth > 0) {   // leaves at least half of the time free for the colour sampler
      lastT = now; state.frames++;
      wctx.drawImage(video, 0, 0, W, H);
      const d0 = performance.now(), res = landmarker.detectForVideo(dbg.src === "canvas" ? work : video, now), lm = res.faceLandmarks?.[0];
      dbg.ms = dbg.frames ? 0.8 * dbg.ms + 0.2 * (performance.now() - d0) : performance.now() - d0; dbg.frames++; dbg.lastFrame = now; dbg.errRun = 0; if (lm) dbg.faces++;
      vctx.clearRect(0, 0, W, H);
      if (lm) {
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        let sy = 0; for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; sy += p.y; }
        x0 *= W; x1 *= W; y0 *= H; y1 *= H; const fw = x1 - x0, fh = y1 - y0, cy = (y0 + y1) / 2;
        const moved = lastCy !== null && Math.abs(cy - lastCy) > 0.03 * fh; lastCy = cy;
        if (t0 === null) t0 = now; const t = (now - t0) / 1000;
        state.faceFrames++; state.frameT.push(t); state.faceFrac.push(fh / H); if (moved) state.motionFrames++;
        state.headT.push(t); state.headY.push((sy / lm.length) * 1000);          // head height, averaged over 478 points: rises and falls with each breath
        // three skin regions as fractions of the face box; each is stored on its own and pooled
        // The box is smoothed so that tracker jitter does not slide the regions across the skin (which looks like a pulse to the maths).
        const jump = !box || Math.abs(x0 - box.x) > 0.15 * fw || Math.abs(y0 - box.y) > 0.15 * fh, k = jump ? 1 : 0.25;
        box = jump ? { x: x0, y: y0, w: fw, h: fh } : { x: box.x + k * (x0 - box.x), y: box.y + k * (y0 - box.y), w: box.w + k * (fw - box.w), h: box.h + k * (fh - box.h) };
        boxAt = now; if (moved || jump) holdUntil = now + 250;                  // drop a quarter second of colour samples after a head movement
        const boxes = regionsOf(box);
        let G = 0, N = 0;
        for (const q of Object.values(boxes)) {
          const a = avg(...q); if (settings.overlay) { vctx.strokeStyle = "#5fd0ff"; vctx.strokeRect(...q); }
          if (a) { G += a.g * a.n; N += a.n; }
        }
        const cats = res.faceBlendshapes?.[0]?.categories || [], sc = (name) => cats.find((c) => c.categoryName === name)?.score ?? 0;
        state.blinkT.push(t); state.blinkC.push((sc("eyeBlinkLeft") + sc("eyeBlinkRight")) / 2); state.jaw.push(sc("jawOpen")); state.lastT = t;
        const pair = (n) => (sc(n + "Left") + sc(n + "Right")) / 2;
        state.expr.push({ t, smile: pair("mouthSmile"), frown: pair("mouthFrown"), furrow: pair("browDown"), raise: sc("browInnerUp"), press: pair("mouthPress"), squint: pair("eyeSquint"), wide: pair("eyeWide"), jaw: sc("jawOpen") });
        if (settings.overlay) { vctx.strokeStyle = "#ffc66b"; vctx.strokeRect(box.x - 0.3 * box.w, box.y + 1.12 * box.h, 1.6 * box.w, 0.9 * box.h); }
        if (state.phase === "scan") {
          const left = Math.max(0, mode.scan - t), light = N ? G / N : 0, closed = state.blinkC[state.blinkC.length - 1] >= 0.5, jaw = state.jaw[state.jaw.length - 1] >= 0.55;
          ui.ring(t / mode.scan, Math.ceil(left)); ui.once("face", "Face found. Measuring.");
          ui.step("face", "ok", "Face found"); ui.step("light", light < 40 || light > 235 ? "bad" : "ok", light < 40 ? "Too dark" : light > 235 ? "Too bright" : "Lighting good"); ui.step("still", moved ? "bad" : "ok", moved ? "Hold still" : "Holding still");
          setStatus(light < 40 ? "Too dark. Face a window or a lamp." : light > 235 ? "Too bright. Move away from direct light." : fh / H < 0.22 ? "Move a little closer." : moved ? "Hold still." : pulsePhase ? "Measuring your pulse. Keep still and breathe normally." : "Good. Keep still and breathe normally.");
          if (!pulsePhase && closed && !live.closed) live.blinks++; live.closed = closed;
          if (jaw && !live.jaw) ui.log("Mouth opened wide (possible yawn)"); live.jaw = jaw;
          if (t - lastEst >= 1) { lastEst = t; ui.live(t); }
          if (left <= 0) { ui.log("Scan complete"); endScanPhase(); }
        }
      } else if (state.phase === "scan") { setStatus("Face not found. Centre your face and upper chest in the frame."); ui.step("face", "wait", "Looking for your face"); }
    }
  };
  const loop = () => { if (!running) return; try { tick(); } catch (e) { onErr(e); } if (running) requestAnimationFrame(loop); };
  loop();
}
function stopCamera() { running = false; clearInterval(watch); stream?.getTracks().forEach((t) => t.stop()); stream = null; try { landmarker?.close(); } catch {} landmarker = null; }
function setStatus(s) { $("status").textContent = s; }
function fail(msg) { show("error"); $("errmsg").textContent = msg; }
function endScanPhase() {                       // the scan is over; the camera may stay on, shrunk to a corner, to follow the heart through the tests
  if (state.phase !== "scan") return; state.phase = "tests"; state.tScanEnd = state.lastT;
  if (settings.keepCamera) { const st = document.querySelector(".stage"); document.body.appendChild(st); st.classList.add("mini"); } else stopCamera();
  show("game"); runTests();
}
$("skip").addEventListener("click", () => {       // works at any point, including while the tracker is still loading
  if (state.phase !== "scan") return;
  if (state.faceFrames > 0 && landmarker) return endScanPhase();
  state.phase = "tests"; state.tScanEnd = 0; stopCamera(); show("game"); runTests();
});

// ------------------------------------------------------------------ cognitive tests
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function runTests() {
  // The tests are played as one docking mission (js/mission.js). It returns raw trial data; the statistics are worked out here, as before.
  const raw = await runMission($("mission"), { stages: mode.tests, trials: mode.trials, dockSeconds: CONFIG.DOCKING_SECONDS, muted: () => !settings.sound, debug: !!params.get("demo"),
    onStage: (title, help) => { $("gtitle").textContent = title; $("ghelp").textContent = help; } });
  if (raw.reaction) state.tests.reaction = { ...D.reactionStats(raw.reaction.rts, raw.reaction.falseStarts), misses: raw.reaction.misses };
  if (raw.gonogo) state.tests.gonogo = D.goNoGoStats(raw.gonogo.trials);
  if (raw.memory) state.tests.memory = D.memoryStats(raw.memory.attempts);
  if (raw.docking) state.tests.docking = D.dockingStats(raw.docking.samples);
  state.tests.mission = { points: raw.points, best_streak: raw.best_streak, game_version: 2 };
  state.tTestsEnd = state.lastT;
  if (running && settings.keepCamera) { show("recovery"); for (let s = CONFIG.RECOVERY_SECONDS; s > 0; s--) { $("rectimer").textContent = `${s} s`; await sleepMs(1000); } }
  stopCamera(); document.querySelector(".stage.mini")?.remove();
  if (settings.finger_step && !params.get("demo")) await fingerStep();
  $("valbox").hidden = !settings.validation; show("sleep");
}

// ------------------------------------------------------------------ fingertip pulse: the reliable heart rate
// The fingertip covers the lens and the whole picture is averaged, so the signal is tens of times stronger than in a face video.
// Samples only count while the lens is covered. A value is kept only if D.estimateFingerPulse calls it reliable.
function fingerStep() {
  return new Promise((done) => {
    show("finger"); const video = $("fvideo"), NEED = CONFIG.FINGER_SECONDS || 20, LIMIT = NEED + 25;
    const cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true }); cv.width = 48; cv.height = 36;
    let fstream = null, on = false, samples = [], all = [], t0 = 0, coveredFrom = null, lastLive = 0, lastMedia = -1, torch = false;
    const status = (t) => ($("fstatus").textContent = t);
    const finish = (result, msg) => {
      on = false; try { fstream?.getTracks().forEach((t) => t.stop()); } catch {} video.srcObject = null;
      state.finger = result; if (msg) status(msg); $("fstart").hidden = true; $("fskip").textContent = "Continue";
      $("fskip").onclick = () => done(); if (!result) return void done(); setTimeout(done, result.reliable ? 1800 : 3200);
    };
    $("fskip").onclick = () => finish(null);
    const frame = (now) => {
      if (!on) return;
      cx.drawImage(video, 0, 0, 48, 36); const d = cx.getImageData(0, 0, 48, 36).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } const n = d.length / 4, t = (now - t0) / 1000, smp = { t, r: r / n, g: g / n, b: b / n };
      all.push(smp); const cover = D.fingerCover(all.slice(-15));
      if (cover.covered) { if (coveredFrom === null) coveredFrom = t; if (t - coveredFrom > 1.5) samples.push(smp); }       // skip the first moments while the finger settles
      else { coveredFrom = null; if (samples.length && t - samples[samples.length - 1].t > 1.5) samples = []; }               // finger lifted: start again
      const got = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0;
      if (t - lastLive >= 0.5) {
        lastLive = t; $("fcover").textContent = cover.covered ? "Yes" : cover.reason === "too_dark" ? "Too dark" : "No";
        $("ftimer").textContent = cover.covered ? `${Math.max(0, Math.ceil(NEED - got))} s` : "--"; $("fring").style.strokeDashoffset = String(94.25 * (1 - Math.min(1, got / NEED)));
        status(cover.covered ? (got < 3 ? "Finger found. Hold still." : "Measuring. Keep still and press lightly.") : cover.reason === "too_dark" ? `Too dark. ${torch ? "Press more lightly." : "Point the lens at a lamp or bright window with your finger over it."}` : "Cover the lens completely with your fingertip.");
        if (got >= 6) { const e = D.estimateFingerPulse(samples.slice(-300), { minSeconds: 5 }); $("fbpm").textContent = e.reliable ? Math.round(e.bpm) : "--"; $("fq").style.width = `${Math.round(Math.min(1, e.quality) * 100)}%`; $("fq").style.background = e.reliable ? cssv("--green") : cssv("--amber");
          if (e.pulse) { const c = $("fwave"), x = c.getContext("2d"), W = c.width, H = c.height, p = e.pulse.slice(-180), m = Math.max(...p.map(Math.abs)) || 1; x.clearRect(0, 0, W, H); x.strokeStyle = cssv("--red"); x.lineWidth = 3; x.lineJoin = "round"; x.beginPath(); p.forEach((v, i) => { const px = (i / (p.length - 1)) * W, py = H / 2 - (v / m) * (H / 2 - 10); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); } }
      }
      if (got >= NEED) { const e = D.estimateFingerPulse(samples); const { pulse, ...keep } = e; return finish({ ...keep, torch }, e.reliable ? `Pulse read: ${Math.round(e.bpm)} beats a minute.` : "The signal was not clear enough to trust, so no value was kept."); }
      if (t > LIMIT) return finish({ bpm: null, quality: 0, reliable: false, reason: samples.length ? "timed_out" : "finger_not_detected", torch }, samples.length ? "Time ran out before a steady reading." : "No fingertip was detected on the lens.");
      schedule();
    };
    const schedule = () => { if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now) => frame(now)); else requestAnimationFrame((now) => { if (video.currentTime !== lastMedia) { lastMedia = video.currentTime; frame(now); } else schedule(); }); };
    $("fstart").onclick = async () => {
      $("fstart").hidden = true; status("Opening the camera...");
      try {
        fstream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } }, audio: false });
        video.srcObject = fstream; await video.play().catch(() => {});
        const track = fstream.getVideoTracks()[0]; try { if (track.getCapabilities?.().torch) { await track.applyConstraints({ advanced: [{ torch: true }] }); torch = true; } } catch {}
        if (!(await waitFor(() => video.videoWidth > 0 && video.readyState >= 2, 6000))) return finish(null, "The camera sent no picture. Skipping this step.");
        on = true; t0 = performance.now(); schedule();
      } catch { finish(null, "The camera could not be opened. Skipping this step."); }
    };
  });
}
if (params.get("demo") === "finger") fingerStep().then(() => { show("finger"); $("fstatus").textContent = state.finger ? JSON.stringify(state.finger) : "Skipped."; });
const syncMute = () => { $("mute").textContent = settings.sound ? "Sound on" : "Sound off"; $("mute").setAttribute("aria-pressed", String(!settings.sound)); };
$("mute").addEventListener("click", () => { settings.sound = !settings.sound; store.set("halo_settings", settings); syncMute(); }); syncMute();

// ------------------------------------------------------------------ results
$("sleepform").addEventListener("submit", (e) => { e.preventDefault(); results(); });
const num = (id) => { const v = $(id).value; return v === "" ? null : Number(v); };

function results() {
  const scanned = state.faceFrames > 0, ok = (m) => m && m.quality >= Q, r1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : null);
  const scanEnd = state.tScanEnd ?? Infinity, restRoi = D.slicePhase(state.roi, 0, state.blinkFrom ?? scanEnd), inScan = (t) => t < scanEnd;
  const bi0 = state.blinkFrom === null ? 0 : state.blinkT.findIndex((t) => t >= state.blinkFrom), bi1 = state.blinkT.filter(inScan).length, bt = bi0 < 0 ? [] : state.blinkT.slice(bi0, bi1), bc = bi0 < 0 ? [] : state.blinkC.slice(bi0, bi1), ct = state.chestT.filter(inScan), cd = state.chestD.slice(0, ct.length);
  const heart = scanned ? D.estimateHeartRateAdvanced(restRoi, { method: settings.method, Q }) : { bpm: null, quality: 0, confidence: 0, candidates: [] };
  const chest = D.estimateBreathing(ct, cd);
  const fromBeats = ok(heart) && heart.beats?.valid && heart.quality >= 0.6 ? D.estimateBreathingFromBeats(heart.beats.beat_times) : null;
  const breathing = D.estimateBreathingMulti([...breathSources(scanEnd), ...(fromBeats?.brpm ? [{ name: "heartbeat", estimate: fromBeats }] : [])], { Q }), bstats = D.breathStats(ct, cd);
  const blink = D.blinkStats(bt, bc), yawns = D.countEvents(bt, bi0 < 0 ? [] : state.jaw.slice(bi0, bi1), 0.55, 1200);
  const ex = D.moodEstimate(state.expr.filter((e) => e.t < scanEnd)), dk = state.tests.docking || null, selfMood = num("mood");
  const phase = (a, b) => { if (!ok(heart)) return null; const h = D.estimateHeartRateAdvanced(D.slicePhase(state.roi, a, b), { method: settings.method, Q }); return h.bpm && h.quality >= Math.max(Q, 0.5) && h.track.coverage >= 0.5 ? h.bpm : null; };   // short windows: only reported when the resting scan worked and the signal is clearly good
  const taskHr = scanned && state.tTestsEnd !== null && settings.keepCamera ? phase(scanEnd, state.tTestsEnd) : null, recHr = scanned && state.tTestsEnd !== null && settings.keepCamera ? phase(state.tTestsEnd, Infinity) : null;
  const rx = state.tests.reaction || D.reactionStats([]), gng = state.tests.gonogo || null, mem = state.tests.memory || null;
  const span = state.frameT.length > 1 ? state.frameT[state.frameT.length - 1] - state.frameT[0] : 0;
  const cSpan = restRoi.all.length > 1 ? restRoi.all[restRoi.all.length - 1].t - restRoi.all[0].t : 0, colourRate = cSpan ? restRoi.all.length / cSpan : null;
  const quality = D.scanQuality({ fps: colourRate, motion_pct: scanned ? (state.motionFrames / state.faceFrames) * 100 : null,
    brightness: state.light.length ? D.mean(state.light) : null, face_frac: state.faceFrac.length ? D.median(state.faceFrac) : null, heart_quality: scanned ? heart.quality : null });
  const finger = state.finger && state.finger.reliable ? state.finger : null;        // fingertip pulse, when it passed its own checks
  const hrv = finger?.beats?.valid ? finger.beats : ok(heart) && heart.quality >= 0.6 && heart.beats?.valid ? heart.beats : null;
  const record = {
    session_id: sessionId, created_at: new Date().toISOString(), app_version: APP_VERSION, mode: settings.mode,
    heart_bpm: finger ? finger.bpm : ok(heart) ? heart.bpm : null, heart_quality: finger ? finger.quality : heart.quality, heart_confidence: finger ? 0.9 : heart.confidence ?? 0,
    heart_method: finger ? "finger" : heart.method ?? null, heart_region: finger ? "fingertip" : heart.region ?? null,
    heart_min_bpm: ok(heart) ? heart.track?.min ?? null : null, heart_max_bpm: ok(heart) ? heart.track?.max ?? null : null, heart_trend_bpm_per_min: ok(heart) ? heart.track?.trend_bpm_per_min ?? null : null,
    hrv_rmssd_ms: hrv?.rmssd_ms ?? null, hrv_sdnn_ms: hrv?.sdnn_ms ?? null, beat_irregularity_pct: hrv?.irregularity_pct ?? null,
    breathing_brpm: breathing.brpm, breathing_quality: r1(breathing.quality), breathing_source: breathing.source, breathing_interval_cv_pct: breathing.brpm ? bstats.interval_cv_pct ?? null : null,
    blink_rate_per_min: scanned ? blink.blink_rate_per_min : null, mean_blink_ms: scanned ? blink.mean_blink_ms : null, long_closures: scanned ? blink.long_closures : null,
    perclos_pct: scanned ? blink.perclos_pct : null, yawns: scanned ? yawns : null,
    reaction_median_ms: rx.median_ms, reaction_lapses: rx.lapses, reaction_false_starts: rx.false_starts, reaction_trials: rx.trials,
    gonogo_hit_rate_pct: gng?.hit_rate_pct ?? null, gonogo_false_alarms: gng?.false_alarms ?? null, gonogo_median_rt_ms: gng?.median_rt_ms ?? null, memory_span: mem?.span ?? null,
    heart_task_bpm: taskHr, heart_recovery_bpm: recHr, expression_label: scanned ? ex.label : null, smile_pct: scanned ? ex.shares.smiling ?? null : null, brow_furrow_pct: scanned ? ex.shares.tense ?? null : null,
    mood_label: scanned ? ex.label : null, mood_valence: scanned ? ex.valence : null, self_mood: selfMood,
    docking_error_pct: dk?.mean_error_pct ?? null, docking_on_target_pct: dk?.time_on_target_pct ?? null, docking_docked: dk ? dk.docked : null,
    sleep_hours: num("sleephours"), self_alertness: num("alertness"),
    scan_seconds: scanned ? blink.seconds : 0, frames: state.faceFrames, motion_pct: scanned ? r1((state.motionFrames / state.faceFrames) * 100) : null, scan_grade: scanned ? quality.grade : null,
    reference_heart_bpm: settings.validation ? num("refhr") : null, reference_breathing_brpm: settings.validation ? num("refbr") : null,
  };
  record.heart_error_bpm = record.reference_heart_bpm !== null && record.heart_bpm !== null ? r1(record.heart_bpm - record.reference_heart_bpm) : null;
  record.heart_task_delta_bpm = taskHr !== null && record.heart_bpm !== null ? r1(taskHr - record.heart_bpm) : null;
  record.heart_recovery_delta_bpm = recHr !== null && record.heart_bpm !== null ? r1(recHr - record.heart_bpm) : null;
  record.breathing_error_brpm = record.reference_breathing_brpm !== null && record.breathing_brpm !== null ? r1(record.breathing_brpm - record.reference_breathing_brpm) : null;

  const a = D.assess({ heart: { bpm: record.heart_bpm, quality: heart.quality }, breathing: { brpm: breathing.brpm, quality: breathing.quality }, blink: scanned ? blink : null, reaction: rx }, Q);
  if (!scanned) a.notes = ["no camera scan in this session"];
  if (state.simulated) { a.notes.unshift("simulated input: test signals, not a real measurement"); $("simnote").hidden = false; }
  if (scanned && yawns > 0) a.flags.push(`${yawns} yawn(s) during the scan`);
  if (gng && gng.false_alarms > 1) a.flags.push(`${gng.false_alarms} taps on red in the attention test`);
  if (mem && mem.span < 4) a.flags.push(`memory span of ${mem.span}`);
  if (record.sleep_hours !== null && record.sleep_hours < 7) a.flags.push("fewer than 7 hours of sleep reported");
  if (selfMood !== null && selfMood <= 2) a.flags.push("low mood reported");
  if (hrv && hrv.irregularity_pct > 15) a.flags.push("beat-to-beat timing varied more than 15% (camera estimate, experimental)");
  const score = D.readinessScore({ ...record, false_starts: rx.false_starts, false_alarms: gng?.false_alarms ?? 0 });

  // personal baseline from earlier checks on this device
  const hist = store.get("halo_history", []), KEYS = { heart_bpm: "heart rate", breathing_brpm: "breathing rate", reaction_median_ms: "reaction time", blink_rate_per_min: "blink rate" }, dev = {};
  for (const [k, label] of Object.entries(KEYS)) {
    const z = D.deviation(record[k], D.baselineStats(hist.map((h) => h[k]))); dev[k] = z;
    if (z !== null && Math.abs(z) >= 2.5) a.flags.push(`${label} is ${z > 0 ? "above" : "below"} your usual range on this device`);
  }
  // ---- machine learning: isolation forest on this scan's two-second windows, and on this person's earlier checks
  const names = ["eye closure", "chest movement", "pulse strength", "lighting"], windows = [], T = Math.min(scanEnd, state.frameT[state.frameT.length - 1] ?? 0);
  const seg = (ta, va, a, b) => { const o = []; for (let i = 0; i < ta.length; i++) if (ta[i] >= a && ta[i] < b) o.push(va[i]); return o; };
  const pStart = heart.pulse && heart.region ? restRoi[heart.region][0]?.t ?? 0 : 0, pT = heart.pulse ? heart.pulse.map((_, i) => pStart + i / 30) : [];
  for (let w = 0; scanned && w + 2 <= T; w += 1) {
    const e = seg(bt, bc, w, w + 2), c = seg(ct, cd, w, w + 2), p = seg(pT, heart.pulse || [], w, w + 2), l = seg(state.frameT, state.light, w, w + 2);
    if (e.length >= 5) windows.push({ t: w + 1, v: [D.mean(e), c.length > 2 ? D.std(c) : null, p.length > 5 ? D.std(p) : null, l.length ? D.mean(l) : null] });
  }
  const moments = D.unusualMoments(windows, names);
  const VEC = ["heart_bpm", "breathing_brpm", "blink_rate_per_min", "perclos_pct", "reaction_median_ms"], anomaly = D.checkAnomaly(hist.map((hh) => VEC.map((k) => hh[k] ?? null)), VEC.map((k) => record[k] ?? null));
  if (moments.moments.length >= 3) a.flags.push(`${moments.moments.length} unusual moments during the scan (model)`);
  if (anomaly.unusual) a.flags.push("today's check is unlike your earlier checks on this device (model)");
  record.ml_unusual_moments = scanned ? moments.moments.length : null; record.ml_check_score = anomaly.score; record.ml_check_unusual = anomaly.score === null ? null : anomaly.unusual;
  // ---- trends across checks on this device
  const series = (k) => [...hist.map((hh) => hh[k]), record[k]];
  const trends = { "Reaction time": D.trendLabel(series("reaction_median_ms"), { higherIsBetter: false }), "Docking error": D.trendLabel(series("docking_error_pct"), { higherIsBetter: false }),
                   "Memory span": D.trendLabel(series("memory_span")), "Readiness score": D.trendLabel([...hist.map((hh) => hh.readiness_score), score.score]) };
  const alertFlags = a.flags.filter((f) => /eye|slow|early|yawn|red|memory/.test(f)).length;
  record.verdict = a.flags.length === 0 ? "ready" : alertFlags >= 2 || (score.score !== null && score.score < 50) ? "rest" : "caution";      // "rest" needs two performance or drowsiness flags, or a low score
  record.readiness_score = score.score; record.flags = a.flags; record.notes = a.notes;
  record.details = { finger: state.finger || null, face_heart: scanned ? { bpm: heart.bpm, quality: heart.quality, raw_quality: heart.raw_quality ?? null, steady: heart.steady ?? null, method: heart.method ?? null, region: heart.region ?? null } : null,
                     diagnostics: { tracker_ms: Math.round(dbg.ms), tracker_frames: dbg.frames, colour_samples_per_s: colourRate === null ? null : Math.round(colourRate * 10) / 10, delegate: dbg.delegate, safari: SAFARI, phased: state.phased, light_mean: state.light.length ? Math.round(D.mean(state.light)) : null }, score_parts: score.parts, deviations: dev, scan_issues: quality.issues, candidates: heart.candidates, heart_series: heart.track?.series ?? [],
                     breathing: { chest, from_beats: fromBeats, agree: breathing.agree, estimates: breathing.estimates, ...bstats }, tests: state.tests, settings: { ...settings },
                     expression: ex, ml: { model: "isolation forest", windows: moments.trained_on, moments: moments.moments, check: anomaly }, trends };

  // ---- render
  const tag = (t) => `<span class="tag ${t}">${t === "live" ? "live measurement" : "experimental"}</span>`;
  const row = (label, value, sub, t) => `<div class="row"><div><b>${label}</b><small>${sub}</small></div><div class="val">${value}${tag(t)}</div></div>`;
  const sig = (q) => (!scanned ? "no camera scan in this session" : q >= 0.6 ? "good signal" : q >= Q ? "fair signal" : "signal too weak, not reported");
  const vs = (k) => (dev[k] === null ? "" : `; ${dev[k] > 0 ? "+" : ""}${dev[k]} vs your baseline`);
  $("verdict").textContent = { ready: "Ready", caution: "Caution", rest: "Rest advised" }[record.verdict]; $("verdict").className = `verdict ${record.verdict}`;
  $("score").innerHTML = score.score === null ? "" : `<div class="scoreline"><b>Readiness score ${score.score}</b> / 100</div>` +
    Object.entries(score.parts).map(([k, v]) => `<div class="part"><span>${k}</span><div class="pbar"><i style="width:${v}%"></i></div><span>${v}</span></div>`).join("");
  const hrSpan = restRoi.all.length > 1 ? restRoi.all[restRoi.all.length - 1].t - restRoi.all[0].t : 0, hrRate = hrSpan ? Math.round(restRoi.all.length / hrSpan) : 0, lightMean = state.light.length ? D.mean(state.light) : 0;
  const hrTip = hrRate && hrRate < 20 ? "The camera delivered too few frames; close other tabs and add light." : lightMean < 70 ? "The face was too dark; face a window or a lamp." : lightMean > 200 ? "The face was over-exposed; move away from direct light." : state.motionFrames / Math.max(1, state.faceFrames) > 0.1 ? "There was too much head movement; rest your elbows and keep still." : "Use even light from the front, keep still and do not talk; laptop cameras in room light are often too noisy.";
  const faceNote = ok(heart) ? ` The face-video estimate was ${Math.round(heart.bpm)} bpm (experimental).` : scanned ? " The face video gave no usable estimate." : "";
  let h = finger ? row("Heart rate", `${Math.round(finger.bpm)} bpm`, `fingertip pulse, ${finger.quality >= 0.6 ? "good signal" : "fair signal"}; ${finger.beats.beats} beats counted over ${Math.round(finger.seconds)} s, and the beat count and the spectrum agree.${faceNote}${vs("heart_bpm")}`, "live")
        : row("Heart rate", record.heart_bpm ? `${Math.round(record.heart_bpm)} bpm` : "-", ok(heart) ? `${sig(heart.quality)}, confidence ${Math.round(heart.confidence * 100)}%; range ${Math.round(heart.track.min ?? heart.bpm)}-${Math.round(heart.track.max ?? heart.bpm)}; ${heart.method.toUpperCase()} on ${heart.region}${vs("heart_bpm")}` : scanned ? `signal too weak, not reported (quality ${Math.round(heart.quality * 100)}%, needs ${Math.round(Q * 100)}%; ${hrRate} colour samples/s). ${hrTip}` : sig(0), "live");
  if (hrv) h += row("Beat-to-beat variation", `${hrv.rmssd_ms} ms`, `RMSSD from ${hrv.beats} beats${finger ? " (fingertip)" : ""}; SDNN ${hrv.sdnn_ms} ms. Camera timing is coarse.`, "experimental");
  h += row("Breathing rate", breathing.brpm ? `${Math.round(breathing.brpm)} /min` : "-", breathing.brpm ? `${sig(breathing.quality)}; from ${breathing.source}${breathing.agree ? " (both agree)" : breathing.agree === false ? " (methods disagreed)" : ""}${vs("breathing_brpm")}` : sig(breathing.quality), "experimental");
  h += row("Blink rate", scanned && blink.blink_rate_per_min !== null ? `${blink.blink_rate_per_min} /min` : "-", scanned ? `eyes closed ${blink.perclos_pct ?? "-"}% of the time; ${blink.long_closures} long closure(s); ${yawns} yawn(s)${vs("blink_rate_per_min")}` : sig(0), "live");
  const MOODS = { 5: "very good", 4: "good", 3: "neutral", 2: "low", 1: "very low" };
  if ((scanned && ex.label) || selfMood !== null) h += row("Mood", selfMood !== null ? MOODS[selfMood] : ex.label,
    (selfMood !== null ? "self-reported. " : "") + (scanned && ex.label ? `Expression estimate: ${ex.label} (valence ${ex.valence > 0 ? "+" : ""}${ex.valence}); smiling ${ex.shares.smiling}%, tense ${ex.shares.tense}%, frowning ${ex.shares.frowning}% of the scan. Reads the face, not the feeling.` : "No camera scan for an expression estimate."), selfMood !== null ? "live" : "experimental");
  if (taskHr !== null) h += row("Heart rate during the tests", `${Math.round(taskHr)} bpm`, record.heart_task_delta_bpm !== null ? `${record.heart_task_delta_bpm > 0 ? "+" : ""}${record.heart_task_delta_bpm} bpm against the resting scan` : "resting value not available", "experimental");
  if (recHr !== null) h += row("Heart rate after resting", `${Math.round(recHr)} bpm`, record.heart_recovery_delta_bpm !== null ? `${record.heart_recovery_delta_bpm > 0 ? "+" : ""}${record.heart_recovery_delta_bpm} bpm against the resting scan, after ${CONFIG.RECOVERY_SECONDS} s still` : "resting value not available", "experimental");
  h += row("Reaction time", rx.median_ms ? `${rx.median_ms} ms` : "-", `${rx.lapses} slow response(s), ${rx.false_starts} early tap(s)${rx.misses ? `, ${rx.misses} missed` : ""} in ${rx.trials} trials${vs("reaction_median_ms")}`, "live");
  if (gng) h += row("Attention", gng.hit_rate_pct !== null ? `${gng.hit_rate_pct}%` : "-", `supply pods caught; ${gng.false_alarms} tap(s) on debris; median ${gng.median_rt_ms ?? "-"} ms`, "live");
  if (mem) h += row("Memory span", `${mem.span}`, `longest sequence repeated correctly, in ${mem.attempts} attempts`, "live");
  if (state.tests.mission) h += row("Mission points", `${state.tests.mission.points}`, `best streak ${state.tests.mission.best_streak}. For fun only; not used in the readiness score.`, "live");
  if (dk && dk.mean_error_pct !== null) h += row("Docking", `${dk.mean_error_pct}%`, `average distance from the port; on target ${dk.time_on_target_pct}% of the time; ${dk.docked ? "docked" : "missed the port"}`, "live");
  h += row("Sleep last night", record.sleep_hours !== null ? `${record.sleep_hours} h` : "-", "self-reported", "live");
  if (record.heart_error_bpm !== null) h += row("Heart rate vs reference", `${record.heart_error_bpm > 0 ? "+" : ""}${record.heart_error_bpm} bpm`, `reference device read ${record.reference_heart_bpm} bpm`, "live");
  if (record.breathing_error_brpm !== null) h += row("Breathing vs counted", `${record.breathing_error_brpm > 0 ? "+" : ""}${record.breathing_error_brpm} /min`, `counted ${record.reference_breathing_brpm} per minute`, "live");
  $("rows").innerHTML = h;
  $("flags").innerHTML = (a.flags.length ? a.flags.map((f) => `<li>${f}</li>`).join("") : "<li>Nothing flagged.</li>") + a.notes.map((n) => `<li class="note">${n}</li>`).join("");
  $("grade").textContent = scanned ? `Scan quality ${quality.grade}${quality.issues.length ? ": " + quality.issues.join(", ") : ": no issues"}` : "";
  drawSeries(heart.track?.series ?? []);
  $("trends").innerHTML = Object.entries(trends).map(([k, v]) => `<div class="row"><div><b>${k}</b><small>${v.change_pct === null ? `${v.n} check(s) so far; needs 4` : `${v.change_pct > 0 ? "+" : ""}${v.change_pct}% across the last ${v.n} checks`}</small></div><div class="val trend ${v.label.split(" ")[0]}">${v.label}</div></div>`).join("");
  $("ml").innerHTML = (scanned ? `<p>Within this scan: an isolation forest was fitted to ${moments.trained_on} two-second windows.</p><ul>${moments.moments.length ? moments.moments.map((m) => `<li>at ${m.t} s: ${m.driver} unusually ${m.direction} (score ${m.score})</li>`).join("") : `<li>${moments.reason || "No unusual moments found."}</li>`}</ul>` : "<p>No camera scan in this session.</p>") +
    `<p>Against your earlier checks: ${anomaly.score === null ? `needs ${anomaly.needed} earlier checks on this device; you have ${anomaly.n}.` : `score ${anomaly.score} (highest earlier check ${anomaly.highest_earlier_score}): ${anomaly.unusual ? "unlike your earlier checks." : "within your usual pattern."}`}</p>`;

  store.set("halo_history", [...hist, Object.fromEntries(["created_at", ...Object.keys(KEYS), "perclos_pct", "memory_span", "docking_error_pct", "readiness_score"].map((k) => [k, record[k]]))].slice(-40));
  show("results"); save(record); sendToAgent(record);
  const dl = (name, text, type) => { const u = URL.createObjectURL(new Blob([text], { type })); Object.assign(document.createElement("a"), { href: u, download: name }).click(); URL.revokeObjectURL(u); };
  $("download").onclick = () => dl(`halo-scan-${sessionId.slice(0, 8)}.json`, JSON.stringify(record, null, 2), "application/json");
  $("csv").onclick = () => dl(`halo-heart-series-${sessionId.slice(0, 8)}.csv`, "seconds,bpm,quality\n" + (heart.track?.series ?? []).map((p) => `${p.t},${p.bpm},${p.quality}`).join("\n"), "text/csv");
  $("reset").onclick = () => { store.set("halo_history", []); $("reset").textContent = "Baseline cleared"; };
}

function drawSeries(series) {
  const c = $("chart"), good = series.filter((p) => p.quality >= Q); c.hidden = good.length < 3; if (c.hidden) return;
  const x = c.getContext("2d"), W = (c.width = 600), H = (c.height = 160), lo = Math.min(...good.map((p) => p.bpm)) - 5, hi = Math.max(...good.map((p) => p.bpm)) + 5, T = series[series.length - 1].t || 1;
  x.clearRect(0, 0, W, H); x.strokeStyle = cssv("--line"); x.fillStyle = cssv("--dim"); x.font = "20px system-ui";
  for (const v of [lo, (lo + hi) / 2, hi]) { const y = H - ((v - lo) / (hi - lo)) * (H - 20) - 10; x.beginPath(); x.moveTo(50, y); x.lineTo(W, y); x.stroke(); x.fillText(Math.round(v), 4, y + 6); }
  x.strokeStyle = cssv("--blue"); x.lineWidth = 3; x.beginPath();
  good.forEach((p, i) => { const px = 50 + (p.t / T) * (W - 60), py = H - ((p.bpm - lo) / (hi - lo)) * (H - 20) - 10; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
}

// The HALO agent (teammate's FastAPI service) scores the scan against this crew member's own baseline. Simulated runs are never sent.
async function sendToAgent(record) {
  const el = $("agentmsg");
  if (state.simulated || !CONFIG.AGENT_URL) { el.hidden = true; return; }
  el.hidden = false; el.textContent = "Sending to the HALO agent...";
  const crewId = params.get("crew") || CONFIG.AGENT_CREW || "LIVE_01";
  try {
    const r = await fetch(`${CONFIG.AGENT_URL.replace(/\/$/, "")}/api/v1/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ crew_id: crewId, record }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) { el.textContent = `The HALO agent did not accept the scan (answer ${r.status}).`; return; }
    el.textContent = `The HALO agent has this check, filed under ${j?.crew_id ?? crewId}.${j?.duplicate ? " It already had it." : ""}`;
    // What the agent makes of it: its own status for this crew member, how far their personal baseline has got, and what it could not use.
    const sc = j?.score || {}, bb = sc.baseline_building, notes = [];
    $("agentchip").textContent = bb?.label ? `Agent: ${bb.label}` : `Agent status: ${sc.status ?? "not available"}`;
    if (bb?.label) notes.push("The agent compares you with your own earlier checks. It needs three before it can call a reading unusual.");
    for (const [k, why] of Object.entries(j?.reading?.scan_context?.excluded || {})) notes.push(`${k.replace(/_/g, " ")} was not used: ${why}.`);
    notes.push("Blood oxygen, blood pressure and temperature are not measured by a camera and stay blank.");
    $("agentnotes").replaceChildren(...notes.map((t) => Object.assign(document.createElement("li"), { textContent: t, className: "note" })));
    const q = `?crew=${encodeURIComponent(j?.crew_id ?? crewId)}`; $("consolelink").href = `../console.html${q}`; $("helplink").href = `../console.html${q}&sos=1`;
    $("agentbox").hidden = false;
  } catch { el.textContent = "The HALO agent could not be reached. Your results are still saved."; }
}
async function save(record) {
  const el = $("saved");
  if (state.simulated) { el.textContent = "Simulated run: nothing was saved."; return; }
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) { el.textContent = "Not saved: no database is configured. Use the download buttons."; return; }
  try {
    const r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/scans`, { method: "POST", headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(record) });
    el.textContent = r.ok ? "Saved to the HALO database." : `Not saved (database answered ${r.status}). Use the download buttons.`;
  } catch { el.textContent = "Not saved (no connection). Use the download buttons."; }
}

if (params.get("demo") === "tests") { show("game"); runTests(); }        // lets the team try the tests without a camera

// ------------------------------------------------------------------ ?demo=scan : drive the scan screen with test signals (no camera, clearly labelled as simulated)
if (params.get("demo") === "scan") {
  state.simulated = true; settings.keepCamera = false; mode = { ...mode, scan: 20 }; show("scan"); setStatus("Simulated input: test signals, not a person.");
  ["camera", "tracker", "face", "light", "still"].forEach((k) => ui.step(k, "ok")); $("rec").hidden = false; $("rec").textContent = "SIMULATED"; ui.log("Simulated scan started");
  let t = 0, lastSec = -1; const noise = () => (Math.random() - 0.5) * 0.4;
  const iv = setInterval(() => {
    for (let k = 0; k < 3; k++, t += 1 / 30) {
      const p = Math.sin(2 * Math.PI * 1.2 * t), smp = { t, r: 150 + 0.15 * p + noise(), g: 110 + 0.6 * p + noise(), b: 90 + 0.27 * p + noise() };
      for (const r of ["all", "forehead", "left", "right"]) state.roi[r].push({ ...smp });
      const closed = t % 4 > 3.8 ? 0.9 : 0.05; state.blinkT.push(t); state.blinkC.push(closed); state.jaw.push(0.05); state.frameT.push(t); state.light.push(130); state.faceFrac.push(0.4); state.faceFrames++; state.lastT = t;
      state.expr.push({ t, smile: t > 8 && t < 13 ? 0.6 : 0.05, frown: 0.02, furrow: 0.05, raise: 0.05, press: 0.05, squint: 0.1, wide: 0.05, jaw: 0.05 });
      state.headT.push(t); state.headY.push(500 + 2 * Math.sin(2 * Math.PI * 0.25 * t) + noise());
      if (closed >= 0.5 && !live.closed) live.blinks++; live.closed = closed >= 0.5;
      if (Math.round(t * 30) % 3 === 0) { state.chestT.push(t); state.chestD.push(1.5 * Math.sin(2 * Math.PI * 0.25 * t) + noise()); }
    }
    ui.ring(t / mode.scan, Math.ceil(mode.scan - t)); if (Math.floor(t) !== lastSec) { lastSec = Math.floor(t); ui.live(t); }
    if (t >= mode.scan) { clearInterval(iv); ui.log("Scan complete"); state.phase = "tests"; state.tScanEnd = t; show("game"); runTests(); }
  }, 100);
}
