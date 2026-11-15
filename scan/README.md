# HALO live health check (QR section)

A phone-friendly web page a judge opens by scanning a QR code. In about two minutes it runs:

1. **Consent screen**: nothing starts until the person agrees.
2. **45-second camera scan**: heart rate, breathing rate, blink rate and eye-closure time.
3. **Thinking tests**: reaction time, plus attention and memory in the longer modes.
4. **Two sleep questions**: hours slept, self-rated alertness.
5. **Results card**: ready / caution / rest, every value labelled "live measurement" or "experimental", saved to the database.

The video is processed on the device and never uploaded or stored. Only the numbers are saved, under a random session code.

## Run it
```
npm test          # 22 signal-processing tests
npx serve .       # then open http://localhost:3000  (camera needs localhost or https)
```
Deploy: push this folder to GitHub and import it in Vercel as a static site (no build step, no framework).

## Connect the database (Supabase)
1. Run `supabase_schema.sql` in the Supabase SQL editor.
2. Put the project URL and anon key in `js/config.js`.
The page can only insert rows; it cannot read or change anyone's results. Without a database the results screen offers a JSON download.

## Files
| file | what it is |
|---|---|
| `index.html` | landing page that shows a QR code for a new session |
| `scan.html` | the health check |
| `js/app.js` | camera, face tracking, reaction test, results, saving |
| `js/dsp.js` | signal processing: heart rate, breathing, blinks, reaction stats, screening rules |
| `js/config.js` | database keys, scan length, number of trials |
| `tests/dsp.test.mjs` | tests for `dsp.js` |
| `supabase_schema.sql` | the `scans` table |
| `vendor/qrcode.js` | QR generator (qrcode-generator 2.0.4, MIT) |

## Options (consent screen)
| option | choices |
|---|---|
| Check length | Quick: 30 s scan + reaction test. Standard: 45 s + reaction + attention. Full: 60 s + reaction + attention + memory |
| Heart-rate method | Automatic (tries POS, CHROM and green on each skin region and keeps the cleanest), or force one |
| Camera | Front or back |
| Show measured regions | Draws the forehead, cheek and chest boxes on the video |
| Validation mode | Asks for a reference heart rate and a counted breathing rate, and saves the error |
Choices are remembered on the device. Scan lengths, trial counts and the quality cut-off are in `js/config.js`.

## What it measures (version 0.2)
| value | method | label |
|---|---|---|
| Heart rate | three skin regions x three methods (POS, CHROM, green); cleanest signal wins; tracked in 10-second windows | live measurement |
| Heart-rate range, trend, confidence | from the tracked windows, the signal quality and how many other region/method pairs agree within 3 bpm | live measurement |
| Beat-to-beat variation (RMSSD, SDNN), irregularity | beat timing on the pulse wave; shown only at quality 0.6+ with clean beats | experimental |
| Breathing rate | chest movement below the chin, cross-checked against breathing-linked changes in beat timing | experimental |
| Breathing regularity | variation between breaths | experimental |
| Blink rate, blink length, eye-closure share, long closures | MediaPipe eye-blink scores | live measurement |
| Yawns | jaw-open score held for 1.2 s or more | live measurement |
| Reaction time, slow responses, early taps | tap when green | live measurement |
| Attention | go/no-go: tap on green, hold on red; hit rate, taps on red | live measurement |
| Memory span | repeat a growing sequence on a 3x3 grid | live measurement |
| Scan quality A-D | frame rate, movement, lighting, face size, pulse signal | live measurement |
| Readiness score 0-100 and its five parts | cardio, respiratory, alertness, cognitive, sleep; weights in `readinessScore()` | experimental |
| Change from your baseline | robust z-score against earlier checks on the same device (needs 3) | experimental |

Every heart and breathing value has a signal quality from 0 to 1. Below 0.35 the value is not shown and not saved.
Exports: full results as JSON, the heart-rate series as CSV. The `scan_accuracy` view in the SQL file summarises validation-mode errors.

## Added in version 0.3
| feature | how it works | label |
|---|---|---|
| Facial expression | share of the scan spent smiling, brow-furrowed, lips pressed; one summary label. It describes the face, not the mood | experimental |
| Docking task | keep a crosshair on a drifting docking port for 25 s; average distance, time on target, time to first lock, docked or not | live measurement |
| Heart rate during the tests and after resting | the camera stays on (small corner view) through the tests and a 15 s still period; compared with the resting scan | experimental |
| Trend labels | stable / improving / declining for reaction time, docking error, memory span and readiness score, over the last 4-8 checks on the device | experimental |
| Unusual moments in the scan | an isolation forest (unsupervised machine learning) fitted to two-second windows of eye closure, chest movement, pulse strength and lighting | experimental |
| Unusual check | the same model fitted to the person's earlier checks; needs 8 of them; flags a check that scores above every earlier one | experimental |

