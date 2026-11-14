# Independent checks on this dataset (14 Nov 2026)

Run from the repository root:

    python data/checks/verify.py data data      # needs pandas, numpy
    python data/checks/baseline.py data data/checks/baseline_results.json   # also needs scikit-learn

## What was checked

| Check | Result |
|---|---|
| The four raw files have the SHA-256 hashes listed in `validation_report.json` | match |
| `prepare_feature3.py` run again on `raw/` reproduces the tables | 11 of 11 data tables byte-identical. `data_dictionary.csv` differs only in a type name (`str` vs `object`, a pandas version difference) and `validation_report.json` has one extra note in the shipped copy. |
| 8,627 five-minute rows, unique and sorted, 1-30 May 2024, 13 missing bins | pass |
| Train 6,797 rows within 1-24 May; test 1,722 rows within 25-30 May; no shared rows | pass |
| Model files hold only id, time, the 18 contract features and the target; no missing values | pass |
| Peak threshold equals 3 x the training-period median dose rate (11.60008 uGy/h) | pass |
| Every label recomputed from the next six bins; 5- and 30-minute lags match the series | pass, train and test |
| No training label window reaches into the test period | pass |
| Dose rates against the earlier pack | all 8,627 rows match, largest difference 0.00005 uGy/h (rounding in the earlier pack) |
| Labs: 3,190 rows, 4 astronauts, 7 timepoints, unique keys, 9 values blank for source review | pass |
| Space weather: 34 rows (20 Kp readings, 14 particle-event reports) | pass |
| `data_dictionary.csv` covers every column of every CSV | pass |

Not checked: the raw files against NASA's services today, and the clinical meaning of any lab value.

## First baseline under `model_contract.json`

Task: at the end of a five-minute bin, will any of the next six bins exceed the peak threshold?
Fit on 1-19 May, decision threshold chosen on 20-24 May (30-minute purge before the cut), then refit on all training rows and scored once on the held-out test set (25-30 May, 18.3% positive).

| Model | Precision | Recall | F1 | ROC AUC | Average precision |
|---|---|---|---|---|---|
| Naive: "current bin is above the threshold" | 0.652 | 0.232 | 0.342 | | |
| Logistic regression, balanced classes | 0.666 | 0.613 | 0.638 | 0.911 | 0.685 |
| Gradient boosting (scikit-learn HistGradientBoosting, depth 4, 200 rounds) | 0.933 | 0.886 | 0.909 | 0.991 | 0.969 |

These replace the earlier, unreproduced 0.94 / 0.92. They are one untuned run each. The test set has now been looked at once; further model selection should use the validation split inside training, not the test set.

The peak threshold is a statistical definition (three times the median), not a NASA exposure limit.
