module.exports = function logger(req, res, next) {
  try {
    const now = new Date().toISOString();
    console.log(`[${now}] ${req.method} ${req.originalUrl} - ${req.ip}`);
  } catch (e) { /* ignore logging errors */ }
  next();
};