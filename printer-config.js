/**
 * Load config.json for CLI tools (resend.js, etc.).
 */

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfigFromFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("config.json not found. Run proxy.js first to generate it.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

module.exports = { CONFIG_FILE, loadConfigFromFile };
