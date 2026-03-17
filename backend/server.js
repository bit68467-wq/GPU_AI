import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/authRoutes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("CUP9 server running on port", PORT);
});
app.get("/", (req, res) => {
  res.json({
    status: "CUP9GPU backend running",
    api: "/api"
  });
});
import collections from "./routes/collections.js";
app.use("/api", collections);
