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

    if (!investor_id) {
      return res.status(400).json({ error: "Missing investor_id" });
    }

    const [result] = await db.execute(
      `INSERT INTO property (
        title, image_url, address, city, state, zip_code,
        investor_id, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        image,
        address,
        city,
        state,
        zip_code,
        investor_id,
        description,
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

/**
 * ✅ Get Single Property with All Related Data
 */
router.get("/property/:id", async (req, res) => {
  const propertyId = req.params.id;

  try {
    // 1️⃣ Fetch property details
    const [propertyRows] = await db.execute(
      "SELECT * FROM property WHERE property_id = ?",
      [propertyId]
    );

    if (propertyRows.length === 0) {
      return res.status(404).json({ error: "Property not found" });
    }

    const property = propertyRows[0];

    // 2️⃣ Fetch related data
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

    const [payments] = await db.execute(
      "SELECT * FROM payments WHERE property_id = ?",
      [propertyId]
    );

    // 3️⃣ Send full response
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
