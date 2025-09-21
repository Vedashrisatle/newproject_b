const express = require('express');
require('dotenv').config();
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const { google } = require('googleapis');
const { VertexAI } = require('@google-cloud/vertexai');

const app = express();

// CORS setup - allow your frontend
// CORS setup - allow your frontend 
app.use( cors({ origin: "https://new-project-three-flax.vercel.app", // **no trailing slash** 
               methods: ["GET", "POST", "OPTIONS"], 
               allowedHeaders: ["Content-Type", "Authorization"],
              }) );

app.use(express.json());

const PROJECT_ID = "genai-471818";
const LOCATION = 'us';
const PROCESSOR_ID = "54be1a4c93565429";

// Google Document AI Auth
const client = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.client_email,
    private_key: process.env.private_key.replace(/\\n/g, "\n"),
    private_key_id: process.env.private_key_id,
    project_id: PROJECT_ID,
  },
project_id: PROJECT_ID,
  projectId: PROJECT_ID,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const documentai = google.documentai({
  version: 'v1',
  auth: client,
});

// Multer for file upload
const upload = multer({ storage: multer.memoryStorage() });


// Vertex AI setup
const vertexAI = new VertexAI({
  project: PROJECT_ID,
  location: 'us-central1',
});

const model = vertexAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
});

// Upload & Analyze endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
   const fileData = req.file.buffer; // already a Buffer
const encodedFile = fileData.toString("base64");


    const name = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;

    const result = await documentai.projects.locations.processors.process({
      name,
      requestBody: {
        rawDocument: {
          content: encodedFile,
          mimeType: req.file.mimetype,
        },
      },
    });

    const text = result.data.document?.text || '';
    

    if (!text.trim()) {
      return res.status(400).json({ error: 'Document contained no extractable text.' });
    }

    // Generate summary
    const summaryResult = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Summarize the following legal document:\n\n${text}` }] }],
      temperature: 0.3,
      maxOutputTokens: 300,
    });
    const summary = summaryResult.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Summary not generated';

    // Extract key terms
    const keyTermsResult = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Extract key terms and their values in bullet points:\n\n${text}` }] }],
      temperature: 0.3,
      maxOutputTokens: 300,
    });
    const keyTerms = keyTermsResult.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Key terms not extracted';

    // Risk assessment
    const riskAssessmentResult = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Provide a risk assessment in this format:\n- Risk Item: Description (Severity: Low/Medium/High)\n\nFor this legal document:\n\n${text}` }] }],
      temperature: 0.3,
      maxOutputTokens: 300,
    });
    const riskAssessment = riskAssessmentResult.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Risk assessment not generated';

    res.json({ text, summary, keyTerms, riskAssessment });
  } catch (error) {
    console.error('Upload & Analyze error:', error.response?.data || error.message || error);
    res.status(500).json({ error: 'Failed to analyze document' });
  }
});

// 👇 This is the correct way for Vercel (don’t use app.listen)
module.exports = app;














