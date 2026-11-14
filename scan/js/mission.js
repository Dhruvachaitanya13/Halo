// HALO docking mission: the thinking tests, played as one short spaceflight.
// Based on the four rounds of Kavya's "MissionPulse - Daily Dock" (reaction, go/no-go attention, control, sequence memory),
// rebuilt for touch and keyboard on one canvas.
//
// What is measured is kept apart from what is only for fun:
//   measured  -> the raw trial data returned by runMission() (reaction times, taps, tracking error, recalled sequences)
//   for fun   -> points, streaks, sounds, particles. They never feed the health results.
// Cues are visual only. Sounds play as feedback after a response, never with a cue, so they cannot speed up a reaction time.

const W = 360, H = 460, CX = 180, CY = 235;                 // logical drawing size; the canvas scales to the screen
const C = { bg0: "#04060c", bg1: "#0b1322", ink: "#eef2f7", dim: "#8b97ad", cyan: "#6fd3ff", green: "#4be0a0", amber: "#ffc266", red: "#ff6b5e", hull: "#c9d2e0", panel: "#2b4a7a" };
const STAGES = {
  reaction: { name: "Ignition", tag: "REACTION", help: ["The ring around the station is amber.", "The moment it turns green, tap.", "Do not tap early."] },
  gonogo:   { name: "Debris field", tag: "ATTENTION", help: ["Supply pods are blue diamonds: tap to grab them.", "Debris is a red rock: leave it alone.", "Each one is only there for a second."] },
  docking:  { name: "Final approach", tag: "CONTROL", help: ["The docking port drifts.", "Drag anywhere to steer the crosshair onto it", "and hold it there until contact."] },
  memory:   { name: "Clearance code", tag: "MEMORY", help: ["The station flashes its ports in order.", "Tap them back in the same order.", "The code gets longer each time."] },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const PORTS = Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return { x: CX + 112 * Math.cos(a), y: CY + 112 * Math.sin(a) }; });
const TONES = [262, 330, 392, 494, 587, 698];

