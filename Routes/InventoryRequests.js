import express from 'express';
const router = express.Router();
import { db } from '../db.js';

// Supplier submits a new inventory request (simple: item_name, supplier_id)
// Supplier submits a new inventory request (with all required fields)
router.post('/supplier/inventory-request', async (req, res) => {
  const { item_name, supplier_id, property_id, item_type, purchase_date, warranty_end_date } = req.body;
  try {
    await db.query(
      `INSERT INTO inventory_requests (item_name, supplier_id, property_id, item_type, purchase_date, warranty_end_date, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [item_name, supplier_id, property_id, item_type, purchase_date, warranty_end_date]
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
      `SELECT ir.*, u.first_name AS supplier_first_name, u.last_name AS supplier_last_name, p.title AS property_title
       FROM inventory_requests ir
       LEFT JOIN users u ON ir.supplier_id = u.user_id
       LEFT JOIN property p ON ir.property_id = p.property_id
       WHERE ir.status = 'pending'`
    );
    // Add supplier_name and property_title for frontend
    const formatted = requests.map(r => ({
      ...r,
      supplier_name: `${r.supplier_first_name || ''} ${r.supplier_last_name || ''}`.trim(),
      property_title: r.property_title || r.property_id
    }));
    res.json({ requests: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Investor accepts a pending inventory request (manual add to inventory_items, update request status)
router.put('/investor/inventory-requests/:id/accept', async (req, res) => {
  const request_id = req.params.id;
  const { property_id, item_type, purchase_date, warranty_end_date, accepted_by } = req.body;
  try {
    // Get the request details
    const [[request]] = await db.query(`SELECT * FROM inventory_requests WHERE request_id = ?`, [request_id]);
    if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
    // Manually add to inventory_items
    await db.query(
      `INSERT INTO inventory_items (property_id, item_name, item_type, purchase_date, warranty_end_date, supplier_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [property_id, request.item_name, item_type, purchase_date, warranty_end_date, request.supplier_id]
    );
    // Update request status and acceptance info
    await db.query(`UPDATE inventory_requests SET status = 'accepted', accepted_at = NOW(), accepted_by = ? WHERE request_id = ?`, [accepted_by, request_id]);
    res.json({ success: true, message: 'Inventory request accepted and item added.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
