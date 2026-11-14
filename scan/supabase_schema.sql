-- HALO live scans (app version 0.6). Run once in the Supabase SQL editor.
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
create policy "anon can insert scans" on public.scans for insert to anon with check (true);

-- Accuracy against a reference device, built from validation-mode scans.
create or replace view public.scan_accuracy as
select count(*) filter (where heart_error_bpm is not null) as heart_n,
       round(avg(abs(heart_error_bpm)) filter (where heart_error_bpm is not null), 1) as heart_mean_abs_error_bpm,
       count(*) filter (where breathing_error_brpm is not null) as breathing_n,
       round(avg(abs(breathing_error_brpm)) filter (where breathing_error_brpm is not null), 1) as breathing_mean_abs_error
from public.scans;