export function runMission(canvas, { stages, trials = 6, dockSeconds = 25, muted = () => false, onStage = () => {}, debug = false } = {}) {
  const ctx = canvas.getContext("2d");
  const S = { mode: "idle", stage: -1, points: 0, streak: 0, best: 0, warp: 0.25, dist: 400, shake: 0, cue: "", label: "", obj: null, lit: -1, pressed: -1, portsOn: false,
              cross: { x: 0.5, y: 0.5 }, target: { x: 0.5, y: 0.5 }, lock: 0, k: 0, t0: null, distTo: 0, onTap: null, onPort: null, goAt: null, flash: 0, flashCol: C.green, count: 0, stick: null };
  if (debug) window.__halo = S;
  const stars = Array.from({ length: 90 }, () => ({ x: rand(-1, 1), y: rand(-1, 1), z: rand(0.05, 1) })), parts = [], floats = [], keys = new Set();
  let raf = 0, last = performance.now(), alive = true, audio = null, pointer = null;

  // ---------------------------------------------------------------- sound and touch feedback (after a response only)
  const beep = (freq, ms = 90, type = "sine", vol = 0.06) => {
    if (muted()) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(); o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
      o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
    } catch {}
  };
  const buzz = (p) => { try { navigator.vibrate?.(p); } catch {} };
  const good = (pts, text, x = CX, y = CY - 70) => { S.streak++; S.best = Math.max(S.best, S.streak); const total = pts + 10 * Math.min(S.streak - 1, 5); S.points += total; floats.push({ x, y, text, col: C.green, t: 0 }); floats.push({ x, y: y + 22, text: `+${total}`, col: C.ink, t: 0, small: true }); S.flash = 1; S.flashCol = C.green; beep(660, 80); setTimeout(() => beep(880, 110), 70); buzz(15); };
  const bad = (text, x = CX, y = CY - 70) => { S.streak = 0; floats.push({ x, y, text, col: C.red, t: 0 }); S.shake = 1; S.flash = 1; S.flashCol = C.red; beep(150, 220, "sawtooth", 0.05); buzz([40, 40, 40]); };
  const note = (text, col = C.dim, x = CX, y = CY - 70) => floats.push({ x, y, text, col, t: 0 });
  const burst = (x, y, col, n = 18) => { for (let i = 0; i < n; i++) { const a = rand(0, 6.283), v = rand(40, 190); parts.push({ x, y, vx: v * Math.cos(a), vy: v * Math.sin(a), t: 0, life: rand(0.35, 0.8), col }); } };

  // ---------------------------------------------------------------- input: tap or Space, drag or arrows, ports or 1-6
  const toLogical = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const tap = (p) => {
    if (S.onPort && p) { const i = PORTS.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= 40); if (i >= 0) return S.onPort(i); return; }
    if (S.onTap) S.onTap(p);
  };
  const down = (e) => { e.preventDefault(); try { canvas.setPointerCapture?.(e.pointerId); } catch {} const p = toLogical(e); pointer = { ...p, type: e.pointerType };
    if (S.mode === "docking" && e.pointerType !== "mouse") S.stick = { x: p.x, y: p.y }; else if (S.mode === "docking") { S.cross.x = p.x / W; S.cross.y = (p.y - 50) / W; } tap(p); };
  const move = (e) => {
    if (S.mode !== "docking") return; const p = toLogical(e);
    if (e.pointerType === "mouse") { S.cross.x = p.x / W; S.cross.y = (p.y - 50) / W; }                       // mouse: the crosshair follows the pointer
    else if (pointer) { S.cross.x += ((p.x - pointer.x) / W) * 1.25; S.cross.y += ((p.y - pointer.y) / W) * 1.25; }   // touch: drag like a trackpad, so the finger never hides the target
    S.cross.x = Math.min(1, Math.max(0, S.cross.x)); S.cross.y = Math.min(1, Math.max(0, S.cross.y)); pointer = { ...p, type: e.pointerType }; e.preventDefault();
  };
  const up = () => { pointer = null; S.stick = null; };
  const keydown = (e) => {
    if (e.target.matches?.("input,select,textarea")) return;
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); if (!e.repeat && !S.onPort) tap(null); }
    else if (/^Arrow|^Key[WASD]$/.test(e.code)) { if (S.mode === "docking") e.preventDefault(); keys.add(e.code); }
    else if (/^(Digit|Numpad)[1-6]$/.test(e.code) && S.onPort && !e.repeat) S.onPort(Number(e.code.slice(-1)) - 1);
  };
  const keyup = (e) => keys.delete(e.code);
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  document.addEventListener("keydown", keydown); document.addEventListener("keyup", keyup);

  // ---------------------------------------------------------------- drawing
  const fit = () => { const r = canvas.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.max(1, Math.round(r.width * d)); canvas.height = Math.max(1, Math.round(r.height * d)); };
  const text = (s, x, y, { size = 14, col = C.ink, align = "center", weight = 600, mono = false, alpha = 1 } = {}) => {
    ctx.globalAlpha = alpha; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.font = `${weight} ${size}px ${mono ? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'}`; ctx.fillText(s, x, y); ctx.globalAlpha = 1;
  };
  const station = (x, y, s, portCol) => {                                            // a small station: truss, two solar wings, hub, docking port
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = C.hull; ctx.fillRect(-92, -3, 184, 6);
    for (const sx of [-1, 1]) { ctx.fillStyle = C.panel; ctx.fillRect(sx * 58 - 26, -34, 52, 26); ctx.fillRect(sx * 58 - 26, 8, 52, 26); ctx.strokeStyle = "#5f86c4"; ctx.lineWidth = 1; for (let i = -13; i <= 13; i += 13) { ctx.beginPath(); ctx.moveTo(sx * 58 + i, -34); ctx.lineTo(sx * 58 + i, -8); ctx.moveTo(sx * 58 + i, 8); ctx.lineTo(sx * 58 + i, 34); ctx.stroke(); } }
    ctx.fillStyle = "#dfe6f0"; ctx.beginPath(); ctx.arc(0, 0, 24, 0, 6.283); ctx.fill();
    ctx.fillStyle = "#101826"; ctx.beginPath(); ctx.arc(0, 0, 13, 0, 6.283); ctx.fill();
    ctx.strokeStyle = portCol; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 13, 0, 6.283); ctx.stroke();
    ctx.restore();
  };
  const ring = (x, y, r, col, lw = 3, dash = null, a0 = 0, a1 = 6.2832) => { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash(dash || []); ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke(); ctx.setLineDash([]); };
  const pill = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, h / 2) : ctx.rect(x, y, w, h); ctx.fill(); };

  const draw = (now, dt) => {
    const sc = canvas.width / W; ctx.setTransform(sc, 0, 0, sc, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, C.bg0); g.addColorStop(1, C.bg1); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (S.shake > 0.01) { ctx.translate(rand(-5, 5) * S.shake, rand(-5, 5) * S.shake); S.shake *= Math.pow(0.002, dt); }
    for (const s of stars) {                                                          // stars stream outward from the centre; faster means more speed
      s.z -= dt * S.warp * 0.5; if (s.z <= 0.03) { s.x = rand(-1, 1); s.y = rand(-1, 1); s.z = 1; }
      const px = CX + (s.x / s.z) * 150, py = CY + (s.y / s.z) * 150, r = Math.max(0.4, (1 - s.z) * 1.9);
      if (px < 0 || px > W || py < 0 || py > H) { s.z = 0; continue; }
      ctx.globalAlpha = Math.min(1, 1.25 - s.z); ctx.fillStyle = "#cfe0ff"; ctx.fillRect(px, py, r, r);
    }
    ctx.globalAlpha = 1;
    const t = now / 1000, prog = 1 - S.dist / 400, baseScale = 0.42 + 0.5 * prog;

    if (S.mode === "reaction") {
      station(CX, CY, baseScale, S.cue === "go" ? C.green : C.amber);
      const pulse = 1 + 0.04 * Math.sin(t * 4), col = S.cue === "go" ? C.green : S.cue === "early" ? C.red : C.amber;
      if (S.cue === "go") { if (S.goAt === null) S.goAt = performance.now(); ctx.fillStyle = "rgba(75,224,160,.16)"; ctx.beginPath(); ctx.arc(CX, CY, 118, 0, 6.283); ctx.fill(); ring(CX, CY, 118, col, 7); text("FIRE", CX, CY + 150, { size: 30, weight: 800, col }); }
      else { ring(CX, CY, 118 * pulse, col, 3, [10, 9]); text(S.cue === "early" ? "TOO EARLY" : "HOLD", CX, CY + 150, { size: 18, weight: 700, col, mono: true }); }
    } else if (S.mode === "gonogo") {
      station(CX, CY - 150, baseScale * 0.55, C.dim);
      const o = S.obj;
      if (o) {
        if (o.shown === null) o.shown = performance.now();
        const age = (performance.now() - o.shown) / o.life, sz = 26 + 30 * Math.min(1, age);
        ctx.save(); ctx.translate(o.x, o.y + 24 * age);
        if (o.state === "caught") { ctx.globalAlpha = Math.max(0, 1 - (performance.now() - o.at) / 250); ctx.scale(1.3, 1.3); }
        if (o.state === "hit") ctx.rotate(0.3 * Math.sin(t * 40));
        if (o.type === "go") {
          ctx.rotate(Math.PI / 4); ctx.fillStyle = "#123a52"; ctx.strokeStyle = C.cyan; ctx.lineWidth = 3; ctx.fillRect(-sz / 2, -sz / 2, sz, sz); ctx.strokeRect(-sz / 2, -sz / 2, sz, sz); ctx.rotate(-Math.PI / 4);
          ctx.fillStyle = C.cyan; ctx.fillRect(-sz * 0.22, -2, sz * 0.44, 4); ctx.fillRect(-2, -sz * 0.22, 4, sz * 0.44);
        } else {
          ctx.fillStyle = "#4a211d"; ctx.strokeStyle = C.red; ctx.lineWidth = 3; ctx.beginPath();
          for (let i = 0; i < 9; i++) { const a = (i / 9) * 6.283 + o.spin + t * 0.8, r = (sz / 1.6) * (0.78 + 0.22 * Math.sin(i * 2.7 + o.spin * 5)); i ? ctx.lineTo(r * Math.cos(a), r * Math.sin(a)) : ctx.moveTo(r * Math.cos(a), r * Math.sin(a)); }
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.restore(); ctx.globalAlpha = 1;
        if (o.state === "live") text(o.type === "go" ? "SUPPLY POD" : "DEBRIS", o.x, o.y + 78, { size: 12, mono: true, weight: 700, col: o.type === "go" ? C.cyan : C.red });
      } else { ring(CX, CY, 7, C.dim, 2); }
      ctx.fillStyle = C.hull; ctx.beginPath(); ctx.moveTo(CX, H - 74); ctx.lineTo(CX - 15, H - 44); ctx.lineTo(CX + 15, H - 44); ctx.closePath(); ctx.fill();     // the capsule
    } else if (S.mode === "docking") {
      const tx = S.target.x * W, ty = 50 + S.target.y * W, cx = S.cross.x * W, cy = 50 + S.cross.y * W, locked = S.lock > 0;
      station(tx, ty, 0.5 + 0.75 * S.k, locked ? C.green : C.amber);
      ring(tx, ty, 0.08 * W, locked ? C.green : C.amber, 2.5, locked ? null : [7, 6]);
      ctx.strokeStyle = C.cyan; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 6, cy); ctx.moveTo(cx + 6, cy); ctx.lineTo(cx + 20, cy); ctx.moveTo(cx, cy - 20); ctx.lineTo(cx, cy - 6); ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 20); ctx.stroke(); ring(cx, cy, 3, C.cyan, 2);
      if (!locked) { ctx.globalAlpha = 0.35; ctx.strokeStyle = C.cyan; ctx.lineWidth = 1; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
      pill(60, H - 62, 240, 8, "rgba(255,255,255,.12)"); pill(60, H - 62, Math.max(8, 240 * S.k), 8, locked ? C.green : C.amber);                                   // approach progress
      text(locked ? "ALIGNED" : "ALIGN", CX, H - 80, { size: 13, mono: true, weight: 700, col: locked ? C.green : C.amber });
      if (S.stick && pointer) { ring(S.stick.x, S.stick.y, 26, "rgba(255,255,255,.25)", 2); ctx.fillStyle = "rgba(111,211,255,.5)"; ctx.beginPath(); ctx.arc(pointer.x, pointer.y, 12, 0, 6.283); ctx.fill(); }
    } else if (S.mode === "memory") {
      ring(CX, CY, 112, "rgba(255,255,255,.14)", 2); ctx.fillStyle = "#101826"; ctx.beginPath(); ctx.arc(CX, CY, 46, 0, 6.283); ctx.fill(); ring(CX, CY, 46, S.cue === "ok" ? C.green : S.cue === "no" ? C.red : C.dim, 3);
      text(S.cue === "watch" ? "WATCH" : S.cue === "ok" ? "CLEARED" : S.cue === "no" ? "DENIED" : "ENTER", CX, CY - 7, { size: 13, mono: true, weight: 700, col: S.cue === "ok" ? C.green : S.cue === "no" ? C.red : C.ink });
      text(S.codeText || "", CX, CY + 12, { size: 12, mono: true, col: C.dim });
      PORTS.forEach((p, i) => {
        const lit = S.lit === i, pr = S.pressed === i;
        ctx.fillStyle = lit ? C.cyan : pr ? "#2b5f7d" : "#13202f"; ctx.beginPath(); ctx.arc(p.x, p.y, lit ? 37 : 33, 0, 6.283); ctx.fill();
        if (lit) { ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(p.x, p.y, 48, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1; }
        ring(p.x, p.y, lit ? 37 : 33, lit ? "#fff" : S.portsOn ? C.cyan : "rgba(255,255,255,.25)", 2);
        text(String(i + 1), p.x, p.y + 1, { size: 17, mono: true, weight: 700, col: lit ? "#04202c" : S.portsOn ? C.ink : C.dim });
      });
    } else station(CX, CY - (S.mode === "brief" || S.mode === "count" ? 108 : 40), baseScale * (S.mode === "done" ? 1.25 : 0.8), S.mode === "done" ? C.green : C.amber);

    if (S.mode === "brief") {
      const st = STAGES[stages[S.stage]];
      text(`STAGE ${S.stage + 1} OF ${stages.length}  /  ${st.tag}`, CX, 212, { size: 11, mono: true, weight: 700, col: C.cyan });
      text(st.name, CX, 242, { size: 30, weight: 800 });
      st.help.forEach((l, i) => text(l, CX, 282 + i * 21, { size: 13.5, weight: 500, col: "#c5cedd" }));
      const a = 0.75 + 0.25 * Math.sin(t * 4); pill(CX - 92, 372, 184, 46, `rgba(111,211,255,${a})`); text("TAP TO START", CX, 395.5, { size: 14, mono: true, weight: 800, col: "#04202c" });
      text("or press Space", CX, 434, { size: 11, col: C.dim, weight: 500 });
    } else if (S.mode === "count") { text(String(S.count), CX, 300, { size: 84, weight: 800, col: C.ink }); text("GET READY", CX, 362, { size: 12, mono: true, weight: 700, col: C.dim }); }
    else if (S.mode === "done") {
      text("DOCKED", CX, 300, { size: 34, weight: 800, col: C.green }); text("Mission complete", CX, 334, { size: 15, weight: 500, col: "#c5cedd" });
      text(`${S.points} pts`, CX, 372, { size: 24, mono: true, weight: 700 }); text(`best streak ${S.best}`, CX, 400, { size: 11, mono: true, col: C.dim });
    }

    for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.t += dt; if (p.t > p.life) { parts.splice(i, 1); continue; } p.x += p.vx * dt; p.y += p.vy * dt; ctx.globalAlpha = 1 - p.t / p.life; ctx.fillStyle = p.col; ctx.fillRect(p.x, p.y, 3, 3); }
    ctx.globalAlpha = 1;
    for (let i = floats.length - 1; i >= 0; i--) { const f = floats[i]; f.t += dt; if (f.t > 1.1) { floats.splice(i, 1); continue; } text(f.text, f.x, f.y - 34 * f.t, { size: f.small ? 13 : 20, weight: 800, mono: f.small, col: f.col, alpha: Math.min(1, 2.2 - 2 * f.t) }); }
    if (S.flash > 0.02) { ctx.globalAlpha = 0.22 * S.flash; ctx.strokeStyle = S.flashCol; ctx.lineWidth = 14; ctx.strokeRect(0, 0, W, H); ctx.globalAlpha = 1; S.flash *= Math.pow(0.004, dt); }

    // heads-up display
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    stages.forEach((_, i) => pill(14 + i * 22, 16, 17, 5, i < S.stage || S.mode === "done" ? C.green : i === S.stage ? C.cyan : "rgba(255,255,255,.2)"));
    if (S.stage >= 0 && S.mode !== "brief" && S.mode !== "done") text(STAGES[stages[S.stage]].name.toUpperCase(), 14, 36, { size: 11, mono: true, weight: 700, align: "left", col: C.dim });
    text(`${S.points}`, W - 14, 20, { size: 17, mono: true, weight: 700, align: "right" }); text(S.streak > 1 ? `STREAK x${S.streak}` : "POINTS", W - 14, 38, { size: 9.5, mono: true, weight: 700, align: "right", col: S.streak > 1 ? C.green : C.dim });
    text(`${Math.round(S.dist)} m`, CX, 20, { size: 12, mono: true, weight: 700, col: C.dim });
    if (S.label && S.mode !== "brief" && S.mode !== "count" && S.mode !== "done") text(S.label, CX, H - 20, { size: 12, mono: true, weight: 600, col: C.dim });
  };

  const update = (now, dt) => {
    if (S.mode !== "docking" || S.t0 === null) return;
    const t = (now - S.t0) / 1000, k = Math.min(1, t / dockSeconds), amp = 0.3 * (1 - 0.6 * k), ph = S.ph;                                  // drift settles as the capsule closes in
    S.k = k; S.target.x = 0.5 + amp * (0.6 * Math.sin(0.9 * t + ph[0]) + 0.4 * Math.sin(2.3 * t + ph[1])); S.target.y = 0.5 + amp * (0.6 * Math.cos(0.7 * t + ph[2]) + 0.4 * Math.sin(1.9 * t + ph[3]));
    const v = 0.55 * dt, kx = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0), ky = (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0) - (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0);
    S.cross.x = Math.min(1, Math.max(0, S.cross.x + kx * v)); S.cross.y = Math.min(1, Math.max(0, S.cross.y + ky * v));
    const err = Math.hypot(S.cross.x - S.target.x, S.cross.y - S.target.y), on = err <= 0.08;
    if (t > 1 && t <= dockSeconds) S.samples.push({ t, err });
    if (on) { S.lock += dt; S.lockPts += dt * 20; if (S.lockPts >= 20) { S.points += 20; S.lockPts -= 20; } } else S.lock = 0;
    S.dist = S.distFrom - (S.distFrom - S.distTo) * k; S.label = `${Math.max(0, Math.ceil(dockSeconds - t))} s to contact`;
    if (t >= dockSeconds && S.dockDone) { const d = S.dockDone; S.dockDone = null; d(); }
  };
  const loop = (now) => { if (!alive) return; const dt = Math.min(0.05, (now - last) / 1000); last = now; update(now, dt); try { draw(now, dt); } catch {} raf = requestAnimationFrame(loop); };

  // ---------------------------------------------------------------- stage scripts
  const flyTo = async (dist, ms = 700) => { const from = S.dist, t0 = performance.now(); S.warp = 2.2; while (performance.now() - t0 < ms) { S.dist = from + (dist - from) * ((performance.now() - t0) / ms); await sleep(30); } S.dist = dist; S.warp = 0.25; };
  const brief = async (i) => {
    S.stage = i; S.mode = "brief"; S.label = ""; const st = STAGES[stages[i]]; onStage(st.name, st.help.join(" "));
    await new Promise((res) => { S.onTap = () => { S.onTap = null; res(); }; }); beep(520, 70);
    S.mode = "count"; for (S.count = 3; S.count > 0; S.count--) { beep(440, 60); await sleep(650); }
  };

  const reaction = async () => {
    const rts = []; let falseStarts = 0, misses = 0, n = 0, tries = 0; S.mode = "reaction";
    while (n < trials && tries < trials + 10) {
      tries++; S.cue = "hold"; S.goAt = null; S.label = `Burn ${n + 1} of ${trials}`;
      const r = await new Promise((res) => {
        let missT = null;
        const goT = setTimeout(() => { S.goAt = null; S.cue = "go"; S.onTap = () => { clearTimeout(missT); res({ rt: performance.now() - (S.goAt ?? performance.now()) }); }; missT = setTimeout(() => res({ miss: true }), 1500); }, rand(1500, 4000));
        S.onTap = () => { clearTimeout(goT); res({ early: true }); };
      });
      S.onTap = null;
      if (r.early) { falseStarts++; S.cue = "early"; bad("Too early"); await sleep(900); continue; }
      S.cue = "hold"; n++;
      if (r.miss) { misses++; bad("Missed"); await sleep(700); continue; }
      rts.push(r.rt); burst(CX, CY, C.green, 26); S.warp = 3; setTimeout(() => (S.warp = 0.25), 350);
      good(Math.max(20, Math.round((650 - r.rt) / 2)), `${Math.round(r.rt)} ms`); note(r.rt < 260 ? "Lightning" : r.rt < 350 ? "Sharp" : r.rt < 500 ? "Good" : "Slow", C.dim, CX, CY + 96); await sleep(800);
    }
    return { rts, falseStarts, misses };
  };

  const gonogo = async () => {
    const total = trials * 2, nNo = Math.max(2, Math.round(total * 0.3)), types = Array.from({ length: total }, (_, i) => (i < nNo ? "nogo" : "go")), out = [];
    for (let i = total - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [types[i], types[j]] = [types[j], types[i]]; }
    S.mode = "gonogo"; S.warp = 0.9;
    for (let i = 0; i < total; i++) {
      S.obj = null; S.label = `Contact ${i + 1} of ${total}`; await sleep(rand(600, 1200));
      const type = types[i], o = (S.obj = { type, x: CX + rand(-70, 70), y: CY - 40 + rand(-30, 30), life: 1000, shown: null, state: "live", spin: rand(0, 6), at: 0 }); let rt = null;
      S.onTap = () => { if (rt !== null) return; rt = performance.now() - (o.shown ?? performance.now()); o.at = performance.now();
        if (type === "go") { o.state = "caught"; burst(o.x, o.y, C.cyan); good(50, "Pod secured", o.x, o.y - 50); } else { o.state = "hit"; burst(o.x, o.y, C.red, 24); bad("Hull strike", o.x, o.y - 50); } };
      await sleep(1000); S.onTap = null;
      if (rt === null) { if (type === "go") { S.streak = 0; note("Pod lost", C.amber, o.x, o.y - 50); beep(220, 120, "triangle", 0.04); } else { S.points += 30; S.streak++; S.best = Math.max(S.best, S.streak); note("Clear  +30", C.green, o.x, o.y - 50); } }
      out.push({ type, responded: rt !== null, rt });
    }
    S.obj = null; S.warp = 0.25; return { trials: out };
  };

  const docking = async () => {
    S.samples = []; S.ph = [0, 1, 2, 3].map(() => rand(0, 6.283)); S.cross = { x: 0.5, y: 0.5 }; S.lock = 0; S.lockPts = 0; S.k = 0; S.distFrom = S.dist; S.t0 = performance.now(); S.mode = "docking"; S.warp = 0.5;
    await new Promise((res) => (S.dockDone = res));
    const samples = S.samples, tail = samples.slice(-Math.max(3, Math.round(samples.length * 0.1))), docked = tail.length && tail.reduce((s, v) => s + v.err, 0) / tail.length <= 0.08;
    S.t0 = null; S.warp = 0.25; if (docked) { burst(S.target.x * W, 50 + S.target.y * W, C.green, 40); good(200, "Soft capture"); } else bad("Hard contact"); await sleep(900);
    return { samples };
  };

  const memory = async () => {
    const attempts = []; let len = 3, fails = 0; S.mode = "memory"; S.lit = -1; S.pressed = -1;
    while (len <= 7 && fails < 2) {
      const seq = []; while (seq.length < len) { const v = Math.floor(Math.random() * 6); if (v !== seq[seq.length - 1]) seq.push(v); }
      S.cue = "watch"; S.portsOn = false; S.codeText = `${len} ports`; S.label = "Watch the order"; if (debug) S.seq = seq; await sleep(700);
      for (const i of seq) { S.lit = i; beep(TONES[i], 300, "sine", 0.05); await sleep(450); S.lit = -1; await sleep(200); }
      S.cue = "enter"; S.portsOn = true; S.label = "Your turn"; let k = 0; S.codeText = "0 / " + len;
      const correct = await new Promise((res) => {
        const to = setTimeout(() => res(false), 15000);
        S.onPort = (i) => { S.pressed = i; beep(TONES[i], 120, "sine", 0.05); setTimeout(() => { if (S.pressed === i) S.pressed = -1; }, 160);
          if (i !== seq[k]) { clearTimeout(to); return res(false); } k++; S.codeText = `${k} / ${len}`; if (k === seq.length) { clearTimeout(to); res(true); } };
      });
      S.onPort = null; S.portsOn = false; attempts.push({ length: len, correct });
      if (correct) { S.cue = "ok"; good(60 * len, "Code accepted"); len++; fails = 0; } else { S.cue = "no"; bad("Wrong code"); fails++; }
      await sleep(900);
    }
    S.lit = -1; return { attempts };
  };

  // ---------------------------------------------------------------- run the stages in order
  const SCRIPT = { reaction, gonogo, docking, memory };
  return (async () => {
    fit(); window.addEventListener("resize", fit); raf = requestAnimationFrame(loop);
    const out = {};
    try {
      for (let i = 0; i < stages.length; i++) {
        await brief(i);
        S.distTo = 400 - (400 * (i + 1)) / stages.length;
        if (stages[i] !== "docking") await flyTo(400 - (400 * (i + 0.5)) / stages.length, 500);
        out[stages[i]] = await SCRIPT[stages[i]]();
        if (stages[i] !== "docking") await flyTo(S.distTo); else S.dist = S.distTo;
      }
      S.dist = 0; S.mode = "done"; S.label = ""; burst(CX, CY - 40, C.green, 50); beep(523, 120); setTimeout(() => beep(659, 120), 120); setTimeout(() => beep(784, 220), 240); await sleep(2600);
    } finally {
      alive = false; cancelAnimationFrame(raf); window.removeEventListener("resize", fit);
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", up);
      document.removeEventListener("keydown", keydown); document.removeEventListener("keyup", keyup); try { audio?.close(); } catch {}
    }
    return { ...out, points: S.points, best_streak: S.best };
  })();
}
