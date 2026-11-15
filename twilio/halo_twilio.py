"""HALO assistant service: one assistant, reached by website chat, text message, phone call and browser call.

Run:   uvicorn halo_twilio:app --host 0.0.0.0 --port $PORT

Works with no Twilio account at all: POST /assistant then serves the website chat. Twilio adds the other channels.

Env (all optional; each unlocks a channel):
       HALO_AGENT_URL            the HALO agent API, e.g. https://halo-production-a2375a44.up.railway.app
       HALO_BRIDGE_CREW          crew that emergencies and reports are about (default LIVE_01)
       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER    text messages and phone calls (Twilio console)
       PUBLIC_BASE_URL           this service's own https address; needed to check Twilio's signatures
       MISSION_CONTROL_NUMBERS   comma-separated, E.164 format: who receives alerts
       TWILIO_API_KEY, TWILIO_API_SECRET, TWIML_APP_SID             "Call HALO" from the browser (Twilio Voice SDK)
       HALO_VOICE                Twilio voice for calls (default alice)
       TWILIO_VALIDATE=0         only for local testing; leave unset in production

In the Twilio console:
       phone number  > "A message comes in" -> POST {PUBLIC_BASE_URL}/twilio/sms
       phone number  > "A call comes in"    -> POST {PUBLIC_BASE_URL}/twilio/voice
       TwiML App     > Voice request URL     -> POST {PUBLIC_BASE_URL}/twilio/voice     (for browser calls)

The assistant itself is assistant.py; crew SOS and status come from twilio_bridge.py, which talks to the HALO agent.
"""
import os
import time
from fastapi import FastAPI, Form, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from twilio.request_validator import RequestValidator
from twilio.rest import Client
from twilio.twiml.messaging_response import MessagingResponse
from twilio.twiml.voice_response import Gather, VoiceResponse

