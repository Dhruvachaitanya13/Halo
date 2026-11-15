"""Run from the twilio folder:  python -m pytest -q   (or: python tests/test_assistant.py)"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import assistant as A

CREWS = {"crews": [{"crew_id": "CREW_01", "source": "synthetic", "readings": 276, "latest_status": "alert", "baseline_building": None},
                   {"crew_id": "LIVE_01", "source": "live", "readings": 2, "latest_status": "normal", "baseline_building": {"label": "Baseline building (2/3)"}}]}
SCAN = [{"created_at": "2026-11-15T01:25:57+00:00", "verdict": "caution", "readiness_score": 88, "heart_bpm": None, "breathing_brpm": 14, "reaction_median_ms": 475, "sleep_hours": 7, "flags": ["2 slow response(s) over 500 ms"]}]
RAD = [{"dose_rate_ugy_h": 3.0, "is_peak": False, "dose_in_observed_bin_ugy": 0.25, "peak_threshold_ugy_h": 11.60008}] * 280 + [{"dose_rate_ugy_h": 120.0, "is_peak": True, "dose_in_observed_bin_ugy": 10.0, "peak_threshold_ugy_h": 11.60008}] * 8
WX = [{"timestamp": "2024-05-11T00:00:00+00:00", "event_type": "geomagnetic_storm_kp_observation", "value": 9.0, "detail": "NOAA"},
      {"timestamp": "2024-05-11T02:10:00+00:00", "event_type": "solar_particle_event_report", "value": 1, "detail": "GOES"}]


FC = [{"for_timestamp": f"2024-05-10T{h:02d}:00:00+00:00", "peak_probability": pr, "predicted_peak": pr >= 0.34, "actual_peak_within_30min": act, "forecast_kind": "walk_forward", "model_name": "m"}
      for h, pr, act in [(1, 0.02, False), (2, 0.9, True), (3, 0.6, False), (4, 0.1, True), (5, 0.97, True)]]


def fake_db(table, query):
    return {"radiation_forecasts": FC, "scan_feed": SCAN, "nasa_radiation": RAD, "nasa_space_weather": WX, "nasa_labs": [{"timepoint": "L-92", "value": 13.2, "unit": "g/dL", "status": "within_supplied_range", "value_quality": "as_supplied"}]}[table]


def setup():
    A.db = fake_db
    A.agent_get = lambda path: CREWS if path.endswith("/crews") else {"summary_text": "Duty status: READY."}


def test_topics_are_recognised():
    c = A.classify
    assert c("how is the crew doing") == "crew_status" and c("read me the daily report") == "daily_report" and c("what was my last check") == "last_check"
    assert c("radiation on May 11") == "radiation" and c("any solar storms?") == "space_weather" and c("labs C002 hemoglobin") == "labs"
    assert c("EMERGENCY he fainted") == "emergency" and c("my crewmate has chest pain") == "emergency" and c("done") == "sos_step"
    assert c("menu") == "menu" and c("goodbye") == "goodbye" and c("tell me a joke") == "other" and c("") == "empty"
    assert c("why this step", in_sos=True) == "sos_question" and c("help", in_sos=True) == "sos_question"


def test_answers_come_from_the_sources_and_missing_values_are_said():
    setup()
    r = A.reply("crew status")
    assert "CREW_01" in r["text"] and "alert" in r["text"] and "baseline building (2/3)" in r["text"] and r["source"] == "agent: crews"
    r = A.reply("my last check")
    assert "88 out of 100" in r["text"] and "heart rate not measured" in r["text"] and "475" in r["text"]
    r = A.reply("radiation on 11 May")
    assert "Historical NASA data, not live" in r["text"] and "11 May 2024" in r["text"] and "8 readings were above" in r["text"] and "not a safety limit" in r["text"]
    r = A.reply("space weather")
    assert "Kp 9" in r["text"] and "1 solar particle event reports" in r["text"]
    assert "not your results" in A.reply("labs C002 hemoglobin")["text"]
    r = A.reply("what did the forecast say on 10 May")
    assert r["intent"] == "forecast" and "called a peak 3 times out of 5, and 2 of those calls were right" in r["text"] and "caught 2 of them" in r["text"] and "97 percent at 05:00" in r["text"] and "not a live forecast" in r["text"]


def test_a_failed_source_is_reported_not_guessed():
    setup()
    def boom(*a): raise OSError("down")
    A.db = boom
    r = A.reply("radiation on 10 May")
    assert "could not reach the HALO database" in r["text"] and "Nothing was guessed" in r["text"] and not any(ch.isdigit() for ch in r["text"])


def test_length_limits_and_symptom_choice():
    setup()
    assert len(A.reply("my last check", channel="sms")["text"]) <= 300 and len(A.reply("menu", channel="voice")["text"]) <= 420
    assert A.pick_symptom("she can't breathe") == "breathing_difficulty" and A.pick_symptom("lots of blood") == "bleeding_injury" and A.pick_symptom("something is wrong") == "other"
    assert A._may_day("radiation on May 31") == 10 and A._may_day("11th May") == 11


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"): fn(); print("ok", name)
