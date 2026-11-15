# HALO assistant service

One assistant, four ways to reach it. All four go through the same function (`assistant.reply`), so the answer to "crew status" is the same by chat, text or phone.

| Channel | What the crew does | Needs |
|---|---|---|
| Website chat | type or tap on `assistant.html` | this service deployed |
| Browser voice | tap the microphone on `assistant.html` | the same; uses the browser's own speech |
| Text message | text the HALO number | a Twilio number |
| Phone call | dial the HALO number and talk | a Twilio number |
| Call from the web page | press "Call HALO" on `assistant.html` | a Twilio API key and TwiML App |

It also sends alerts: `POST /alerts/send` texts and calls the mission-control numbers, and `POST /reports/daily` texts the daily report.

## What it answers

Crew status, the daily report, the latest saved health check, historical NASA radiation and space weather for May 2024, the Inspiration4 reference labs, and the crew SOS checklists step by step ("my crewmate fainted", then "done", "can't", "changed", "skip").

Every number comes from the HALO agent or the HALO database in that same request. If a source cannot be reached it says so and guesses nothing. Topics are matched by keyword rules (`assistant.classify`), so the same words always get the same answer; there is no language model in this service. It does not diagnose or give treatment advice.

## Deploy (Railway, about ten minutes)

1. In the `halo-agent` Railway project: Create > GitHub Repo > `Dhruvachaitanya13/Halo` (a second service from the same repository).
2. Settings: Root Directory `/twilio`, Start Command `uvicorn halo_twilio:app --host 0.0.0.0 --port $PORT`, Healthcheck Path `/health`. Networking: Generate Domain.
3. Variables: `HALO_AGENT_URL` = the agent's address, `HALO_BRIDGE_CREW` = `LIVE_01`, `PUBLIC_BASE_URL` = this service's own address.
4. Deploy, then open `/health`. It should show `"assistant": true`.
5. Put this service's address in `scan/js/config.js` as `ASSISTANT_URL`, commit and push. `assistant.html` now works by chat and browser voice.

## Add text messages and phone calls (Twilio)

1. In the Twilio console, get a phone number with SMS and Voice.
2. Nothing to edit on the number: when the service starts with the Twilio variables and `PUBLIC_BASE_URL` set, it points the number's call and message webhooks at itself. `/health` shows the result under `number_webhooks`. (To do it by hand instead: "A message comes in" `POST {address}/twilio/sms`, "A call comes in" `POST {address}/twilio/voice`, and set `HALO_AUTOCONFIGURE=0`.)
3. Add variables on Railway: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `MISSION_CONTROL_NUMBERS` for alerts.
4. A trial account can only text and call numbers you have verified in the console, and plays a trial notice before each call.

## HALO calls you

`POST /call/start` rings the first number in `MISSION_CONTROL_NUMBERS` and connects it to the talking assistant. `assistant.html` shows a "Call me" button for it. It never calls a number supplied by the page, and is limited to one call a minute and ten a day. This works on a Twilio trial account even when the account owns no number to dial in to; `/health` shows `can_call_out` and `can_receive_calls`.

## Add "Call HALO" on the web page (Twilio Voice SDK)

1. Twilio console > Voice > TwiML Apps > create one with Voice request URL `POST {address}/twilio/voice`. Copy its SID (starts with `AP`).
2. Account > API keys > create a Standard key. Copy the SID (starts with `SK`) and the secret.
3. Add variables on Railway: `TWIML_APP_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`.
4. `/health` then shows `"browser_calling": true` and the button appears on `assistant.html`.

## Run and test here

    pip install -r requirements.txt
    python tests/test_assistant.py                       # the assistant, with the sources replaced by fixed data
    HALO_AGENT_URL=http://127.0.0.1:8001 TWILIO_VALIDATE=0 uvicorn halo_twilio:app --port 8000

Never commit the Twilio auth token or API secret. They belong only in Railway's variables.

Checked: unit tests; the chat, text-message and phone-call paths driven locally against a running agent and a stand-in database (Twilio's own requests imitated with form posts). Not checked: a real Twilio number, a real phone call, or the "Call HALO" button, because no Twilio credentials were available.
