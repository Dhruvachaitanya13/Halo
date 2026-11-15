"""HALO assistant: one brain behind three channels (the website chat, text messages and phone calls).

    reply(text, channel="web" | "sms" | "voice", sender="") -> {"text", "intent", "suggestions", "source"}

Standard library only. It answers from two places and nowhere else:
  - the HALO agent API (crew status, daily report, crew SOS checklists, questions about a step)
  - the HALO database (latest health checks, and the NASA reference tables: ISS radiation, space weather, Inspiration4 labs)

Rules it keeps:
  - Every number it says was read from one of those sources in that same request. If a source cannot be reached or has
    no value, it says so. It never estimates.
  - The NASA data is historical (May 2024) and the lab data is about other people; replies say that each time.
  - It does not diagnose or give treatment advice. Emergencies go to the agent's sourced checklists.
  - Which topic a message is about is decided by plain keyword rules, so the same words always get the same answer.
    Anything it does not recognise is passed to the agent's own question endpoint, then to a short menu.

Environment:
  HALO_AGENT_URL          the agent API (twilio_bridge.py reads the same variable)
  HALO_BRIDGE_CREW        crew an emergency or report is about when none is named (default LIVE_01 here)
  SUPABASE_URL, SUPABASE_KEY   database address and its PUBLIC (publishable) key; read-only tables only
"""
from __future__ import annotations

import json
import os
import re
import statistics
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

import twilio_bridge as bridge

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://fvbvplcdmpoifwjylgno.supabase.co").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_eO7f18_oGfyr2fKHBOkIOg_rrO8yshX")   # public key: can only read the public tables
DEFAULT_CREW = os.getenv("HALO_BRIDGE_CREW", "LIVE_01")
TIMEOUT_S = 6.0
LIMITS = {"sms": 300, "voice": 420, "web": 900}
MENU = ["Crew status", "Daily report", "My last check", "Radiation on 10 May", "Forecast on 10 May", "Space weather", "Emergency"]
NOT_ADVICE = "HALO is a prototype, not a medical device."


# ---------------------------------------------------------------- data access (each returns parsed JSON or raises)
def agent_get(path: str) -> dict:
    return bridge._call("GET", path)


def db(table: str, query: str) -> list:
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{table}?{query}", headers={"apikey": SUPABASE_KEY, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read().decode())


# ---------------------------------------------------------------- small helpers
def _norm(text: str) -> str:
    return " " + re.sub(r"[^a-z0-9' ]+", " ", (text or "").lower()).strip() + " "


def _has(t: str, *words: str) -> bool:
    return any((" " + w + " ") in t or (w.endswith("*") and (" " + w[:-1]) in t) for w in words)


def _num(v, unit: str = "", digits: int = 0) -> str:
    if v is None or v == "":
        return "not measured"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = f"{f:.{digits}f}" if digits else str(int(round(f)))
    return f"{s} {unit}".strip()


def _fit(text: str, channel: str) -> str:
    limit = LIMITS.get(channel, 900)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rsplit(" ", 1)[0] + "…"


def _crew_in(text: str) -> Optional[str]:
    m = re.search(r"\b((?:crew|live|sim)[_ ]?[a-z]*[_ ]?\d{1,3})\b", (text or "").lower())
    if not m:
        return None
    return re.sub(r"[ ]+", "_", m.group(1)).upper().replace("__", "_")


MONTH_DAY = re.compile(r"\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+may|may\s+(\d{1,2})(?:st|nd|rd|th)?)\b")


def _may_day(text: str, default: int = 10) -> int:
    m = MONTH_DAY.search((text or "").lower())
    d = int(m.group(1) or m.group(2)) if m else default
    return d if 1 <= d <= 30 else default


# ---------------------------------------------------------------- intents
def crew_status() -> str:
    crews = agent_get("/api/v1/crews").get("crews", [])
    if not crews:
        return "The agent has no crew members yet."
    words = {"normal": "normal", "caution": "caution", "alert": "alert"}
    parts = []
    for c in crews:
        if not c.get("readings"):
            parts.append(f"{c['crew_id']}: no readings yet")
            continue
        st = words.get(c.get("latest_status"), "no status")
        bb = (c.get("baseline_building") or {}).get("label")
        kind = "live camera checks" if c.get("source") == "live" else "demo data"
        parts.append(f"{c['crew_id']} ({kind}): {st}" + (f", {bb.lower()}" if bb and c.get("source") == "live" else ""))
    return "Crew status from the HALO agent. " + ". ".join(parts) + "."


def daily_report(crew: str) -> str:
    try:
        r = agent_get(f"/api/v1/crew/{urllib.parse.quote(crew)}/daily-report")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return f"There is no daily report for {crew} yet, because the agent has no readings for them."
        raise
    return f"Daily report for {crew}. " + (r.get("summary_text") or "The report has no summary.")


