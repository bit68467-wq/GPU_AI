const path = require('path');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const file = path.join(__dirname, '..', 'db.json');
const adapter = new JSONFile(file);
const db = new Low(adapter);

async function initDb() {
  await db.read();
  db.data = db.data || { collections: {} };
  const defaults = ['user_v1','transaction_v1','device_v1','otp_v1','session_v1','meta_v1'];
  defaults.forEach(c => {
    db.data.collections[c] = db.data.collections[c] || [];
  });
  await db.write();
}

function getCollection(name) {
  db.data = db.data || { collections: {} };
  db.data.collections[name] = db.data.collections[name] || [];
  return db.data.collections[name];
}

async function write() {
  await db.write();
}

function generate6UniqueUserUid() {
  const users = getCollection('user_v1');
  const existing = new Set(users.map(u => String(u.user_uid)));
  let val;
  let tries = 0;
  do {
    val = String(Math.floor(100000 + Math.random() * 900000));
    tries++;
    if (tries > 500) break;
  } while (existing.has(val));
  return val;
}

function findById(col, id) {
  return col.find(r => String(r.id) === String(id));
}

module.exports = {
  db,
  initDb,
  getCollection,
  write,
  generate6UniqueUserUid,
  findById,
  nanoid
};