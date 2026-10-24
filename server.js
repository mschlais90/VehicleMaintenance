// Service Book: a small Express server for the vehicle maintenance app.
// Storage is Postgres when DATABASE_URL is set (Render), otherwise a local JSON file for development.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PASSCODE = process.env.APP_PASSCODE || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const VEHICLE_IDS = ["equinox", "odyssey"];
const COOKIE = "sb_auth";
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "seed.json"), "utf8"));

// ---------- Storage ----------
function pgStore() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
  });
  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, data JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      const seeded = await pool.query("SELECT 1 FROM meta WHERE key = 'seeded'");
      if (seeded.rowCount) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const { id, ...data } of SEED.logs) {
          await client.query("INSERT INTO logs (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [id, data]);
        }
        for (const [id, data] of Object.entries(SEED.vehicles)) {
          await client.query("INSERT INTO vehicles (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [id, data]);
        }
        await client.query("INSERT INTO meta (key, value) VALUES ('seeded', $1)", [new Date().toISOString()]);
        await client.query("COMMIT");
        console.log(`Seeded ${SEED.logs.length} logs`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    async state() {
      const [logs, vehicles] = await Promise.all([pool.query("SELECT id, data FROM logs"), pool.query("SELECT id, data FROM vehicles")]);
      return {
        logs: logs.rows.map(r => ({ id: r.id, ...r.data })),
        vehicles: Object.fromEntries(vehicles.rows.map(r => [r.id, r.data]))
      };
    },
    async putLog(id, data) {
      await pool.query(
        "INSERT INTO logs (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
        [id, data]);
    },
    async hasLog(id) { return (await pool.query("SELECT 1 FROM logs WHERE id = $1", [id])).rowCount > 0; },
    async deleteLog(id) { await pool.query("DELETE FROM logs WHERE id = $1", [id]); },
    async putVehicle(id, data) {
      await pool.query("INSERT INTO vehicles (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [id, data]);
    }
  };
}

function fileStore() {
  const file = path.join(__dirname, "data.local.json");
  let db;
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  return {
    async init() {
      if (fs.existsSync(file)) { db = JSON.parse(fs.readFileSync(file, "utf8")); return; }
      db = { logs: Object.fromEntries(SEED.logs.map(({ id, ...d }) => [id, d])), vehicles: { ...SEED.vehicles } };
      save();
      console.log(`No DATABASE_URL; using ${file}`);
    },
    async state() { return { logs: Object.entries(db.logs).map(([id, d]) => ({ id, ...d })), vehicles: db.vehicles }; },
    async putLog(id, data) { db.logs[id] = data; save(); },
    async hasLog(id) { return id in db.logs; },
    async deleteLog(id) { delete db.logs[id]; save(); },
    async putVehicle(id, data) { db.vehicles[id] = data; save(); }
  };
}

const store = process.env.DATABASE_URL ? pgStore() : fileStore();

// ---------- Validation ----------
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function cleanLog(body) {
  if (!body || !VEHICLE_IDS.includes(body.vehicle)) return null;
  if (!isDate(body.date)) return null;
  const items = Array.isArray(body.items) ? body.items.filter(i => typeof i === "string" && /^[a-z_]{1,40}$/.test(i)).slice(0, 30) : [];
  const miles = num(body.miles);
  const cost = num(body.cost);
  return {
    vehicle: body.vehicle, date: body.date,
    miles: miles === null ? null : Math.max(0, Math.round(miles)),
    items, title: str(body.title, 120), minder: str(body.minder, 12).toUpperCase(),
    shop: str(body.shop, 80), cost: cost === null ? null : Math.max(0, Math.round(cost * 100) / 100),
    notes: str(body.notes, 2000)
  };
}

function cleanVehicle(body) {
  const out = {};
  const odo = num(body && body.odometer);
  if (odo !== null) out.odometer = Math.max(0, Math.round(odo));
  if (isDate(body && body.odometerDate)) out.odometerDate = body.odometerDate;
  if (body && ["normal", "severe"].includes(body.profile)) out.profile = body.profile;
  if (isDate(body && body.inService)) out.inService = body.inService;
  return out;
}

// ---------- Auth ----------
const token = () => crypto.createHmac("sha256", SECRET).update("service-book:" + PASSCODE).digest("hex");
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function requireAuth(req, res, next) {
  if (!PASSCODE || safeEqual(readCookie(req, COOKIE), token())) return next();
  res.status(401).json({ error: "Sign in required" });
}

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("/healthz", (req, res) => res.send("ok"));

app.post("/api/login", async (req, res) => {
  if (!PASSCODE) return res.json({ ok: true });
  if (!safeEqual(str(req.body && req.body.passcode, 200), PASSCODE)) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: "That passcode didn't match." });
  }
  res.cookie(COOKIE, token(), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 365 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.use("/api", requireAuth);

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: "Server error" }); });

app.get("/api/state", wrap(async (req, res) => res.json(await store.state())));

app.post("/api/logs", wrap(async (req, res) => {
  const log = cleanLog(req.body);
  if (!log) return res.status(400).json({ error: "A vehicle and a date are required." });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.putLog(id, { ...log, createdAt: now, updatedAt: now });
  res.status(201).json({ id });
}));

app.put("/api/logs/:id", wrap(async (req, res) => {
  const log = cleanLog(req.body);
  if (!log) return res.status(400).json({ error: "A vehicle and a date are required." });
  if (!(await store.hasLog(req.params.id))) return res.status(404).json({ error: "That entry no longer exists." });
  const now = new Date().toISOString();
  await store.putLog(req.params.id, { ...log, createdAt: str(req.body.createdAt, 40) || now, updatedAt: now });
  res.json({ id: req.params.id });
}));

app.delete("/api/logs/:id", wrap(async (req, res) => {
  await store.deleteLog(req.params.id);
  res.status(204).end();
}));

app.put("/api/vehicles/:id", wrap(async (req, res) => {
  if (!VEHICLE_IDS.includes(req.params.id)) return res.status(404).json({ error: "Unknown vehicle." });
  await store.putVehicle(req.params.id, cleanVehicle(req.body));
  res.json({ ok: true });
}));

app.get("/api/export", wrap(async (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="service-book-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(await store.state());
}));

store.init().then(() => {
  app.listen(PORT, () => console.log(`Service Book on http://localhost:${PORT}${PASSCODE ? "" : " (no passcode set)"}`));
}).catch(e => { console.error("Startup failed:", e); process.exit(1); });
