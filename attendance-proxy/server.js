import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();

// ✅ Allow CORS for all origins and methods
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// Your Google Apps Script URL
const YOUR_DEPLOYED_WEBAPP_ID = "AKfycbzPQe4xRUFpmtkEv1YDMc1iqPRWjAWXLfN-9r9oax95bYp0YXHeHdI3YFSjVP3ISvuy";
const SCRIPT_URL = "https://script.google.com/macros/s/" + YOUR_DEPLOYED_WEBAPP_ID + "/exec";

// ✅ Handle OPTIONS preflight requests properly
app.options("/api", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  return res.status(204).send(); // No content response
});

// ✅ Handle POST requests
app.post("/api", async (req, res) => {
  try {
    const response = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();
    res.set("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("Proxy error (POST):", err);
    res.status(500).json({ error: "Proxy failed" });
  }
});

// ✅ Handle GET requests
app.get("/api", async (req, res) => {
  try {
    const response = await fetch(SCRIPT_URL);
    const text = await response.text();
    res.set("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("Proxy error (GET):", err);
    res.status(500).json({ error: "Proxy failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
