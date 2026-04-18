const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = resolveDataDir(process.env.DATA_DIR || path.join(ROOT, 'storage'));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = DATA_DIR;
const BOTS_DIR = path.join(STORAGE_DIR, 'bots');
const MONTHS_DIR = path.join(STORAGE_DIR, 'months');
const MONTHS_BY_BOT_DIR = path.join(STORAGE_DIR, 'months_by_bot');
const STATE_FILE = path.join(STORAGE_DIR, 'bot_state.json');

for (const dir of [PUBLIC_DIR, STORAGE_DIR, BOTS_DIR, MONTHS_DIR, MONTHS_BY_BOT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
const PORT = envNum('PORT', 3000);
const HOST = envText('HOST', '0.0.0.0');
const APP_NAME = envText('APP_NAME', 'EA Mobile Bridge');
const EA_TOKEN = envText('EA_TOKEN', envText('BRIDGE_EA_TOKEN', 'change_me'));
const ADMIN_USER = envText('ADMIN_USER', 'admin');
const ADMIN_PASSWORD = envText('ADMIN_PASSWORD', '');
const ADMIN_PASSWORD_HASH = envText('ADMIN_PASSWORD_HASH', '');
const ADMIN_SESSION_SECRET = envText('ADMIN_SESSION_SECRET', 'change-this-secret');
const SESSION_DAYS = envNum('SESSION_DAYS', 7);
const PUBLIC_REFRESH_MS = envNum('PUBLIC_REFRESH_MS', 2000);
const ADMIN_IP_ALLOWLIST = envText('ADMIN_IP_ALLOWLIST', '').split(',').map(s => s.trim()).filter(Boolean);

if (envBool('TRUST_PROXY', false)) {
  app.set('trust proxy', true);
}

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));

const loginAttempts = new Map();

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));

  if (acceptsHtml(req)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  }
  next();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use('/public', express.static(PUBLIC_DIR, { index: false, etag: true, maxAge: '1h' }));
app.use(express.static(PUBLIC_DIR, { index: false, etag: true, maxAge: '1h' }));

app.get('/health', (req, res) => res.json({ ok: true, app: APP_NAME, now: new Date().toISOString(), storageDir: STORAGE_DIR }));

app.get('/api/public/meta', (req, res) => {
  res.json({ ok: true, appName: APP_NAME, refreshMs: PUBLIC_REFRESH_MS, now: new Date().toISOString(), month: currentMonthKeyUtc() });
});

app.get('/api/public/bots', (req, res) => {
  const state = readState();
  const bots = sortBotsStable(state, Object.values(state.bots || {}));
  const now = Date.now();
  const summary = {
    totalBots: bots.length,
    onlineBots: bots.filter(b => now - (b.updatedAtTs || 0) <= 15000).length,
    pausedBots: bots.filter(b => String(b.status || '').toUpperCase() === 'PAUSED').length,
    totalFloating: round2(bots.reduce((s, b) => s + num(b.floating), 0)),
    totalDayProfit: round2(bots.reduce((s, b) => s + num(b.realProfit), 0)),
    avgDd: bots.length ? round2(bots.reduce((s, b) => s + num(b.dd), 0) / bots.length) : 0
  };
  res.json({ ok: true, summary, bots: bots.map(toPublicBot) });
});

app.get('/api/public/month-calendar', (req, res) => {
  const state = readState();
  const sorted = sortBotsStable(state, Object.values(state.bots || {}));
  const fallbackBotKey = sorted[0]?.botKey || '';
  const botKey = String(req.query.botKey || fallbackBotKey || '').trim();
  const month = normalizeMonthKey(req.query.month || currentMonthKeyUtc());
  if (!botKey) {
    return res.json({ ok: true, botKey: '', month, bot: null, days: [], stats: emptyMonthStats() });
  }

  const bot = state.bots[botKey] || readBotSnapshot(botKey) || { botKey };
  const monthDoc = readBotMonth(botKey, month);
  const days = Object.values(monthDoc.days || {}).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const stats = calcMonthStats(days);
  res.json({ ok: true, botKey, month, bot: pickBotIdentity(bot), days, stats });
});

