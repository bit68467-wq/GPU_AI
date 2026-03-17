import { pool } from "../config/database.js";

export async function createUser(email,password){

const result = await pool.query(
"INSERT INTO users (email,password) VALUES ($1,$2) RETURNING *",
[email,password]
);

return result.rows[0];

}

export async function findUserByEmail(email){

const result = await pool.query(
"SELECT * FROM users WHERE email=$1",
[email]
);

return result.rows[0];

}
