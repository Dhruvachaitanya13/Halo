"""Loads the NASA tables from data/ into Supabase. No packages needed (Python 3.9+).

    export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
    export SUPABASE_SERVICE_KEY=...        # Settings > API keys > secret / service_role. Never commit it.
    python db/load_nasa.py

Run db/schema.sql first. Safe to run again: rows are replaced by key, not duplicated.
"""
import csv, json, os, sys, urllib.request
from pathlib import Path
URL, KEY = os.environ.get("SUPABASE_URL", "").rstrip("/"), os.environ.get("SUPABASE_SERVICE_KEY", "")
DATA = Path(__file__).resolve().parent.parent / "data"
TABLES = {   # table: (file, columns to load, key columns)
    "nasa_radiation": ("radiation_5min.csv", ["timestamp", "dose_rate_ugy_h", "dose_rate_max_ugy_h", "latitude", "longitude", "altitude_km", "in_saa_box", "region", "is_peak", "peak_threshold_ugy_h", "split",
                                               "dose_in_observed_bin_ugy", "observed_dose_accumulated_day_ugy"], "timestamp"),
    "nasa_space_weather": ("space_weather_events.csv", ["event_id", "timestamp", "event_type", "value", "unit", "detail", "record_submission_time_utc", "event_url"], "event_id,timestamp,event_type"),
    "nasa_labs": ("inspiration4_labs_long_corrected.csv", ["astronaut_id", "timepoint", "panel", "analyte", "timepoint_order", "phase", "days_from_launch", "analyte_label", "value", "unit", "normal_low", "normal_high",
                                                            "value_as_published", "value_quality", "preflight_mean", "preflight_sd", "preflight_n", "change_from_preflight", "pct_change_from_preflight", "z_from_preflight",
                                                            "status", "baseline_quality", "source_study"], "astronaut_id,timepoint,panel,analyte"),
    "radiation_forecasts": ("forecasts.csv", ["for_timestamp", "peak_probability", "predicted_peak", "actual_peak_within_30min", "forecast_kind", "model_name", "model_version"],
                            "for_timestamp,model_name,model_version"),
}
FORECASTS = Path(__file__).resolve().parent.parent / "model" / "forecasts.csv"      # written by model/train_forecast.py
def clean(v):                       # blank -> null, True/False -> boolean; numbers stay as text and Postgres converts them exactly
    return None if v == "" else True if v == "True" else False if v == "False" else v
def rows(table):
    file, cols, _ = TABLES[table]
    with open(FORECASTS if table == "radiation_forecasts" else DATA / file, newline="", encoding="utf-8") as f:
        return [{c: clean(r[c]) for c in cols} for r in csv.DictReader(f)]
def post(table, batch, key):
    req = urllib.request.Request(f"{URL}/rest/v1/{table}?on_conflict={key}", data=json.dumps(batch).encode(), method="POST",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"})
    urllib.request.urlopen(req, timeout=60).read()
if __name__ == "__main__":
    if "--check" in sys.argv:       # read the files and report, without touching the database
        for t in TABLES: r = rows(t); print(t, len(r), "rows,", len(r[0]), "columns")
        sys.exit(0)
    if not URL or not KEY: sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY first (see the top of this file).")
    for t, (_, _, key) in TABLES.items():
        r = rows(t)
        for i in range(0, len(r), 500): post(t, r[i:i + 500], key)
        print(f"{t}: {len(r)} rows loaded")