app = FastAPI(title="HALO assistant service")
# The website chat calls this service from the browser: allow the project's own pages and local development only.
app.add_middleware(CORSMiddleware, allow_origins=["https://dhruvachaitanya13.github.io"], allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$",
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
API_KEY, API_SECRET, TWIML_APP = os.getenv("TWILIO_API_KEY", ""), os.getenv("TWILIO_API_SECRET", ""), os.getenv("TWIML_APP_SID", "")
VOICE = os.getenv("HALO_VOICE", "alice")
SID, TOKEN = os.getenv("TWILIO_ACCOUNT_SID", ""), os.getenv("TWILIO_AUTH_TOKEN", "")
FROM = os.getenv("TWILIO_FROM_NUMBER", "")
CONTROL = [n.strip() for n in os.getenv("MISSION_CONTROL_NUMBERS", "").split(",") if n.strip()]
BASE = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
VALIDATE = os.getenv("TWILIO_VALIDATE", "1") != "0"
SMS_LIMIT = 300                      # keep texts short; long replies are cut with a pointer to the app


# ----------------------------------------------------------------- HALO agent connection
# ask_agent(text, mode, sender) and current_status() come from the HALO agent's bridge module (agent/halo_agent/integrations/twilio_bridge.py,
# copied here as twilio_bridge.py; standard library only). It calls the agent over HTTP at HALO_AGENT_URL (default http://127.0.0.1:8001)
# and returns a safe fixed reply if the agent cannot be reached.
from twilio_bridge import ask_agent, current_status  # noqa: E402
import assistant  # noqa: E402

# ----------------------------------------------------------------- helpers
def client() -> Client:
    if not (SID and TOKEN and FROM):
        raise HTTPException(503, "Twilio credentials are not configured")
    return Client(SID, TOKEN)


async def verify(request: Request) -> dict:
    """Reject requests that were not signed by Twilio."""
    form = dict(await request.form())
    if VALIDATE:
        url = (BASE + request.url.path) if BASE else str(request.url)
        ok = RequestValidator(TOKEN).validate(url, form, request.headers.get("X-Twilio-Signature", ""))
        if not ok:
            raise HTTPException(403, "Invalid Twilio signature")
    return form


def short(text: str) -> str:
    return text if len(text) <= SMS_LIMIT else text[: SMS_LIMIT - 22].rstrip() + "... (more in the app)"


def xml(twiml) -> Response:
    return Response(content=str(twiml), media_type="application/xml")


# ----------------------------------------------------------------- outbound: alerts and reports
class Alert(BaseModel):
    level: str                 # "watch" or "act"
    message: str               # one sentence: what happened and what to do
    call: bool | None = None   # default: phone call only for "act"


@app.post("/alerts/send")
def send_alert(a: Alert):
    """Called by the HALO backend when the engine raises watch/act."""
    if a.level not in ("watch", "act"):
        raise HTTPException(422, "level must be 'watch' or 'act'")
    if not CONTROL:
        raise HTTPException(503, "MISSION_CONTROL_NUMBERS is empty")
    tw, sent, failed = client(), [], []
    body = short(f"HALO {a.level.upper()}: {a.message}")
    do_call = a.call if a.call is not None else a.level == "act"
    for to in CONTROL:
        try:
            m = tw.messages.create(to=to, from_=FROM, body=body)
            entry = {"to": to, "sms_sid": m.sid}
            if do_call:
                v = VoiceResponse()
                v.say(f"This is HALO. Priority alert. {a.message}", voice=VOICE)
                v.pause(length=1)
                v.say(f"Repeating. {a.message}", voice=VOICE)
                entry["call_sid"] = tw.calls.create(to=to, from_=FROM, twiml=str(v)).sid
            sent.append(entry)
        except Exception as e:                      # e.g. unverified number on a trial account
            failed.append({"to": to, "error": str(e)[:200]})
    return {"sent": sent, "failed": failed}


@app.post("/reports/daily")
def send_daily_report():
    """Trigger from a scheduler once per 'mission morning'."""
    text = short(ask_agent("Give today's crew health brief in three sentences.", mode="daily_report"))
    tw, out = client(), []
    for to in CONTROL:
        try:
            out.append({"to": to, "sms_sid": tw.messages.create(to=to, from_=FROM, body=text).sid})
        except Exception as e:
            out.append({"to": to, "error": str(e)[:200]})
    return {"results": out}


# ----------------------------------------------------------------- website chat
class Ask(BaseModel):
    text: str
    sender: str = ""           # a random id the page keeps, so an SOS started in the chat continues in the chat
    channel: str = "web"


_hits: dict = {}


def _limit(key: str, per_minute: int = 30) -> None:
    now, window = time.time(), _hits.setdefault(key, [])
    window[:] = [t for t in window if now - t < 60]
    if len(window) >= per_minute:
        raise HTTPException(429, "Too many messages. Wait a minute.")
    window.append(now)


@app.post("/assistant")
def assistant_chat(a: Ask, request: Request):
    """One message in, one reply out. The same function answers text messages and phone calls."""
    _limit(request.client.host if request.client else "?")
    if len(a.text) > 500:
        raise HTTPException(422, "Message too long")
    return assistant.reply(a.text, channel="web" if a.channel not in ("web", "voice") else a.channel, sender=("web:" + a.sender[:64]) if a.sender else "")


@app.post("/voice/token")
def voice_token(request: Request):
    """Short-lived token that lets the web page place a call to HALO through Twilio (Voice SDK). 503 until the three variables are set."""
    _limit("token:" + (request.client.host if request.client else "?"), 10)
    if not (SID and API_KEY and API_SECRET and TWIML_APP):
        raise HTTPException(503, "Browser calling is not configured")
    from twilio.jwt.access_token import AccessToken
    from twilio.jwt.access_token.grants import VoiceGrant
    token = AccessToken(SID, API_KEY, API_SECRET, identity="halo-web", ttl=600)
    token.add_grant(VoiceGrant(outgoing_application_sid=TWIML_APP, incoming_allow=False))
    jwt = token.to_jwt()
    return {"token": jwt if isinstance(jwt, str) else jwt.decode()}


# ----------------------------------------------------------------- inbound: crew texts HALO
@app.post("/twilio/sms")
async def inbound_sms(request: Request):
    form = await verify(request)
    text, sender = (form.get("Body") or "").strip(), form.get("From", "")
    r = MessagingResponse()
    r.message(short(assistant.reply(text, channel="sms", sender=sender)["text"]))
    return xml(r)


# ----------------------------------------------------------------- inbound: someone calls HALO (phone, or the browser through the Voice SDK)
def _listen(v: VoiceResponse, prompt: str) -> None:
    g = Gather(input="speech", action="/twilio/voice/answer", method="POST", speech_timeout="auto", timeout=6, language="en-US",
               hints="emergency, done, can't, changed, skip, crew status, daily report, my last check, radiation, space weather, menu, goodbye")
    if prompt:
        g.say(prompt, voice=VOICE)
    v.append(g)


@app.post("/twilio/voice")
async def inbound_call(request: Request):
    form = await verify(request)
    s = current_status()
    v = VoiceResponse()
    v.say(f"This is HALO, the crew health assistant. Overall crew status: {s['level']}. {s['summary']}", voice=VOICE)
    _listen(v, "Ask me about crew status, the daily report, the latest health check, radiation or space weather. In an emergency, say emergency and what is happening.")
    v.say("I did not hear anything. Goodbye.", voice=VOICE)
    return xml(v)


@app.post("/twilio/voice/answer")
async def voice_answer(request: Request):
    form = await verify(request)
    heard = (form.get("SpeechResult") or "").strip()
    # On a call HALO placed, "From" is HALO's own number and the person is "To"; on a call someone made to HALO it is the other way round.
    sender = (form.get("To") if str(form.get("Direction", "")).startswith("outbound") else form.get("From")) or form.get("CallSid", "")
    r = assistant.reply(heard, channel="voice", sender=sender)
    v = VoiceResponse()
    v.say(r["text"], voice=VOICE)
    if r["intent"] == "goodbye":
        v.hangup()
        return xml(v)
    _listen(v, "Say done, can't, changed or skip." if r["intent"] in ("emergency", "sos_step", "sos_question") else "Anything else?")
    v.say("Goodbye from HALO.", voice=VOICE)
    return xml(v)


# ----------------------------------------------------------------- HALO calls the mission phone
_calls: list = []


@app.post("/call/start")
def call_mission_phone():
    """Ring the first mission-control number and connect it to the talking assistant (the same one that answers when someone dials HALO).
    It only ever calls the configured number, never one supplied by the caller, and at most once a minute and ten times a day."""
    if not CONTROL:
        raise HTTPException(503, "No mission phone is configured")
    if not BASE:
        raise HTTPException(503, "PUBLIC_BASE_URL is not set")
    now = time.time()
    _calls[:] = [t for t in _calls if now - t < 86400]
    if _calls and now - _calls[-1] < 60:
        raise HTTPException(429, "A call was just placed. Wait a minute.")
    if len(_calls) >= 10:
        raise HTTPException(429, "Daily call limit reached")
    try:
        c = client().calls.create(to=CONTROL[0], from_=FROM, url=BASE + "/twilio/voice", method="POST")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, "Twilio refused the call: " + str(e)[:160])
    _calls.append(now)
    return {"calling": "the mission phone", "call_sid": c.sid}


