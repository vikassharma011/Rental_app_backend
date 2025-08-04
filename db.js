// src/db.ts
import mysql from 'mysql2/promise';
import dotenv from 'dotenv'

dotenv.config();

export const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // ✅ Add these:
  waitForConnections: true,
  connectionLimit: 5,     // Adjust based on Railway plan
  queueLimit: 0
});
