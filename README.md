# HALO

Crew health monitoring prototype by team Helixonauts for the 2026 NASA Space Apps Challenge
("Create Health Monitoring Software for Astronauts on Space Missions").

HALO is a prototype. It is not a medical device and its results are not medical advice.

## Live links

| What | Address |
|---|---|
| Project page and health check (start here) | https://dhruvachaitanya13.github.io/Halo/ |
| QR page for the health check | https://dhruvachaitanya13.github.io/Halo/scan/ |
| Crew console (agent status, daily report, crew SOS) | https://dhruvachaitanya13.github.io/Halo/console.html |
| HALO agent API (interactive page) | https://halo-production-a2375a44.up.railway.app/docs |

Open the QR page on a laptop, scan the code with a phone, and the check runs in the phone's browser.
The camera only works over https, which GitHub Pages provides.

## What is in here

| Folder | What it is | Status |
|---|---|---|
| `scan/` | The QR health check: camera heart rate, breathing, blinking, mood, the docking mission game (thinking tests, based on Kavya's Daily Dock), results. Plain HTML and JavaScript, no build step. Saves each check to the database and sends it to the agent. | Live on GitHub Pages. 27 unit tests. Heart rate is not yet confirmed on a live person. |
| `agent/` | The HALO agent (FastAPI): scores each crew member against their own baseline, crew SOS checklists, daily report, nudges, demo scenes. Built by a teammate in `zh315-bit/Halo`, merged here with `git subtree`. | Live on Railway. 350 tests. Checklists are sourced but not medically reviewed. |
| `db/` | Supabase (Postgres) schema, NASA loader, and how to read the data. | Live. NASA tables loaded; scans are saved from the live page. |
| `data/` | The NASA-only dataset (Feature 3 package): ISS radiation in 5-minute bins with train and test tables, space weather events, Inspiration4 labs, a model contract, the build script, independent checks (`data/CHECKS.md`), and two optional variants: corrected labs and weather model inputs (`data/ADDITIONS.md`). | Checked and reproducible from `data/raw/`. First baseline: precision 0.93, recall 0.89 on the held-out days. |
| `twilio/` | FastAPI bridge for text and voice alerts through Twilio, connected to the agent through `twilio_bridge.py`. | Tested locally against the agent. Not deployed; no messages are sent. |
| `docs/` | Team map. | |

How the pieces connect: the phone runs the check in `scan/`, saves the result to Supabase and sends it to the agent. The agent scores it and runs the SOS flow. The NASA tables sit in Supabase for the dashboard. The Twilio bridge talks to the agent over HTTP.

## Run the health check on your own machine

    cd scan
    npm test            # 27 unit tests, needs Node 20+
    npx serve .         # then open the printed address

The camera works on `localhost` and on https. It does not work on a plain http address,
so to try it on a phone use the live GitHub Pages address.

To try it without a camera: `scan.html?demo=scan` (simulated signals, labelled as simulated)
or `scan.html?demo=tests` (thinking tests only).

## Team

| Name | Area |
|---|---|
| Dhruva Chaitanya | Backend, AI |
| Kavya Krishnamurthy | Backend, ML |
| Anusha Prasad | UX |
| Shreyas Kalyanpad | UX |
| Prathiksha Harish | Frontend, AI |
| Chris | ML, Frontend, AI |

## Open work

- Confirm camera heart rate on real phones (Safari and Chrome) against a pulse oximeter or smartwatch.
- Dashboard that reads `scan_feed` and the NASA tables from Supabase and the crew status from the agent.
- Train the radiation model following `data/model_contract.json` and write its output to the `radiation_forecasts` table. Start from `data/checks/baseline.py`.
- Deploy the Twilio bridge and switch the agent from `ALERT_MODE=dry_run` when alerts should really be sent.
- Confirm the source and sharing terms of `agent/data/qr_scan_demo_clean.csv` (composite demo data, not NASA, not a camera measurement).
- Demo video (30 seconds at most) or slides (7 at most) for the submission.

See `CONTRIBUTING.md` for how to work in this repository.
