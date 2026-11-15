// HALO voice: speech in and out for the crew console, using the browser's own speech engines (Web Speech API).
// No server, no key, no cost. Speech output also works with no network; speech input depends on the browser
// (Chrome and Safari have it, Firefox on Android does not), so every action also has a button.
//
// What the voice may do is deliberately narrow: read out checklist steps and data the agent returned, and turn a few
// spoken words into the same actions the buttons send. It never composes medical advice of its own.

/** Spoken reply to a checklist step -> the action the buttons would send, or a console command. Pure function. */
export function parseCommand(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  const has = (...words) => words.some((w) => t.includes(" " + w + " "));
  if (t.trim() === "") return { kind: "none" };
  if (has("stop listening", "stop voice", "be quiet", "mute")) return { kind: "stop" };
  if (has("repeat", "say again", "say that again", "again", "pardon", "what was that")) return { kind: "repeat" };
  if (has("resolved", "end checklist", "end the checklist", "we are okay now", "all clear")) return { kind: "end", outcome: "resolved" };
  if (has("hand off", "handed off", "hand over", "handover")) return { kind: "end", outcome: "handed_off" };
  // "changed" comes before "done": "it's done but he got worse" must not be read as done
  if (has("changed", "condition changed", "worse", "getting worse", "not breathing", "no pulse", "unresponsive", "stopped breathing", "collapsed")) return { kind: "step", action: "condition_changed" };
  if (has("can't", "cant", "cannot", "can not", "unable", "not able", "impossible", "couldn't", "don't have", "do not have")) return { kind: "step", action: "cannot_do" };
  if (has("skip", "skip it", "skip this", "next one")) return { kind: "step", action: "skip" };
  if (has("why", "what does", "what is", "what's", "how do", "how should", "how long", "explain", "where", "which")) return { kind: "ask", question: String(text).trim() };
  if (has("done", "did it", "finished", "complete", "completed", "okay", "ok", "yes", "yep", "yeah", "next", "continue", "got it", "they are", "he is", "she is")) return { kind: "step", action: "done" };
  return { kind: "unknown" };
}

/** A spoken description of the emergency -> one of the agent's checklists. Keyword match only; the console says which
 *  checklist it chose and the crew member can switch. Anything unclear goes to the general checklist ("other"). */
export function pickSymptom(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ") + " ";
  const has = (...words) => words.some((w) => t.includes(w));
  if (has("chest", "heart attack", "heart hurts", "tightness")) return "chest_pain";
  if (has("breath", "choking", "can't breathe", "cant breathe", "suffocat", "wheez", "airway")) return "breathing_difficulty";
  if (has("faint", "passed out", "pass out", "unconscious", "blacked out", "collapsed", "dizzy", "not responding")) return "fainting";
  if (has("bleed", "blood", "cut ", "wound", "injur", "laceration", "gash")) return "bleeding_injury";
  return "other";
}

/** True when the words are a request to start an SOS ("help", "emergency", "sos", or a description of a problem). */
export function isHelpRequest(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  return /\b(help|emergency|sos|mayday|something is wrong|something's wrong)\b/.test(t) || pickSymptom(text) !== "other";
}

/** Browser speech, wrapped. `onState` receives "idle" | "speaking" | "listening" | "unsupported". */
export function createVoice({ onHeard = () => {}, onInterim = () => {}, onState = () => {}, lang = "en-US" } = {}) {
  const w = typeof window === "undefined" ? {} : window, SR = w.SpeechRecognition || w.webkitSpeechRecognition, synth = w.speechSynthesis;
  let rec = null, listening = false, speaking = false, enabled = true, handsFree = false, lastText = "", turn = 0;
  const set = () => onState(speaking ? "speaking" : listening ? "listening" : "idle");

  function listen() {
    if (!SR || listening || speaking) return false;
    try {
      rec = new SR(); rec.lang = lang; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false; let final = "";
      rec.onresult = (e) => { let interim = ""; for (const r of e.results) { if (r.isFinal) final += r[0].transcript + " "; else interim += r[0].transcript; } onInterim((final + interim).trim()); };
      rec.onerror = (e) => { listening = false; set(); if (e.error === "not-allowed" || e.error === "service-not-allowed") onState("denied"); };
      const me = rec; let ended = false;                                  // deliver what was heard exactly once, even if the browser signals "end" twice
      rec.onend = () => { if (ended) return; ended = true; if (rec === me) rec = null; listening = false; set(); if (final.trim()) onHeard(final.trim()); };
      rec.start(); listening = true; set(); return true;
    } catch { listening = false; set(); return false; }
  }
  function stopListening() { const r = rec; rec = null; try { r?.abort(); } catch {} listening = false; set(); }

  /** Speak text. Listening is paused while speaking so the console never hears itself; with hands-free on it listens again afterwards. */
  function say(text, { then = null, force = false } = {}) {
    lastText = text;
    if (!synth || (!enabled && !force) || !text) { then?.(); if (handsFree) listen(); return; }
    stopListening(); try { synth.cancel(); } catch {}
    const u = new w.SpeechSynthesisUtterance(text); u.lang = lang; u.rate = 0.98; u.pitch = 1;
    const voices = synth.getVoices?.() || [], pick = voices.find((v) => v.lang === lang && /natural|enhanced|premium|samantha|google us english/i.test(v.name)) || voices.find((v) => v.lang === lang);
    if (pick) u.voice = pick;
    // Each utterance has its own number, so a late "finished" signal from an earlier one (or its safety timer) can never run again
    // and repeat that utterance's follow-up action.
    const mine = ++turn; let finished = false;
    const done = () => { if (finished || mine !== turn) return; finished = true; speaking = false; set(); then?.(); if (handsFree) setTimeout(() => { if (mine === turn) listen(); }, 250); };
    u.onend = done; u.onerror = done; speaking = true; set(); synth.speak(u);
    setTimeout(done, Math.min(30000, 2500 + text.length * 90));          // some browsers never fire onend; do not get stuck in "speaking"
  }
  function hush() { turn++; try { synth?.cancel(); } catch {} speaking = false; set(); }

  return {
    canListen: !!SR, canSpeak: !!synth, listen, stopListening, say, hush,
    repeat: () => say(lastText),
    setEnabled: (v) => { enabled = !!v; if (!enabled) hush(); }, isEnabled: () => enabled,
    setHandsFree: (v) => { handsFree = !!v; if (!handsFree) stopListening(); }, isHandsFree: () => handsFree,
    state: () => (speaking ? "speaking" : listening ? "listening" : "idle"),
  };
}