Standard mode is now reaction + docking + attention; Full adds memory. Turn "Keep the camera on during the tests" off to stop the camera after the scan.
The model learns only from the scan in progress and that person's own history. It is not trained on NASA data or on other people.

## What has been tested, and what has not
Tested here:
- `dsp.js` on synthetic signals, 22 of 22 tests pass (the six new ones cover expression labels, docking scoring, trend labels, the
  isolation forest, unusual moments and unusual checks). The earlier sixteen cover: heart rate within 2 bpm at 52-130 bpm for all three methods; choosing a clean region
  over a noisy one; tracking a rising heart rate; beat counting and interval timing; breathing from chest movement and from beat timing;
  fusion of the two; blink, yawn, reaction, attention and memory scoring; baseline deviation; scan grading; readiness score.
- In a headless phone browser: options, consent gate, reaction, docking, attention and memory tests, validation fields, trends and
  model cards with a seeded history, results card with score,
  and that the camera is released when the face tracker fails to load.

NOT tested, because my workspace has no real camera and cannot reach the face-tracker download:
- The scan on a real face. Nothing in this folder has measured a real person yet.
- Beat-to-beat variation and both breathing methods on real video. Treat them as the least reliable values.
- Facial expression, heart rate during the tests (hands move the phone, so expect weak signal), the corner camera view on real phones,
  and the within-scan model on real windows.
- Yawn detection on a real face, the heart-rate chart with real data, and saving to a real Supabase project.

## First things to do
1. Turn on validation mode and scan 5 people wearing a smartwatch or pulse oximeter. The `scan_accuracy` view then gives your error.
2. Check breathing against a counted breath rate. If it is not within about 2 per minute, hide it for the demo.
3. Try bad light, glasses, darker and lighter skin, and a moving head, and note where quality drops below 0.35.
4. Tune the cut-offs in `assess()` and the weights in `readinessScore()`; they are starting values, not validated.

## Limits
- Estimates for a demonstration, not a medical device. It flags; it does not diagnose.
- Camera heart rate degrades with movement, poor light and darker skin tones.
- The face tracker (about 30 MB) and its model load from Google and jsDelivr when the scan starts, so the first scan needs a good connection.
- "Your earlier median" compares with previous checks on the same device only (browser storage).

## Credits
POS method: Wang, den Brinker, Stuijk, de Haan, "Algorithmic Principles of Remote PPG", IEEE TBME 2017.
Face tracking: Google MediaPipe Tasks Vision 1.2.3 (Apache-2.0). QR: qrcode-generator (MIT).
No code was copied from other repositories.

## Version 0.4
- Live scan screen: countdown ring, step indicators (camera, face tracker, face, lighting, stillness), live tiles for heart rate with a
  signal bar, breathing, blinks, eye closure, expression and frame rate, a live pulse wave, and a running event log.
- The face tracker starts downloading when the page opens; Safari uses the processor path, which avoids a hang on its graphics path.
- "Skip the scan" works at any time, including while the tracker is still loading; it becomes "Finish the scan early" once tracking starts.
- `scan.html?demo=scan` drives the scan screen with test signals and no camera. It is labelled SIMULATED on screen and nothing is saved.
- `scan.html?demo=tests` runs only the thinking tests.

## Version 0.5
- **Fixed: the scan never started.** Two elements shared the id `overlay` (the "show measured regions" checkbox and the video overlay canvas),
  so the scanner tried to draw on the checkbox and stopped before the first frame. The canvas is now `roicanvas`.
- The scan loop can no longer stop silently: each frame is guarded, three failures switch the tracker's input between the video and a
  canvas copy, and twelve in a row end the scan with the error shown.
- A diagnostics line under the event log shows frames processed, faces found, milliseconds per frame, video size, tracker path and the
  last error, so one screenshot is enough to see what happened.
- A once-a-second watchdog reports a stalled camera, a tracker that sees no face, or a slow device.
- The Start button cannot start two scans; the scan waits for the first camera picture before starting.
- `VISION_URL` and `MODEL_URL` in `js/config.js` let you host the face tracker files yourself instead of loading them from Google and jsDelivr.

Tested for 0.5 in a Chromium test browser with the real face tracker and a still photo of a face as the camera: the tracker loaded,
found the face, the steps went green, the countdown ran, and the scan handed over to the tests with the corner camera view in place.
Still NOT tested: Safari itself, and heart rate, breathing and blinks on a live person (a still photo has no pulse).

