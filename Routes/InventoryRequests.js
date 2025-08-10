import express from 'express';
const router = express.Router();
import { db } from '../db.js';

// Supplier submits a new inventory request
router.post('/supplier/inventory-request', async (req, res) => {
  const { property_id, supplier_id, item_name, item_type, purchase_date, warranty_end_date } = req.body;
  try {
    await db.query(
      `INSERT INTO inventory_requests (property_id, supplier_id, item_name, item_type, purchase_date, warranty_end_date, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [property_id, supplier_id, item_name, item_type, purchase_date, warranty_end_date]
    );
    res.json({ success: true, message: 'Inventory request submitted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Investor views all pending inventory requests
router.get('/investor/inventory-requests', async (req, res) => {
  try {
    const [requests] = await db.query(
      `SELECT ir.*, p.title AS property_title, u.first_name AS supplier_first_name, u.last_name AS supplier_last_name
       FROM inventory_requests ir
       LEFT JOIN property p ON ir.property_id = p.property_id
       LEFT JOIN users u ON ir.supplier_id = u.user_id
       WHERE ir.status = 'pending'`
    );
    // Add supplier_name for frontend
    const formatted = requests.map(r => ({
      ...r,
      supplier_name: `${r.supplier_first_name || ''} ${r.supplier_last_name || ''}`.trim()
    }));
    res.json({ requests: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Investor accepts a request (adds to inventory, updates status)
router.post('/investor/inventory-requests/:id/accept', async (req, res) => {
  const request_id = req.params.id;
  try {
    // Get the request details
    const [[request]] = await db.query(`SELECT * FROM inventory_requests WHERE request_id = ?`, [request_id]);
    if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
    // Add to inventory_items
    await db.query(
      `INSERT INTO inventory_items (property_id, item_name, item_type, purchase_date, warranty_end_date, supplier_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [request.property_id, request.item_name, request.item_type, request.purchase_date, request.warranty_end_date, request.supplier_id]
    );
    // Update request status
    await db.query(`UPDATE inventory_requests SET status = 'accepted' WHERE request_id = ?`, [request_id]);
    res.json({ success: true, message: 'Inventory request accepted and item added.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
