"""HALO radiation peak forecast: train, test, and write the forecasts the dashboard and assistant read.

    python model/train_forecast.py            (from the repository root; needs pandas, numpy, scikit-learn)

Question the model answers, at the end of every five-minute bin: will the ISS dose rate exceed the peak line in any of the next
six bins (30 minutes)? Inputs, target, split and peak line are exactly those in data/model_contract.json. Space weather is not used.

It writes, into model/:
  forecasts.csv   one row per bin: probability, yes/no call, what actually happened, and how the row was produced
  metrics.json    scores, the decision threshold and how it was chosen, feature importance, calibration
Two kinds of forecast, never mixed up:
  walk_forward    for each day from 8 to 24 May the model is refitted on all EARLIER days only, then forecasts that day.
                  Every one of these forecasts is out of sample, which is why the storm days (10-11 May) can be shown honestly.
  held_out_test   one model fitted on 1-24 May forecasts 25-30 May, the days the contract reserves for the final score.
The decision threshold is chosen on the walk-forward forecasts only and then applied unchanged to the held-out days.
"""
import json
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.inspection import permutation_importance

ROOT = Path(__file__).resolve().parent.parent; D = ROOT / "data"; OUT = ROOT / "model"
C = json.loads((D / "model_contract.json").read_text()); F, T = C["features"], C["target"]
MODEL = dict(max_depth=4, learning_rate=0.08, max_iter=200, random_state=0)      # fixed in advance; not tuned on the test days
NAME, VERSION = "hist_gradient_boosting", "1.0"
tr = pd.read_csv(D / "radiation_model_train.csv", parse_dates=["timestamp"]); te = pd.read_csv(D / "radiation_model_test.csv", parse_dates=["timestamp"])
X = lambda d: d[F].astype(float).to_numpy(); y = lambda d: d[T].astype(bool).to_numpy()
fit = lambda d: HistGradientBoostingClassifier(**MODEL).fit(X(d), y(d))

# ---- walk-forward: forecast each day with a model that has only seen earlier days (30-minute gap so no label overlaps the day)
tr["day"] = tr.timestamp.dt.day; parts = []
for day in range(8, 25):
    start = pd.Timestamp(2024, 5, day, tz="UTC"); past = tr[tr.timestamp < start - pd.Timedelta(minutes=30)]; today = tr[tr.day == day]
    if len(today) == 0 or y(past).sum() < 20: continue
    parts.append(today.assign(peak_probability=fit(past).predict_proba(X(today))[:, 1], forecast_kind="walk_forward"))
wf = pd.concat(parts, ignore_index=True)

# ---- decision threshold: best F1 on the walk-forward forecasts only
grid = np.round(np.arange(0.05, 0.96, 0.01), 2); thr = float(grid[int(np.argmax([f1_score(y(wf), wf.peak_probability >= t) for t in grid]))])

# ---- held-out test days: one model on all training days, threshold unchanged
final = fit(tr); ho = te.assign(peak_probability=final.predict_proba(X(te))[:, 1], forecast_kind="held_out_test")

def score(d):
    p, a = d.peak_probability.to_numpy(), y(d); call = p >= thr
    bins = pd.cut(p, [0, .1, .3, .5, .7, .9, 1.0], include_lowest=True)
    cal = [{"forecast_range": str(k), "n": int(len(g)), "mean_forecast": round(float(g.p.mean()), 3), "observed_rate": round(float(g.a.mean()), 3)}
           for k, g in pd.DataFrame({"p": p, "a": a}).groupby(bins, observed=True)]
    return {"rows": int(len(d)), "peak_rate": round(float(a.mean()), 3), "precision": round(float(precision_score(a, call)), 3), "recall": round(float(recall_score(a, call)), 3),
            "f1": round(float(f1_score(a, call)), 3), "roc_auc": round(float(roc_auc_score(a, p)), 3), "average_precision": round(float(average_precision_score(a, p)), 3),
            "brier": round(float(brier_score_loss(a, p)), 4), "calibration": cal}

naive = lambda d: {"precision": round(float(precision_score(y(d), d.dose_rate_ugy_h > C["peak_threshold_ugy_h"])), 3), "recall": round(float(recall_score(y(d), d.dose_rate_ugy_h > C["peak_threshold_ugy_h"])), 3)}
imp = permutation_importance(final, X(te), y(te), n_repeats=5, random_state=0, scoring="average_precision")
metrics = {"model": NAME, "version": VERSION, "settings": MODEL, "features": len(F), "target": T, "peak_threshold_ugy_h": C["peak_threshold_ugy_h"],
           "decision_threshold": thr, "decision_threshold_chosen_on": "walk-forward forecasts, 8-24 May 2024 (best F1); applied unchanged to the held-out days",
           "walk_forward_8_to_24_may": score(wf), "held_out_test_25_to_30_may": score(ho),
           "naive_rule_current_bin_above_line": {"walk_forward": naive(wf), "held_out_test": naive(ho)},
           "top_features_by_permutation_importance": [{"feature": F[i], "drop_in_average_precision": round(float(imp.importances_mean[i]), 4)} for i in np.argsort(-imp.importances_mean)[:6]],
           "limits": ["One month of data from one instrument (DOSTEL-1, ISS Columbus, May 2024).", "The peak line is three times the training median dose rate: a statistical definition, not a NASA exposure limit.",
                      "Cabin dose rate, not anyone's personal dose.", "Space weather is not an input; this month cannot show whether it would help."]}
allf = pd.concat([wf, ho], ignore_index=True).sort_values("timestamp")
out = pd.DataFrame({"for_timestamp": allf.timestamp.dt.strftime("%Y-%m-%dT%H:%M:%SZ"), "peak_probability": allf.peak_probability.round(4), "predicted_peak": allf.peak_probability >= thr,
                    "actual_peak_within_30min": y(allf), "forecast_kind": allf.forecast_kind, "model_name": NAME, "model_version": VERSION})
assert out.for_timestamp.is_unique and out.peak_probability.between(0, 1).all()
out.to_csv(OUT / "forecasts.csv", index=False); (OUT / "metrics.json").write_text(json.dumps(metrics, indent=1))
print(json.dumps({k: metrics[k] for k in ["decision_threshold", "naive_rule_current_bin_above_line"]}, indent=1))
for k in ["walk_forward_8_to_24_may", "held_out_test_25_to_30_may"]: print(k, {a: b for a, b in metrics[k].items() if a != "calibration"})
print("calibration (held out):", metrics["held_out_test_25_to_30_may"]["calibration"]); print("top features:", metrics["top_features_by_permutation_importance"]); print("rows written:", len(out))
