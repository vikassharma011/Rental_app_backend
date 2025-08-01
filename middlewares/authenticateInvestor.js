import jwt from "jsonwebtoken";

export const authenticateInvestor = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "investor") {
      return res.status(403).json({ success: false, message: "Only investors can approve users" });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
};
