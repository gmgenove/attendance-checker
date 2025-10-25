import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const TARGET_URL = "https://script.google.com/macros/s/AKfycbzPQe4xRUFpmtkEv1YDMc1iqPRWjAWXLfN-9r9oax95bYp0YXHeHdI3YFSjVP3ISvuy/exec";

app.post("/api", async (req, res) => {
  try {
    const response = await fetch(TARGET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
