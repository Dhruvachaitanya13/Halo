# HALO

Crew health monitoring prototype by team Helixonauts for the 2026 NASA Space Apps Challenge
("Create Health Monitoring Software for Astronauts on Space Missions").

HALO is a prototype. It is not a medical device and its results are not medical advice.

## Live health check

Once GitHub Pages is switched on for this repository, the QR page is at

    https://dhruvachaitanya13.github.io/halo/

Open it on a laptop, scan the code with a phone, and the check runs in the phone's browser.
The camera only works over https, which GitHub Pages provides.

## What is in here

| Folder | What it is | Status |
|---|---|---|
| `scan/` | The QR health check: camera heart rate, breathing, blinking, mood, the docking mission game (thinking tests, based on Kavya's Daily Dock), results. Plain HTML and JavaScript, no build step. | Runs. 26 unit tests. Not yet checked on a live person or on Safari. |
| `data/` | The NASA-only dataset (Feature 3 package): ISS radiation in 5-minute bins with train and test tables, space weather events, Inspiration4 labs, a model contract, the build script independent checks (`data/CHECKS.md`), and two optional variants: corrected labs and weather model inputs (`data/ADDITIONS.md`). | Checked and reproducible from `data/raw/`. First baseline: precision 0.93, recall 0.89 on the held-out days. |
| `twilio/` | FastAPI bridge for text and voice alerts through Twilio. | Tested locally only. Not deployed. |
| `docs/` | Team map. | |

These pieces are not connected to each other yet. See "Open work" below.

## Run the health check on your own machine

    cd scan
    npm test            # 24 unit tests, needs Node 20+
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

- Check the scan on real phones (Safari and Chrome) against a pulse oximeter or smartwatch.
- Create the Supabase project, run `scan/supabase_schema.sql`, and put the URL and anon key in `scan/js/config.js` so results are saved.
- Train and compare models on `data/radiation_model_train.csv` following `data/model_contract.json`; tune on a validation split inside training, and keep `radiation_model_test.csv` for the final score. Start from `data/checks/baseline.py`.
- Build the emergency agent and connect it to `twilio/halo_twilio.py` (`ask_agent` and `current_status` are stubs).
- Dashboard that reads the saved scans and the radiation model output.
- Project page with the demo video and documentation.

See `CONTRIBUTING.md` for how to work in this repository.
