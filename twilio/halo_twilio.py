"""HALO x Twilio: alerts out, crew questions in.

Run:   uvicorn halo_twilio:app --port 8000
Env:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER   (from the Twilio console)
       MISSION_CONTROL_NUMBERS   comma-separated, E.164 format, e.g. +13125550101,+13125550102
       PUBLIC_BASE_URL           your deployed URL, e.g. https://halo.up.railway.app
       TWILIO_VALIDATE=0         only for local testing; leave unset in production

In the Twilio console, on your phone number set:
       "A message comes in"  -> POST {PUBLIC_BASE_URL}/twilio/sms
       "A call comes in"     -> POST {PUBLIC_BASE_URL}/twilio/voice

Two functions are stubs for the team to replace: ask_agent() and current_status().
"""
import os
from fastapi import FastAPI, Form, HTTPException, Request, Response
from pydantic import BaseModel
from twilio.request_validator import RequestValidator
from twilio.rest import Client
from twilio.twiml.messaging_response import MessagingResponse
from twilio.twiml.voice_response import Gather, VoiceResponse

app = FastAPI(title="HALO Twilio bridge")
SID, TOKEN = os.getenv("TWILIO_ACCOUNT_SID", ""), os.getenv("TWILIO_AUTH_TOKEN", "")
FROM = os.getenv("TWILIO_FROM_NUMBER", "")
CONTROL = [n.strip() for n in os.getenv("MISSION_CONTROL_NUMBERS", "").split(",") if n.strip()]
BASE = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
VALIDATE = os.getenv("TWILIO_VALIDATE", "1") != "0"
SMS_LIMIT = 300                      # keep texts short; long replies are cut with a pointer to the app


# ----------------------------------------------------------------- stubs to replace
def ask_agent(text: str, mode: str = "question", sender: str = "") -> str:
    """Call the HALO agent. mode: 'question' | 'emergency' | 'daily_report'."""
    return f"HALO received: {text[:120]}. (Agent not connected yet.)"


def current_status() -> dict:
    """Latest overall status from the database / model."""
    return {"level": "normal", "summary": "All monitored values are in range. No radiation peak predicted in the next 30 minutes."}


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
                v.say(f"This is HALO. Priority alert. {a.message}", voice="alice")
                v.pause(length=1)
                v.say(f"Repeating. {a.message}", voice="alice")
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


# ----------------------------------------------------------------- inbound: crew texts HALO
@app.post("/twilio/sms")
async def inbound_sms(request: Request):
    form = await verify(request)
    text, sender = (form.get("Body") or "").strip(), form.get("From", "")
    mode = "emergency" if text.lower().startswith(("emergency", "help", "sos")) else "question"
    reply = ask_agent(text, mode=mode, sender=sender) if text else "Text a question, or start with EMERGENCY for step-by-step help."
    r = MessagingResponse()
    r.message(short(reply))
    return xml(r)


# ----------------------------------------------------------------- inbound: someone calls HALO
@app.post("/twilio/voice")
async def inbound_call(request: Request):
    await verify(request)
    s = current_status()
    v = VoiceResponse()
    v.say(f"This is HALO, the crew health officer. Current status: {s['level']}. {s['summary']}", voice="alice")
    g = Gather(input="speech", action="/twilio/voice/answer", method="POST", speech_timeout="auto", timeout=5)
    g.say("Ask a question after the tone, or say emergency.", voice="alice")
    v.append(g)
    v.say("No question heard. Goodbye.", voice="alice")
    return xml(v)


@app.post("/twilio/voice/answer")
async def voice_answer(request: Request):
    form = await verify(request)
    heard = (form.get("SpeechResult") or "").strip()
    mode = "emergency" if "emergency" in heard.lower() else "question"
    v = VoiceResponse()
    v.say(ask_agent(heard, mode=mode, sender=form.get("From", "")) if heard else "I did not catch that.", voice="alice")
    g = Gather(input="speech", action="/twilio/voice/answer", method="POST", speech_timeout="auto", timeout=5)
    g.say("Anything else?", voice="alice")
    v.append(g)
    v.say("Goodbye.", voice="alice")
    return xml(v)


@app.get("/health")
def health():
    return {"twilio_configured": bool(SID and TOKEN and FROM), "mission_control_numbers": len(CONTROL), "signature_check": VALIDATE}
