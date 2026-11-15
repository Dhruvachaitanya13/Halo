// Fill these in from your Supabase project (Settings > API). The anon key is safe to ship: the table only allows inserts.
export const CONFIG = {
  SUPABASE_URL: "https://fvbvplcdmpoifwjylgno.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_eO7f18_oGfyr2fKHBOkIOg_rrO8yshX",
  AGENT_URL: "https://halo-production-a2375a44.up.railway.app",               // optional: https address of the HALO agent API. When set, each real scan is also sent to POST /api/v1/scan
  ASSISTANT_URL: "https://halo-assistant-production.up.railway.app",           // optional: https address of the HALO assistant service (the twilio/ folder). Powers assistant.html: chat, text and calls
  AGENT_CREW: "LIVE_01",       // crew id the agent files scans under; a link with ?crew=LIVE_02 overrides it
  VISION_URL: "",              // optional: folder holding vision_bundle.mjs and wasm/ if you host the face tracker yourself
  MODEL_URL: "",               // optional: your own copy of face_landmarker.task
  QUALITY_MIN: 0.35,           // heart and breathing values below this signal quality are not shown or saved
  MODES: {                     // what each check length includes
    quick:    { label: "Quick (about 1 minute)",     scan: 30, tests: ["reaction"],                    trials: 5 },
    standard: { label: "Standard (about 3 minutes)", scan: 45, tests: ["reaction", "gonogo", "docking"], trials: 6 },
    full:     { label: "Full (about 5 minutes)",     scan: 60, tests: ["reaction", "gonogo", "memory", "docking"], trials: 8 },
  },
  DOCKING_SECONDS: 25,         // length of the docking task
  RECOVERY_SECONDS: 15,        // still period after the tests, for the recovery heart rate
  DEFAULTS: { mode: "standard", method: "auto", camera: "user", overlay: true, validation: false, keepCamera: true, sound: true },
};
