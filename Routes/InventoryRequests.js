import express from 'express';
const router = express.Router();
import { db } from '../db.js';

// Supplier submits a new inventory item (request)
router.post('/supplier/inventory-item', async (req, res) => {
  const { property_id, supplier_id, item_name, item_type, purchase_date, warranty_end_date } = req.body;
  try {
    await db.query(
      `INSERT INTO inventory_items (property_id, supplier_id, item_name, item_type, purchase_date, warranty_end_date, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [property_id, supplier_id, item_name, item_type, purchase_date, warranty_end_date]
    );
    res.json({ success: true, message: 'Inventory item request submitted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Investor views all pending inventory items (requests)
router.get('/investor/inventory-requests', async (req, res) => {
  try {
    const [items] = await db.query(
      `SELECT ii.*, p.title AS property_title, u.first_name AS supplier_first_name, u.last_name AS supplier_last_name
       FROM inventory_items ii
       LEFT JOIN property p ON ii.property_id = p.property_id
       LEFT JOIN users u ON ii.supplier_id = u.user_id
       WHERE ii.status = 'pending'`
    );
    // Add supplier_name for frontend
    const formatted = items.map(r => ({
      ...r,
      supplier_name: `${r.supplier_first_name || ''} ${r.supplier_last_name || ''}`.trim()
    }));
    res.json({ requests: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Investor accepts a pending inventory item (updates status)
router.put('/investor/inventory/:id/accept', async (req, res) => {
  const item_id = req.params.id;
  try {
    const [[item]] = await db.query(`SELECT * FROM inventory_items WHERE item_id = ?`, [item_id]);
    if (!item) return res.status(404).json({ success: false, error: 'Item not found.' });
    await db.query(`UPDATE inventory_items SET status = 'accepted' WHERE item_id = ?`, [item_id]);
    res.json({ success: true, message: 'Inventory item accepted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