app.get('/ea/heartbeat', (req, res) => {
  const token = String(req.query.ea_token || '');
  if (token !== EA_TOKEN) {
    return res.status(403).json({ ok: false, error: 'bad_token' });
  }

  const state = readState();
  const normalized = normalizeHeartbeat(req.query);
  const botKey = normalized.botKey;
  const existing = state.bots[botKey] || null;
  const now = new Date();
  const updatedAt = now.toISOString();
  const updatedAtTs = now.getTime();
  const sortIndex = ensureBotOrder(state, botKey, existing?.sortIndex);

  const payload = {
    ...existing,
    ...normalized,
    sortIndex,
    firstSeenAt: existing?.firstSeenAt || updatedAt,
    firstSeenAtTs: existing?.firstSeenAtTs || updatedAtTs,
    updatedAt,
    updatedAtTs,
    isOnline: true,
    online: true
  };

  state.bots[botKey] = payload;
  writeState(state);
  writeBotSnapshot(botKey, payload);
  const monthFile = writeMonthSnapshot(payload);

  return res.json({ ok: true, botKey, saved: true, month_file: path.basename(monthFile), server_time: updatedAt, sortIndex });
});

app.get('/ea/next', (req, res) => {
  const token = String(req.query.ea_token || '');
  if (token !== EA_TOKEN) {
    return res.status(403).json({ ok: false, error: 'bad_token' });
  }

  const botKey = buildBotKey(req.query.id, req.query.bot, req.query.symbol);
  const state = readState();
  const queue = ensureCommandQueue(state, botKey);
  const nextCmd = queue.find(item => item.status === 'queued');

  if (!nextCmd) {
    return res.json({ ok: true, idle: true, nonce: '', cmd: '' });
  }

  nextCmd.status = 'delivered';
  nextCmd.deliveredAt = new Date().toISOString();
  writeState(state);

  return res.json({ ok: true, nonce: nextCmd.nonce, cmd: nextCmd.cmd, createdAt: nextCmd.createdAt });
});

app.get('/ea/ack', (req, res) => {
  const token = String(req.query.ea_token || '');
  if (token !== EA_TOKEN) {
    return res.status(403).json({ ok: false, error: 'bad_token' });
  }

  const botKey = buildBotKey(req.query.id, req.query.bot, req.query.symbol);
  const nonce = String(req.query.nonce || '');
  const result = String(req.query.result || '');
  const state = readState();
  const queue = ensureCommandQueue(state, botKey);
  const item = queue.find(cmd => cmd.nonce === nonce);

  if (item) {
    item.status = 'acked';
    item.ackAt = new Date().toISOString();
    item.result = result;
    writeState(state);
  }

  return res.json({ ok: true, botKey, nonce, result });
});

app.get('/admin/login', (req, res) => {
  if (isAdminAuthenticated(req)) return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'admin-login.html'));
});

app.post('/admin/api/login', requireAdminAllowlist, (req, res) => {
  const ip = getIp(req);
  const limiter = consumeLoginRate(ip);
  if (!limiter.allowed) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts', retryAfterSec: limiter.retryAfterSec });
  }

  const username = String(req.body.username || '');
  const password = String(req.body.password || '');

  const okUser = safeEqual(username, ADMIN_USER);
  const okPass = verifyPassword(password);

  if (!okUser || !okPass) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }

  clearLoginRate(ip);
  setAdminSessionCookie(req, res, { user: ADMIN_USER });
  return res.json({ ok: true, user: ADMIN_USER });
});

app.post('/admin/api/logout', requireAdminAuth, (req, res) => {
  clearAdminSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/admin/api/session', (req, res) => {
  const session = getAdminSession(req);
  res.json({ ok: !!session, user: session?.user || null, appName: APP_NAME });
});

app.get('/admin/api/bots', requireAdminAuth, (req, res) => {
  const state = readState();
  const bots = sortBotsStable(state, Object.values(state.bots || {}));
  const commands = state.commands || {};
  res.json({
    ok: true,
    botOrder: state.botOrder || [],
    bots: bots.map(bot => ({
      ...bot,
      commands: (commands[bot.botKey] || []).slice(-10).reverse()
    }))
  });
});

