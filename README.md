# Shop

A simple online shop with an admin panel. No packages to install — it only needs Node.js.

## Start it
1. Install Node.js (LTS) from https://nodejs.org if you don't have it.
2. Double-click `start.bat` (or run `node server.js` in this folder).
3. Shop: http://localhost:4080 — Admin: http://localhost:4080/admin

First admin login: username `admin`, password `admin123`. Change it under Settings straight away.

## Shop discount wallet rule
Paying by MoMo:
- As much of the order as possible is taken from the customer's shop discount wallet.
- The customer pays 40% of the amount taken from the wallet through MoMo, plus anything the wallet did not cover.
- Wallet GH₵30, order GH₵10 → wallet −10, MoMo 4.
- Wallet GH₵5, order GH₵10 → wallet −5, MoMo 2 + 5 = 7.

Paying by cash: the wallet is not touched; the full price is paid in cash.

The 40% can be changed under Admin → Settings. The rule lives in the `quote` function in `server.js`.

## Unpaid orders
An unpaid order holds its stock and the wallet credit it used. After 24 hours (change this under Admin → Settings, 0 = never) it is cancelled automatically and both are released.

## Letting customers reach it
Right now the shop only runs on this computer. Phones on the same Wi-Fi can open it at `http://<this computer's IP>:4080`. For customers elsewhere it needs to be put on a small server with HTTPS, because logins travel in plain text over plain HTTP.

## Good to know
- All data is in `data/db.json`; product photos are in `data/uploads/`. Back up the `data` folder.
- MoMo payments are confirmed by hand: the customer sends the money and submits the transaction ID, and the admin clicks "Confirm payment received".
- Cancelling an order restores stock and returns the wallet amount.
