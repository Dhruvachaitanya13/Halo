-- HALO database (Supabase / Postgres). Run this whole file once in the Supabase SQL editor. It is safe to run again.
--
--   LIVE      scans                 one row per finished health check, written by the phone (insert only)
--   NASA      nasa_radiation        ISS radiation, 5-minute bins, May 2024 (read only)
--             nasa_space_weather    storm and solar particle reports, May 2024 (read only)
--             nasa_labs             Inspiration4 reference labs, corrected table (read only)
--   MODEL     radiation_forecasts   output of the radiation model, written by the backend
--   VIEWS     scan_feed             the live feed for the dashboard: numbers only, last 48 hours
--             scan_accuracy         camera readings against a reference device
--
-- Who can do what with the public (anon) key that ships in the web page:
--   scans: add rows only.   NASA tables, radiation_forecasts, scan_feed, scan_accuracy: read only.
-- Everything else needs the service key, which stays on the backend and is never committed.

-- ------------------------------------------------------------------ live scans
create table if not exists public.scans (
  id bigint generated always as identity primary key,
  session_id text not null,
  created_at timestamptz not null default now(),
  app_version text, mode text,
  heart_bpm numeric, heart_quality numeric, heart_confidence numeric, heart_method text, heart_region text,
  heart_min_bpm numeric, heart_max_bpm numeric, heart_trend_bpm_per_min numeric,
  hrv_rmssd_ms numeric, hrv_sdnn_ms numeric, beat_irregularity_pct numeric,
  breathing_brpm numeric, breathing_quality numeric, breathing_source text, breathing_interval_cv_pct numeric,
  blink_rate_per_min numeric, mean_blink_ms numeric, long_closures integer, perclos_pct numeric, yawns integer,
  reaction_median_ms numeric, reaction_lapses integer, reaction_false_starts integer, reaction_trials integer,
  gonogo_hit_rate_pct numeric, gonogo_false_alarms integer, gonogo_median_rt_ms numeric, memory_span integer,
  sleep_hours numeric, self_alertness integer,
  scan_seconds numeric, frames integer, motion_pct numeric, scan_grade text,
  heart_task_bpm numeric, heart_recovery_bpm numeric, heart_task_delta_bpm numeric, heart_recovery_delta_bpm numeric,
  expression_label text, smile_pct numeric, brow_furrow_pct numeric,
  mood_label text, mood_valence numeric, self_mood integer,
  docking_error_pct numeric, docking_on_target_pct numeric, docking_docked boolean,
  ml_unusual_moments integer, ml_check_score numeric, ml_check_unusual boolean,
  reference_heart_bpm numeric, reference_breathing_brpm numeric, heart_error_bpm numeric, breathing_error_brpm numeric,
  verdict text check (verdict in ('ready','caution','rest')), readiness_score integer,
  flags jsonb not null default '[]', notes jsonb not null default '[]', details jsonb not null default '{}'
);
create index if not exists scans_session_idx on public.scans (session_id, created_at);
alter table public.scans enable row level security;
-- The public page may only add rows. It cannot read, change or delete anyone's results.
drop policy if exists "anon can insert scans" on public.scans;
create policy "anon can insert scans" on public.scans for insert to anon with check (true);


-- The live feed for the dashboard. It leaves out the session code and the detailed signal data.
create or replace view public.scan_feed as
select id, created_at, mode, verdict, readiness_score, heart_bpm, breathing_brpm, blink_rate_per_min, perclos_pct,
       reaction_median_ms, gonogo_hit_rate_pct, memory_span, docking_on_target_pct, sleep_hours, self_alertness, self_mood, mood_label, scan_grade, flags
from public.scans where created_at > now() - interval '48 hours' order by created_at desc;
grant select on public.scan_feed to anon;

-- Accuracy against a reference device, built from validation-mode scans.
create or replace view public.scan_accuracy as
select count(*) filter (where heart_error_bpm is not null) as heart_n,
       round(avg(abs(heart_error_bpm)) filter (where heart_error_bpm is not null), 1) as heart_mean_abs_error_bpm,
       count(*) filter (where breathing_error_brpm is not null) as breathing_n,
       round(avg(abs(breathing_error_brpm)) filter (where breathing_error_brpm is not null), 1) as breathing_mean_abs_error