## Version 0.6
- **Breathing rate now comes from three independent sources**: movement of the neck, shoulders and upper chest; the rise and fall of the
  head (averaged over all 478 face points, so it works when the chest is out of frame); and, in the final result, the breathing rhythm in
  beat timing. Sources that agree within 3 breaths a minute are averaged and marked as agreeing. The live tile shows the rate from
  15 seconds in, with the source and a signal bar. The chest region now starts just under the chin, so it no longer needs a wide shot.
- **Mood**: the expression reading is compared with the person's own resting face (the first two seconds) and reports a label
  (positive, neutral, tense, low), a valence from -100 to 100 and the share of time smiling, tense or frowning. The live tile shows the
  expression right now. A self-reported mood question was added; when answered, it is the headline mood and the expression estimate
  sits beside it. The expression estimate reads the face, not the feeling.
- A progress bar at the top shows Consent, Scan, Tests, Questions, Results.
Tested: 24 of 24 signal tests (two new: multi-source breathing, mood). The new breathing and mood code has not been run on a live person.

## Version 0.7

New theme ("Flight chart"). Nothing in the measurement code changed.

- Light, high-contrast paper-and-ink look with one accent colour; green, amber and red are used only for status.
- Numbers and labels use tabular monospace figures so readings do not jump while they update.
- A dark variant follows the phone's own light/dark setting automatically.
- Every colour is a CSS variable at the top of `style.css`. The pulse wave, quality bars and heart-rate chart in `js/app.js` read the same variables, so changing the palette is a one-place edit.
- The camera stage and the docking game stay dark on purpose (live video, space scene).
- The theme is an original design. It follows published guidance for clinical interfaces (high contrast, tabular figures, restrained colour, light and dark modes); it does not copy any site and uses no NASA logo or branding.
- Checked: 24 unit tests, no duplicate ids, and the full simulated flow (consent, scan, test, questions, results) in headless Chromium at phone size in light and dark. Not checked: Safari on a real phone, or any reading on a live person.

## Version 0.8

Heart rate was often "signal too weak" on real use. Cause and fix:

- **Cause.** Skin colour was read only on frames the face tracker had finished. On Safari the tracker runs on the CPU and takes 50-150 ms a frame, so the pulse signal had roughly 7-15 samples a second. The pulse is a brightness change of under 1%, and at that rate it is lost in camera noise.
- **Fix.** Skin colour is now read on every camera frame (`requestVideoFrameCallback`), independent of the tracker, using the last face position. The tracker runs at most half of the time so camera frames are not blocked.
- The face box is smoothed, so tracker jitter no longer slides the measured regions across the skin. A quarter second of samples is dropped after a head movement.
- A peak on the edge of the search band (42 or 180 bpm) is treated as drift and rejected.
- Heart rate during the tests and after resting is shown only when the resting scan itself worked and the short-window signal is clearly good. Before, a value such as "52 bpm after resting" could appear while the resting value was missing.
- When the heart signal is too weak the result now says why: signal quality, colour samples per second, and what to change (light, movement, frame rate).
- Breathing is not reported from fewer than 2 readings a second.
- The diagnostics line under the scan shows the number of colour samples.

Checked: 26 unit tests. A simulation with a weak pulse and realistic noise gave a correct, reported value in 5 of 40 runs at 8 samples/s, 9 of 40 at 15, and 35 of 40 at 30. A full scan in headless Chromium with the real face tracker on a video of a still portrait whose skin tone was modulated at 72 bpm returned 72 bpm, although the tracker there managed only 16 frames in 27 s. That modulation (about 1%) is stronger than a real pulse.

Not checked: a live person, or Safari. Camera heart rate still needs even front light and a still head; in dim room light on a laptop camera it can honestly fail, and the app will say so rather than guess.

## Version 0.9

The thinking tests are now one game, the **docking mission** (`js/mission.js`). It is based on the four rounds of Kavya's "MissionPulse - Daily Dock" (reaction, go/no-go attention, control, sequence memory), rebuilt on one canvas so it plays by touch on a phone as well as by keyboard.

| Stage | Measures | How it plays |
|---|---|---|
| Ignition | reaction time, early taps, misses (cue times out after 1.5 s) | tap when the amber ring turns green |
| Debris field | go/no-go attention: hits, misses, taps on debris | tap supply pods (blue diamond), leave debris (red rock); about 30% are debris, each visible 1 s |
| Clearance code | memory span, 3 to 7, ends after two wrong codes in a row | six ports flash in order; tap them back, or use keys 1-6 |
| Final approach | tracking error, time on target, docked or not, over 25 s | drag to steer the crosshair onto a drifting port; arrows or WASD also work |

