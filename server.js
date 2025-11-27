// server.js - Vercel-ready, uses GOOGLE_CREDENTIALS env for both DocumentAI and Vertex AI
const express = require('express');
require('dotenv').config();
const multer = require('multer');
const cors = require('cors');
const { google } = require('googleapis');
const { VertexAI } = require('@google-cloud/vertexai');

const app = express();

// --- CORS ---
const FRONTEND_ORIGIN = "https://new-project-three-flax.vercel.app"; // no trailing slash
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

// --- Body parser ---
app.use(express.json());

// --- Config ---
const PROJECT_ID = process.env.PROJECT_ID || "genai-471818"; // prefer env but fallback to your value
const LOCATION = 'us'; // Document AI location (e.g. 'us')
const VERTEX_LOCATION = 'us-central1'; // Vertex model location
const PROCESSOR_ID = process.env.PROCESSOR_ID || "54be1a4c93565429";
const VERTEX_MODEL = process.env.VERTEX_MODEL || 'gemini-2.5-flash-lite';

// --- Load and parse credentials from single env var GOOGLE_CREDENTIALS ---
if (!process.env.GOOGLE_CREDENTIALS) {
  console.error("Missing GOOGLE_CREDENTIALS env var");
}
let credentials;
try {
  // try direct parse first
  try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (err) {
    // maybe private_key has escaped newlines - replace \\n with \n and parse again
    const fixed = process.env.GOOGLE_CREDENTIALS.replace(/\\n/g, '\n');
    credentials = JSON.parse(fixed);
  }
  // basic sanity
  if (!credentials || !credentials.client_email || !credentials.private_key) {
    console.warn("GOOGLE_CREDENTIALS parsed but missing client_email/private_key fields.");
  }
} catch (err) {
  console.error("Failed to parse GOOGLE_CREDENTIALS:", err.message || err);
  credentials = null;
}

// --- Document AI auth using google-auth with parsed credentials ---
const docAuth = new google.auth.GoogleAuth({
  credentials: credentials || undefined,
  projectId: PROJECT_ID,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const documentai = google.documentai({
  version: 'v1',
  auth: docAuth,
});

// --- Multer memory storage (works on Vercel) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- Vertex AI setup with explicit credentials ---
let vertexAI;
try {
  const vertexOpts = {
    project: PROJECT_ID,
    location: VERTEX_LOCATION,
  };
  if (credentials) {
    // pass credentials object to Vertex client
    vertexOpts.googleAuthOptions = { credentials };
  }
  vertexAI = new VertexAI(vertexOpts);
} catch (err) {
  console.error("VertexAI client init error:", err);
  vertexAI = null;
}


const model = vertexAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
});

// --- Health/ping endpoint ---
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', project: PROJECT_ID, vertexModel: VERTEX_MODEL });
});

// --- Upload & Analyze endpoint ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    // Basic validations
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!credentials) {
      console.error("Missing or invalid GOOGLE_CREDENTIALS - cannot authenticate to Google Cloud");
      return res.status(500).json({ error: 'Server misconfigured: missing credentials' });
    }
    if (!documentai) {
      return res.status(500).json({ error: 'DocumentAI client not initialized' });
    }
    if (!model) {
      console.error("Vertex model not available (client or model init failed).");
      return res.status(500).json({ error: 'Vertex AI not initialized' });
    }

    console.log("Received file:", req.file.originalname, "size:", req.file.size);

    // Read file from memory
    const fileBuffer = req.file.buffer;
    const encodedFile = fileBuffer.toString('base64');

    // Call Document AI
    const name = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;
    console.log("Calling Document AI processor:", name);

    let result;
    try {
      result = await documentai.projects.locations.processors.process({
        name,
        requestBody: {
          rawDocument: {
            content: encodedFile,
            mimeType: req.file.mimetype,
          },
        },
      });
    } catch (docErr) {
      console.error("Document AI request failed:", docErr.response?.data || docErr.message || docErr);
      return res.status(500).json({ error: 'Document AI processing failed', detail: docErr.response?.data || docErr.message });
    }

    const text = result.data.document?.text || '';
    console.log("Extracted text length:", text.length);

    if (!text.trim()) {
      return res.status(400).json({ error: 'Document contained no extractable text.' });
    }

    // Prepare prompts and call Vertex AI (with defensive logging)
    try {
      const makeRequest = async (promptText) => {
        const reqBody = {
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          temperature: 0.3,
          maxOutputTokens: 300,
        };
        const r = await model.generateContent(reqBody);
        console.log("Raw Vertex response keys:", Object.keys(r || {}));
        return r;
      };

      const summaryPrompt = `Summarize the following legal document:\n\n${text}`;
      const summaryResult = await makeRequest(summaryPrompt);
      const summary = summaryResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Summary not generated';

      const keyTermsPrompt = `Extract key terms and their values in concise bullet points:\n\n${text}`;
      const keyTermsResult = await makeRequest(keyTermsPrompt);
      const keyTerms = keyTermsResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Key terms not extracted';

      const riskPrompt = `You are a legal risk analysis expert.

Analyze the following legal document and generate a clear risk assessment.

Follow this EXACT structured format:

- Risk Item: <short title>
  Description: <what could go wrong>
  Severity: Low/Medium/High

Example:
- Risk Item: Ambiguous Payment Terms
  Description: Payment due dates are unclear, which may cause disputes between parties.
  Severity: Medium

Now analyze this document:

${text}`;
      const riskAssessmentResult = await makeRequest(riskPrompt);
      const riskAssessment = riskAssessmentResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Risk assessment not generated';

      // Return response
      return res.json({ text, summary, keyTerms, riskAssessment });
    } catch (vertexErr) {
      console.error("Vertex AI generateContent error:", vertexErr.response?.data || vertexErr.message || vertexErr);
      return res.status(500).json({ error: 'Vertex AI generation failed', detail: vertexErr.response?.data || vertexErr.message });
    }
  } catch (error) {
    console.error('Upload & Analyze error (outer):', error.response?.data || error.message || error);
    return res.status(500).json({ error: 'Failed to analyze document' });
  }
});

// Export for Vercel (do not use app.listen)
module.exports = app;



