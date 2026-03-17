import express from "express";

const router = express.Router();

/*
Simple in-memory storage.
If you later connect PostgreSQL this can be replaced.
*/
const db = {};

/* GET collection */
router.get("/collections/:name", (req, res) => {
  const name = req.params.name;
  if (!db[name]) db[name] = [];
  res.json(db[name]);
});

/* CREATE item */
router.post("/collections/:name", (req, res) => {
  const name = req.params.name;
  if (!db[name]) db[name] = [];

  const item = {
    id: Date.now().toString(),
    ...req.body
  };

  db[name].push(item);
  res.json(item);
});

/* UPDATE item */
router.put("/collections/:name/:id", (req, res) => {
  const { name, id } = req.params;

  if (!db[name]) db[name] = [];

  const index = db[name].findIndex(x => x.id === id);

  if (index === -1) {
    return res.status(404).json({ error: "not found" });
  }

  db[name][index] = { ...db[name][index], ...req.body };

  res.json(db[name][index]);
});

/* DELETE item */
router.delete("/collections/:name/:id", (req, res) => {
  const { name, id } = req.params;

  if (!db[name]) db[name] = [];

  db[name] = db[name].filter(x => x.id !== id);

  res.json({ success: true });
});

export default router;