app.post('/admin/api/command', requireAdminAuth, requireSameOrigin, (req, res) => {
  const botKey = String(req.body.botKey || '');
  const cmd = String(req.body.cmd || '').trim().toLowerCase();
  const allowed = new Set(['close_all', 'close_buy', 'close_sell', 'close_loss', 'close_loss_first', 'time_on', 'time_off', 'resume', 'pause', 'start', 'stop']);
  if (!botKey || !allowed.has(cmd)) {
    return res.status(400).json({ ok: false, error: 'invalid_command' });
  }

  const state = readState();
  if (!state.bots[botKey]) {
    return res.status(404).json({ ok: false, error: 'bot_not_found' });
  }

  const queue = ensureCommandQueue(state, botKey);
  const nonce = crypto.randomBytes(12).toString('hex');
  queue.push({
    nonce,
    cmd,
    status: 'queued',
    createdAt: new Date().toISOString(),
    createdBy: ADMIN_USER
  });

  if (queue.length > 50) {
    queue.splice(0, queue.length - 50);
  }

  writeState(state);
  res.json({ ok: true, botKey, nonce, cmd });
});

app.get('/admin/api/export-all', requireAdminAuth, (req, res) => {
  const payload = buildExportPayload();
  const stamp = compactStamp(new Date());
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ea_mobile_bridge_backup_${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

app.post('/admin/api/import-all', requireAdminAuth, requireSameOrigin, (req, res) => {
  const backup = req.body?.backup || req.body;
  if (!backup || typeof backup !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid_backup' });
  }

  const normalized = normalizeImportPayload(backup);
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'invalid_backup_shape' });
  }

  applyImportPayload(normalized);
  res.json({
    ok: true,
    importedAt: new Date().toISOString(),
    bots: Object.keys(normalized.state.bots || {}).length,
    monthsBotFiles: Object.keys(normalized.storage.monthsByBot || {}).length,
    globalMonthFiles: Object.keys(normalized.storage.months || {}).length
  });
});

app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  if (acceptsHtml(req)) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  }
  return res.status(404).json({ ok: false, error: 'not_found' });
});

