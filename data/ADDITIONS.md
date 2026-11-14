# Two optional additions to the Feature 3 tables

Built by `apply_additions.py` (run it after `prepare_feature3.py`). The original Feature 3 files are unchanged; these sit beside them.
Use the original files when you want the cautious version, and these when you want the correction or the weather inputs.

## 1. Corrected labs

| File | What it is |
|---|---|
| `inspiration4_labs_long_corrected.csv` | The long lab table with the C003 / L-92 blood-count correction applied and all baselines recomputed. 3,191 rows. |
| `inspiration4_labs_wide_corrected.csv` | The wide blood count and chemistry table from the corrected values. |
| `inspiration4_baseline_summary_corrected.csv` | The per-astronaut summary from the corrected values. |

In the source table, astronaut C003's blood count at L-92 has nine values one row out of place (for example a platelet count of 12.9 and neutrophils of 10.1 cells/uL).

Why the correction is safe to apply: six of the corrected values can be recomputed from values in the same blood draw that were not shifted.

| Analyte | Corrected value | Recomputed from unshifted values | How |
|---|---|---|---|
| Absolute neutrophils | 6826 | 6825.6 | white cell count x neutrophil % |
| Absolute lymphocytes | 1997 | 1996.8 | white cell count x lymphocyte % |
| Absolute monocytes | 614 | 614.4 | white cell count x monocyte % |
| Absolute eosinophils | 125 | 124.8 | white cell count x eosinophil % |
| MCH | 29.6 | 29.6 | haemoglobin / red cell count x 10 |
| MCHC | 32.4 | 32.4 | haemoglobin / haematocrit x 100 |

The other three (RDW 12.9, platelet count 330, MPV 10.1) cannot be recomputed this way. They are the neighbouring values in the same shift and sit close to the same astronaut's other pre-flight draws (13.2 and 12.5; 345 and 367; 10.3 and 10.8).

What changed in the table, marked in `value_quality`:

- `corrected_row_shift` (8 rows): `value` holds the corrected number; `value_as_published` still holds NASA's published number.
- `restored_row_missing_from_source` (1 row): MCH at L-92 was missing from the source and is added with 29.6.
- `suspected_row_shift_excluded_pending_review` (1 row): absolute basophils at L-92 stays blank. Its real value fell off the end of the shifted row and is not in the source.

## 2. Space weather as model inputs

| File | What it is |
|---|---|
| `radiation_model_train_weather.csv`, `radiation_model_test_weather.csv` | The same rows as the model tables, with six weather columns added before the target. |
| `model_contract_weather.json` | The contract with the 24 features (18 + 6). |

| Column | Meaning |
|---|---|
| `wx_storm_report_active_6h` | a storm Kp reading from the last 6 hours is known |
| `wx_kp_last_known_6h` | the latest such Kp value; 0 means no storm report, not Kp 0 |
| `wx_kp_max_known_24h` | highest known Kp in the last 24 hours; 0 means none |
| `wx_hours_since_storm_kp` | hours since the last known storm Kp reading, capped at 72 |
| `wx_particle_reports_known_24h` | number of solar particle reports known from the last 24 hours |
| `wx_hours_since_particle_report` | hours since the last known particle report, capped at 72 |

Timing rule: a record is used only after both its observation time and the submission time of the returned record have passed. That can make a record available later than it really was, never earlier, so the forecast cannot see the future.

What the numbers say:

| Gradient boosting, held-out test days | Precision | Recall | F1 |
|---|---|---|---|
| 18 features (no weather) | 0.933 | 0.886 | 0.909 |
| 24 features (with weather) | 0.911 | 0.911 | 0.911 |

There is no real difference, and there could not be one: every storm and particle report falls on 2-17 May 2024. The validation days (20-24 May) and the test days (25-30 May) contain none, so the weather columns are constant there. In training, bins with an active storm report had peaks ahead 29% of the time against 18% otherwise, but that comes from a single storm period and may reflect the orbit as much as the storm.

So the weather columns are available and leak-free, but this month of data cannot show whether they improve the forecast. Showing that needs radiation data from a second storm period to test on.