from public.scans;
grant select on public.scan_accuracy to anon;

-- ------------------------------------------------------------------ NASA reference data (loaded by db/load_nasa.py)
create table if not exists public.nasa_radiation (
  "timestamp" timestamptz primary key,
  dose_rate_ugy_h numeric not null, dose_rate_max_ugy_h numeric, latitude numeric, longitude numeric, altitude_km numeric,
  in_saa_box boolean, region text, is_peak boolean, peak_threshold_ugy_h numeric, split text,
  dose_in_observed_bin_ugy numeric, observed_dose_accumulated_day_ugy numeric
);
create table if not exists public.nasa_space_weather (
  event_id text not null, "timestamp" timestamptz not null, event_type text not null,
  value numeric, unit text, detail text, record_submission_time_utc timestamptz, event_url text,
  primary key (event_id, "timestamp", event_type)
);
create table if not exists public.nasa_labs (
  astronaut_id text not null, timepoint text not null, panel text not null, analyte text not null,
  timepoint_order integer, phase text, days_from_launch integer, analyte_label text,
  value numeric, unit text, normal_low numeric, normal_high numeric, value_as_published numeric, value_quality text,
  preflight_mean numeric, preflight_sd numeric, preflight_n integer, change_from_preflight numeric, pct_change_from_preflight numeric, z_from_preflight numeric,
  status text, baseline_quality text, source_study text,
  primary key (astronaut_id, timepoint, panel, analyte)
);
create index if not exists nasa_labs_lookup on public.nasa_labs (astronaut_id, panel, analyte, timepoint_order);

-- ------------------------------------------------------------------ model output
create table if not exists public.radiation_forecasts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  for_timestamp timestamptz not null,            -- the 5-minute bin the forecast was made at
  peak_probability numeric not null check (peak_probability between 0 and 1),
  predicted_peak boolean not null,
  model_name text not null, model_version text,
  unique (for_timestamp, model_name, model_version)
);

-- ------------------------------------------------------------------ read-only access for the public key
alter table public.nasa_radiation enable row level security;
alter table public.nasa_space_weather enable row level security;
alter table public.nasa_labs enable row level security;
alter table public.radiation_forecasts enable row level security;
do $$ declare t text; begin
  foreach t in array array['nasa_radiation','nasa_space_weather','nasa_labs','radiation_forecasts'] loop
    execute format('drop policy if exists "anon can read" on public.%I', t);
    execute format('create policy "anon can read" on public.%I for select to anon using (true)', t);
  end loop;
end $$;
-- Explicit grants, so this works whatever the project's default privileges are. Row level security above still applies.
grant usage on schema public to anon;
grant insert on public.scans to anon;
grant select on public.nasa_radiation, public.nasa_space_weather, public.nasa_labs, public.radiation_forecasts to anon;

-- ------------------------------------------------------------------ demo playback data (not NASA, not a camera measurement)
-- 276 rows of composite playback vitals (agent/data/qr_scan_demo_clean.csv). Kept apart from scans. No public read policy:
-- only the secret key can read it until the source and sharing terms of the data are confirmed.
create table if not exists public.demo_vitals (
  demo_record_id text primary key, crew_id text not null default 'CREW_01', scenario text not null default 'baseline',
  step integer not null unique, step_minutes integer not null default 5, elapsed_min integer not null, mission_day integer not null,
  clock_time text not null, activity text not null,
  heart_rate_bpm numeric, resp_rate_bpm numeric, systolic_bp_mmhg numeric, diastolic_bp_mmhg numeric, body_temp_c numeric, spo2_pct numeric,
  bp_new_reading boolean, temp_new_reading boolean, estimated_fields text not null default 'none',
  source_hr_sleep_mood text not null default 'MM_01', source_bp_temp_spo2_resp text not null default 'MI_35446858',
  data_context text not null default 'composite_dataset_demo', measurement_origin text not null default 'master_csv_playback_not_camera',
  display_label text not null default 'Demo data - not measured from your camera'
);
alter table public.demo_vitals enable row level security;