app.listen(PORT, HOST, () => {
  console.log(`EA Mobile Bridge running on ${HOST}:${PORT}`);
  console.log(`NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  console.log(`DATA_DIR=${STORAGE_DIR}`);
});

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = stripWrappingQuotes(trimmed.slice(idx + 1).trim());
    if (!(key in process.env)) process.env[key] = val;
  }
}

function resolveDataDir(input) {
  const raw = stripWrappingQuotes(String(input || '').trim()) || path.join(ROOT, 'storage');
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function envText(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return stripWrappingQuotes(String(raw));
}

function envNum(name, fallback) {
  const raw = envText(name, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = envText(name, '');
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function stripWrappingQuotes(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function acceptsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState();
  }
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return normalizeStateShape(data);
  } catch {
    return emptyState();
  }
}

function emptyState() {
  return { bots: {}, commands: {}, botOrder: [] };
}

function normalizeStateShape(data) {
  const out = data && typeof data === 'object' ? data : {};
  if (!out.bots || typeof out.bots !== 'object') out.bots = {};
  if (!out.commands || typeof out.commands !== 'object') out.commands = {};
  if (!Array.isArray(out.botOrder)) out.botOrder = [];
  const known = new Set(out.botOrder);
  for (const botKey of Object.keys(out.bots)) {
    if (!known.has(botKey)) {
      out.botOrder.push(botKey);
      known.add(botKey);
    }
  }
  out.botOrder = out.botOrder.filter(botKey => out.bots[botKey]);
  out.botOrder.forEach((botKey, idx) => {
    if (out.bots[botKey]) out.bots[botKey].sortIndex = idx + 1;
  });
  return out;
}

function writeState(state) {
  atomicWriteJson(STATE_FILE, normalizeStateShape(state));
}

function ensureBotOrder(state, botKey, existingSortIndex) {
  if (!Array.isArray(state.botOrder)) state.botOrder = [];
  if (!state.botOrder.includes(botKey)) state.botOrder.push(botKey);
  const index = state.botOrder.indexOf(botKey);
  return Number.isFinite(existingSortIndex) && existingSortIndex > 0 ? existingSortIndex : index + 1;
}

function sortBotsStable(state, bots) {
  const order = Array.isArray(state.botOrder) ? state.botOrder : [];
  const map = new Map(order.map((botKey, idx) => [botKey, idx + 1]));
  return [...bots].sort((a, b) => {
    const ai = map.get(a.botKey) || num(a.sortIndex) || 999999;
    const bi = map.get(b.botKey) || num(b.sortIndex) || 999999;
    if (ai !== bi) return ai - bi;
    return String(a.botKey || '').localeCompare(String(b.botKey || ''));
  }).map(bot => ({ ...bot, sortIndex: map.get(bot.botKey) || bot.sortIndex || 999999 }));
}

function writeBotSnapshot(botKey, payload) {
  const file = path.join(BOTS_DIR, `${sanitizeFile(botKey)}.json`);
  atomicWriteJson(file, payload);
}

function readBotSnapshot(botKey) {
  const file = path.join(BOTS_DIR, `${sanitizeFile(botKey)}.json`);
  if (!fs.existsSync(file)) return null;
  return safeJson(fs.readFileSync(file, 'utf8'), null);
}

function writeMonthSnapshot(payload) {
  const d = new Date();
  const monthKey = currentMonthKeyUtc(d);
  const dateKey = currentDateKeyUtc(d);
  const monthFile = path.join(MONTHS_DIR, `lich_thang_${monthKey.replace('-', '_')}.json`);
  const month = fs.existsSync(monthFile) ? safeJson(fs.readFileSync(monthFile, 'utf8'), {}) : {};
  if (!month[dateKey]) month[dateKey] = {};
  month[dateKey][payload.botKey] = snapshotDayRecord(payload, dateKey, monthKey);
  atomicWriteJson(monthFile, month);

  const botMonthFile = path.join(MONTHS_BY_BOT_DIR, `${sanitizeFile(payload.botKey)}__${monthKey.replace('-', '_')}.json`);
  const botMonth = fs.existsSync(botMonthFile) ? safeJson(fs.readFileSync(botMonthFile, 'utf8'), { botKey: payload.botKey, bot: payload.bot, symbol: payload.symbol, month: monthKey, days: {} }) : { botKey: payload.botKey, bot: payload.bot, symbol: payload.symbol, month: monthKey, days: {} };
  botMonth.botKey = payload.botKey;
  botMonth.bot = payload.bot;
  botMonth.symbol = payload.symbol;
  botMonth.month = monthKey;
  if (!botMonth.days || typeof botMonth.days !== 'object') botMonth.days = {};
  botMonth.days[dateKey] = snapshotDayRecord(payload, dateKey, monthKey);
  atomicWriteJson(botMonthFile, botMonth);

  return botMonthFile;
}

function readBotMonth(botKey, monthKey) {
  const file = path.join(MONTHS_BY_BOT_DIR, `${sanitizeFile(botKey)}__${monthKey.replace('-', '_')}.json`);
  if (!fs.existsSync(file)) {
    return { botKey, month: monthKey, days: {} };
  }
  const doc = safeJson(fs.readFileSync(file, 'utf8'), { botKey, month: monthKey, days: {} });
  if (!doc.days || typeof doc.days !== 'object') doc.days = {};
  return doc;
}

function snapshotDayRecord(payload, dateKey, monthKey) {
  return {
    dateKey,
    monthKey,
    day: Number(dateKey.slice(-2)),
    botKey: payload.botKey,
    bot: payload.bot,
    symbol: payload.symbol,
    realProfit: round2(payload.realProfit),
    realPct: round2(payload.realPct),
    dd: round2(payload.dd),
    balance: round2(payload.balance),
    equity: round2(payload.equity),
    floating: round2(payload.floating),
    target: round2(payload.target),
    remain: round2(payload.remain),
    orders: intNum(payload.orders),
    buy: intNum(payload.buy),
    sell: intNum(payload.sell),
    status: payload.status,
    updatedAt: payload.updatedAt
  };
}

function normalizeHeartbeat(q) {
  const id = String(q.id || '');
  const bot = String(q.bot || 'UNKNOWN');
  const symbol = String(q.symbol || 'UNKNOWN');
  const botKey = buildBotKey(id, bot, symbol);
  return {
    botKey,
    id,
    bot,
    symbol,
    balance: num(q.balance),
    equity: num(q.equity),
    realProfit: num(q.realProfit),
    realPct: num(q.realPct),
    dayTotal: num(q.dayTotal),
    dd: num(q.dd),
    orders: intNum(q.orders),
    dayOrders: intNum(q.dayOrders),
    targetHit: intNum(q.targetHit),
    status: String(q.status || '').toUpperCase() || 'UNKNOWN',
    timeMode: String(q.timeMode || ''),
    action: String(q.action || ''),
    hedge: String(q.hedge || ''),
    sigm5: intNum(q.sigm5),
    sigm1: intNum(q.sigm1),
    sigall: intNum(q.sigall),
    buy: intNum(q.buy),
    sell: intNum(q.sell),
    floating: num(q.floating),
    target: num(q.target),
    remain: num(q.remain)
  };
}

function toPublicBot(bot) {
  const online = Date.now() - (bot.updatedAtTs || 0) <= 15000;
  return {
    botKey: bot.botKey,
    id: bot.id,
    bot: bot.bot,
    symbol: bot.symbol,
    balance: bot.balance,
    equity: bot.equity,
    realProfit: bot.realProfit,
    realPct: bot.realPct,
    dd: bot.dd,
    orders: bot.orders,
    targetHit: bot.targetHit,
    status: bot.status,
    timeMode: bot.timeMode,
    action: bot.action,
    hedge: bot.hedge,
    sigm5: bot.sigm5,
    sigm1: bot.sigm1,
    sigall: bot.sigall,
    buy: bot.buy,
    sell: bot.sell,
    floating: bot.floating,
    target: bot.target,
    remain: bot.remain,
    updatedAt: bot.updatedAt,
    online,
    sortIndex: bot.sortIndex || 999999
  };
}

function pickBotIdentity(bot) {
  return {
    botKey: bot.botKey,
    bot: bot.bot || bot.botKey,
    symbol: bot.symbol || '-',
    id: bot.id || '-',
    sortIndex: bot.sortIndex || 999999
  };
}

function calcMonthStats(days) {
  if (!Array.isArray(days) || !days.length) return emptyMonthStats();
  const profitTotal = round2(days.reduce((s, d) => s + num(d.realProfit), 0));
  const maxDd = round2(days.reduce((m, d) => Math.max(m, num(d.dd)), 0));
  const winDays = days.filter(d => num(d.realProfit) > 0).length;
  const lossDays = days.filter(d => num(d.realProfit) < 0).length;
  return { profitTotal, maxDd, activeDays: days.length, winDays, lossDays };
}

function emptyMonthStats() {
  return { profitTotal: 0, maxDd: 0, activeDays: 0, winDays: 0, lossDays: 0 };
}

function currentMonthKeyUtc(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function currentDateKeyUtc(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function normalizeMonthKey(input) {
  const raw = String(input || '').trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return currentMonthKeyUtc();
}

function buildBotKey(id, bot, symbol) {
  return [String(id || '0').trim(), String(bot || 'bot').trim(), String(symbol || 'symbol').trim()].join('__');
}

function ensureCommandQueue(state, botKey) {
  if (!state.commands) state.commands = {};
  if (!state.commands[botKey]) state.commands[botKey] = [];
  return state.commands[botKey];
}

function buildExportPayload() {
  return {
    version: 'ea-mobile-bridge-backup-v2',
    exportedAt: new Date().toISOString(),
    appName: APP_NAME,
    state: readState(),
    storage: {
      bots: readJsonDirectory(BOTS_DIR),
      months: readJsonDirectory(MONTHS_DIR),
      monthsByBot: readJsonDirectory(MONTHS_BY_BOT_DIR)
    }
  };
}

function normalizeImportPayload(backup) {
  const state = normalizeStateShape(backup.state || {});
  const storage = backup.storage || {};
  const out = {
    state,
    storage: {
      bots: storage.bots && typeof storage.bots === 'object' ? storage.bots : {},
      months: storage.months && typeof storage.months === 'object' ? storage.months : {},
      monthsByBot: storage.monthsByBot && typeof storage.monthsByBot === 'object' ? storage.monthsByBot : {}
    }
  };
  return out;
}

function applyImportPayload(payload) {
  clearJsonDirectory(BOTS_DIR);
  clearJsonDirectory(MONTHS_DIR);
  clearJsonDirectory(MONTHS_BY_BOT_DIR);

  writeState(payload.state);
  writeJsonDirectory(BOTS_DIR, payload.storage.bots);
  writeJsonDirectory(MONTHS_DIR, payload.storage.months);
  writeJsonDirectory(MONTHS_BY_BOT_DIR, payload.storage.monthsByBot);
}

function readJsonDirectory(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    out[name] = safeJson(fs.readFileSync(file, 'utf8'), {});
  }
  return out;
}

function clearJsonDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

function writeJsonDirectory(dir, payload) {
  for (const [name, data] of Object.entries(payload || {})) {
    if (!name.endsWith('.json')) continue;
    atomicWriteJson(path.join(dir, sanitizeFile(name)), data);
  }
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function sanitizeFile(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function intNum(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function signSession(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function getAdminSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies.admin_session || '');
}

function isAdminAuthenticated(req) {
  return !!getAdminSession(req);
}

function setAdminSessionCookie(req, res, data) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ ...data, exp });
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https') || process.env.NODE_ENV === 'production';
  const parts = [
    `admin_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAdminSessionCookie(req, res) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https') || process.env.NODE_ENV === 'production';
  const parts = ['admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function requireAdminAllowlist(req, res, next) {
  if (!ADMIN_IP_ALLOWLIST.length) return next();
  const ip = getIp(req);
  if (!ADMIN_IP_ALLOWLIST.includes(ip)) {
    return res.status(403).json({ ok: false, error: 'ip_not_allowed' });
  }
  next();
}

function requireAdminAuth(req, res, next) {
  if (ADMIN_IP_ALLOWLIST.length) {
    const ip = getIp(req);
    if (!ADMIN_IP_ALLOWLIST.includes(ip)) {
      return res.status(403).json({ ok: false, error: 'ip_not_allowed' });
    }
  }
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function requireAdminPage(req, res, next) {
  if (ADMIN_IP_ALLOWLIST.length) {
    const ip = getIp(req);
    if (!ADMIN_IP_ALLOWLIST.includes(ip)) {
      return res.status(403).send('Forbidden');
    }
  }
  if (!isAdminAuthenticated(req)) {
    return res.redirect('/admin/login');
  }
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.host !== host) {
        return res.status(403).json({ ok: false, error: 'bad_origin' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'bad_origin' });
    }
  }
  next();
}

function verifyPassword(password) {
  const input = String(password || '');
  if (ADMIN_PASSWORD_HASH) {
    return verifyPasswordHash(input, ADMIN_PASSWORD_HASH);
  }
  if (!ADMIN_PASSWORD) return false;
  return safeEqual(input, ADMIN_PASSWORD);
}

function verifyPasswordHash(password, packed) {
  const [algo, iterRaw, salt, hashHex] = String(packed).split('$');
  if (algo !== 'pbkdf2_sha256' || !iterRaw || !salt || !hashHex) return false;
  const iterations = Number(iterRaw);
  if (!Number.isFinite(iterations) || iterations < 10000) return false;
  const calc = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return safeEqual(calc, hashHex);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function consumeLoginRate(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 6;
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  if (entry.count > max) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

function clearLoginRate(ip) {
  loginAttempts.delete(ip);
}

function compactStamp(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}_${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
}
