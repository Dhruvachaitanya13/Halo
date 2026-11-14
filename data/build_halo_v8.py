#!/usr/bin/env python3
"""HALO v8 - NASA-only, model-ready tables. Inputs: ./nasa/raw (saved NASA API responses), ./final (Inspiration4 labs).
Outputs in ./v8: radiation_features.csv, labs_wide.csv, labs_long.csv, labs_change_summary.csv, space_weather_events.csv
"""
import io, json, re
from pathlib import Path
import numpy as np, pandas as pd
OUT = Path("."); OUT.mkdir(exist_ok=True)

def load(fn):
    raw = open(fn).read(); p = re.split(r"(?m)^# .*\nURL: (\S+)\n\n", raw)
    return {p[i]: p[i + 1] for i in range(1, len(p) - 1, 2)}
docs = {**load("raw/radlab_donki_2024-05.txt"), **load("raw/radlab_2024-05_extra.txt"), **load("raw/donki_2024-05_full.txt")}

# ============ 1. RADIATION (RadLab, DosTel1, ISS Columbus) ============
fr = []
for k, v in docs.items():
    if "radlab" not in k or "DosTel1" not in k: continue
    v = v[: v.find("\n\nError fetching")] if "\n\nError fetching" in v else v
    d = pd.read_csv(io.StringIO(v), skipinitialspace=True); d.columns = [c.strip() for c in d.columns]; fr.append(d)
rad = pd.concat(fr, ignore_index=True)
n_raw = len(rad)
rad["timestamp"] = pd.to_datetime(rad.timestamp.astype(str).str.strip(), errors="coerce")
for c in ["absorbed_dose_rate", "latitude", "longitude", "altitude"]: rad[c] = pd.to_numeric(rad[c], errors="coerce")
rad = rad.dropna(subset=["timestamp", "absorbed_dose_rate"]).drop_duplicates("timestamp").sort_values("timestamp")
n_dedup = len(rad)
rad = rad[(rad.absorbed_dose_rate >= 0) & (rad.absorbed_dose_rate < 5000)]
rad = rad[rad.latitude.between(-52, 52) & rad.longitude.between(-180, 180) & rad.altitude.between(350, 480)]
n_clean = len(rad)
g = rad.set_index("timestamp").resample("5min").agg(dose_rate_ugy_h=("absorbed_dose_rate", "mean"), dose_rate_max_ugy_h=("absorbed_dose_rate", "max"),
        latitude=("latitude", "mean"), longitude=("longitude", "last"), altitude_km=("altitude", "mean"), n_samples=("absorbed_dose_rate", "size"))
g = g[g.n_samples > 0].reset_index()
# contiguous segments: a new segment starts after any gap longer than 15 minutes (lags never cross a gap)
gap = g.timestamp.diff().dt.total_seconds().div(60).fillna(5)
g["segment_id"] = (gap > 15).cumsum() + 1
g["minutes_since_prev"] = gap.round(0).astype(int)
# geography
g["abs_latitude"] = g.latitude.abs()
g["lat_moving_north"] = g.groupby("segment_id").latitude.diff().fillna(0) > 0
g["in_saa_box"] = g.latitude.between(-50, 0) & g.longitude.between(-90, 40)          # approximate South Atlantic Anomaly box
g["region"] = np.where(g.in_saa_box, "saa_box", np.where(g.abs_latitude >= 45, "high_latitude", "low_mid_latitude"))
g["lon_sin"] = np.sin(np.radians(g.longitude)).round(4); g["lon_cos"] = np.cos(np.radians(g.longitude)).round(4)
g["hour_utc"] = g.timestamp.dt.hour; g["date"] = g.timestamp.dt.date.astype(str)
# history features and targets, within segment only
grp = g.groupby("segment_id").dose_rate_ugy_h
for k in (1, 2, 3, 6): g[f"dose_rate_lag_{5*k}min"] = grp.shift(k)
g["dose_rate_roll_median_1h"] = grp.transform(lambda s: s.rolling(12, min_periods=6).median())
g["dose_rate_roll_max_1h"] = grp.transform(lambda s: s.rolling(12, min_periods=6).max())
for k, n in ((1, "5min"), (3, "15min"), (6, "30min")): g[f"target_dose_rate_plus_{n}"] = grp.shift(-k)
med = g.dose_rate_ugy_h.median()
g["is_peak"] = g.dose_rate_ugy_h > 3 * med
g["target_peak_within_30min"] = pd.concat([g.groupby("segment_id").is_peak.shift(-k) for k in range(1, 7)], axis=1).max(axis=1)
g.loc[grp.shift(-6).isna(), "target_peak_within_30min"] = np.nan
# dose bookkeeping (uGy): each 5-min bin contributes rate * 5/60
g["dose_in_bin_ugy"] = g.dose_rate_ugy_h * 5 / 60
g["dose_accumulated_day_ugy"] = g.groupby("date").dose_in_bin_ugy.cumsum()