def last_check() -> str:
    rows = db("scan_feed", "select=*&order=created_at.desc&limit=1")
    if not rows:
        return "No health check has been saved in the last 48 hours."
    s = rows[0]
    when = str(s.get("created_at", ""))[:16].replace("T", " ")
    verdict = {"ready": "ready", "caution": "caution", "rest": "rest advised"}.get(s.get("verdict"), "no verdict")
    bits = [f"readiness {_num(s.get('readiness_score'))} out of 100" if s.get("readiness_score") is not None else "no readiness score",
            f"verdict {verdict}", f"heart rate {_num(s.get('heart_bpm'), 'beats a minute')}", f"breathing {_num(s.get('breathing_brpm'), 'a minute')}",
            f"reaction time {_num(s.get('reaction_median_ms'), 'milliseconds')}"]
    if s.get("sleep_hours") is not None:
        bits.append(f"sleep {_num(s.get('sleep_hours'), 'hours', 1)}")
    flags = s.get("flags") or []
    tail = f" Flagged: {'; '.join(flags[:2])}." if flags else " Nothing was flagged."
    return (f"The latest health check, saved {when} UTC: " + ", ".join(bits) + "." + tail +
            " Camera readings are experimental, and 'not measured' means the signal was too weak, not that it was normal.")


def radiation(day: int) -> str:
    d0, d1 = f"2024-05-{day:02d}T00:00:00Z", f"2024-05-{day + 1:02d}T00:00:00Z"
    rows = db("nasa_radiation", f"select=dose_rate_ugy_h,is_peak,dose_in_observed_bin_ugy,peak_threshold_ugy_h&timestamp=gte.{d0}&timestamp=lt.{d1}&order=timestamp")
    if not rows:
        return f"There is no radiation data for {day} May 2024. The data covers 1 to 30 May 2024."
    rates = [float(r["dose_rate_ugy_h"]) for r in rows]
    peaks = sum(1 for r in rows if r.get("is_peak"))
    total = sum(float(r.get("dose_in_observed_bin_ugy") or 0) for r in rows)
    thr = rows[0].get("peak_threshold_ugy_h")
    return (f"Historical NASA data, not live: ISS radiation on {day} May 2024, from {len(rows)} five-minute readings in the Columbus module. "
            f"Typical dose rate {statistics.median(rates):.1f} micrograys an hour, highest {max(rates):.0f}. "
            f"{peaks} readings were above the peak line of {_num(thr, digits=1)}, which is a statistical line, not a safety limit. "
            f"Dose for the day about {total:.0f} micrograys. This is a cabin measurement, not anyone's personal dose.")


def forecast(day: int) -> str:
    """How the radiation peak forecast did on one day: what it called, and what then happened."""
    rows = db("radiation_forecasts", f"select=for_timestamp,peak_probability,predicted_peak,actual_peak_within_30min,forecast_kind,model_name"
                                     f"&for_timestamp=gte.2024-05-{day:02d}T00:00:00Z&for_timestamp=lt.2024-05-{day + 1:02d}T00:00:00Z&order=for_timestamp")
    if not rows:
        return (f"There is no forecast for {day} May 2024. Forecasts exist for 8 to 30 May 2024; the model needs the first week to learn from. "
                "If none exist at all, the forecast table has not been loaded yet.")
    called = [r for r in rows if r["predicted_peak"]]
    actual = [r for r in rows if r.get("actual_peak_within_30min")]
    hit = sum(1 for r in called if r.get("actual_peak_within_30min"))
    caught = sum(1 for r in actual if r["predicted_peak"])
    top = max(rows, key=lambda r: float(r["peak_probability"]))
    kind = "held-out test day" if rows[0].get("forecast_kind") == "held_out_test" else "the model had only seen earlier days"
    out = (f"Historical replay, not a live forecast: radiation peak forecast for {day} May 2024 ({kind}). "
           f"Every five minutes the model estimated the chance of a dose-rate peak in the next 30 minutes. It called a peak {len(called)} times out of {len(rows)}")
    out += f", and {hit} of those calls were right. " if called else ". "
    out += f"A peak did follow {len(actual)} times and the model caught {caught} of them. " if actual else "No peak followed on this day. "
    out += f"Its highest estimate was {float(top['peak_probability']) * 100:.0f} percent at {str(top['for_timestamp'])[11:16]} UTC. "
    return out + "A peak here is a statistical line, not a safety limit, and this is cabin dose rate, not a personal dose."


