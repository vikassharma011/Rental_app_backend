import express from "express" ; 
import { db } from "../../db.js";
import { authenticateInvestor } from "../../middlewares/authenticateInvestor.js";

const router = express.Router();

router.use(authenticateInvestor);

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
      `INSERT INTO properties (
        title, image, address, city, state, zip_code,
        investor_id, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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


export { router as PropertyRouter };
