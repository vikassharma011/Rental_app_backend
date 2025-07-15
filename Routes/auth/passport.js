// auth/passport.ts
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { db } from "../../db.js";
import dotenv from "dotenv";
dotenv.config();

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "https://rentalappbackend-production.up.railway.app/auth/google/callback"
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0].value;
        const socialId = profile.id;

        // ✅ Only allow if user already exists
        const [rows] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
        const user = rows[0];

        if (!user) {
          return done(null, false, {
            message: "Account not found. Please signup first.",
          });
        }

        // ✅ If local account, upgrade to Google
        if (user.social_provider === 'none') {
          await db.execute(
            "UPDATE users SET social_provider = 'google', social_id = ? WHERE user_id = ?",
            [socialId, user.user_id]
          );
        }

        // Re-fetch after update
        const [updatedRows] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
        const updatedUser = updatedRows[0];

        if (updatedUser.status !== 'approved') {
          return done(null, false, {
            message: "Your account is pending approval by Superadmin",
          });
        }

        return done(null, updatedUser);
      } catch (error) {
        console.error("Google Auth Error:", error);
        return done(error, false);
      }
    }
  )
);
