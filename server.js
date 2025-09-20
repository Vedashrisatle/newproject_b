const express = require('express');
require('dotenv').config();
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { VertexAI } = require('@google-cloud/vertexai');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = 'us';
const PROCESSOR_ID = process.env.PROCESSOR_ID;
const keyFilePath = path.join(__dirname, 'genai-471818-c3cbc7fa755d.json');

const client = new google.auth.GoogleAuth({
  keyFile: keyFilePath,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const documentai = google.documentai({
  version: 'v1',
  auth: client,
});

const upload = multer({ dest: 'uploads/' });

process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFilePath;

const vertexAI = new VertexAI({
  project: PROJECT_ID,
  location: 'us-central1',
});

const model = vertexAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const fileData = fs.readFileSync(filePath);
    const encodedFile = fileData.toString('base64');

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
    fs.unlinkSync(filePath);

    if (!text.trim()) {
      return res.status(400).json({ error: 'Document contained no extractable text.' });
    }

    const summaryRequest = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `Summarize the following legal document :\n\n${text}` }],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 300,
    };

    const summaryResult = await model.generateContent(summaryRequest);
    const summary = summaryResult.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Summary not generated';

    const keyTermsRequest = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `Extract key terms and their values from the following legal document in a concise bullet-point format:\n\n${text}` }],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 300,
    };

    const keyTermsResult = await model.generateContent(keyTermsRequest);
    const keyTerms = keyTermsResult.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Key terms not extracted';

    const riskAssessmentRequest = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `Provide a risk assessment in the following format:\n- Risk Item: Description (Severity: Low/Medium/High)\n\nFor this legal document:\n\n${text}` }],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 300,
    };

    const riskAssessmentResult = await model.generateContent(riskAssessmentRequest);
    const riskAssessment = riskAssessmentResult.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Risk assessment not generated';

    res.json({
      text,
      summary,
      keyTerms,
      riskAssessment,
    });
  } catch (error) {
    console.error('Upload & Analyze error:', error.response?.data || error.message || error);
    res.status(500).json({ error: 'Failed to analyze document' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
