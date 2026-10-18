# Secure Shop (test project)

A small TypeScript React app with a fake login, where each common way of securing a web app has a working example.
Visual Editor uses it to check that previews show every page, logged in or not, without real logins.

```
npm install
npm run backend      # dev backend on 127.0.0.1:4600
npm run dev          # the app (Vite sends /api and /files to the backend)
```

Log in with **any password**. The email decides who you are: `admin…@` is an admin, `staff…@` is staff, others are
customers; an email containing `pro` has the Pro plan. The CAPTCHA is Cloudflare's always-passes test key. The 2FA code
is `123456`.

| # | Case | Where |
|---|---|---|
| A1 | Session cookie (server-side session) | `server` /api/login, /api/me · `src/auth/AuthContext.tsx` |
| A2 | JWT in an HttpOnly cookie | /api/notifications · `src/pages/Home.tsx` |
| A3 | Bearer token in localStorage | /api/orders · `src/api/http.ts` (`shop.accessToken`) · `src/pages/Orders.tsx` |
| A4 | Short access token + refresh cookie | /api/refresh · `src/api/http.ts` (renew on 401, retry once) |
| A5 | API key in a header | /api/catalog · `src/pages/Catalog.tsx` (`VITE_CATALOG_KEY`) |
| A6 | HTTP Basic auth | /api/legacy/health · `src/pages/Legacy.tsx` |
| A7 | Login provider (Auth0) | `src/main.tsx` (`Auth0Provider`) · `src/pages/Profile.tsx` (`useAuth0`) |
| A9 | Passwordless: one-time code | /api/magic · `src/pages/MagicLink.tsx` |
| A10 | Second factor before a sensitive action | /api/2fa/verify, DELETE /api/account · `src/pages/Account.tsx` · `src/components/TwoFactorDialog.tsx` |
| B12 | Route guard (route level) | `src/auth/RequireAuth.tsx` · `src/App.tsx` |
| B12/B14 | Guard inside the page; admins only | `src/pages/Admin.tsx` (`<Navigate>` unless admin) · /api/admin/stats |
| B13 | Auth context + `useAuth()` | `src/auth/AuthContext.tsx` |
| B14 | Role-based links | `src/components/Navbar.tsx` |
| B15 | Plan and feature flags (zustand store) | `src/pages/Reports.tsx` · `src/store/features.ts` · /api/reports |
| C17 | CSRF token (double submit) | /api/csrf · cancel order in `src/pages/OrderDetail.tsx` |
| C18/C19 | Cookies sent with requests; SameSite=Lax | `credentials: 'include'` in `src/api/http.ts` · cookies in `server` |
| C20 | Expiry and logout handling | `src/api/http.ts` (`onLoggedOut`) |
| C21 | CAPTCHA (Cloudflare Turnstile) | `src/components/Captcha.tsx` · `src/pages/Login.tsx` · checked by /api/login |
| C22 | Signed, expiring download link | /api/invoices/:id/link, /files/… · `src/pages/Invoice.tsx` |

Not included: enterprise SSO (SAML) and client certificates, which need outside systems; server-side checks before a
page loads belong to Next.js apps.
