"""Adds two optional variants on top of the Feature 3 tables. Run after prepare_feature3.py:

    python apply_additions.py DATA_DIRECTORY

1. Corrected labs: applies the row-shift correction for astronaut C003 at L-92 (blood count) and recomputes the baselines.
   Writes inspiration4_labs_long_corrected.csv, inspiration4_labs_wide_corrected.csv, inspiration4_baseline_summary_corrected.csv.
2. Space weather as model inputs: adds six weather columns to the model tables, using only records already known at the end of each bin.
   Writes radiation_model_train_weather.csv, radiation_model_test_weather.csv, model_contract_weather.json.

The original Feature 3 files are not changed. Requires pandas and numpy.
"""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd
D = Path(sys.argv[1])

# ---------------------------------------------------------------- 1. corrected labs
L = pd.read_csv(D / "inspiration4_labs_long.csv"); A = pd.read_csv(D / "labs_source_review.csv")
row = (L.astronaut_id == "I4_C003") & (L.timepoint == "L-92") & (L.panel == "blood_count")
pub = L[row].set_index("analyte").value_as_published
# The correction is checked against values in the same blood draw that were NOT shifted:
#   absolute count = white cell count x 1000 x percentage / 100;  MCH = haemoglobin / red cells x 10;  MCHC = haemoglobin / haematocrit x 100
wbc, hgb, hct, rbc = pub["white_blood_cell_count"], pub["hemoglobin"], pub["hematocrit"], pub["red_blood_cell_count"]
expect = {"absolute_neutrophils": wbc * 10 * pub["neutrophils"], "absolute_lymphocytes": wbc * 10 * pub["lymphocytes"], "absolute_monocytes": wbc * 10 * pub["monocytes"],
          "absolute_eosinophils": wbc * 10 * pub["eosinophils"], "mch": hgb / rbc * 10, "mchc": hgb / hct * 100}
prop = A.set_index("analyte").proposed_corrected_value
check = {k: {"proposed": float(prop[k]), "from_unshifted_values": round(float(v), 1), "agrees": bool(abs(prop[k] - v) <= max(0.06, 0.005 * v))} for k, v in expect.items()}
assert all(c["agrees"] for c in check.values()), check
# rdw, platelet_count and mpv cannot be derived from other values; their corrected values are the neighbours in the same shift and are judged against the other pre-flight draws.

C = L.copy()
for a, v in prop.dropna().items():
    m = row & (C.analyte == a)
    if m.any(): C.loc[m, "value"] = v; C.loc[m, "value_quality"] = "corrected_row_shift"
mch = C[(C.astronaut_id == "I4_C003") & (C.timepoint == "L-44") & (C.panel == "blood_count") & (C.analyte == "mch")].iloc[0].copy()      # template for the row missing from the source
tmpl = C[row].iloc[0]
for k in ["timepoint", "timepoint_order", "phase", "days_from_launch"]: mch[k] = tmpl[k]
mch["value"] = float(prop["mch"]); mch["value_as_published"] = np.nan; mch["proposed_corrected_value"] = float(prop["mch"]); mch["value_quality"] = "restored_row_missing_from_source"
C = pd.concat([C, pd.DataFrame([mch])], ignore_index=True)
# absolute_basophils at L-92 stays blank: its true value fell off the end of the shifted row and is not in the source.

keys = ["astronaut_id", "panel", "analyte", "unit"]            # same formulas as prepare_feature3.py
C = C.drop(columns=["preflight_mean", "preflight_sd", "preflight_n"]).merge(C[C.phase == "pre-flight"].groupby(keys).value.agg(preflight_mean="mean", preflight_sd="std", preflight_n="count").reset_index(), on=keys, how="left")
C["preflight_n"] = C.preflight_n.fillna(0).astype(int)
C["change_from_preflight"] = C.value - C.preflight_mean; C["pct_change_from_preflight"] = 100 * C.change_from_preflight / C.preflight_mean.replace(0, np.nan)
C["z_from_preflight"] = C.change_from_preflight / C.preflight_sd.where(C.preflight_sd.gt(0) & C.preflight_n.ge(3))
C["status"] = np.select([C.value.isna(), C.reference_range_coverage.eq("none"), C.value.lt(C.normal_low), C.value.gt(C.normal_high), C.reference_range_coverage.ne("both_bounds")],
                        ["not_assessed_source_review", "no_reference_range", "below_supplied_range", "above_supplied_range", "within_available_bound"], default="within_supplied_range")
