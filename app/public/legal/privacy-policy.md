# Privacy Policy

Last updated: October 30, 2026

Code Siren ("we", "us", or "our") operates the Code Siren IDE (the "Service"). This Privacy Policy explains how we collect, use, and protect your information when you use our Service.

## 1. Information We Collect

### Account Data
- **Email address** — used for authentication and account recovery
- **Name** — used for display within the IDE
- **Password** — stored as a bcrypt hash (never in plaintext)

### Usage Data
- **Chat messages and prompts** — processed by AI models to generate responses
- **Code snippets** — uploaded or edited within the IDE for AI-assisted development
- **Voice data** — audio recordings for voice-to-code features (processed and discarded)

### Technical Data
- **IP address** — for rate limiting and security
- **Browser type** — for compatibility
- **Usage logs** — for debugging and service improvement

## 2. How We Use Your Information

- To authenticate you and manage your account
- To provide AI-assisted code generation, review, and editing features
- To operate voice, avatar, and terminal features
- To detect and prevent security threats
- To improve our Service through anonymized analytics

## 3. Data Storage

- **Database**: PostgreSQL with parameterized queries and connection pooling
- **Passwords**: bcrypt hashed (cost factor 10)
- **JWT tokens**: stored in httpOnly cookies (not accessible to JavaScript)
- **Biometric data**: if face auth is enabled, templates are stored as local files (never in the database)
- **Voice recordings**: processed in memory and discarded after generating text

## 4. Data Sharing

We do not sell your data. We share data only with:
- **AI providers** (e.g., Z.ai, Anthropic, OpenAI) — only the prompts/code you explicitly send for processing
- **Hosting providers** — for server infrastructure
- **Legal authorities** — when required by law

## 5. Your Rights

You have the right to:
- **Access** your data via `GET /api/auth/me`
- **Delete** your account and data via `DELETE /api/auth/account`
- **Export** your data via `GET /api/export/settings`
- **Opt out** of voice features by not enabling them

## 6. Data Retention

- Account data: retained until you delete your account
- Chat history: retained until you clear it
- Voice data: discarded immediately after processing
- Logs: retained for 30 days then automatically deleted

## 7. Security Measures

- All API endpoints require JWT authentication
- Rate limiting on all endpoints
- Input validation via Zod schemas
- Parameterized SQL queries (no injection)
- File upload validation (type and size limits)
- Secret detection scanning (Ghost Mode)
- Environment variables never exposed to the frontend
- Production JWT secret guard (refuses to start with dev defaults)

## 8. Cookies

We use only essential cookies:
- `code_siren_token` — httpOnly, Secure, SameSite=Strict — for authentication
- No tracking or advertising cookies

## 9. Third-Party Services

- **Z.ai SDK** — AI model API (prompts sent for processing)
- **Anthropic/OpenAI** — optional AI providers (only if you configure API keys)
- **Playwright** — browser automation (runs locally, no data sent externally)

## 10. Contact

For privacy questions or data deletion requests: use the in-app support or create an issue on our GitHub repository.

## 11. Changes

We will notify you of material changes by updating this page.
