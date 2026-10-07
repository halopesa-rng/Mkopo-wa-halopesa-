# Loan Application Portal

A simple, mobile-first loan application portal with:

- 5 short application pages instead of one long page
- Customer details
- Loan calculator
- Application verification
- Telegram admin approval/rejection
- Multiple Telegram administrators
- 30-second portal verification code
- Final confirmation code
- PostgreSQL persistence
- Render deployment configuration

## Important

This is a generic loan application portal. It does **not** collect HaloPesa passwords, official HaloPesa authentication OTPs, or SMS transaction PINs/codes.

If this is being used by a financial company, connect the relevant official APIs and notification provider through the company's authorized process.

## Pages

1. Customer details
2. Amount + calculator
3. Application verification + Telegram approval wait
4. Portal verification code
5. Final loan offer confirmation

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open:

`http://localhost:10000`

## Telegram setup

1. Create a Telegram bot with BotFather.
2. Put the bot token in `TELEGRAM_BOT_TOKEN`.
3. Put Telegram numeric user IDs in `TELEGRAM_ADMIN_IDS`, separated by commas.
4. Start the server.
5. Each admin should open the bot and send `/start`.

Telegram admins receive an application card with:

- Approve
- Reject

Only IDs in `TELEGRAM_ADMIN_IDS` can use the approval buttons.

## PostgreSQL

The server creates the required table automatically on startup.

For Render, create a PostgreSQL database and set its `DATABASE_URL` on the web service.

## SMS

The code contains an SMS service boundary. In development, generated codes are printed in the server logs and optionally displayed on the UI when `DEV_SHOW_CODES=true`.

For production, connect an authorized SMS provider and replace the `sendSms()` function in `server.js`.

## Security

Before production:

- use HTTPS
- set `DEV_SHOW_CODES=false`
- use strong Telegram admin controls
- connect an authorized SMS provider
- add identity/KYC controls required by the business
- add proper audit/log retention
- use official financial APIs only where authorized
