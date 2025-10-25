import express from "express";
import fetch from "node-fetch";

const app = express();
const YOUR_DEPLOYED_WEBAPP_ID = "AKfycbzPQe4xRUFpmtkEv1YDMc1iqPRWjAWXLfN-9r9oax95bYp0YXHeHdI3YFSjVP3ISvuy";
const SCRIPT_URL = "https://script.google.com/macros/s/" + YOUR_DEPLOYED_WEBAPP_ID + "/exec";

// --- GLOBAL CORS HANDLER ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// --- MAIN API ROUTE ---
app.all("/api", async (req, res) => {
  try {
    const opts = {
      method: req.method,
      headers: { "Content-Type": "application/json" },
    };
    if (req.method === "POST") opts.body = JSON.stringify(req.body);

    const response = await fetch(SCRIPT_URL, opts);
    const text = await response.text();

    res.set("Access-Control-Allow-Origin", "*");
    res.status(response.status).send(text);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
