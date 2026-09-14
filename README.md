# Interview Prompter — MVP (text -> LLM -> text)

## What this is
A prototype: the interviewer's question is typed in as text, the backend sends it to
an LLM (Groq) together with the candidate's resume, and returns a ready-to-say answer
for a seafarer during a job interview.

## Structure
```
interview-prompter/
├── server.js          # Express server, proxy to the Groq API, resume storage
├── package.json
├── .env.example       # template for the API key
├── resume-data.txt    # saved resume text (created at runtime, gitignored)
└── public/
    └── index.html     # simple frontend (resume screen + Q&A screen)
```

## Running it

1. Install dependencies:
   ```
   npm install
   ```

2. Get a free Groq API key (no card required): https://console.groq.com/keys

3. Copy `.env.example` to `.env` and paste in your key:
   ```
   cp .env.example .env
   ```
   Open `.env` and replace `your_key_here` with your real key.

4. Start the server:
   ```
   npm start
   ```

5. Open in a browser: http://localhost:3000

## How it works
- On first load, the frontend shows a resume screen. The user pastes their resume once;
  it's saved on the server (`POST /api/resume`) and persisted to `resume-data.txt`.
- The frontend sends each question to `/api/answer` — its OWN server, not directly to Groq.
- The server (`server.js`) builds a system prompt that injects the resume as the only
  source of biographical/career facts, with hard rules against inventing details not
  present in the resume, and requests the answer to always be in English.
- The LLM's answer is returned to the frontend and shown to the seafarer.

This architecture (frontend -> own backend -> Groq) exists because:
- storing the API key in client-side code is insecure — anyone opening DevTools could steal it;
- routing through our own server makes it easy to add logic (grounding, history, streaming,
  rate limits) without touching the frontend.

## Why Groq instead of Gemini
Groq runs on specialized hardware (LPUs) and generates responses much faster — this matters
when a suggestion is needed within seconds, live, during a conversation. Gemini has an edge
in context size and multimodality, but for this use case, speed matters more.

## Note on language
Code, comments, the system prompt, and the UI are all in English, so the codebase and
the product are accessible to non-Russian-speaking contributors and, eventually, to
users beyond the initial Russian-speaking test group.

## Roadmap (see project plan for details)
1. Build a verified knowledge base of maritime terminology and typical interview Q&A
   (from real sources, not from the LLM's general "knowledge") and inject it into context
   the same way the resume is.
2. Add speech recognition (Web Speech API or Whisper) so the question doesn't need to be
   typed manually.
3. Stream the answer token-by-token instead of returning it as one block, for speed.
4. Improve UX for real interview conditions (discreet screen, fast glance, quiet mode).
5. Abstract the LLM provider so it's easy to switch from Groq to a paid provider
   (OpenAI, Claude, etc.) when free-tier quality becomes insufficient.
6. Wrap the web app into a native Android app (e.g. via Capacitor).
