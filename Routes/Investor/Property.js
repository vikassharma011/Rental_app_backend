import express from "express" ; 
import { db } from "../../db.js";
import { authenticateInvestor } from "../../middlewares/authenticateInvestor.js";

const router = express.Router();

// router.use(authenticateInvestor);

router.post("/add/property", async (req, res) => {
  try {
    const {
      title,
      image,
      address,
      city,
      state,
      zip_code,
      description,
      investor_id,
    } = req.body;

    // Validate required fields
    if (!investor_id) {
      return res.status(400).json({ error: "Missing investor_id" });
    }

    // Ensure all parameters are defined and not undefined
    const finalTitle = title || '';
    const finalImage = image || null;
    const finalAddress = address || '';
    const finalCity = city || '';
    const finalState = state || '';
    const finalZipCode = zip_code || '';
    const finalDescription = description || '';

    const [result] = await db.execute(
      `INSERT INTO property (
        title, image_url, address, city, state, zip_code,
        investor_id, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalTitle,
        finalImage,
        finalAddress,
        finalCity,
        finalState,
        finalZipCode,
        investor_id,
        finalDescription,
      ]
    );

    res.status(201).json({ message: "Property created", id: result.insertId });
  } catch (error) {
    console.error("Insert Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// /Routes/Investor/Property.js
router.get("/properties", async (req, res) => {
  const investor_id = req.query.investor_id;
  
  try {
    let query = "SELECT * FROM property";
    let params = [];
    
    if (investor_id) {
      query += " WHERE investor_id = ?";
      params = [investor_id];
    }
    
    const [properties] = await db.execute(query, params);
    res.status(200).json({ properties });
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch properties" });
  }
});

// ...existing code...
router.get("/leases", async (req, res) => {
  try {
    const investor_id = req.query.investor_id;
    let query = `
      SELECT l.*, 
        u.first_name as tenant_first_name, u.last_name as tenant_last_name,
        p.title as property_title
      FROM leases l
      JOIN users u ON l.tenant_id = u.user_id
      JOIN property p ON l.property_id = p.property_id
    `;
    let params = [];
    if (investor_id) {
      query += " WHERE p.investor_id = ?";
      params = [investor_id];
    }
    const [leases] = await db.execute(query, params);
    res.json({ leases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ...existing code...

/**
 * ✅ Get Single Property with All Related Data
 */
/**
 * ✅ Get Single Property with All Related Data
 */
router.get("/property/:id", async (req, res) => {
  const propertyId = req.params.id;

  try {
    // 1️⃣ Property details
    const [propertyRows] = await db.execute(
      "SELECT * FROM property WHERE property_id = ?",
      [propertyId]
    );

    if (propertyRows.length === 0) {
      return res.status(404).json({ error: "Property not found" });
    }

    const property = propertyRows[0];

    // 2️⃣ Related data
    const [documents] = await db.execute(
      "SELECT * FROM documents WHERE property_id = ?",
      [propertyId]
    );

    const [inventory] = await db.execute(
      "SELECT * FROM inventory_items WHERE property_id = ?",
      [propertyId]
    );

    const [maintenance] = await db.execute(
      "SELECT * FROM maintenance_requests WHERE property_id = ?",
      [propertyId]
    );

    const [leases] = await db.execute(
      "SELECT * FROM leases WHERE property_id = ?",
      [propertyId]
    );

    // ✅ Payments linked via lease_id
    const [payments] = await db.execute(
      `SELECT p.* 
       FROM payments p
       JOIN leases l ON p.lease_id = l.lease_id
       WHERE l.property_id = ?`,
      [propertyId]
    );

    // 3️⃣ Send response
    res.status(200).json({
      ...property,
      documents,
      inventory,
      maintenance,
      leases,
      payments,
    });

  } catch (err) {
    console.error("Fetch property details error:", err);
    res.status(500).json({ error: "Failed to fetch property details" });
  }
});




export { router as PropertyRouter };
