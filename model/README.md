# Radiation peak forecast

**Question.** At the end of every five-minute bin: will the ISS dose rate go above the peak line in any of the next six bins (30 minutes)?

**Data.** NASA RadLab, DOSTEL-1 in the ISS Columbus module, 1-30 May 2024, as prepared in `../data/` (inputs, target, split and peak line are those in `../data/model_contract.json`). 18 inputs: the current and recent dose rate, and where the station is in its orbit. Space weather is not an input.

**Model.** Gradient-boosted trees (scikit-learn `HistGradientBoostingClassifier`, depth 4, 200 rounds). The settings were fixed in advance and not tuned on the test days.

## Results

| | Walk-forward, 8-24 May | Held-out test, 25-30 May |
|---|---|---|
| How it was produced | each day forecast by a model fitted on earlier days only | one model fitted on 1-24 May |
| Bins | 4,811 | 1,722 |
| Share with a peak ahead | 21.7% | 18.3% |
| Precision | 0.79 | 0.82 |
| Recall | 0.80 | 0.93 |
| ROC AUC | 0.92 | 0.99 |
| Naive rule ("the current bin is already above the line") | precision 0.64, recall 0.22 | precision 0.65, recall 0.23 |

A peak is called when the estimated chance is 0.34 or more. That cut-off was chosen on the walk-forward forecasts and applied unchanged to the held-out days. Calibration by range is in `metrics.json`: on the held-out days, forecasts above 0.9 were followed by a peak every time, and forecasts between 0.3 and 0.7 were somewhat too high.

## What it has learned, and where it fails

- The most important input by far is the station's longitude. Most peaks are passes through the South Atlantic Anomaly, which repeat with the orbit, and that is what the model predicts well.
- It does not predict storm-driven radiation. On 11 May 2024, during the geomagnetic storm, a peak followed 130 bins and the model caught 41 of them. On an ordinary day it catches most.
- So this is a forecast of the regular, orbit-driven peaks. It is not a space-weather warning.

## Limits

- One month from one instrument. It has not been tried on another month or another detector.
- The peak line is three times the training median dose rate (11.6 micrograys an hour): a statistical definition, not a NASA exposure limit.
- It is cabin dose rate, not anyone's personal dose.
- The forecasts are a replay of history, not a live feed.

## Files and how to rebuild

| File | What it is |
|---|---|
| `train_forecast.py` | trains, tests and writes the two files below; run from the repository root |
| `forecasts.csv` | 6,533 forecasts: time, probability, the call, what then happened, and whether the row is walk-forward or held-out |
| `metrics.json` | scores, the cut-off and how it was chosen, calibration, feature importance |

    pip install pandas numpy scikit-learn
    python model/train_forecast.py
    python db/load_nasa.py          # loads the forecasts into the radiation_forecasts table (needs the database secret key; see db/README.md)

The assistant answers "forecast on 10 May" from that table, and says how many of the model's calls were right that day.