# space weather (DONKI): storms are only listed when Kp >= storm level, so absence means "no storm reported", not Kp = 0
def js(key):
    k = [u for u in docs if f"DONKI/{key}" in u]; t = docs[k[-1]] if k else "[]"   # last = full-month query
    try: return json.loads(t[: t.rfind("]") + 1])
    except Exception: return []
kp = pd.DataFrame([{"timestamp": pd.to_datetime(x["observedTime"]).tz_localize(None), "kp_index": x["kpIndex"], "storm_id": e["gstID"]} for e in js("GST") for x in e["allKpIndex"]]).drop_duplicates("timestamp").sort_values("timestamp")
sep = pd.DataFrame([{"timestamp": pd.to_datetime(e["eventTime"]).tz_localize(None), "event_id": e["sepID"], "detector": "; ".join(i["displayName"] for i in (e.get("instruments") or []))} for e in js("SEP")]).sort_values("timestamp")
kp3 = kp.set_index("timestamp").kp_index
g["kp_index_storm"] = [kp3[(kp3.index > t - pd.Timedelta(hours=3)) & (kp3.index <= t + pd.Timedelta(minutes=1))].max() if len(kp3) else np.nan for t in g.timestamp + pd.Timedelta(hours=3) - pd.Timedelta(minutes=1)]
g["geomagnetic_storm_active"] = g.kp_index_storm.notna()
st = sep.timestamp.to_numpy()
g["hours_since_particle_event"] = [((t - st[st <= t].max()) / np.timedelta64(1, "h")) if (st <= t).any() else np.nan for t in g.timestamp.to_numpy()]
g["particle_event_last_24h"] = g.hours_since_particle_event.le(24)
# suggested chronological split: last 20% of days = test
days = sorted(g.date.unique()); cut = days[int(len(days) * 0.8)]
g["split"] = np.where(g.date < cut, "train", "test")
num = g.select_dtypes("float").columns; g[num] = g[num].round(4)
g.insert(0, "row_id", np.arange(1, len(g) + 1))
g.to_csv(OUT / "radiation_features.csv", index=False)

W = pd.concat([kp.assign(event_type="geomagnetic_storm_kp", value=kp.kp_index, detail=kp.kp_index.map(lambda v: "G5 extreme" if v >= 9 else "G4 severe" if v >= 8 else "G3 strong" if v >= 7 else "G2 moderate" if v >= 6 else "G1 minor"), event_id=kp.storm_id)[["timestamp", "event_type", "value", "detail", "event_id"]],
               sep.assign(event_type="solar_energetic_particle_event", value=1, detail=sep.detector)[["timestamp", "event_type", "value", "detail", "event_id"]]]).sort_values("timestamp")
W.to_csv(OUT / "space_weather_events.csv", index=False)

