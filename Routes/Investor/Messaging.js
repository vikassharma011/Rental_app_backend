import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Send a message (investor, tenant, supplier)
router.post("/send", async (req, res) => {
  try {
    const { sender_id, receiver_id, role, content } = req.body;
    if (!sender_id || !receiver_id || !role || !content) return res.status(400).json({ error: "Missing required fields" });
    const [result] = await db.execute(
      `INSERT INTO messages (sender_id, receiver_id, role, content) VALUES (?, ?, ?, ?)`,
      [sender_id, receiver_id, role, content]
    );
    res.status(201).json({ message: "Message sent", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a user (inbox)
router.get("/inbox/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [messages] = await db.execute(
      `SELECT * FROM messages WHERE receiver_id = ? ORDER BY created_at DESC`,
      [user_id]
    );
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages sent by a user (sent)
router.get("/sent/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
    const [messages] = await db.execute(
      `SELECT * FROM messages WHERE sender_id = ? ORDER BY created_at DESC`,
      [user_id]
    );
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as MessagingRouter };