def space_weather(day: Optional[int]) -> str:
    q = "select=timestamp,event_type,value,detail&order=timestamp"
    if day:
        q += f"&timestamp=gte.2024-05-{day:02d}T00:00:00Z&timestamp=lt.2024-05-{day + 1:02d}T00:00:00Z"
    rows = db("nasa_space_weather", q)
    scope = f"on {day} May 2024" if day else "in May 2024"
    if not rows:
        return f"Historical NASA data, not live: no storm or solar particle reports {scope}. No report does not prove the weather was quiet."
    kp = [r for r in rows if r["event_type"] == "geomagnetic_storm_kp_observation"]
    sep = [r for r in rows if r["event_type"] == "solar_particle_event_report"]
    out = f"Historical NASA data, not live: space weather {scope}. "
    if kp:
        top = max(kp, key=lambda r: float(r["value"]))
        out += f"{len(kp)} geomagnetic storm readings, the strongest Kp {float(top['value']):g} at {str(top['timestamp'])[:16].replace('T', ' ')} UTC. "
    out += f"{len(sep)} solar particle event reports." if sep else "No solar particle event reports."
    return out + " Several reports can describe the same event seen by different instruments."


ANALYTES = {"hemoglobin": "hemoglobin", "haemoglobin": "hemoglobin", "platelet": "platelet_count", "platelets": "platelet_count", "white blood": "white_blood_cell_count",
            "red blood": "red_blood_cell_count", "hematocrit": "hematocrit", "glucose": "glucose", "calcium": "calcium", "sodium": "sodium", "potassium": "potassium", "creatinine": "creatinine"}


def labs(text: str) -> str:
    t = (text or "").lower()
    crew = re.search(r"\bc00([1-4])\b", t)
    analyte = next((v for k, v in ANALYTES.items() if k in t), None)
    if not crew or not analyte:
        return ("The lab table holds NASA reference blood tests for the four Inspiration4 astronauts, C001 to C004, at seven time points before and after flight. "
                "Ask for one test and one astronaut, for example: labs C002 hemoglobin. These are other people's results, not yours.")
    aid = f"I4_C00{crew.group(1)}"
    rows = db("nasa_labs", f"select=timepoint,value,unit,status,value_quality&astronaut_id=eq.{aid}&analyte=eq.{analyte}&order=timepoint_order")
    if not rows:
        return f"No {analyte.replace('_', ' ')} results for {aid} in the table."
    vals = ", ".join(f"{r['timepoint']} {_num(r['value'], digits=1) if r['value'] is not None else 'not assessed'}" for r in rows)
    out = sum(1 for r in rows if r.get("status") in ("above_supplied_range", "below_supplied_range"))
    return (f"NASA Inspiration4 reference labs, not your results: {analyte.replace('_', ' ')} for {aid} in {rows[0].get('unit') or 'the supplied unit'}. {vals}. "
            f"{out} of {len(rows)} were outside the supplied range. L means days before launch, R days after return.")


SYMPTOMS = [("chest_pain", ("chest", "heart attack", "tightness")), ("breathing_difficulty", ("breath", "choking", "suffocat", "wheez", "airway")),
            ("fainting", ("faint", "passed out", "pass out", "unconscious", "blacked out", "collapsed", "dizzy", "not responding")),
            ("bleeding_injury", ("bleed", "blood", " cut ", "wound", "injur", "gash"))]


def pick_symptom(text: str) -> str:
    """Spoken or typed description -> one of the agent's checklists, by keyword. Unclear descriptions use the general checklist."""
    t = _norm(text)
    return next((name for name, words in SYMPTOMS if any(w in t for w in words)), "other")


def start_sos(text: str, sender: str) -> str:
    """Start the matching checklist for this sender and return step 1. The reply names the checklist so a wrong match is visible."""
    symptom = pick_symptom(text)
    if symptom == "other":
        return bridge.ask_agent(text, mode="emergency", sender=sender)          # the agent's own free-text path (general checklist)
    try:
        s = bridge._call("POST", "/api/v1/sos", {"crew_id": bridge._crew(), "symptom": symptom, "note": f"Assistant, from {sender}" if sender else "Assistant"})
    except Exception:
        return bridge.SAFE_REPLY
    bridge._remember(sender, s.get("session_id"))
    return f"{symptom.replace('_', ' ').capitalize()} checklist. " + bridge._step_reply(s)


def menu() -> str:
    return ("I am HALO. I can tell you the crew status, read the daily report, describe the latest health check, and give historical NASA radiation, the radiation peak forecast and space weather "
            "for May 2024. In an emergency say EMERGENCY and what is happening, and I will read a checklist one step at a time. " + NOT_ADVICE)


