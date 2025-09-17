const express = require("express");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const mime    = require("mime-types");

const app = express();
const PORT = process.env.PORT || 3000;

const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Simpan file ke folder downloads, nama asli + timestamp agar tak tertimpa
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, DOWNLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    const safe = name.replace(/[^\w\-]+/g, "_");
    cb(null, `${safe}__${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// Static files (html/css/js) dan file unduhan
app.use(express.static(__dirname));
app.use("/downloads", express.static(DOWNLOAD_DIR));

// Daftar file (nama display = original tanpa timestamp)
app.get("/api/files", async (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const items = files.map(f => {
      const full = path.join(DOWNLOAD_DIR, f);
      const st = fs.statSync(full);
      const ext = path.extname(f);
      const mimetype = mime.lookup(ext) || "application/octet-stream";
      // ambil nama asli sebelum "__timestamp"
      const base = path.basename(f, ext);
      const display = base.includes("__") ? base.split("__")[0] + ext : f;

      return {
        name: display,
        url: `/downloads/${encodeURIComponent(f)}`,
        type: mimetype,
        size: st.size,
        uploadedAt: st.mtimeMs
      };
    }).sort((a,b)=> b.uploadedAt - a.uploadedAt);

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload endpoint (field name "file", boleh multiple)
app.post("/api/upload", upload.array("file", 20), (req, res) => {
  res.json({ ok: true, count: req.files?.length || 0, files: req.files?.map(f => f.filename) });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
