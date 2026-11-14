// Fill these in from your Supabase project (Settings > API). The anon key is safe to ship: the table only allows inserts.
export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  VISION_URL: "",              // optional: folder holding vision_bundle.mjs and wasm/ if you host the face tracker yourself
  MODEL_URL: "",               // optional: your own copy of face_landmarker.task
  QUALITY_MIN: 0.35,           // heart and breathing values below this signal quality are not shown or saved
  MODES: {                     // what each check length includes
    quick:    { label: "Quick (about 1 minute)",     scan: 30, tests: ["reaction"],                    trials: 5 },
    standard: { label: "Standard (about 3 minutes)", scan: 45, tests: ["reaction", "docking", "gonogo"], trials: 6 },
    full:     { label: "Full (about 5 minutes)",     scan: 60, tests: ["reaction", "gonogo", "memory", "docking"], trials: 8 },
  },
  DOCKING_SECONDS: 25,         // length of the docking task
  RECOVERY_SECONDS: 15,        // still period after the tests, for the recovery heart rate
  DEFAULTS: { mode: "standard", method: "auto", camera: "user", overlay: true, validation: false, keepCamera: true },
};