# ============ 2. ASTRONAUT LABS (OSDR Inspiration4) ============
L = pd.read_csv("raw/inspiration4_labs_long_precorrection.csv")
PAN = {"complete_blood_count": "blood_count", "comprehensive_metabolic_panel": "blood_chemistry", "serum_cardiovascular_panel": "heart_vessel_markers", "serum_immune_cytokine_panel": "immune_markers"}
L = L[L.panel.isin(PAN)].copy(); L["panel"] = L.panel.map(PAN); L["astronaut_id"] = "I4_" + L.crew_id
# --- source correction: in NASA's file the C003 L-92 blood count has MCH missing and the next nine values shifted down one row.
#     Confirmed by arithmetic (white cells x neutrophil % = 6826, x lymphocyte % = 1997, x monocyte % = 614, x eosinophil % = 125).
L["value_as_published"] = L.value; L["corrected"] = False
FIX = {"mch": 29.6, "mchc": 32.4, "rdw": 12.9, "platelet_count": 330.0, "mpv": 10.1, "absolute_neutrophils": 6826.0,
       "absolute_lymphocytes": 1997.0, "absolute_monocytes": 614.0, "absolute_eosinophils": 125.0}
m = (L.crew_id == "C003") & (L.timepoint == "L-92") & (L.panel == "blood_count")
tmpl = L[(L.crew_id == "C003") & (L.timepoint == "L-44") & (L.analyte == "mch")].iloc[0].copy()
row = L[m & (L.analyte == "mchc")].iloc[0].copy()
for c in ["analyte", "analyte_label", "unit", "ref_min", "ref_max"]: row[c] = tmpl[c]
row["value_as_published"] = np.nan; L = pd.concat([L, row.to_frame().T], ignore_index=True)
for c in ["value", "ref_min", "ref_max", "value_as_published", "timepoint_order", "timeline_day"]: L[c] = pd.to_numeric(L[c])
m = (L.crew_id == "C003") & (L.timepoint == "L-92") & (L.panel == "blood_count")
for an, v in FIX.items(): L.loc[m & (L.analyte == an), ["value", "corrected"]] = [v, True]
L = L[~(m & (L.analyte == "absolute_basophils"))]                      # its true value was not published
st = pd.Series("in_range", index=L.index); st[L.value < L.ref_min] = "below_range"; st[L.value > L.ref_max] = "above_range"
L["ref_status"] = st.where(L.ref_min.notna() | L.ref_max.notna(), "no_reference_range")
key = ["crew_id", "panel", "analyte"]
pre = L[L.phase == "pre-flight"].groupby(key).value.agg(baseline_mean="mean", baseline_sd="std", bn="count").reset_index()
L = L.drop(columns=["baseline_mean", "baseline_sd"]).merge(pre, on=key, how="left")
L["change_from_baseline"] = L.value - L.baseline_mean
L["pct_change_from_baseline"] = (100 * L.change_from_baseline / L.baseline_mean.replace(0, np.nan)).round(2)
L["z_from_baseline"] = (L.change_from_baseline / L.baseline_sd.where(L.baseline_sd > 0)).where(L.bn >= 3)
L["status"] = L.ref_status.map({"in_range": "normal", "below_range": "below_range", "above_range": "above_range", "no_reference_range": "no_reference_range"})
# robust change score: needs a non-zero pre-flight spread; otherwise blank
L["z_from_preflight"] = L.z_from_baseline.where(L.baseline_sd > 0).clip(-10, 10).round(2)
LL = L[["astronaut_id", "sex", "timepoint", "timepoint_order", "phase", "timeline_day", "panel", "analyte", "value", "unit", "ref_min", "ref_max", "status",
        "baseline_mean", "baseline_sd", "change_from_baseline", "pct_change_from_baseline", "z_from_preflight", "corrected", "value_as_published", "source_study"]].rename(
        columns={"ref_min": "normal_low", "ref_max": "normal_high", "baseline_mean": "preflight_mean", "baseline_sd": "preflight_sd",
                 "change_from_baseline": "change_from_preflight", "pct_change_from_baseline": "pct_change_from_preflight", "timeline_day": "days_from_launch"})
