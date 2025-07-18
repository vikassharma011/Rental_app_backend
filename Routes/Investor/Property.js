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
  if (!investor_id) return res.status(400).json({ error: "Investor ID missing" });

  try {
    const [properties] = await db.execute(
      "SELECT * FROM property WHERE investor_id = ?",
      [investor_id]
    );
    res.status(200).json({ properties });
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch properties" });
  }
});



export { router as PropertyRouter };
