# MAINS//LAB — UPSC Mains Answer Studio

A responsive, dark ultra-modern UPSC Mains practice website with a 3D-inspired interface and three workflows:

1. **Answer evaluator** — upload a text-based PDF, DOCX, TXT or MD; receive structured AI feedback, an indicative coaching score, strengths, gaps, enrichment ideas, an improved answer skeleton and follow-up practice questions.
2. **Copy comparison** — upload a topper reference PDF and your own PDF; receive a comparative gap analysis and a practical improvement plan.
3. **Daily question** — choose a GS/Essay/optional paper, enter a topic and difficulty, and generate an original UPSC-style question with an approach and value-addition suggestion.

## Requirements

- Node.js 20 or later (18.18+ should also work)
- An OpenAI API key with API access
- Netlify account for hosting

## Run locally

```bash
npm install
npm install -D netlify-cli
cp .env.example .env
```

Add your API key to `.env`:

```env
OPENAI_API_KEY=your_secret_api_key
OPENAI_MODEL=gpt-6
```

Then run the app through Netlify Dev so the serverless function is available:

```bash
npx netlify dev
```

Open the local URL printed by Netlify (usually http://localhost:8888).

If your API account does not have access to the model configured in `OPENAI_MODEL`, change that variable to a model available to your account. The model name is configurable; it is never exposed to the browser.

## Deploy to Netlify

### Option A — GitHub (recommended)

1. Unzip the project and put the `upsc-mains-studio` folder in a Git repository.
2. Push the repository to GitHub.
3. In Netlify, choose **Add new site → Import an existing project**.
4. Select your repository.
5. Build settings should be detected from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
6. Before deploying, open **Site configuration → Environment variables** and add:
   - `OPENAI_API_KEY` = your secret API key
   - `OPENAI_MODEL` = a model enabled for your API account (default in this project: `gpt-6`)
7. Deploy the site. If you add/change environment variables later, trigger a new deploy.

### Option B — Netlify CLI

```bash
npm install
npm install -D netlify-cli
npx netlify login
npx netlify init
npx netlify env:set OPENAI_API_KEY "your_secret_api_key"
npx netlify env:set OPENAI_MODEL "gpt-6"
npx netlify deploy --build --prod
```

## Important limitations and privacy

- The browser extracts selectable text from PDFs using PDF.js. DOCX text extraction uses Mammoth. **Scanned/image-only PDFs and handwriting OCR are not supported in this starter version**; upload text-based PDFs. The comparison report explicitly notes that visual handwriting/layout may not be assessed from extracted text.
- Files are parsed in the browser; only extracted text (up to 45,000 characters per file) is sent to the Netlify function for analysis. Raw files are not uploaded to a storage service by this app.
- The Netlify function sends extracted text to the OpenAI API. Tell users about this before collecting other people's work, and review your API provider's data/privacy terms.
- There is no user login, database, saved history, payment system or rate limiting in this starter. Add authentication, quotas and abuse protection before opening it publicly.
- Scores are coaching estimates, not official UPSC marks or guarantees.
- Do not put the OpenAI API key in frontend code, GitHub, or Vite `VITE_` variables. Keep it only in Netlify environment variables.
- The default model is configurable. If `gpt-6` is not enabled for your API account, set `OPENAI_MODEL` to a model that is.

## Project structure

```text
upsc-mains-studio/
├── index.html
├── package.json
├── vite.config.js
├── netlify.toml
├── .env.example
├── src/
│   ├── main.jsx
│   └── styles.css
└── netlify/
    └── functions/
        └── ai.mjs
```
