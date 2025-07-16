import express from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));

router.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/" }),
  (req, res) => {
    const user = req.user;

    const token = jwt.sign(
      { userId: user.user_id, role: user.role },
      process.env.JWT_SECRET || "default",
      { expiresIn: "1h" }
    );

    const frontendURL = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendURL}/login?token=${token}`);
  }
);


export { router as googleAuthRoutes };
