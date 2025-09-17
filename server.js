// server.js — Supabase Storage, auto-create bucket, robust listing
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
const UPLOAD_PREFIX = "uploads"; // folder untuk file baru

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Sajikan file statis
app.use(express.static(__dirname));

/** Pastikan bucket ada & public */
async function ensureBucket() {
  try {
    const { data: bucket, error: getErr } = await supabase.storage.getBucket(BUCKET);
    if (getErr || !bucket) {
      // tidak ada → buat baru (public)
      const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: null
      });
      if (createErr) throw createErr;
      console.log(`[storage] bucket "${BUCKET}" dibuat (public).`);
    } else if (!bucket.public) {
      // ada tapi private → ubah ke public
      const { error: updErr } = await supabase.storage.updateBucket(BUCKET, { public: true });
      if (updErr) throw updErr;
      console.log(`[storage] bucket "${BUCKET}" diset public.`);
    } else {
      console.log(`[storage] bucket "${BUCKET}" sudah ada & public.`);
    }
  } catch (e) {
    console.error("[storage] ensureBucket error:", e.message);
  }
}

// ===== Upload (pakai memory, tidak menyentuh disk Railway) =====
const upload = multer({ storage: multer.memoryStorage() });

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

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(key, f.buffer, { contentType, upsert: false });

      if (error) throw error;
      keys.push(key);
    }

    res.json({ ok: true, count: keys.length, files: keys });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Helper: list isi folder (rekursif 1–2 tingkat) =====
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
        const name = entry.name;
        const ext  = path.extname(name);
        const type = entry.metadata?.mimetype || mime.lookup(ext) || "application/octet-stream";
        const size = entry.metadata?.size ?? entry.size ?? 0;
        const updated = entry.updated_at || entry.created_at || new Date().toISOString();
        const fullKey = prefix ? `${prefix}/${name}` : name;
        const disp = name.includes("__") ? name.split("__")[0] + ext : name;

        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(fullKey);
        out.push({
          name: disp,
          url: pub.publicUrl,
          type,
          size,
          uploadedAt: new Date(updated).getTime()
        });
      } else {
        // folder → telusuri satu tingkat lagi
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

// ===== List semua file dari root + uploads + (jika ada) YYYY/MM =====
app.get("/api/files", async (_req, res) => {
  try {
    await ensureBucket();

    const collected = [];
    // root
    collected.push(...await listFolder(""));
    // uploads/
    collected.push(...await listFolder(UPLOAD_PREFIX));

    // pola lama YYYY/MM (jika ada)
    const { data: rootList } = await supabase.storage.from(BUCKET).list("");
    const years = (rootList || []).filter(e => !e.id && /^\d{4}$/.test(e.name)).map(e => e.name);
    for (const y of years) {
      const { data: months } = await supabase.storage.from(BUCKET).list(y);
      for (const m of (months || []).filter(e => !e.id && /^\d{2}$/.test(e.name)).map(e => e.name)) {
        collected.push(...await listFolder(`${y}/${m}`));
      }
    }

    // dedup
    const seen = new Set();
    const items = [];
    for (const it of collected) {
      const k = `${it.url}|${it.size}|${it.uploadedAt}`;
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

// Health & root redirect
app.get("/health", (_req,res)=>res.type("text/plain").send("ok"));
app.get("/", (_req,res)=>res.redirect("/login.html"));

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
