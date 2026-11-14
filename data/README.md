# Feature 3: Space environment and NASA astronaut reference data

Using thus package instead of the earlier HALO derivative package for this feature.
It rebuilds tables from the uploaded RadLab/DONKI response captures and Inspiration4 source CSV. 
It does not query live NASA services. Original uploads remain unchanged.

## Which file powers which feature?
| File | Use |
|---|---|
| radiation_5min.csv | Historical ISS environment graph; 8,627 observed five-minute bins, May 1–30, 2024, UTC |
| radiation_model_train.csv | 6,797 complete forecast examples from May 1–24 |
| radiation_model_test.csv | 1,722 complete held-out examples from May 25–30 |
| space_weather_events.csv | Historical storm/particle timeline: 20 Kp observations and 14 particle-event reports |
| inspiration4_labs_long.csv | 3,190 source lab records across four astronauts and seven timepoints; units, bounds, baseline comparisons and quality flags |
| inspiration4_labs_wide.csv | 28 astronaut/timepoint snapshots, blood count and chemistry only; use long table for units/ranges/provenance |
| inspiration4_baseline_summary.csv | 459 astronaut/analyte summaries; no clinical recovery inference |
| labs_source_review.csv | Nine suspect source rows plus one proposed missing MCH entry; audit only |
| radiation_missing_bins.csv | 13 absent five-minute bins; no synthetic interpolation |
| radiation_rejected_rows.csv | Rejected source observations; currently header-only, none rejected |
| model_contract.json | Explicit model feature allowlist, targets, dates, threshold and preliminary score disclaimer |
| validation_report.json | Row counts, class counts, quality checks and source hashes |
| data_dictionary.csv | Every CSV column, type and missing count |
| prepare_feature3.py | Reproducible builder; dependencies: pandas and numpy |

## Radiation prediction
At the end of each observed five-minute bin, predict whether ANY of the next six consecutive bins has a dose rate greater than 3 × the TRAINING-only median. The exact threshold is in model_contract.json. This is a statistical peak definition, not a clinical or mission exposure limit. Train only on the contract's feature list. Identity/time fields and labels are not predictor columns. Current-bin measurements are valid predictors only after that bin has closed.

All 8,627 observed bins remain available for the dashboard; 108 rows are excluded from model tables due to unavailable history or incomplete/cross-split target windows. Features use exact contiguous five-minute segments and complete 12-bin rolling windows. The test split can use already observed training-period history; its forecast targets never extend into another split. Use time-based validation inside training and purge training forecast windows overlapping validation. Do not select parameters on the held-out test set.

The earlier precision 0.94 / recall 0.92 were supplied by the user as preliminary untuned results. No fitted model, predictions or evaluation code was provided, and these figures have NOT been reproduced. This package does not claim model accuracy; a model must be trained and re-evaluated with this contract. It also does not include a trained-model artifact or generated predictions.

RadLab inputs: 28,761 unique valid DosTel1 observations in ISS Columbus; dose-rate aggregation retains full numerical precision. Latitude and altitude use means; longitude uses the last observation in the bin to avoid averaging across the dateline. SAA is an approximate geographic box. Dose is absorbed dose in uGy, not effective dose in uSv. Observed-bin dose is mean rate × 5/60; daily accumulated dose excludes missing bins and is not personal astronaut exposure. Within-bin sample coverage is not fully known; daily coverage is observed bins / 288. Clock times are UTC and historical, never live readings.

## Weather context
The 34 timeline rows are NOT 34 independent storms. There are five GST parent objects containing 20 Kp observations, plus 14 SEP reports. Reports may correspond to related detections from different instruments and should not be assumed independent solar episodes. Source query URLs, event IDs and event URLs are retained.

No Kp observation means no observation in this returned storm-event feed, not Kp=0 or proof of quiet weather. Particle-event reports are not ISS dosimeter readings. Event observation time and returned-version submission time are separate. Because verified publication histories are unavailable, weather is a separate historical context panel and is excluded from forecast predictor files. Do not retrospectively join future Kp or revised event records as if known at forecast time.

## Lab rules
1. Use only nonmissing `value`; check `value_quality` first.
2. Compare with supplied lower/upper bounds only; no new normal ranges were invented. `within_available_bound` indicates one-sided coverage, not a complete normal-range assessment. `no_reference_range` means unavailable.
3. Preflight baseline = mean of that astronaut's available preflight values for the same panel, analyte and unit. Difference and percent difference are descriptive; percentages are blank for missing or zero baseline.
4. Z-score requires >=3 baseline values and nonzero sample SD, without clipping. `baseline_quality` and `preflight_n` disclose limitations. Small sample z-scores are not calibrated risk estimates. Baseline summaries and out-of-range counts do not establish diagnosis or flight causation.
5. Exclude suspect source rows from automated rule judgments. Do not treat an excluded or missing value as normal or zero.

Source review: C003/L-92 CBC appears shifted. A prior script proposed shifting nine values, inserting MCH 29.6 and removing absolute basophils. That assertion is not independently confirmed by the supplied source CSV, which is itself an extracted table. This package retains the nine existing suspect records, their published values and correction candidates, but sets analysis `value` blank. The missing MCH proposal appears only in the audit and is not inserted into the long table. Thus the total remains 3,190 source records, with 3,181 usable values. Baselines are recomputed after exclusions, so some have fewer than three points. Do not reapply earlier corrected baselines from other packages.

Panels retained: CBC (553 records), chemistry (509), cardiovascular markers (252), serum immune cytokines (1,876). NULISA serum and urine panels are deliberately excluded from this feature. Source-study IDs and supplied units are retained per record. Sample times are launch/return-relative labels, not fabricated calendar dates: R+1 corresponds to days_from_launch=4 in this source. The long file is the source of truth; wide and summary files are derivatives.

## Backend and UI
Keep NASA environment data and astronaut labs separate from the QR session user's measurements. 
ISS May 2024 and Inspiration4 lab records are not paired subject measurements and must not be 
merged into a health-effect training set.

Suggested labels:
- Environment graph: Historical ISS radiation — May 2024.
- Weather timeline: Historical NASA DONKI reports.
- Lab panel: NASA Inspiration4 reference labs — not your blood results.
- Uncertain lab value: Not assessed — source review.
- Missing reference bounds: Reference range unavailable.
- Forecast before a model is trained: Model not trained.

Filter lab requests by astronaut_id plus panel/analyte/timepoint. Preserve source_study, unit, value_quality and baseline_quality in responses. Convert CSV blanks to JSON null; use a JSON parser/serializer that rejects NaN. Forecast responses must keep observation timestamp, historical context, target definition and model status. Do not manufacture scores or predictions to populate the dashboard.

## Rebuild
Run `python prepare_feature3.py INPUT_DIRECTORY OUTPUT_DIRECTORY` with these original uploads in INPUT_DIRECTORY:
- radlab_donki_2024-05.txt
- radlab_2024-05_extra.txt
- donki_2024-05_full.txt
- inspiration4_labs_long_precorrection.csv

Verification covers counts, unique keys, exact timestamp lag alignment, complete model features, and source hashes. Raw NASA publication provenance, clinical validity and live forecasting availability have not been certified by these checks.