LL = LL.sort_values(["astronaut_id", "timepoint_order", "panel", "analyte"]); LL.to_csv(OUT / "labs_long.csv", index=False)
keyc = ["astronaut_id", "sex", "timepoint", "timepoint_order", "phase", "days_from_launch"]
C = LL[LL.panel.isin(["blood_count", "blood_chemistry"])]
Wd = C.pivot_table(index=keyc, columns="analyte", values="value").reset_index().sort_values(["astronaut_id", "timepoint_order"])
fl = C[C.status.isin(["below_range", "above_range"])].groupby(["astronaut_id", "timepoint"]).agg(out_of_range_count=("analyte", "size"), out_of_range_tests=("analyte", lambda s: ";".join(sorted(s)))).reset_index()
Wd = Wd.merge(fl, on=["astronaut_id", "timepoint"], how="left"); Wd["out_of_range_count"] = Wd.out_of_range_count.fillna(0).astype(int); Wd["out_of_range_tests"] = Wd.out_of_range_tests.fillna("none")
Wd.to_csv(OUT / "labs_wide.csv", index=False)
# per astronaut x test: what flight did and whether it recovered
rows = []
for (a, p, an), d in LL.groupby(["astronaut_id", "panel", "analyte"]):
    d = d.set_index("timepoint"); post = d[d.phase == "post-flight"].sort_values("timepoint_order")
    if not len(post) or pd.isna(d.preflight_mean.iloc[0]): continue
    pm, sd = d.preflight_mean.iloc[0], d.preflight_sd.iloc[0]
    r1 = d.value.get("R+1", np.nan); last = post.iloc[-1]
    tol = max(2 * sd, 0.10 * abs(pm)) if pd.notna(sd) else 0.10 * abs(pm)
    back = post[(post.value - pm).abs() <= tol]
    rows.append({"astronaut_id": a, "panel": p, "analyte": an, "unit": d.unit.iloc[0], "preflight_mean": pm, "preflight_sd": sd,
                 "value_day_after_return": r1, "pct_change_day_after_return": round(100 * (r1 - pm) / pm, 1) if pm else np.nan,
                 "largest_post_flight_pct_change": round(100 * ((post.value - pm) / pm).abs().max(), 1) if pm else np.nan,
                 "last_value": last.value, "last_timepoint": last.name, "pct_change_at_last": round(100 * (last.value - pm) / pm, 1) if pm else np.nan,
                 "back_within_tolerance_at_last": bool(abs(last.value - pm) <= tol),
                 "first_timepoint_back_within_tolerance": back.index[0] if len(back) else "not_by_last_sample",
                 "post_flight_out_of_range_count": int(post.status.isin(["below_range", "above_range"]).sum())})
S = pd.DataFrame(rows); S.to_csv(OUT / "labs_change_summary.csv", index=False)

print(f"radlab rows raw {n_raw} -> unique {n_dedup} -> plausible {n_clean} -> 5-min bins {len(g)} | {g.timestamp.min()} .. {g.timestamp.max()} | days {g.date.nunique()} | segments {g.segment_id.nunique()}")
print("radiation_features", g.shape, "| median", round(med, 2), "| peaks", int(g.is_peak.sum()), f"({100*g.is_peak.mean():.1f}%)", "| peaks in SAA box", round(100 * g[g.is_peak].in_saa_box.mean(), 1), "%", "| split", g.split.value_counts().to_dict(), "cut", cut)
print(g.groupby("region").dose_rate_ugy_h.agg(["size", "median", "mean", "max"]).round(1))
print("missing %:", (100 * g.isna().mean()).round(1)[lambda s: s > 0].to_dict())
print("daily dose uGy:", g.groupby("date").agg(d=("dose_in_bin_ugy", "sum"), n=("row_id", "size")).query("n >= 280").d.describe()[["min", "50%", "max"]].round(0).tolist(), "| full days", int((g.groupby("date").size() >= 280).sum()))
print("labs_long", LL.shape, "| labs_wide", Wd.shape, "| change_summary", S.shape, "| weather", W.shape)
print("recovered at last sample:", S.back_within_tolerance_at_last.mean().round(2), "| largest R+1 shifts:", S.reindex(S.pct_change_day_after_return.abs().sort_values(ascending=False).index)[S.panel.isin(["blood_count", "blood_chemistry"])].head(5)[["astronaut_id", "analyte", "pct_change_day_after_return"]].values.tolist())
