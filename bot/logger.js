// FLASH - simple file + console logger.
const fs = require("fs");
const path = require("path");
const util = require("util");

const LOG_DIR = path.join(__dirname, "..", "logs");
const OUT_FILE = path.join(LOG_DIR, "bot.out.log");
const ERR_FILE = path.join(LOG_DIR, "bot.err.log");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function write(file, line) {
  try {
    ensureLogDir();
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch (_) {
    /* ignore */
  }
}

function line(level, args) {
  const msg = util.format(...args);
  return `[${stamp()}] [${level}] ${msg}`;
}

function info(...args) {
  const l = line("INFO", args);
  console.log(l);
  write(OUT_FILE, l);
}

function warn(...args) {
  const l = line("WARN", args);
  console.warn(l);
  write(ERR_FILE, l);
}

function error(...args) {
  const l = line("ERROR", args);
  console.error(l);
  write(ERR_FILE, l);
}

function debug(...args) {
  if (process.env.DEBUG) {
    const l = line("DEBUG", args);
    console.log(l);
    write(OUT_FILE, l);
  }
}

module.exports = { info, warn, error, debug, LOG_DIR, OUT_FILE, ERR_FILE };