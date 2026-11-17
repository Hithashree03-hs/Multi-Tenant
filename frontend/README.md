# CampusFlow Pro frontend

This is the React and Vite browser application for the existing CampusFlow Pro API. It includes sign-in and student registration, role-aware dashboards, organizations and departments, users, courses and enrollment, attendance, project collaboration, notifications, and profile pages. The browser uses the backend's existing authorization rules; hiding a button in the UI is only a usability choice, never the security boundary.

## Run locally

1. Start the backend from `../backend` using its documented setup. The API defaults to `http://localhost:5000`.
2. Copy `.env.example` to `.env` in this directory if the API uses a different URL, and set `VITE_API_BASE_URL` to its `/api` address. This variable is public browser configuration, so never put database credentials, `JWT_SECRET`, or `PLATFORM_ADMIN_SECRET` in it.
3. From this directory run:

   ```powershell
   npm install
   npm run dev
   ```

4. Open the local Vite URL shown in the terminal (normally `http://127.0.0.1:5173`).

The backend's `FRONTEND_ORIGINS` setting must include the exact Vite origin when running in a browser. It allows both local Vite host spellings by default. For production, set it to the comma-separated list of trusted deployed origins in the backend environment.

## Session and API behavior

The JWT is kept in React memory and sent only in the `Authorization` header. The app does not write it to local storage, session storage, URLs, or logs. Reloading closes the session and requires the user to sign in again. API `401` responses clear the current session and return to login; server errors are displayed as JSON API messages when available.

Student self-registration uses the backend's configured default organization and always creates a student account. Organization membership and role permissions are enforced by the backend using the authenticated user. Organization administration, document binary storage, and platform credentials remain server-side concerns.

## Build

```powershell
npm test
npm run build
```

`npm test` runs Vitest and React Testing Library component/workflow tests with mocked API responses. Backend `npm test` uses mock Prisma clients. `npm run test:integration` from `../backend` exercises PostgreSQL directly. These test suites are not browser-driven end-to-end tests.

The production bundle is written to `dist/`.
