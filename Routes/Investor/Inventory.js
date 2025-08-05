import express from "express";
import { db } from "../../db.js";
const router = express.Router();

// Get all inventory items
router.get("/inventory", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM inventory_items");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new inventory item
router.post("/inventory", async (req, res) => {
  try {
    const { property_id, item_name, item_type, purchase_date, warranty_end_date, supplier_id } = req.body;
    const [result] = await db.execute(
      "INSERT INTO inventory_items (property_id, item_name, item_type, purchase_date, warranty_end_date, supplier_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())",
      [property_id, item_name, item_type, purchase_date, warranty_end_date, supplier_id]
    );
    res.json({ item_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit inventory item
router.put("/inventory/:id", async (req, res) => {
  try {
    const { item_name, item_type, purchase_date, warranty_end_date, supplier_id } = req.body;
    await db.execute(
      "UPDATE inventory_items SET item_name=?, item_type=?, purchase_date=?, warranty_end_date=?, supplier_id=?, updated_at=NOW() WHERE item_id=?",
      [item_name, item_type, purchase_date, warranty_end_date, supplier_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as InventoryRouter };
