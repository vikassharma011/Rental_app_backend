import express from "express";
import { db } from "../../db.js";
import jwt from "jsonwebtoken";
const router = express.Router();

// Supplier submits a quote for a maintenance request
router.post("/quotes", async (req, res) => {
  try {
    const { request_id, supplier_id, amount, description } = req.body;
    if (!request_id || !supplier_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    await db.execute(
      "INSERT INTO maintenance_quotes (request_id, supplier_id, amount, description) VALUES (?, ?, ?, ?)",
      [request_id, supplier_id, amount, description]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all quotes for a maintenance request (Investor view)
router.get("/quotes/:request_id", async (req, res) => {
  try {
    const request_id = req.params.request_id;
    const [quotes] = await db.execute(
      `SELECT q.*, s.first_name, s.last_name FROM maintenance_quotes q JOIN users s ON q.supplier_id = s.user_id WHERE q.request_id = ?`,
      [request_id]
    );
    res.json({ quotes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Investor accepts a quote (assigns supplier)
router.put("/quotes/:quote_id/accept", async (req, res) => {
  try {
    const quote_id = req.params.quote_id;
    // Get quote details
    const [[quote]] = await db.execute("SELECT * FROM maintenance_quotes WHERE quote_id = ?", [quote_id]);
    if (!quote) return res.status(404).json({ error: "Quote not found" });
    // Mark quote as accepted, others as rejected
    await db.execute("UPDATE maintenance_quotes SET status = 'accepted' WHERE quote_id = ?", [quote_id]);
    await db.execute("UPDATE maintenance_quotes SET status = 'rejected' WHERE request_id = ? AND quote_id != ?", [quote.request_id, quote_id]);
    // Assign supplier to request
    await db.execute("UPDATE maintenance_requests SET supplier_id = ?, status = 'assigned' WHERE request_id = ?", [quote.supplier_id, quote.request_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as QuotesRouter };
