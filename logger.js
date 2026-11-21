'use strict';

const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logStream = fs.createWriteStream(path.join(logDir, 'bot.log'), { flags: 'a' });

const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = levels[process.env.LOG_LEVEL || 'INFO'] ?? 1;

function log(level, ...args) {
  if (levels[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${args.map(String).join(' ')}`;
  if (level === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  logStream.write(line + '\n');
}

module.exports = {
  debug: (...a) => log('DEBUG', ...a),
  info:  (...a) => log('INFO',  ...a),
  warn:  (...a) => log('WARN',  ...a),
  error: (...a) => log('ERROR', ...a),
};
