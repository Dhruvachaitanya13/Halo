# HALO NASA data pack v8 (14 Nov 2026) - clean, preprocessed, model-ready

Everything here was downloaded from NASA data services. Nothing is simulated or gap-filled.

## Files
| file | rows x cols | one row is | use it for |
|---|---|---|---|
| `radiation_features.csv` | 8,627 x 36 | one 5-minute step on the ISS, 1-30 May 2024 | radiation replay, peak countdown, model training |
| `space_weather_events.csv` | 34 x 5 | one storm reading or solar particle event, May 2024 | storm replay |
| `labs_wide.csv` | 28 x 47 | one astronaut at one timepoint, 39 routine blood tests as columns | lab panel |
| `labs_long.csv` | 3,190 x 21 | one blood test result (115 tests incl. immune and heart markers) | baseline and change |
| `labs_change_summary.csv` | 457 x 15 | one astronaut x test: change after flight, whether it recovered | recovery tracker |
| `build_halo_v8.py` | | | rebuilds all of the above from `raw/` |

## Features this pack supports (no live input needed)
1. Astronaut lab panel: each test against the lab's normal range (`labs_wide`, `labs_long.status`).
2. Personal baseline and change: `preflight_mean`, `pct_change_from_preflight`, `z_from_preflight`.
3. Recovery tracker: `pct_change_day_after_return`, `back_within_tolerance_at_last`, `first_timepoint_back_within_tolerance`.
4. Radiation replay: `dose_rate_ugy_h`, `dose_accumulated_day_ugy`, with `latitude` / `longitude` for the map.
5. Storm replay: `space_weather_events.csv`, plus `geomagnetic_storm_active` and `particle_event_last_24h` on every radiation row.
6. Radiation peak countdown: the targets below.

## radiation_features.csv
- Measured: `timestamp` (UTC), `dose_rate_ugy_h` (mean of the step), `dose_rate_max_ugy_h`, `latitude`, `longitude`, `altitude_km`, `n_samples`.
- Position features: `abs_latitude`, `lat_moving_north`, `lon_sin`, `lon_cos`, `in_saa_box`, `region`.
  `in_saa_box` is an approximate box over the South Atlantic (lat -50..0, lon -90..40), not an official boundary.
- History features: `dose_rate_lag_5/10/15/30min`, `dose_rate_roll_median_1h`, `dose_rate_roll_max_1h`.
- Space weather: `kp_index_storm` (blank when no storm was reported; blank does NOT mean zero), `geomagnetic_storm_active`,
  `hours_since_particle_event`, `particle_event_last_24h`.
- Targets: `target_dose_rate_plus_5min/15min/30min`, `target_peak_within_30min`. `is_peak` = dose rate above 3x the month's median (3.87).
- Bookkeeping: `segment_id` (4 unbroken runs; lags and targets never cross a gap), `minutes_since_prev`, `date`, `hour_utc`,
  `dose_in_bin_ugy`, `split` (train = 1-24 May, test = 25-30 May).
- Do not use any `target_*` column, `is_peak` of a future row, or `dose_accumulated_day_ugy` as an input when predicting.

## Baseline check I ran (untuned, one split, to prove the table trains)
| task | result on 25-30 May | naive comparison |
|---|---|---|
| Will a peak occur in the next 30 min? | AUC 0.996, precision 0.94, recall 0.92 | 18% of rows are positive |
| Dose rate in 30 min | R2 0.69, mean error 3.0 uGy/h | repeating the current value: R2 -1.05, error 12.8 |
| Dose rate in 15 min | R2 0.41, mean error 3.7 uGy/h | repeating the current value: R2 -1.00, error 12.4 |
Peaks are predictable mainly because the station's orbit is: 82% of peaks fall inside the South Atlantic box.

## Blood tests: what to know
- 4 astronauts, 7 timepoints (3 before launch, 4 after return). No in-flight samples.
- **This is too small to train a model on.** Use rules and each person's own baseline. `z_from_preflight` rests on 3 points and is capped at +/-10.
- **One source error corrected.** In NASA's file, astronaut C003's first blood count (L-92) has one value missing and the next nine
  shifted down a row (e.g. platelets listed as 12.9, MPV as 330). I moved them back; the white-cell arithmetic confirms it, and all nine
  now sit in the normal range. Corrected rows have `corrected = True` and keep the original in `value_as_published`.
  That sample's absolute basophil count was never published and is absent. Data packs v1-v7 still contain the uncorrected values.
- Immune and heart-marker tests have no normal range (`status = no_reference_range`).

## Cleaning done
- Radiation: 28,761 raw readings, no duplicates, all within plausible ranges; averaged to 5-minute steps; 30 complete days.
- Space weather re-pulled for the whole month so storm flags cover every radiation row.
- Labs: units from the lab-submitted files, sex-specific labels merged, empty results dropped, source shift corrected, baselines recomputed.

## Checklist for the tester
1. Row counts match the table above; `row_id` and `timestamp` are unique in `radiation_features.csv`.
2. Steps inside a `segment_id` are 5 minutes apart; `minutes_since_prev` > 15 only at the 3 segment starts.
3. `target_dose_rate_plus_5min` on row n equals `dose_rate_ugy_h` on row n+1 within the same segment.
4. Sum of `dose_in_bin_ugy` per day is 173-241 uGy.
5. No `test` row has a date before 25 May.
6. `labs_wide.csv` has 28 rows = 4 astronauts x 7 timepoints; every `out_of_range_tests` entry is outside its range in `labs_long.csv`.
7. The 9 `corrected` rows: confirm you agree with the fix before relying on C003's baseline.
8. Re-run `python build_halo_v8.py` from this folder's parent layout and compare outputs.

## Limits
- The astronauts (SpaceX Dragon, 2021) and the radiation (ISS, 2024) are different missions. Do not join them as one crew.
- The detector (DosTel1) is a German instrument in the European module, served by NASA RadLab; Kp is NOAA's, served by NASA DONKI.
- One month, one detector, one location in the station. A model trained here is not validated for other periods or modules.
- Radiation has no normal/watch/act status: NASA's exposure limits still need to be looked up and applied.

## Credit
NASA OSDR OSD-569, OSD-575 (SpaceX Inspiration4) - NASA OSDR RadLab (DosTel, DLR) - NASA CCMC DONKI.
