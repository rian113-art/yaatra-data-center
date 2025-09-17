// server.js — Supabase Storage: upload + robust list + force-download
const express = require("express");
const multer  = require("multer");
const path    = require("path");
const mime    = require("mime-types");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET       = (process.env.BUCKET_NAME || "yaatra-file").trim();
const UPLOAD_PREFIX = "uploads"; // folder default untuk file baru

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// statics
app.use(express.static(__dirname));

/** Pastikan bucket ada & public */
async function ensureBucket() {
  try {
    const { data: bucket, error: getErr } = await supabase.storage.getBucket(BUCKET);
    if (getErr || !bucket) {
      const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: null,
      });
      if (createErr) throw createErr;
      console.log(`[storage] bucket "${BUCKET}" dibuat (public).`);
    } else if (!bucket.public) {
      const { error: updErr } = await supabase.storage.updateBucket(BUCKET, { public: true });
      if (updErr) throw updErr;
      console.log(`[storage] bucket "${BUCKET}" diset public.`);
    }
  } catch (e) {
    console.error("[storage] ensureBucket error:", e.message);
  }
}

/** Multer di memory (tidak tulis disk Railway) */
const upload = multer({ storage: multer.memoryStorage() });

/** Upload endpoint */
app.post("/api/upload", upload.array("file", 20), async (req, res) => {
  try {
    await ensureBucket();
    const files = req.files || [];
    if (files.length === 0) return res.json({ ok: true, count: 0 });

    const now = Date.now();
    const keys = [];

    for (const f of files) {
      const ext  = path.extname(f.originalname);
      const base = path.basename(f.originalname, ext).replace(/[^\w\-]+/g, "_");
      const key  = `${UPLOAD_PREFIX}/${base}__${now}${ext}`;
      const contentType = f.mimetype || mime.lookup(ext) || "application/octet-stream";

      const { error } = await supabase.storage.from(BUCKET).upload(key, f.buffer, {
        contentType,
        upsert: false,
      });
      if (error) throw error;
      keys.push(key);
    }

    res.json({ ok: true, count: keys.length, files: keys });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Helper: ubah entry Supabase -> item untuk UI (termasuk link download paksa) */
function mapEntryToItem(prefix, entry) {
  const name = entry.name;
  const ext  = path.extname(name);
  const type = entry.metadata?.mimetype || mime.lookup(ext) || "application/octet-stream";
  const size = entry.metadata?.size ?? entry.size ?? 0;
  const updated = entry.updated_at || entry.created_at || new Date().toISOString();
  const fullKey = prefix ? `${prefix}/${name}` : name;
  const disp = name.includes("__") ? name.split("__")[0] + ext : name;

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(fullKey);
  return {
    name: disp,
    url: pub.publicUrl,                  // preview
    key: fullKey,
    type,
    size,
    uploadedAt: new Date(updated).getTime(),
    dl: `/api/dl?key=${encodeURIComponent(fullKey)}`, // force download
  };
}

/** List isi folder (rekursif satu tingkat) */
async function listFolder(prefix = "") {
  const out = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit, offset, sortBy: { column: "updated_at", order: "desc" } });

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const entry of data) {
      const isFile = typeof entry.id === "string" || typeof entry.size === "number";
      if (isFile) {
        out.push(mapEntryToItem(prefix, entry));
      } else {
        // folder → telusuri subfolder
        const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        const subItems = await listFolder(subPrefix);
        out.push(...subItems);
      }
    }

    if (data.length < limit) break;
    offset += limit;
  }

  return out;
}

/** Endpoint: daftar file (root + uploads + pola YYYY/MM bila ada) */
app.get("/api/files", async (_req, res) => {
  try {
    await ensureBucket();

    const collected = [];
    collected.push(...await listFolder(""));                // root
    collected.push(...await listFolder(UPLOAD_PREFIX));     // uploads/

    // pola lama YYYY/MM (jika ada)
    const { data: rootList } = await supabase.storage.from(BUCKET).list("");
    const years = (rootList || []).filter(e => !e.id && /^\d{4}$/.test(e.name)).map(e => e.name);
    for (const y of years) {
      const { data: months } = await supabase.storage.from(BUCKET).list(y);
      const mm = (months || []).filter(e => !e.id && /^\d{2}$/.test(e.name)).map(e => e.name);
      for (const m of mm) collected.push(...await listFolder(`${y}/${m}`));
    }

    // dedup + urut terbaru
    const seen = new Set();
    const items = [];
    for (const it of collected) {
      const k = `${it.key}|${it.size}|${it.uploadedAt}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
    items.sort((a,b)=> b.uploadedAt - a.uploadedAt);

    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/** Endpoint download: redirect ke signed URL (paksa download → fix Safari) */
app.get("/api/dl", async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send("Missing key");
    const niceName = path.basename(key).split("__")[0];
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(key, 60, { download: niceName });
    if (error) return res.status(404).send("File not found");
    return res.redirect(data.signedUrl);
  } catch (e) {
    console.error("dl error:", e.message);
    return res.status(500).send("Download error");
  }
});

// Health & root redirect
app.get("/health", (_req,res)=>res.type("text/plain").send("ok"));
app.get("/", (_req,res)=>res.redirect("/login.html"));

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
