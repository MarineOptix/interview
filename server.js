require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GROQ_API_KEY) {
  console.error('ERROR: GROQ_API_KEY not found. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';

// The resume is kept in server memory and mirrored to a file so it survives restarts.
// This is fine for a single-user prototype. Once multiple users are supported, this
// must be replaced with per-session / per-user storage (e.g. keyed by session_id).
const RESUME_FILE = path.join(__dirname, 'resume-data.txt');
let currentResume = '';

if (fs.existsSync(RESUME_FILE)) {
  currentResume = fs.readFileSync(RESUME_FILE, 'utf-8');
  console.log('Resume loaded from resume-data.txt (' + currentResume.length + ' characters)');
}

// Static reference material: verified maritime terminology, rank hierarchy, and typical
// interview question categories. Loaded once at startup — this is NOT candidate-specific
// and must never be treated as a source of facts about any particular person.
const KNOWLEDGE_BASE_FILE = path.join(__dirname, 'knowledge-base.md');
let knowledgeBase = '';

if (fs.existsSync(KNOWLEDGE_BASE_FILE)) {
  knowledgeBase = fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf-8');
  console.log('Knowledge base loaded (' + knowledgeBase.length + ' characters)');
} else {
  console.warn('knowledge-base.md not found — answers will rely only on the resume and the model\'s general knowledge');
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ---- Resume: save and fetch ----

app.post('/api/resume', (req, res) => {
  const { resume } = req.body;

  if (typeof resume !== 'string') {
    return res.status(400).json({ error: 'The "resume" field must be a string' });
  }

  currentResume = resume.trim();
  fs.writeFileSync(RESUME_FILE, currentResume, 'utf-8');

  res.json({ ok: true, length: currentResume.length });
});

app.get('/api/resume', (req, res) => {
  res.json({ resume: currentResume });
});

// ---- System prompt ----
// The resume is injected as the ONLY source of facts about the candidate.
// The model is explicitly forbidden from inventing specifics (ships, companies,
// dates, certificates) that aren't in the resume text — this is the main
// safeguard against fact hallucination.

function buildSystemPrompt(resume, knowledgeBaseText) {
  const resumeBlock = resume && resume.trim()
    ? resume.trim()
    : '(no resume uploaded yet — the candidate has not provided their background data)';

  const knowledgeBlock = knowledgeBaseText && knowledgeBaseText.trim()
    ? knowledgeBaseText.trim()
    : '(no reference material loaded)';

  return `You are a whisper-assistant (prompter) for a seafarer during a job interview
(interview for a position on board a ship). You receive the interviewer's question.
Your task is to produce a short, confident, professional answer that the seafarer
can say out loud immediately.

--- CANDIDATE RESUME (the only source of facts about their background and experience) ---
${resumeBlock}
--- END OF RESUME ---

--- MARITIME REFERENCE MATERIAL (verified general terminology and interview context —
NOT specific to this candidate; use it for correct terminology and to recognize what
the interviewer is really asking, never as a source of personal facts) ---
${knowledgeBlock}
--- END OF REFERENCE MATERIAL ---

HARD RULES (these override any other consideration):
0. ALWAYS answer in English only, regardless of the language of this instruction.
   The interviewer's question will always be in English — the answer must also be
   entirely in English, without a single word in Russian or any other language.
1. Any concrete career facts — ship names, companies, job titles, dates, ship types,
   certificates, trading regions — must come ONLY from the resume above. Never invent them.
2. If the question touches on a fact that is not in the resume, do NOT invent specifics.
   Instead, either give a general, professionally sound answer without fabricated details,
   or explicitly flag it in the suggestion as "clarify from memory: [what exactly]" so the
   seafarer recalls and states that fact themselves.
3. Do not attribute qualifications or documents to the candidate (e.g. STCW certificates)
   that are not mentioned in the resume.
4. Use the maritime reference material above for correct terminology, rank names, and
   convention names. Do not use maritime terms that appear in neither the resume nor the
   reference material unless you are certain they are correct general industry knowledge.
5. Keep the answer to 2-5 sentences, in a conversational tone, ready to be spoken aloud.

REMINDER: the answer must be written ENTIRELY in English. Not a single non-English word.`;
}

// Detects Cyrillic characters — a simple, reliable way to catch "the model slipped
// into Russian" regardless of how well it followed the language instruction.
function containsCyrillic(text) {
  return /[а-яА-ЯёЁ]/.test(text);
}

// If the model's answer contains Cyrillic, we don't just re-prompt the same request
// (which could slip again) — we make a focused, single-purpose translation call.
// This is a hard guarantee of English output, independent of the main model's behavior.
async function translateToEnglish(text) {
  const groqRes = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Translate the given text into natural, fluent English. ' +
            'Output ONLY the translation, nothing else — no notes, no quotation marks.'
        },
        { role: 'user', content: text }
      ],
      temperature: 0.2,
      max_tokens: 300
    })
  });

  const data = await groqRes.json();
  if (!groqRes.ok) {
    throw new Error(data.error?.message || `Groq returned status ${groqRes.status}`);
  }
  return data.choices?.[0]?.message?.content?.trim();
}

app.post('/api/answer', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'The "question" field is required and must be a non-empty string' });
    }

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(currentResume, knowledgeBase) },
          { role: 'user', content: question.trim() }
        ],
        temperature: 0.4,
        max_tokens: 300
      })
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      throw new Error(data.error?.message || `Groq returned status ${groqRes.status}`);
    }

    let answer = data.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error('Groq returned an empty answer');
    }

    // Safety net: if the answer slipped into Russian despite the instructions,
    // force it through a dedicated translation call before returning it.
    if (containsCyrillic(answer)) {
      console.warn('Answer contained Cyrillic text — re-translating to English');
      answer = await translateToEnglish(answer);
    }

    res.json({ answer });
  } catch (err) {
    console.error('Error calling Groq API:', err.message);
    res.status(500).json({ error: 'Failed to get an answer from the LLM', details: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', resumeLoaded: currentResume.length > 0 });
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