# ---------------------------------------------------------------- router
def classify(text: str, in_sos: bool = False) -> str:
    t = _norm(text)
    word = re.sub(r"[^a-z']", "", (text or "").strip().lower())
    if not t.strip():
        return "empty"
    if word in bridge.STEP_WORDS:
        return "sos_step"
    if _has(t, "emergency", "sos", "mayday") or (not in_sos and _has(t, "help")) or (not in_sos and _has(t, "chest pain", "can't breathe", "cant breathe", "not breathing", "fainted", "passed out", "unconscious", "bleeding", "collapsed")):
        return "emergency"
    if in_sos:
        return "sos_question"
    if _has(t, "menu", "what can you do", "options", "what do you do", "who are you", "commands"):
        return "menu"
    if _has(t, "hello", "hi", "hey", "good morning", "good evening"):
        return "greeting"
    if _has(t, "lab", "labs", "blood test", "blood tests", "hemoglobin", "haemoglobin", "platelet*", "inspiration4", "inspiration 4"):
        return "labs"
    if _has(t, "space weather", "storm", "storms", "solar", "kp", "geomagnetic", "flare", "flares"):
        return "space_weather"
    if _has(t, "forecast", "forecasts", "predict", "prediction", "predictions", "predicted", "model", "next 30 minutes", "peak coming", "will there be"):
        return "forecast"
    if _has(t, "radiation", "dose", "dosimeter", "radiation level", "rad"):
        return "radiation"
    if _has(t, "report", "brief", "briefing", "summary", "daily"):
        return "daily_report"
    if _has(t, "last check", "my check", "latest check", "my scan", "last scan", "latest scan", "my results", "my result", "readiness", "my score", "health check", "my heart rate", "my reading", "my readings"):
        return "last_check"
    if _has(t, "status", "crew", "how is everyone", "how are they", "anyone unwell", "who needs"):
        return "crew_status"
    if _has(t, "bye", "goodbye", "thanks", "thank you", "that's all", "thats all", "nothing"):
        return "goodbye"
    return "other"


def reply(text: str, channel: str = "web", sender: str = "") -> dict:
    """Answer one message. Never raises: a failed source becomes a plain sentence saying which source failed."""
    in_sos = bool(sender and bridge._session_for(sender))
    intent, source, sugg = classify(text, in_sos), "", MENU
    try:
        if intent == "empty":
            out = "I did not hear anything. " + ("Say menu to hear what I can do." if channel == "voice" else "Send MENU to see what I can do.")
        elif intent in ("sos_step", "sos_question"):
            out, source, sugg = bridge.ask_agent(text, mode="question", sender=sender), "agent: crew SOS", ["Done", "Can't", "Changed", "Skip"]
        elif intent == "emergency":
            out, source, sugg = start_sos(text, sender), "agent: crew SOS", ["Done", "Can't", "Changed", "Skip"]
        elif intent in ("menu", "greeting"):
            out = menu()
        elif intent == "goodbye":
            out = "Goodbye from HALO."
        elif intent == "crew_status":
            out, source = crew_status(), "agent: crews"
        elif intent == "daily_report":
            out, source = daily_report(_crew_in(text) or DEFAULT_CREW), "agent: daily report"
        elif intent == "last_check":
            out, source = last_check(), "database: scan_feed"
        elif intent == "radiation":
            out, source = radiation(_may_day(text)), "database: nasa_radiation"
        elif intent == "forecast":
            out, source = forecast(_may_day(text)), "database: radiation_forecasts"
        elif intent == "space_weather":
            out, source = space_weather(_may_day(text, 0) or None), "database: nasa_space_weather"
        elif intent == "labs":
            out, source = labs(text), "database: nasa_labs"
        else:
            ans = bridge.ask_agent(text, mode="question", sender=sender)
            unknown = ans == bridge.SAFE_REPLY or "Not covered" in ans or ans == bridge.NO_SOS
            out, source = ("I can't answer that. " + menu()) if unknown else ans, "" if unknown else "agent: ask"
    except Exception:
        where = "the HALO database" if intent in ("last_check", "radiation", "forecast", "space_weather", "labs") else "the HALO agent"
        out, source = f"I could not reach {where} just now, so I have no answer for that. Nothing was guessed.", ""
    if intent in ("emergency", "sos_step", "sos_question") and channel != "sms":
        # The agent words checklist steps for text messages. For speech and chat: say "step 2 of 9", drop the texting instructions.
        out = re.sub(r"\bSOS (\d+)/(\d+):", r"Step \1 of \2.", out).replace(" Reply DONE / CANT / CHANGED", "")
        if channel == "voice":
            out = re.sub(r"Press '?condition changed'?", "Say changed", out)
    return {"text": _fit(out, channel), "intent": intent, "suggestions": sugg, "source": source}
