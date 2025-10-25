import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzPQe4xRUFpmtkEv1YDMc1iqPRWjAWXLfN-9r9oax95bYp0YXHeHdI3YFSjVP3ISvuy/exec";

// Handle POST requests from your front-end
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
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed" });
  }
});

// Handle GET requests (optional)
app.get("/api", async (req, res) => {
  try {
    const response = await fetch(SCRIPT_URL);
    const text = await response.text();
    res.set("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
