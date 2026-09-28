    # ElectroStaff: Staff & Wage ERP

> This repo is the **backend** of ElectroStaff. The **frontend** lives at https://github.com/majidkambarath/electrostaff-frontend. Paths below like `backend/...` refer to this repo's root.

ElectroStaff is a phone-first web app for electrician businesses. It covers staff, job sites, site-wise attendance, advances, wages, payroll, site profit and a **staff app**. In the staff app, workers mark their own attendance, see their payslips and apply for leave or advances.

- **Office (owner):** runs the business from a desktop or phone.
- **Staff:** use the same app on their phone. They sign in with their mobile number and a password the owner gives them.
- **Install:** the app can be installed to the home screen (PWA) and sends notifications to the phone.

**Wage formula:** `Daily wage × (Present days + 0.5 × Half days) + OT rate × Overtime hours`
- It is calculated per site and summed.
- Each site's amount is rounded to the nearest rupee.
- The OT rate defaults to daily wage ÷ 8 unless you set it for a staff member.

---

## Contents

1. [Quick start](#quick-start)
2. [How the business flows](#how-the-business-flows)
3. [Architecture](#architecture)
4. [Security](#security)
5. [Configuration](#configuration)
6. [Commands and tests](#commands-and-tests)
7. [API reference](#api-reference)
8. [Business rules the API enforces](#business-rules-the-api-enforces)
9. [Going live](#going-live)
10. [Limitations and notes](#limitations-and-notes)

---

## Quick start

Prerequisites: Node.js 18+ and MongoDB (local or Atlas).

```bash
npm install            # root: installs `concurrently`
npm run install:all    # backend + frontend dependencies
cp backend/.env.example backend/.env     # set MONGODB_URI
cp frontend/.env.example frontend/.env   # BACKEND_URL defaults to http://localhost:5000
npm run dev            # API on :5000, app on :3000
```

Open <http://localhost:3000>.

### First launch: become the owner

A fresh database has no accounts, so the app opens **"Set up your business"**. Enter:
- your name
- your mobile number
- a password (6+ characters)
- the business name

That creates the **owner** account and signs you in. The setup screen then goes away for good. From then on, everyone signs in on the same screen with their mobile number and password.

Forgot the owner password? On the server, run:

```bash
cd backend && npm run reset-password -- 98450xxxxx new-password
```

It signs every device out. There is no reset over the internet on purpose.

### Give a worker the staff app

1. Go to **Staff → Register staff** and tick **Give staff app login & send it on WhatsApp**. For an existing worker, use **⋯ → Give app login**.
2. On **Register staff**, WhatsApp opens straight away on the worker's own mobile number with the login (app link, mobile, one-time password) already typed in. Just press **Send**. If the browser blocks it, tap **Send on WhatsApp** in the dialog, or use **Copy details**.
3. The worker signs in on their phone and must set their own password first.
4. To reset the password or turn access off, use **⋯ → App login: reset / turn off**. Turning access off signs the worker out immediately.

---

## How the business flows

### Office

1. **Register staff:** role, daily wage, optional OT rate, UPI ID, app login.
2. **Create a site** for each job, with its contract value. Then **assign staff** (Sites → site → Assign staff).
3. **Mark attendance** per site per day: present, half, absent or leave, plus overtime hours. Days a worker marks themselves show a phone badge with the check-in time and a map link.
4. **Leaves and staff requests:** approve or reject what staff send from the app. Approved leave pre-fills attendance. Approving an advance request records the advance.
5. **Advances:** money given ahead of wages, recovered from later payments.
6. **Site money:** each site's **Finance** tab covers client receipts, expenses, labour cost, client dues, and profit and margin. General expenses live on **Expenses**.
7. **Pay wages:** **Payments → Unpaid wages** lists attendance not yet paid.
   - **Pay** opens a per-site breakdown where you add a bonus or deductions, recover advances, and pay now or save as pending.
   - **Run payroll** pays everyone for a week or month in one go and prints the payroll sheet.
8. **Pay by UPI:** choose **UPI**.
   - On a phone, **Pay with Google Pay / PhonePe** opens the UPI app with the worker's UPI ID and amount filled in.
   - On a desktop, scan the QR code with your phone.
   - After paying, enter the UTR (transaction ID). You can also attach a screenshot. The screenshot is compressed and stored as proof.
9. **Wage slip:** a printable A4 slip with the amount in words and signature lines. Share it on WhatsApp. The worker sees the same slip, with the proof, in their app.
10. **Review:**
    - **Dashboard:** today's sites, unpaid wages, things that need attention, trends.
    - **Reports:** by staff or site for any date range, with CSV export.
    - **Muster roll:** the monthly attendance register.
    - **Performance:** monthly ratings.

### Staff app (mobile)

| Tab | What the worker can do |
|-----|------------------------|
| Home | **Check in** at an assigned site with one tap (full or half day). GPS is attached if allowed. Undo works until the office marks or pays that day. Also shows days and earnings this month, unpaid wages, advance balance and recent payslips. |
| Attendance | Month calendar with the site for each day and overtime |
| Payslips | Every payment, the formal wage slip and the payment proof |
| Leave | Apply for leave and see the office's decision. A pending application can be cancelled. |
| Requests | Ask for an advance or send a general request, and see the reply |
| Profile | Details, change password, phone notifications |

### Notifications

Every event below creates an in-app notification (the bell, polled every 30 seconds). It is also sent as a **push notification** to phones that turned them on in **Settings** or **Profile**.

- **Office is told:** a worker checked in, applied for leave, or sent a request.
- **Worker is told:** wages paid, leave decided, request answered, advance recorded.

Tapping a notification opens the related screen.

---

## Architecture

### The whole system

```
 ┌──────────────── Phone / desktop browser (PWA) ────────────────┐
 │  Office app (owner/admin)          Staff app (/me)            │
 │        └──────── React SPA: frontend/ ────────┘               │
 │   service worker (sw.js): app-shell cache + push messages     │
 └───────────────┬───────────────────────────────▲───────────────┘
                 │ HTTPS  /api  (Bearer token)    │ Web Push
                 ▼                                │
 ┌──────────────────── Express API: backend/ ─────┴──────────────┐
 │  interfaces/http → application (use cases) → domain (rules)   │
 │                         │                                     │
 │                  infrastructure: Mongo repositories,          │
 │                  bcrypt/JWT, web-push                         │
 └─────────────────────────┬─────────────────────────────────────┘
                           ▼
                  MongoDB (local or Atlas)

 Outside the app (links only, no API keys):
 WhatsApp (wa.me)  ·  Google Pay / PhonePe (upi://pay)  ·  Google Maps
```

The browser only ever talks to `/api`. WhatsApp and UPI apps are opened with links, so no third-party account or key is needed.

### Backend: hexagonal (ports and adapters)

```
            HTTP (Express)            CLI (scripts/)
                  │                         │
        src/interfaces/http          scripts/reset-password.js
     routes · auth guard · errors           │
                  └──────────┬──────────────┘
                             ▼
                  src/application  ── use cases (services) + input validation
                             │
                             ▼
                  src/domain       ── pure business rules, no I/O
                             ▲
                             │ implemented by
                  src/infrastructure ── Mongo repositories, bcrypt/JWT, web-push
                             ▲
                  src/container.js  ── composition root: wires adapters into services
```

Dependencies only point inward. The domain knows nothing about Express or MongoDB, and the services only know the repository **functions** they are given, not Mongoose.

**Folder map**

```
backend/
  server.js                      # entry: loads config, connects Mongo, builds the app, listens
  scripts/reset-password.js      # CLI adapter (owner password recovery)
  src/
    config/index.js              # env vars + generated secrets (.secrets.json)
    container.js                 # composition root: repositories → services
    domain/                      # PURE rules — no database, no HTTP
      wages.js                   #   siteAmount, OT rate, per-site breakdown, net pay
      attendance.js              #   statuses, OT limits, one-day-per-date rule
      dates.js  finance.js  credentials.js  files.js  errors.js
    application/
      validation.js              # pick / requireId / toNumber / requireText
      services/                  # USE CASES — one factory per area
        authService.js           #   setup, sign-in, tokens, change/reset password
        staffService.js          #   staff CRUD + app access (password to share)
        siteService.js  attendanceService.js  wageService.js  paymentService.js
        payrollService.js  advanceService.js  siteMoneyService.js
        leaveService.js  requestService.js  performanceService.js
        reportService.js  dashboardService.js  orgService.js
        portalService.js         #   everything the staff app does (scoped to that worker)
        notificationService.js   #   in-app notifications + push
    infrastructure/
      mongo/connection.js
      mongo/models/*.js          # Mongoose schemas (Staff, Site, Attendance, Payment, User, …)
      mongo/repositories/*.js    # the ONLY code that queries the database
      security.js                # bcrypt password hasher, JWT token service
      webPushNotifier.js         # sends Web Push messages
    interfaces/http/
      app.js                     # Express + security middleware
      middleware.js              # authenticate, requireRole, error → HTTP status
      routes.js                  # URL → service call (public, shared, /me, office)
  tests/
    domain.test.js               # unit tests of the pure rules
    e2e.js                       # whole business cycle against an in-memory MongoDB
```

| Layer | Folder | What lives there | May depend on |
|-------|--------|------------------|---------------|
| Domain | `src/domain/` | Wage maths, attendance rules, dates, finance summary, credentials, file checks, `DomainError` | nothing |
| Application | `src/application/` | One service per use-case area and input helpers. Services receive their dependencies (repositories, hasher, token service, notifier) as function arguments. | domain |
| Infrastructure | `src/infrastructure/` | Mongoose models and repositories, bcrypt/JWT, web-push | domain, libraries |
| Interfaces | `src/interfaces/http/`, `scripts/` | Routes, auth and role guards, error mapping; the CLI | application |
| Composition | `src/container.js`, `src/config/` | Builds every adapter and service once | everything |

**Request pipeline.** Every API call passes through the same steps:

```
request
  → helmet headers → CORS allow-list → JSON size limit → strip $-operators → rate limit
  → authenticate (verify JWT, check tokenVersion, load account → req.principal, req.orgId)
  → requireRole('staff')  for /me/*     |  requireRole('owner','admin')  for office routes
  → routes.js: pick allowed body fields → service.useCase(orgId, …)
  → service: validate → domain rules → repositories → notifications
  → JSON response
  (any DomainError → errorHandler → 400/401/403/404/409/429; anything else → generic 500)
```

For example, `PUT /api/payments/:id/mark-paid` ends in `paymentService.markPaid`. It checks the UPI screenshot with `domain/files`, saves it through `attachmentRepo` and `paymentRepo`, then calls `notificationService.notifyStaff` so the worker is told.

Why it is built this way:
- Business rules can be tested without a database (`tests/domain.test.js`).
- Services never see Express or Mongoose, so the database or web framework could be swapped by writing new adapters.
- A new entry point can reuse the same use cases, as the password-reset CLI does.

### Frontend: feature folders

**Folder map**

```
frontend/
  index.html                     # PWA meta tags
  public/                        # icons, manifest.webmanifest, sw.js (service worker)
  vite.config.js                 # dev proxy /api → BACKEND_URL, chunk splitting
  src/
    main.jsx                     # AuthProvider → ConfirmProvider → App; registers the service worker
    index.css                    # Tailwind theme tokens + mobile utilities
    app/
      App.jsx                    # routes per role (office vs staff), lazy pages, idle prefetch
      layouts/AdminLayout.jsx    # office sidebar, mobile drawer, bottom tabs, notification bell
      NotFound.jsx
    features/                    # one folder per business area
      auth/                      #   AuthContext (session state), sign-in / setup / change password
      dashboard/ staff/ sites/ attendance/ leaves/ requests/ payments/ payroll/
      advances/ expenses/ reports/ performance/ settings/
      portal/                    #   the staff app: home + check-in, attendance, payslips, leave, requests, profile
      notifications/             #   bell, push subscribe
      <feature>/
        <Name>Page.jsx           #   route-level screen (lazy-loaded)
        components/              #   sheets, dialogs, rows used by that feature
        api.js                   #   that feature's endpoints
    shared/                      # used by every feature, never imports from features/
      api/http.js                #   the single HTTP adapter: base URL, token, timeout, 401 → sign out
      hooks/useApi.js            #   data loading + cache (stale-while-revalidate)
      ui/                        #   shadcn-style primitives (Radix): button, dialog, sheet, select…
      components/                #   PageHeader, StatTile, States, Toolbar, DateStepper, print/Document…
      lib/                       #   format, csv, share (WhatsApp), upi, image compression, pwa, chart theme
```

**How a screen gets its data**

```
main.jsx
  └ AuthProvider ── GET /auth/status ──► setup screen | sign-in screen | forced password change
        │ (signed in: token kept in localStorage, principal in context)
        ▼
  App.jsx ── principal.role ──► owner/admin → AdminLayout + office pages
                                staff       → PortalLayout + /me pages
        ▼
  <Feature>Page.jsx
     useApi(() => featureApi.list(), deps, { cacheKey })   ← shows cached data instantly, refreshes
        ▼
  features/<feature>/api.js      e.g. staffApi.create(payload)
        ▼
  shared/api/http.js             adds Authorization, timeout, error → Error(message)
        ▼                        401 → sign out + clear cache
  /api  (Vite proxy in dev, same origin or VITE_API_URL in production)
```

Rules:
- **`shared/` never imports from `features/`.** Features may use another feature's `api.js` or components. For example, Sites embeds the attendance board, and Staff shows payments.
- **Only `shared/api/http.js` calls `fetch`.** Each feature's `api.js` describes its endpoints.
- **Routes by role.** `App.jsx` renders office routes for owner/admin and `/me/*` routes for staff. Pages are lazy-loaded per role, so staff phones never download office screens. The server enforces the same split, so the frontend is not the security boundary.
- **Pages always handle three states:** loading (`PageLoader`), error with retry (`ErrorState`), and empty (`EmptyState`).
- **Phone-first.** Tables become card lists below `md`, controls are finger-sized, and inputs use 16px text so iOS doesn't zoom.
- **PWA.** `public/sw.js` caches the app shell and hashed assets, never `/api`, and handles push messages.

### Main flows, end to end

**1. First launch and sign-in**
```
App → GET /auth/status → { setupRequired: true }
    → "Set up your business" → POST /auth/setup → owner created → token
Later: sign-in screen → POST /auth/login { phone, password }
    → authService checks office accounts, then staff with app access
    → token { sub, kind, v } → App picks office or staff routes
```

**2. Register a worker and send the login on WhatsApp**
```
Staff → Register staff (tick "Give staff app login & send it on WhatsApp")
  → POST /staff                        staffService.create
  → POST /staff/:id/access {generate}  staffService.grantAccess → one-time password (hashed in DB)
  → browser opens https://wa.me/91<worker's phone>?text=<login message>
  → WhatsApp shows the worker's chat with the message typed in → owner presses Send
  (if the browser blocks the new tab, the "Send on WhatsApp" button in the dialog does the same)
Worker opens the link → signs in → must set their own password (mustChangePassword)
```

**3. Worker checks in at a site**
```
Staff app Home → Check in (site, full/half day, GPS if allowed)
  → POST /me/check-in → portalService.checkIn
      assigned to site? office hasn't marked it? not paid yet? one day per date?
  → attendance saved with source 'staff' + checkIn {at, lat, lng}
  → notificationService.notifyAdmins → bell + push "X checked in at Y"
Office sees it on the attendance board with a phone badge and map link
```

**4. Leave or advance request**
```
Staff app → POST /me/leaves or /me/requests → office notified
Office → Leaves / Staff requests → approve or reject
  → approved leave pre-fills attendance; approved advance records an Advance
  → worker notified
```

**5. Pay wages by UPI**
```
Payments → Unpaid wages → Pay → GET /payments/preview (per-site breakdown)
  → choose UPI → phone: opens GPay/PhonePe (upi://pay?pa=<worker UPI>&am=<net>)
                 desktop: QR code to scan
  → enter UTR (+ optional screenshot, compressed in the browser)
  → POST /payments (or PUT /payments/:id/mark-paid) → proof checked and stored
  → worker notified → worker sees the wage slip and proof in the app
```

### Adding a feature

1. **Domain rule**, if any: add it to `backend/src/domain/` with a unit test in `tests/domain.test.js`.
2. **Model and repository** in `src/infrastructure/mongo/`. Export them from both `index.js` files.
3. **Service** in `src/application/services/`. Register it in `services/index.js` and `container.js`.
4. **Routes** in `src/interfaces/http/routes.js` on the `office` or `me` router, so the role guard applies. Whitelist body fields with `pick(req.body, [...])`.
5. **E2E checks** in `tests/e2e.js`.
6. **Frontend:** create `features/<name>/api.js` and `<Name>Page.jsx`. Add the lazy route in `app/App.jsx` and the nav entry in `app/layouts/AdminLayout.jsx`.

---

## Security

| Threat | Protection |
|--------|------------|
| Stolen or guessed passwords | bcrypt hashes (never returned by the API). Minimum 6 characters. Per-number lockout after 8 failures for 15 minutes. Sign-in routes limited per IP. |
| Stolen sessions | Signed JWT (30 days by default). Changing a password, resetting it or turning off app access bumps `tokenVersion`, which ends every session for that account at once. |
| Staff seeing office data | `requireRole` on every office route. Staff routes (`/me/*`) are scoped to the signed-in worker. A worker can't open another worker's payslip or proof. |
| One business reading another's data | Every query is scoped to the organization from the token, never from a header or body. |
| NoSQL injection | `$`- and `.`-prefixed keys are stripped from bodies and queries. Bodies are whitelisted field by field. |
| Uploads | Proof images must really be JPEG, PNG or WebP (magic bytes checked) and ≤ 2 MB. They are served with `nosniff` and only to the office or that worker. |
| Abuse and flooding | 300 requests/min per IP on `/api`. JSON body limit of 200 kB (4 MB on payments for proofs). |
| Browser attacks | Helmet security headers on the API. CORS allow-list (`CORS_ORIGINS`). `x-powered-by` off. |
| Leaking internals | 500 errors return a generic message. Details go to the server log only. |
| Secrets in git | `.env` and `.secrets.json` are git-ignored. Missing secrets (JWT key, VAPID keys) are generated on first start and kept in `backend/.secrets.json`. |

---

## Configuration

`backend/.env` (see `backend/.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `5000` | API port |
| `MONGODB_URI` | required | MongoDB connection string |
| `DEFAULT_ORGANIZATION_ID` | auto | Use an existing organization document for the business |
| `JWT_SECRET` | generated | Token signing key. **Set it in production.** |
| `TOKEN_TTL` | `30d` | How long a sign-in lasts |
| `CORS_ORIGINS` | any | Comma-separated allowed origins, e.g. `https://staff.example.com` |
| `TRUST_PROXY` | `loopback` | `1` behind one reverse proxy (needed for correct per-IP limits) |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-IP API limit |
| `AUTH_RATE_LIMIT` | `50` | Per-IP sign-in attempts per 15 minutes |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Web Push keys (`npx web-push generate-vapid-keys`) |
| `VAPID_SUBJECT` | `mailto:admin@electrostaff.local` | Contact sent to push services |

`frontend/.env` (see `frontend/.env.example`):

| Variable | Purpose |
|----------|---------|
| `BACKEND_URL` | Where the Vite dev/preview server proxies `/api` (default `http://localhost:5000`) |
| `VITE_API_URL` | Full API base such as `https://api.example.com/api`, only when the frontend is hosted separately. Leave it empty to use same-origin `/api`. |

---

## Commands and tests

```bash
# root
npm run dev                 # backend + frontend together
npm test | npm run lint | npm run build    # shortcuts to the backend tests and frontend lint/build

# backend/
npm run dev                 # nodemon (auto-reload). `npm start` does not reload.
npm test                    # domain unit tests + full end-to-end API run on an in-memory MongoDB
npm run test:unit           # domain unit tests only
npm run reset-password -- <mobile> <new-password>

# frontend/
npm run dev                 # Vite on :3000 (also on your LAN, so you can test on a phone)
npm run build               # production build to dist/
npm run preview             # serve the build (proxies /api like dev)
npm run lint                # oxlint
```

`npm test` never touches the database in `.env`. The end-to-end run covers:
- setup and sign-in
- every office flow
- the staff app
- notifications
- UPI proof
- access revocation
- archive rules
- password recovery

---

## API reference

All routes are under `/api`. Errors return `{ message }` with status 400, 401, 403, 404, 409, 429 or 500. Authenticated calls send `Authorization: Bearer <token>`.

**Public**

| | |
|--|--|
| `GET /health` | Liveness |
| `GET /auth/status` | `{ setupRequired }` |
| `POST /auth/setup` | First run only: `{ name, phone, password, businessName }` → `{ token, principal }` |
| `POST /auth/login` | `{ phone, password }` → `{ token, principal }` (owner, admin or staff) |

**Any signed-in user**

| | |
|--|--|
| `GET /auth/me`, `POST /auth/change-password` | Session and own password |
| `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read` | In-app notifications |
| `GET /notifications/push-key`, `POST /notifications/subscribe`, `POST /notifications/unsubscribe` | Web Push |

**Staff app (`role: staff`, own data only)**

| | |
|--|--|
| `GET /me/home` | Today's check-in, month stats, balances, recent payslips |
| `POST /me/check-in` (`{ siteId, status, lat?, lng?, accuracy? }`), `POST /me/check-in/undo` | Self attendance |
| `GET /me/attendance?month=&year=` | Own attendance |
| `GET /me/payslips`, `GET /me/payslips/:id`, `GET /me/payslips/:id/proof` | Own payments |
| `GET /me/advances` | Own advances and balance |
| `GET/POST /me/leaves`, `DELETE /me/leaves/:id` | Apply for or cancel leave |
| `GET/POST /me/requests`, `POST /me/requests/:id/cancel` | Advance and general requests |

**Office (`role: owner | admin`)**

| Area | Endpoints |
|------|-----------|
| Organization | `GET/PUT /org`, `GET /dashboard` |
| Staff | `GET/POST /staff` (`?q=&status=&role=`), `GET/PUT/DELETE /staff/:id`, `POST/DELETE /staff/:id/access` (app login: `{ password }` or `{ generate: true }`) |
| Sites | `GET/POST /sites`, `GET/PUT/DELETE /sites/:id`, `GET /sites/:id/progress`, `GET /sites/:id/finance`, `GET /sites/:id/staff`, `POST /sites/:id/assign`, `DELETE /sites/:id/assign/:staffId` |
| Attendance | `GET /attendance?siteId=&date=`, `POST /attendance`, `POST /attendance/bulk`, `GET /attendance/staff/:staffId?month=&year=` |
| Payments | `GET /payments`, `GET /payments/preview`, `GET /payments/outstanding`, `POST /payments`, `GET /payments/:id`, `GET /payments/:id/proof`, `PUT /payments/:id/mark-paid` (`paymentMode`, `transactionRef`, `proof`), `DELETE /payments/:id` (pending only) |
| Payroll | `GET /payroll`, `GET /payroll/preview?from=&to=`, `POST /payroll`, `GET /payroll/:id`, `PUT /payroll/:id/mark-paid`, `DELETE /payroll/:id` |
| Advances | `GET/POST /advances`, `GET /advances/balances`, `DELETE /advances/:id` |
| Site money | `GET/POST /expenses` (`?siteId=general` for overheads), `PUT/DELETE /expenses/:id`, `GET/POST /receipts`, `DELETE /receipts/:id` |
| Leaves & requests | `GET/POST /leaves`, `PUT/DELETE /leaves/:id`, `GET /requests`, `PUT /requests/:id` (approve or reject; approving an advance records it) |
| Performance | `GET/POST /performance`, `DELETE /performance/:id` |
| Reports | `GET /reports/summary?from=&to=`, `GET /reports/muster?month=&year=&siteId=` |

---

## Business rules the API enforces

- **One day's wage per date.** A person earns at most one day's wage per date across all sites: half + half is fine, present + present is rejected. Overtime (0–16 h) only counts on present or half days.
- **Future dates are rejected** for attendance.
- **Paid days are locked.** Days inside a payment period can't be changed, by the office or by the worker's own check-in. Cancel the pending payment first.
- **Staff check-in rules.** Staff can only check in for today, only at sites they are assigned to, and can't override a mark the office already made.
- **No overlapping payments.** Payment periods can't overlap for the same staff member. Only pending payments can be cancelled, and a payroll run with any paid payment can't be cancelled.
- **Advance recovery** can't exceed the outstanding advance or the wages. An advance that has already been recovered can't be deleted.
- **Archive, don't delete.** Staff and sites with history are archived (inactive or completed). Archiving a worker also ends their app access.

---

## Going live

- **Serve over HTTPS.** Phone push notifications, GPS check-in and "Install app" all need it. On iPhone, push works only after **Add to Home Screen**.
- **Set a strong `JWT_SECRET`.** Also set `CORS_ORIGINS` to your site's address, and `TRUST_PROXY=1` if you run behind Nginx or a host's proxy.
- **Build the frontend** (`npm run build`) and serve `frontend/dist` with a fallback to `index.html`. Proxy `/api` to the backend. If you host the frontend separately, set `VITE_API_URL` instead.
- **Keep `backend/.secrets.json`** (or set the env vars). Losing it signs everyone out and turns off existing push subscriptions.
- **Back up MongoDB** regularly. Payment proofs are stored in the database (`attachments` collection).

---

## Limitations and notes

- **UPI confirmation is manual.** Google Pay and PhonePe don't report back to web apps whether a payment succeeded. The owner confirms by entering the UTR, with an optional screenshot. Automatic confirmation needs a payment gateway or payouts API (Razorpay, Cashfree…), which requires a business account.
- **Logins are shared on WhatsApp**, not SMS. SMS needs a paid provider (MSG91, Twilio…) and DLT registration in India.
- **One office account.** The API supports `owner` and `admin` roles, but only the owner account is created (at setup). There is no screen yet to add more office users.
- **Dates** are sent as `YYYY-MM-DD` and stored as the start of that day in the server's time zone.
- **Legacy data:** staff, leaves and ratings created before organizations existed stay visible. Old payments without adjustments show their gross amount as net. The old monthly Salary module was replaced by Payments. Existing `salaries` documents are left untouched.