# ----------------------------------------------------------------- point the Twilio number at this service
def point_number_at_halo() -> str:
    """Set the HALO number's "a call comes in" and "a message comes in" webhooks to this service, using the account's own credentials.
    Runs once when the service starts, so nobody has to edit the number in the Twilio console. Set HALO_AUTOCONFIGURE=0 to switch it off."""
    if os.getenv("HALO_AUTOCONFIGURE", "1") == "0":
        return "switched off"
    if not (SID and TOKEN and FROM and BASE):
        return "skipped: Twilio variables or PUBLIC_BASE_URL not set"
    try:
        found = Client(SID, TOKEN).incoming_phone_numbers.list(phone_number=FROM, limit=1)
        if not found:
            owned = len(Client(SID, TOKEN).incoming_phone_numbers.list(limit=20))
            return (f"not owned: {FROM} can place calls and texts for this account but is not a number the account owns (it owns {owned}), "
                    "so nobody can dial in. HALO can still call out. To receive calls, claim or buy a number in Twilio and set TWILIO_FROM_NUMBER to it")
        voice, sms = BASE + "/twilio/voice", BASE + "/twilio/sms"
        if found[0].voice_url == voice and found[0].sms_url == sms:
            return "already set"
        found[0].update(voice_url=voice, voice_method="POST", sms_url=sms, sms_method="POST")
        return "set"
    except Exception as e:                       # wrong token, network, permissions: report it on /health, never crash the service
        return "failed: " + str(e)[:160]


WEBHOOKS = point_number_at_halo()


@app.get("/health")
def health():
    return {"ok": True, "assistant": True, "twilio_configured": bool(SID and TOKEN and FROM), "browser_calling": bool(SID and API_KEY and API_SECRET and TWIML_APP),
            "number_webhooks": WEBHOOKS, "can_call_out": bool(SID and TOKEN and FROM and BASE and CONTROL), "can_receive_calls": WEBHOOKS in ("set", "already set"),
            "mission_control_numbers": len(CONTROL), "signature_check": VALIDATE}
