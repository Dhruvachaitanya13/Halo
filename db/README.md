# HALO database

Supabase (hosted Postgres), free plan. One database holds both kinds of data, in separate tables that are never merged.

| Table or view | Holds | Written by | Public key can |
|---|---|---|---|
| `scans` | one row per finished health check (live) | the phone, at the end of a check | add rows only |
| `scan_feed` (view) | last 48 hours of scans, numbers only, no session code | | read |
| `scan_accuracy` (view) | camera readings against a reference device | | read |
| `nasa_radiation` | ISS radiation, 5-minute bins, May 2024 (8,627 rows) | `load_nasa.py`, once | read |
| `nasa_space_weather` | storm and solar particle reports, May 2024 (34 rows) | `load_nasa.py`, once | read |
| `nasa_labs` | Inspiration4 reference labs, corrected table (3,191 rows) | `load_nasa.py`, once | read |
| `radiation_forecasts` | output of the radiation model | the backend | read |

The model training tables (`data/radiation_model_*.csv`) stay as files in this repository. Training reads files; only what the dashboard shows needs to be in the database.

## Set up (about ten minutes)

1. Create a free project at supabase.com. Pick the region nearest to where you will demo.
2. SQL editor: paste all of `db/schema.sql` and run it. It is safe to run again.
3. Load the NASA tables from your computer:

       export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
       export SUPABASE_SERVICE_KEY=...      # Settings > API keys > secret key. Never commit it.
       python db/load_nasa.py

4. Put the project URL and the **publishable (anon)** key in `scan/js/config.js`, commit and push. That key is meant to be public.
5. Run one health check on the live site and look for the new row in the `scans` table.

## Reading the data (dashboard)

    GET {SUPABASE_URL}/rest/v1/scan_feed?select=*&limit=20
    GET {SUPABASE_URL}/rest/v1/nasa_radiation?select=timestamp,dose_rate_ugy_h,is_peak&order=timestamp&timestamp=gte.2024-05-10
    GET {SUPABASE_URL}/rest/v1/nasa_labs?astronaut_id=eq.I4_C003&panel=eq.blood_count&order=timepoint_order

with headers `apikey: <publishable key>` and `Authorization: Bearer <publishable key>`. For a live feed, ask `scan_feed` every five seconds; that is simple and well inside the free limits.

## Rules

- The service (secret) key goes only in backend environment variables, never in the web page or in git.
- Do not join `scans` to the NASA tables. Judges' readings and astronaut data are different people at different times.
- Free plan limits at the time of writing (supabase.com/pricing, 14 Nov 2026): 500 MB database, 5 GB egress, two active projects, and a project is paused after one week without activity. This data set uses a few MB.
- `scan_feed` is readable by anyone who has the page. It carries no names and no session codes, only measurements. Do not add identifying columns to it.

Checked on a local Postgres 16: the schema runs twice without error, and the public role can add scans, read the feed and the NASA tables, and cannot read `scans` directly or change or delete anything. Not yet run on a real Supabase project.
