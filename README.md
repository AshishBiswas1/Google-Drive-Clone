# Google-Drive-Clone (Backend)

A Node.js/Express backend that implements core Google Drive–like functionality using Supabase for authentication, database, and object storage.

## Tech Stack

- Runtime: Node.js, Express
- Auth: Supabase Auth (email/password, password reset)
- Storage: Supabase Storage (object storage for user documents)
- Database: Supabase Postgres tables (User, UserDocuments, documentshares)
- Uploads: Multer (memory storage)
- Security: helmet, hpp, xss-clean, cookie-parser
- Utils: uuid, bcryptjs, morgan

## Features (currently available)

Authentication and Accounts

- Email/password signup and login via Supabase Auth.
- HttpOnly cookie session: access token stored as jwt cookie.
- Protected routes middleware: validates token with Supabase and loads user profile from the User table.
- Role-based authorization helper: restrictTo(...roles) for admin endpoints.
- Password flows:
  - Forgot password: sends reset email via Supabase (configurable redirect).
  - Reset password: verifies recovery token and updates password.
  - Update password (logged-in): reauthenticate with current password, then rotate to a new one and refresh token.

User Profile

- Get current user: GET /api/drive/user/me.
- Update profile: PATCH /api/drive/user/updateMe (syncs Supabase user_metadata and User table; optional photo support).
- Soft account removal: DELETE /api/drive/user/deleteMe.
- Admin user management: list, create, get, update, delete users.

Documents

- Upload documents: POST /api/drive/docs/upload (up to 2 files per request; validated; safe filename; stored in Supabase Storage under documents/{userId}/).
- List documents: GET /api/drive/docs/getDocs (sorted by uploaded_at desc).
- Open/view document: GET /api/drive/docs/openDoc/:docId
  - Issues a short‑lived signed URL.
  - Auto-builds viewer URL for common types (images direct, PDFs direct, Office formats via Google Docs Viewer).
- Download document: GET /api/drive/docs/download/:docId
  - Redirects to a short‑lived signed URL for download.

Link Sharing

- Create share link: POST /api/drive/docs/share
  - shareType: “restricted” or “Anyone with link”.
  - Persists entry in documentshares and returns a share URL (/api/drive/docs/share/:shareId).
- Access shared doc: GET /api/drive/docs/share/:shareId
  - For “Anyone with link”, returns a signed read‑only URL.
  - For “restricted”, currently denies with “Access Restricted” (request/approval flow pending).

Error Handling & Security

- Centralized error controller with environment-aware responses.
- AppError utility for operational errors.
- Security middleware: helmet, hpp, xss-clean, cookie-parser.
- Logging in development with morgan.

## API Overview

Auth and User (base: /api/drive/user)

- POST /signup
- POST /login
- POST /forgetPassword
- POST /resetPassword
- POST /updatePassword (auth)
- GET /me (auth)
- PATCH /updateMe (auth)
- DELETE /deleteMe (auth)
- Admin (auth + restrictTo('admin')):
  - GET/POST /
  - GET/PATCH/DELETE /:id

Documents (base: /api/drive/docs, all routes require auth)

- POST /upload
- GET /getDocs
- GET /openDoc/:docId
- GET /download/:docId
- POST /share
- GET /share/:shareId

## Project Structure

- Router/
  - userRouter.js
  - UserDocumentRouter.js
- controller/
  - authController.js
  - userController.js
  - userDocController.js
  - errorController.js
- util/
  - supabaseClient.js
  - catchAsync.js
  - appError.js
- app.js, server.js
- package.json, package-lock.json

## Getting Started

- Install dependencies:
  - npm install
- Start in development:
  - npm run start:dev
- Start in production:
  - npm start

Ensure Supabase has:

- Storage bucket: User-Documents
- Tables: User, UserDocuments, documentshares
- Appropriate RLS/Policies to match your server-side access pattern.

## Roadmap (next steps)

- Expiring/password-protected share links and view/download counters.
- Folder hierarchy (parentId tree), move/rename operations.
- Per-user and per-folder permissions (viewer/commenter/editor) with inheritance.
- Thumbnails/previews for images/PDFs, optional video previews via background jobs.
- Search (metadata first; full‑text later), trash/restore, file versioning.
- Activity log, rate limiting and schema validation (Zod/Joi), malware scanning, checksums/deduplication.
- Storage abstraction interface and optional S3/GCS backends.

## License

ISC — © Ashish Biswas

## Notes

This backend expects a front-end client to handle authentication flows, upload forms, and consuming signed URLs for previews/downloads.
