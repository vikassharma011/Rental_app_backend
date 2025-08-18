import express from "express";
import { db } from "../../db.js";

const router = express.Router();

async function ensureSettingsTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS investor_settings (
      investor_id bigint UNSIGNED NOT NULL PRIMARY KEY,
      email_notifications tinyint(1) DEFAULT 1,
      sms_notifications tinyint(1) DEFAULT 0,
      in_app_notifications tinyint(1) DEFAULT 1,
      rent_reminders tinyint(1) DEFAULT 1,
      maintenance_updates tinyint(1) DEFAULT 1,
      tenant_notifications tinyint(1) DEFAULT 1,
      supplier_notifications tinyint(1) DEFAULT 1,
      auto_approval tinyint(1) DEFAULT 0,
      auto_backup tinyint(1) DEFAULT 0,
      preferred_language varchar(20) DEFAULT 'English',
      theme varchar(20) DEFAULT 'Light',
      two_factor_auth tinyint(1) DEFAULT 0,
      is_active tinyint(1) DEFAULT 1,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  `);
}

async function getOrCreateDefaultSettings(investorId) {
  await ensureSettingsTable();
  const [rows] = await db.execute("SELECT * FROM investor_settings WHERE investor_id = ?", [investorId]);
  if (rows.length > 0) return rows[0];
  await db.execute(
    `INSERT INTO investor_settings (investor_id) VALUES (?)`,
    [investorId]
  );
  const [[created]] = await db.execute("SELECT * FROM investor_settings WHERE investor_id = ?", [investorId]);
  return created;
}

router.get("/settings/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // ensure investor exists
    const [[user]] = await db.execute(
      "SELECT user_id, is_active FROM users WHERE user_id = ? AND role = 'investor'",
      [id]
    );
    if (!user) return res.status(404).json({ error: "Investor not found" });

    const settings = await getOrCreateDefaultSettings(id);
    res.json({ settings });
  } catch (error) {
    console.error("Error fetching investor settings:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/settings/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      "email_notifications",
      "sms_notifications",
      "in_app_notifications",
      "rent_reminders",
      "maintenance_updates",
      "tenant_notifications",
      "supplier_notifications",
      "auto_approval",
      "auto_backup",
      "preferred_language",
      "theme",
      "two_factor_auth",
      "is_active"
    ];
    const payload = req.body || {};

    await getOrCreateDefaultSettings(id);

    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        fields.push(`${key} = ?`);
        values.push(payload[key]);
      }
    }

    if (fields.length === 0) return res.json({ message: "No changes" });
    values.push(id);
    await db.execute(
      `UPDATE investor_settings SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE investor_id = ?`,
      values
    );

    const [[updated]] = await db.execute("SELECT * FROM investor_settings WHERE investor_id = ?", [id]);
    res.json({ message: "Settings updated", settings: updated });
  } catch (error) {
    console.error("Error updating investor settings:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Deactivate account
router.post("/settings/:id/deactivate", async (req, res) => {
  try {
    const { id } = req.params;
    await ensureSettingsTable();
    await db.execute("UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = 'investor'", [id]);
    await db.execute("UPDATE investor_settings SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE investor_id = ?", [id]);
    res.json({ message: "Account deactivated" });
  } catch (error) {
    console.error("Error deactivating account:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Export data (JSON download of key datasets)
router.get("/settings/:id/export", async (req, res) => {
  try {
    const { id } = req.params;
    const [[user]] = await db.execute(
      "SELECT user_id, first_name, last_name, email, phone, is_active, created_at FROM users WHERE user_id = ? AND role = 'investor'",
      [id]
    );
    if (!user) return res.status(404).json({ error: "Investor not found" });

    const [properties] = await db.execute("SELECT * FROM property WHERE investor_id = ?", [id]);
    const [leases] = await db.execute(
      `SELECT l.* FROM leases l JOIN property p ON l.property_id = p.property_id WHERE p.investor_id = ?`,
      [id]
    );
    const [payments] = await db.execute(
      `SELECT p.* FROM payments p JOIN leases l ON p.lease_id = l.lease_id JOIN property pr ON l.property_id = pr.property_id WHERE pr.investor_id = ?`,
      [id]
    );
    const [maintenance] = await db.execute(
      `SELECT mr.* FROM maintenance_requests mr JOIN property p ON mr.property_id = p.property_id WHERE p.investor_id = ?`,
      [id]
    );

    const payload = { user, properties, leases, payments, maintenance };
    const fileName = `investor_${id}_export.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("Error exporting data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Backup action (no-op placeholder)
router.post("/settings/:id/backup", async (req, res) => {
  try {
    // In a real system, trigger backup service here
    res.json({ message: "Backup initiated" });
  } catch (error) {
    console.error("Error initiating backup:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Login history stub
router.get("/settings/:id/login-history", async (req, res) => {
  try {
    res.json({ logins: [] });
  } catch (error) {
    console.error("Error getting login history:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as SettingsRouter };


