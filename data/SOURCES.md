# HALO final dataset - sources (retrieved 13-14 Nov 2026, UTC)

All data downloaded from NASA data services.

| File | NASA service | Dataset ID | Measured / produced by | Period covered |
|---|---|---|---|---|
| labs_wide.csv, labs_long.csv, labs_change_summary.csv (blood count) | NASA Open Science Data Repository | OSD-569, version-4 folder | SpaceX Inspiration4 crew study led by Weill Cornell Medicine | L-92 to R+194 (2021-22) |
| same files (blood chemistry, heart and vessel markers, immune markers) | NASA Open Science Data Repository | OSD-575, version-3 folder | same study | same |
| radiation_features.csv | NASA OSDR RadLab | instrument DosTel1, ISS Columbus module | DosTel detector (German Aerospace Center, DLR - not verified against RadLab documentation) | 1 May 2024 00:00 to 30 May 2024 23:55 UTC |
| space_weather_events.csv, storm index | NASA DONKI, GST | 5 storms | Kp values from NOAA (stated in each DONKI record) | 2-17 May 2024 |
| space_weather_events.csv, solar particle events | NASA DONKI, SEP | 14 events | DONKI event catalogue | 9-13 May 2024 |

## Exact addresses
| Data | Address |
|---|---|
| Blood count | nasa-osdr.s3.amazonaws.com/OSD-569/version-4/Complete_Blood_Count/LSDS-7_Complete_Blood_Count_CBC.upload_SUBMITTED.csv |
| Blood chemistry | nasa-osdr.s3.amazonaws.com/OSD-575/version-3/Comprehensive_Metabolic_Panel/LSDS-8_Comprehensive_Metabolic_Panel_CMP.upload_SUBMITTED.csv |
| Heart and vessel markers | nasa-osdr.s3.amazonaws.com/OSD-575/version-3/Multiplex/LSDS-8_Multiplex_serum.cardiovascular.EvePanel_SUBMITTED.csv |
| Immune markers | nasa-osdr.s3.amazonaws.com/OSD-575/version-3/Multiplex/LSDS-8_Multiplex_serum_immune_EvePanel_TRANSFORMED.csv |
| Radiation | visualization.osdr.nasa.gov/radlab/api?instrument_id=DosTel1&timestamp>=2024-05-01&timestamp<2024-05-31&module&absorbed_dose_rate&latitude&longitude&altitude&format=csv (15 two-day slices) |
| Storm index | api.nasa.gov/DONKI/GST?startDate=2024-04-28&endDate=2024-05-31 |
| Solar particle events | api.nasa.gov/DONKI/SEP?startDate=2024-04-28&endDate=2024-05-31 |

## Counts
| Item | Value |
|---|---|
| Radiation readings downloaded | 28,761 |
| Radiation rows (5-minute steps) | 8,627 over 30 complete days, 4 unbroken segments |
| Space-weather rows | 34 (20 storm-index readings, 14 solar particle events) |
| Blood-test results | 3,190 across 115 tests (20 blood count, 19 blood chemistry, 9 heart and vessel, 67 immune) |
| Astronauts x timepoints | 4 x 7 (L-92, L-44, L-3, R+1, R+45, R+82, R+194) |
| Values corrected by us | 9 (astronaut C003, L-92 blood count; originals kept in value_as_published) |

## Calculated by us, not downloaded
Lab files: status, preflight_mean, preflight_sd, change and percent change from pre-flight, z_from_preflight, out-of-range counts, recovery columns.
radiation_features.csv: 5-minute averages, position features, in_saa_box, region, lag and rolling columns, is_peak, target_* columns, dose totals, storm flags, segment_id, split.

Files were retrieved through a web-fetch tool that converts to text, so they are not byte-identical to NASA's originals.
Blood count and chemistry values were checked against NASA's own processed tables and matched.
