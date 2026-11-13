# My Shop

A small online shop in Ghana cedis with an admin panel, a shop discount wallet, and MoMo payments.
No packages to install: it only needs **Node.js 22.13 or newer** (get the LTS version from https://nodejs.org).

## Run it on your computer

Double-click `start.bat`. The admin page opens in your browser.

- Shop: http://localhost:4080
- Admin: http://localhost:4080/admin

First admin login: username `admin`, password `admin123`. You are asked to set a new password (at least 10 characters) before anything else opens.
Keep the black window open while the shop runs; closing it stops the shop.

Phones on the same Wi-Fi can open the shop at `http://<this computer's IP address>:4080`.

## The shop discount wallet

On **MoMo** orders the order is paid from the customer's discount wallet first, as far as the balance goes.
The customer then pays **40%** of the amount taken from the wallet by MoMo, plus any part of the order the wallet did not cover.

| Wallet | Order | Taken from wallet | Customer pays by MoMo |
|---|---|---|---|
| GH₵ 30 | GH₵ 10 | GH₵ 10 | GH₵ 4 (40% of 10) |
| GH₵ 5 | GH₵ 10 | GH₵ 5 | GH₵ 7 (40% of 5, plus the 5 not covered) |

**Cash** orders do not use the wallet; the full price is paid in cash.
The percentage can be changed under Admin → Settings. The rule is calculated in one place only, the `quote` function in `server.js`; the shop pages ask the server for every amount, so what customers see is always what they are charged.
If a price, the percentage or a customer's wallet changes while they are checking out, the order is stopped and they are shown the new amount first.

## MoMo payments

**Manual (default).** Customers send MoMo to your number and type in the transaction ID. You check your MoMo and press *Confirm payment received* in the admin.

**Automatic with Paystack.** Customers pay on Paystack's secure page and the order is marked paid by itself.
1. Create a Paystack business account at https://paystack.com (Ghana) and turn on Mobile Money.
2. Copy `.env.example` to a new file called `.env` and paste your secret key after `PAYSTACK_SECRET_KEY=`. Start with the **test** key (`sk_test_...`); no real money moves.
3. Restart the shop. Admin → Settings shows "Paystack connected" and the webhook address.
4. In the Paystack dashboard (Settings → API Keys & Webhooks), paste that webhook address. Paystack can only reach it once the shop is hosted online (below); until then payments are still confirmed when the customer returns to the shop after paying.
5. When everything works, swap in the live key (`sk_live_...`).

Payments that need attention (money that arrived for a cancelled order, or the wrong amount) appear on the admin Overview, to refund from your Paystack dashboard.

## Put it online (HTTPS)

Running on your computer is fine for testing. For real customers, host it with HTTPS so passwords and payments are protected.
The easiest option is **Render** (render.com), using the included `render.yaml`:
1. Push this project to GitHub (the `data` folder and `.env` are never uploaded).
2. On Render: New → Blueprint → choose the repository. It creates the web service with a 1 GB disk for the database (paid "Starter" plan, because the free plan has no lasting disk).
3. In the service's Environment settings, set `PUBLIC_URL` to your Render address (for example `https://my-shop.onrender.com`) and add `PAYSTACK_SECRET_KEY`.
4. To move your existing shop data, upload `data/shop.db` and the `data/uploads` folder to the disk (Render Shell), or start fresh.

Any host that runs Docker works the same way with the included `Dockerfile`: mount a volume at `/var/data` and set `PUBLIC_URL`.
When `PUBLIC_URL` starts with `https://`, the shop switches on secure cookies, HTTPS-only redirects and HSTS automatically.

## Security built in

- Passwords hashed with scrypt; customers need at least 8 characters, the admin at least 10; common passwords are refused.
- Accounts lock for 15 minutes after 5 wrong passwords; sign-in attempts are also limited per network.
- Session cookies are HttpOnly; only a SHA-256 of each session token is stored. Admin sessions end after 2 hours idle or 12 hours total.
- Every change carries a per-session CSRF token, and requests started by other websites are refused.
- Changing a password signs out the other devices.
- Paystack notices are trusted only with a valid signature; amount and currency are checked before an order is marked paid; duplicate notices are ignored.
- Strict security headers (no framing, content security policy, no MIME sniffing).
- Uploaded photos are checked to be real PNG/JPG/WEBP images.
- **Activity log** in the admin records every sign-in, wallet change, order change, settings change and payment event.

## Your data

- Everything is in `data/shop.db` (SQLite) and product photos in `data/uploads/`.
- A backup copy is made every day in `data/backups/`; the last 14 are kept (`BACKUP_DAYS` in `.env`).
- Upgrading from the older version: on first start, `data/db.json` is imported automatically and renamed `db.json.imported`. Customers keep their passwords and wallets.
- The project folder is inside OneDrive. That works, but OneDrive syncing an open database can occasionally clash. If you see problems, set `DATA_DIR` in `.env` to a folder outside OneDrive, for example `C:\ShopData`.
- Copy the `data/backups` folder somewhere outside this computer now and then.

## Files

- `server.js`: web server, all shop rules and API routes
- `lib/db.js`: database tables and backups
- `lib/security.js`: passwords, sessions, CSRF, lockouts, activity log
- `lib/paystack.js`: Paystack payments and webhook signature check
- `lib/config.js`: reads settings from `.env`
- `public/`: shop (`index.html`, `shop.js`) and admin (`admin.html`, `admin.js`) pages, shared `style.css`