C["baseline_quality"] = np.select([C.preflight_n.eq(0), C.preflight_n.lt(3), C.preflight_sd.eq(0)], ["missing", "fewer_than_3_samples", "zero_spread"], default="available_small_n")
C = C[list(L.columns)].sort_values(["astronaut_id", "timepoint_order", "panel", "analyte"]); C.to_csv(D / "inspiration4_labs_long_corrected.csv", index=False)
idx = ["astronaut_id", "sex", "timepoint", "timepoint_order", "phase", "days_from_launch"]
w = C[C.panel.isin(["blood_count", "blood_chemistry"])].pivot(index=idx, columns="analyte", values="value").reset_index(); w.columns.name = None; w.to_csv(D / "inspiration4_labs_wide_corrected.csv", index=False)
summ = []
for key, a in C.groupby(keys):
    post = a[a.phase == "post-flight"].sort_values("timepoint_order")
    if not len(post): continue
    last = post.iloc[-1]
    summ.append(dict(zip(keys, key)) | {"preflight_mean": last.preflight_mean, "preflight_sd": last.preflight_sd, "preflight_n": last.preflight_n, "postflight_available_n": int(post.value.notna().sum()),
        "largest_absolute_postflight_pct_change": post.pct_change_from_preflight.abs().max(), "last_timepoint": last.timepoint, "last_value": last.value, "last_pct_change_from_preflight": last.pct_change_from_preflight,
        "postflight_out_of_supplied_range_count": int(post.status.isin(["below_supplied_range", "above_supplied_range"]).sum()), "data_context": "NASA_Inspiration4_reference_labs"})
pd.DataFrame(summ).to_csv(D / "inspiration4_baseline_summary_corrected.csv", index=False)
assert len(C) == len(L) + 1 and C.value.isna().sum() == 1 and not C.duplicated(["astronaut_id", "timepoint", "panel", "analyte"]).any()

# ---------------------------------------------------------------- 2. space weather as model inputs
W = pd.read_csv(D / "space_weather_events.csv"); W["obs"] = pd.to_datetime(W.timestamp, utc=True); W["sub"] = pd.to_datetime(W.record_submission_time_utc, utc=True)
# A record counts as known only once BOTH its observation time and the submission time of the returned record have passed.
# This can only make a record available later than it really was, never earlier, so it cannot leak the future into a forecast.
W["known_at"] = W[["obs", "sub"]].max(axis=1)
kp = W[W.event_type == "geomagnetic_storm_kp_observation"].sort_values("known_at"); sep = W[W.event_type == "solar_particle_event_report"].sort_values("known_at")
H = pd.Timedelta(hours=1)
def weather(ts):
    T = ts + pd.Timedelta(minutes=5)                                   # features are available at the END of the five-minute bin
    k = kp[kp.known_at <= T]; s = sep[sep.known_at <= T]; k6 = k[k.obs > T - 6 * H]; k24 = k[k.obs > T - 24 * H]; s24 = s[s.obs > T - 24 * H]
    return {"wx_storm_report_active_6h": bool(len(k6)), "wx_kp_last_known_6h": float(k6.sort_values("obs").value.iloc[-1]) if len(k6) else 0.0, "wx_kp_max_known_24h": float(k24.value.max()) if len(k24) else 0.0,
            "wx_hours_since_storm_kp": float(min(72, (T - k.obs.max()) / H)) if len(k) else 72.0, "wx_particle_reports_known_24h": int(len(s24)), "wx_hours_since_particle_report": float(min(72, (T - s.obs.max()) / H)) if len(s) else 72.0}
WX = list(weather(pd.Timestamp("2024-05-01", tz="UTC")))
contract = json.loads((D / "model_contract.json").read_text())
for split in ["train", "test"]:
    m = pd.read_csv(D / f"radiation_model_{split}.csv"); ts = pd.to_datetime(m.timestamp, utc=True); wx = pd.DataFrame([weather(t) for t in ts])
    out = pd.concat([m.drop(columns=[contract["target"]]), wx, m[[contract["target"]]]], axis=1); assert not out.isna().any().any() and len(out) == len(m)
    out.to_csv(D / f"radiation_model_{split}_weather.csv", index=False)
    print(split, "rows", len(out), "| rows with an active storm report:", int(wx.wx_storm_report_active_6h.sum()), "| rows with a particle report in 24 h:", int((wx.wx_particle_reports_known_24h > 0).sum()))
contract |= {"features": contract["features"] + WX, "weather_features_in_model": True, "weather_features": WX,
    "weather_reason": "Optional variant. A weather record is used only after both its observation time and the returned record's submission time; zero means no storm report in the feed, not Kp 0.",
    "weather_caveat": "All storm and particle reports fall on 2-17 May 2024. The validation days (20-24 May) and test days (25-30 May) contain none, so these columns cannot be shown to help on held-out data.",
    "base_contract": "model_contract.json"}
(D / "model_contract_weather.json").write_text(json.dumps(contract, indent=2))
(D / "additions_report.json").write_text(json.dumps({"lab_correction_arithmetic_check": check, "labs_corrected_rows": len(C), "labs_corrected_blank_values": int(C.value.isna().sum()), "weather_features": WX}, indent=2))
print(json.dumps(check, indent=1))