- Which stages run still follows the check length in `js/config.js` (quick: Ignition only; standard: three stages; full: all four).
- Points, streaks, sounds, vibration and particles are for fun only. They never enter the readiness score. The measurements are the raw trial data, turned into the same statistics as before by `js/dsp.js`.
- Cues are visual only. Sounds play after a response, never with a cue, so they cannot shorten a reaction time. Sound can be switched off in the game header.
- On touch the crosshair is dragged like a trackpad, so the finger does not cover the target.
- Changes that affect comparison with earlier checks: the memory stage has 6 ports (was 9 squares), and a missed reaction cue now counts as a miss instead of waiting forever. Records carry `tests.mission.game_version: 2`.
- Checked: an automated player completed the full mission at phone size with no errors and the results page showed the expected values; Space and touch-drag input were checked separately. Not checked: play on a real phone, sound, or vibration.

## Version 0.10

Based on the first scan saved from a real device (heart rate missing, face tracker at 7 frames a second).

- **Pulse first on slow devices.** When the face tracker needs more than about 28 ms a frame (typical for Safari), the first 60% of the scan gives the pulse priority: the tracker only refreshes the face position 2.5 times a second and every camera frame goes to the colour sampler. The rest of the scan runs the tracker at full speed to time blinks. Blink rate then comes from that second part only, and resting heart rate from the first part. Fast devices do both throughout, as before.
- **Chest movement is sampled with the camera frames**, not with the tracker, so breathing does not degrade when the tracker is slow.
- **Signal quality now accounts for short recordings.** With few independent frequency bins (a short recording or the narrow breathing band), noise alone often looks like a peak. The score uses Fisher's test so that 0.35 always means "noise would do this less than 5% of the time". Before this, a still photograph could return a breathing rate with "good signal".
- **Verdict rule.** "Rest advised" now needs two performance or drowsiness flags, or a readiness score under 50. Three mild flags used to be enough, which gave "Rest advised" next to a score of 73.
- **Diagnostics are saved with each scan** (`details.diagnostics`): tracker time per frame, colour samples per second, whether the scan was phased, mean brightness. The scan-quality note now reports pulse samples per second instead of tracker frames.
- Checked: 27 unit tests; a full scan in headless Chromium with the real face tracker on the 72 bpm test video. Not checked: Safari, or a live person. The phased scan is designed for Safari and has only run in Chromium.

## Version 0.11

- Each real scan is also sent to the HALO agent (`POST {AGENT_URL}/api/v1/scan` as `{crew_id, record}`) when `AGENT_URL` is set in `js/config.js`. The results page shows the agent's answer, for example "Baseline building (1/3)". Simulated runs are never sent. A link with `?crew=LIVE_02` files the scan under that crew id.
- The agent must be on https for phones to reach it from the live page. `http://localhost` only works for a browser on the same computer.
- Checked: a full scan in headless Chromium reached a locally running agent, which accepted it and listed the crew. Not checked: against a deployed agent.

## Version 0.12

From the second real-device scan (heart signal quality 26%, needing 35%; 27 colour samples a second; "+8000000000 vs your baseline" on blink rate; "Not saved: no database is configured" on a browser that held an old cached config file).

- **Stale files.** The page now loads its scripts and stylesheet with a version in the address, so a browser cannot keep using an old `config.js`. That was why one browser showed "no database is configured" and no agent line while the deployed config was correct.
- **Baseline comparison.** A baseline of exactly 0 (blink counts from earlier failed scans) turned any reading into a deviation of billions. The spread now has a sensible floor and the result is capped at +-9.9.
- **Heart rate, more signal.** Skin colour is read at the camera's own resolution (up to 640 wide, four times the pixels), the three skin regions are a little larger, and on slow devices the pulse phase is 70% of the scan.
- **Heart rate, fewer false readings.** The plain green channel is the most sensitive method but does not cancel brightness changes that hit the whole face (screen light, auto-exposure, lamp flicker). A green result now only counts when POS on the same region also shows clearly more power than chance at that rate. In simulation with a steady 1% flicker and no pulse, false heart rates fell from 60 in 60 runs to 1 in 60; correct readings of a weak pulse went from 51 to 45 in 60.
- **Crew console** (`../console.html`): a page for the HALO agent with crew status, the daily report, the crew SOS checklists, questions about a step, and the demo scenes. The results page links to it.
- Checked: 27 unit tests; the console driven end to end against a locally running agent; a full scan in headless Chromium with the real face tracker. Not checked: Safari, a live person, or the console against the deployed agent.
