# Service Book

Maintenance log and service schedule for a 2016 Chevrolet Equinox and a 2022 Honda Odyssey Touring.

- `server.js`: Express API, protected by a passcode, with Postgres storage
- `public/index.html`: the app
- `seed.json`: imported history, loaded into the database once on first start
- `render.yaml`: Render Blueprint (web service plus Postgres)

## Run locally

```
npm install
APP_PASSCODE=pick-one npm start
```

Without `DATABASE_URL`, data is stored in `data.local.json`.

## Deploy on Render

1. Push this folder to a **private** GitHub repo. It contains your service history.
2. In Render, go to **New → Blueprint** and select the repo.
3. When prompted, set `APP_PASSCODE`. `SESSION_SECRET` and `DATABASE_URL` are filled in automatically.

To back up your data, sign in and open `/api/export`.
