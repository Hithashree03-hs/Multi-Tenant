const ALLOWED_ROLES = new Set(["ADMIN", "FACULTY", "STUDENT"]);

function requireRole(...allowedRoles) {
  if (
    allowedRoles.length === 0 ||
    allowedRoles.some((role) => typeof role !== "string" || !ALLOWED_ROLES.has(role))
  ) {
    throw new TypeError("requireRole needs one or more supported roles");
  }

  const roleSet = new Set(allowedRoles);
  return function authorizeRole(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    if (!roleSet.has(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    return next();
  };
}

module.exports = requireRole;
