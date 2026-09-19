const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) { console.error('❌ НЕТ DATABASE_URL!'); process.exit(1); }
if (!process.env.JWT_SECRET) { console.error('❌ НЕТ JWT_SECRET!'); process.exit(1); }

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '148823242001';
const ADMIN_JWT_SECRET = JWT_SECRET + ':admin';

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER NOT NULL,
        bio TEXT DEFAULT '',
        contact_type TEXT DEFAULT 'telegram',
        contact_value TEXT DEFAULT '',
        photo TEXT,
        vide INTEGER DEFAULT 100,
        password_hash TEXT,
        reg_ip TEXT,
        device_id TEXT,
        is_admin INTEGER DEFAULT 0,
        is_premium INTEGER DEFAULT 0,
        card_color TEXT DEFAULT '',
        card_bg TEXT DEFAULT '',
        card_rgb INTEGER DEFAULT 0,
        card_pinned INTEGER DEFAULT 0,
        theme_web INTEGER DEFAULT 0,
        theme_glass INTEGER DEFAULT 0,
        profile_banner TEXT DEFAULT '',
        profile_color TEXT DEFAULT '',
        nick_style TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        liker_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(liker_id, target_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wheel_spins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        result_name TEXT NOT NULL,
        result_photo TEXT,
        result_skin_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        skin_id INTEGER NOT NULL,
        obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market (
        id SERIAL PRIMARY KEY,
        seller_id INTEGER NOT NULL,
        skin_id INTEGER NOT NULL,
        price INTEGER NOT NULL,
        is_sold INTEGER DEFAULT 0,
        buyer_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        ip TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bans (
        id SERIAL PRIMARY KEY,
        ip TEXT,
        device_id TEXT,
        reason TEXT DEFAULT '',
        banned_by TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        deleted_by_sender INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_cosmetics (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        cosmetic_key TEXT NOT NULL,
        obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, cosmetic_key)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_receiver ON messages(receiver_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id);`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reg_ip TEXT;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS device_id TEXT;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_banner TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_color TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nick_style TEXT DEFAULT '';`);
    console.log('✅ Таблицы готовы');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}
initDB();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Слишком много попыток входа. Попробуй через 15 минут.' }, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Слишком много регистраций с этого IP. Попробуй позже.' } });
const actionLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Слишком много действий. Подожди минуту.' } });
const msgLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Слишком много сообщений. Подожди минуту.' } });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `photo_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const ok = /jpeg|jpg|png|webp|gif/.test(file.mimetype); cb(ok ? null : new Error('Только изображения'), ok); } });

const SKINS = [
  { id: 0, name: 'Кролик',   rarity: 'common',    photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/f_auto,q_auto/8f150db30f01cc675e70ca4ac6f360bc' },
  { id: 1, name: 'Мадонна',  rarity: 'rare',      photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/f_auto,q_auto/8eaaed0977626bc105e1125bbfe22a37' },
  { id: 2, name: 'Кот',      rarity: 'epic',      photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/v1789725379/ab0c491837585a4bdf8320669dc2fe1c.jpg' },
  { id: 3, name: 'Анонимус', rarity: 'legendary', photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/v1789725482/fea5c0efc037f21668c8448b0a976544.jpg' }
];
const RARITY_CHANCE = { common: 60, rare: 28, epic: 10, legendary: 2 };
function rollSkin() {
  const roll = Math.random() * 100;
  let acc = 0, picked = 'common';
  for (const r of ['legendary', 'epic', 'rare', 'common']) { acc += RARITY_CHANCE[r]; if (roll < acc) { picked = r; break; } }
  const pool = SKINS.filter(s => s.rarity === picked);
  return pool[Math.floor(Math.random() * pool.length)] || SKINS[0];
}
function skinById(id) { return SKINS.find(s => s.id === parseInt(id)); }

// магазин оформления
const COSMETICS = {
  banners: [
    { key: 'banner_web',    name: 'Паутина',   price: 300, preview: 'linear-gradient(135deg,#0d0d12,#050508)', icon: '🕸' },
    { key: 'banner_sunset', name: 'Закат',     price: 250, preview: 'linear-gradient(135deg,#ff9a5c,#c45a1a)', icon: '🌅' },
    { key: 'banner_cosmos', name: 'Космос',    price: 400, preview: 'linear-gradient(135deg,#1a0d33,#050510)', icon: '🌌' },
    { key: 'banner_fire',   name: 'Огонь',     price: 350, preview: 'linear-gradient(135deg,#ff5c6e,#7a1a1a)', icon: '🔥' },
    { key: 'banner_matrix', name: 'Матрица',   price: 300, preview: 'linear-gradient(135deg,#001505,#000300)', icon: '🟢' }
  ],
  nicks: [
    { key: 'nick_neon',   name: 'Неон',        price: 200, icon: '💡' },
    { key: 'nick_fire',   name: 'Огонь',       price: 250, icon: '🔥' },
    { key: 'nick_ice',    name: 'Лёд',         price: 250, icon: '❄️' },
    { key: 'nick_rgb',    name: 'RGB-ник',     price: 400, icon: '🌈' },
    { key: 'nick_gold',   name: 'Золото',      price: 300, icon: '👑' }
  ],
  colors: [
    { key: 'color_red',    name: 'Красный',    price: 150, value: '#ff5c6e' },
    { key: 'color_blue',   name: 'Синий',      price: 150, value: '#5b9dff' },
    { key: 'color_purple', name: 'Фиолетовый', price: 150, value: '#b17aff' },
    { key: 'color_green',  name: 'Зелёный',    price: 150, value: '#4dd68a' }
  ]
};

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}
function getIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  return raw.split(',')[0].trim().slice(0, 64);
}
function getDeviceId(req) { return String(req.headers['x-device-id'] || req.body.deviceId || '').slice(0, 128); }

function makeUserToken(profileId) { return jwt.sign({ uid: profileId, type: 'user' }, JWT_SECRET, { expiresIn: '30d' }); }
function makeAdminToken() { return jwt.sign({ type: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '12h' }); }

function authUser(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нужна авторизация' });
  try { const p = jwt.verify(token, JWT_SECRET); if (p.type !== 'user') throw 0; req.userId = p.uid; next(); }
  catch { return res.status(401).json({ error: 'Сессия истекла. Войди заново.' }); }
}
function authAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нужна авторизация админа' });
  try { const p = jwt.verify(token, ADMIN_JWT_SECRET); if (p.type !== 'admin') throw 0; next(); }
  catch { return res.status(401).json({ error: 'Сессия админа истекла' }); }
}
async function audit(userId, action, details, req) {
  try { await pool.query('INSERT INTO audit_log (user_id, action, details, ip) VALUES ($1,$2,$3,$4)', [userId || null, action, (details || '').slice(0, 500), getIp(req)]); } catch {}
}

async function checkBan(req, res, next) {
  try {
    const ip = getIp(req);
    const device = getDeviceId(req);
    if (!ip && !device) return next();
    const r = await pool.query(`SELECT id FROM bans WHERE (ip IS NOT NULL AND ip = $1) OR (device_id IS NOT NULL AND device_id = $2 AND $2 <> '') LIMIT 1`, [ip, device]);
    if (r.rows.length) { await audit(null, 'ban_block', `ip=${ip}`, req); return res.status(403).json({ error: '🚫 Доступ запрещён.' }); }
    next();
  } catch { next(); }
}
app.use('/api/register', checkBan);
app.use('/api/login', checkBan);
app.use('/api/profiles', checkBan);
app.use('/api/like', checkBan);
app.use('/api/messages', checkBan);

// ==================== РЕГИСТРАЦИЯ / ВХОД ====================
app.post('/api/register', registerLimiter, upload.single('photo'), async (req, res) => {
  try {
    const { name, age, bio, contactType, contactValue, password } = req.body;
    const cleanName = sanitize(name, 40);
    const cleanBio = sanitize(bio, 200);
    const cleanContact = sanitize(contactValue, 60);
    const cleanContactType = ['telegram', 'discord'].includes(contactType) ? contactType : 'telegram';
    const ageNum = parseInt(age);
    const ip = getIp(req);
    const device = getDeviceId(req);

    if (!cleanName || cleanName.length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
    if (!ageNum || ageNum < 16 || ageNum > 99) return res.status(400).json({ error: 'Возраст 16–99' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    if (ip) { const d = await pool.query('SELECT id FROM profiles WHERE reg_ip=$1 LIMIT 1', [ip]); if (d.rows.length) return res.status(403).json({ error: 'С этого IP уже есть анкета.' }); }
    if (device) { const d = await pool.query('SELECT id FROM profiles WHERE device_id=$1 LIMIT 1', [device]); if (d.rows.length) return res.status(403).json({ error: 'С этого устройства уже есть анкета.' }); }
    const exist = await pool.query('SELECT id FROM profiles WHERE LOWER(name)=LOWER($1)', [cleanName]);
    if (exist.rows.length) return res.status(400).json({ error: 'Имя занято.' });

    const hash = await bcrypt.hash(password, 10);
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(`
      INSERT INTO profiles (name, age, bio, contact_type, contact_value, photo, password_hash, vide, reg_ip, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,100,$8,$9)
      RETURNING id, name, age, bio, contact_type, contact_value, photo, vide, is_premium,
                card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_color, nick_style, created_at
    `, [cleanName, ageNum, cleanBio, cleanContactType, cleanContact, photoPath, hash, ip || null, device || null]);
    const profile = result.rows[0];
    const token = makeUserToken(profile.id);
    await audit(profile.id, 'register', `name=${cleanName} ip=${ip}`, req);
    res.json({ profile, token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка регистрации' }); }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { name, password } = req.body;
    const cleanName = sanitize(name, 40);
    const ip = getIp(req);
    if (!cleanName || !password) return res.status(400).json({ error: 'Введи имя и пароль' });
    const r = await pool.query('SELECT * FROM profiles WHERE LOWER(name)=LOWER($1)', [cleanName]);
    if (!r.rows.length) { await audit(null, 'login_fail', `name=${cleanName} (not found)`, req); return res.status(401).json({ error: 'Неверное имя или пароль' }); }
    const row = r.rows[0];
    if (!row.password_hash) return res.status(401).json({ error: 'У этой анкеты нет пароля.' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) { await audit(row.id, 'login_fail', `name=${cleanName}`, req); return res.status(401).json({ error: 'Неверное имя или пароль' }); }
    const token = makeUserToken(row.id);
    const profile = { id: row.id, name: row.name, age: row.age, bio: row.bio, contact_type: row.contact_type, contact_value: row.contact_value, photo: row.photo, vide: row.vide, is_premium: row.is_premium, card_color: row.card_color, card_bg: row.card_bg, card_rgb: row.card_rgb, card_pinned: row.card_pinned, profile_banner: row.profile_banner, profile_color: row.profile_color, nick_style: row.nick_style, created_at: row.created_at };
    await audit(row.id, 'login_ok', `name=${cleanName} ip=${ip}`, req);
    res.json({ profile, token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка входа' }); }
});

app.get('/api/me', authUser, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, age, bio, contact_type, contact_value, photo, vide, is_premium, card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_color, nick_style, created_at FROM profiles WHERE id=$1`, [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/change-password', authUser, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
    const r = await pool.query('SELECT password_hash FROM profiles WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const ok = await bcrypt.compare(oldPassword || '', r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Старый пароль неверный' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, req.userId]);
    await audit(req.userId, 'change_pw_ok', '', req);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПРОФИЛИ ====================
app.get('/api/profiles', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, is_premium,
             card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_color, nick_style, created_at,
             (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles
      ORDER BY card_pinned DESC, created_at DESC
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка загрузки' }); }
});

// один профиль полностью
app.get('/api/profiles/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, is_premium,
             profile_banner, profile_color, nick_style, created_at,
             (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles WHERE id=$1
    `, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/profiles/:id', authUser, upload.single('photo'), async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свою анкету' });
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    const { name, age, bio, contactType, contactValue } = req.body;
    const cleanName = sanitize(name, 40) || row.name;
    const cleanBio = sanitize(bio, 200);
    const cleanContact = sanitize(contactValue, 60);
    const cleanContactType = ['telegram', 'discord'].includes(contactType) ? contactType : row.contact_type;
    const ageNum = parseInt(age) || row.age;
    if (cleanName.toLowerCase() !== row.name.toLowerCase()) {
      const clash = await pool.query('SELECT id FROM profiles WHERE LOWER(name)=LOWER($1) AND id<>$2', [cleanName, req.userId]);
      if (clash.rows.length) return res.status(400).json({ error: 'Имя занято' });
    }
    const photoPath = req.file ? `/uploads/${req.file.filename}` : row.photo;
    const result = await pool.query(`
      UPDATE profiles SET name=$1, age=$2, bio=$3, contact_type=$4, contact_value=$5, photo=$6
      WHERE id=$7
      RETURNING id, name, age, bio, contact_type, contact_value, photo, vide, is_premium,
                card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_color, nick_style, created_at
    `, [cleanName, ageNum, cleanBio, cleanContactType, cleanContact, photoPath, req.userId]);
    await audit(req.userId, 'edit_profile', '', req);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка обновления' }); }
});

app.delete('/api/profiles/:id', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свою' });
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    if (row.photo) { const fp = path.join(__dirname, 'public', row.photo); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await pool.query('DELETE FROM likes WHERE target_id=$1 OR liker_id=$1', [req.userId]);
    await pool.query('DELETE FROM wheel_spins WHERE user_id=$1', [req.userId]);
    await pool.query('DELETE FROM inventory WHERE user_id=$1', [req.userId]);
    await pool.query('DELETE FROM market WHERE seller_id=$1 OR buyer_id=$1', [req.userId]);
    await pool.query('DELETE FROM messages WHERE sender_id=$1 OR receiver_id=$1', [req.userId]);
    await pool.query('DELETE FROM user_cosmetics WHERE user_id=$1', [req.userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [req.userId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка удаления' }); }
});

// оформление карточки (премиум)
app.post('/api/profiles/:id/appearance', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только своё' });
    const { cardColor, cardBg, cardRgb, cardPinned } = req.body;
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    if (!existing.rows[0].is_premium) return res.status(403).json({ error: 'Только для Premium' });
    const safeColor = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); if (!s) return ''; return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : null; };
    await pool.query(`
      UPDATE profiles SET card_color=COALESCE($1,card_color), card_bg=COALESCE($2,card_bg),
        card_rgb=COALESCE($3,card_rgb), card_pinned=COALESCE($4,card_pinned) WHERE id=$5
    `, [safeColor(cardColor), safeColor(cardBg), cardRgb !== undefined ? (cardRgb ? 1 : 0) : null, cardPinned !== undefined ? (cardPinned ? 1 : 0) : null, req.userId]);
    const r = await pool.query(`SELECT id, name, age, bio, contact_type, contact_value, photo, vide, is_premium, card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_color, nick_style, created_at FROM profiles WHERE id=$1`, [req.userId]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// оформление профиля (баннер/цвет/ник) — можно всем, у кого куплено
app.post('/api/profiles/:id/profile-style', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свой' });
    const { profileBanner, profileColor, nickStyle } = req.body;
    // проверяем, что куплено (если не пусто)
    if (profileBanner) {
      const owned = await pool.query('SELECT id FROM user_cosmetics WHERE user_id=$1 AND cosmetic_key=$2', [req.userId, profileBanner]);
      if (!owned.rows.length) return res.status(403).json({ error: 'Баннер не куплен' });
    }
    if (nickStyle) {
      const owned = await pool.query('SELECT id FROM user_cosmetics WHERE user_id=$1 AND cosmetic_key=$2', [req.userId, nickStyle]);
      if (!owned.rows.length) return res.status(403).json({ error: 'Стиль ника не куплен' });
    }
    if (profileColor) {
      const owned = await pool.query('SELECT id FROM user_cosmetics WHERE user_id=$1 AND cosmetic_key=$2', [req.userId, profileColor]);
      if (!owned.rows.length) return res.status(403).json({ error: 'Цвет не куплен' });
    }
    await pool.query(`
      UPDATE profiles SET
        profile_banner = COALESCE($1, profile_banner),
        profile_color  = COALESCE($2, profile_color),
        nick_style     = COALESCE($3, nick_style)
      WHERE id=$4
    `, [profileBanner !== undefined ? profileBanner : null, profileColor !== undefined ? profileColor : null, nickStyle !== undefined ? nickStyle : null, req.userId]);
    const r = await pool.query(`SELECT id, name, age, bio, contact_type, contact_value, photo, vide, is_premium, card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_color, nick_style, created_at FROM profiles WHERE id=$1`, [req.userId]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ЛАЙКИ ====================
app.post('/api/like', authUser, actionLimiter, async (req, res) => {
  try {
    const targetId = parseInt(req.body.targetId);
    if (!targetId) return res.status(400).json({ error: 'Нужен targetId' });
    if (targetId === req.userId) return res.status(400).json({ error: 'Нельзя лайкнуть себя' });
    const existing = await pool.query('SELECT * FROM likes WHERE liker_id=$1 AND target_id=$2', [req.userId, targetId]);
    if (existing.rows.length) { await pool.query('DELETE FROM likes WHERE liker_id=$1 AND target_id=$2', [req.userId, targetId]); res.json({ liked: false }); }
    else { await pool.query('INSERT INTO likes (liker_id, target_id) VALUES ($1,$2)', [req.userId, targetId]); res.json({ liked: true }); }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка лайка' }); }
});

app.get('/api/likes/:userId', async (req, res) => {
  try { const r = await pool.query('SELECT target_id FROM likes WHERE liker_id=$1', [parseInt(req.params.userId)]); res.json(r.rows.map(x => x.target_id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/liked-by/:userId', async (req, res) => {
  try {
    const r = await pool.query(`SELECT p.id, p.name, p.age, p.bio, p.photo, p.contact_type, p.contact_value FROM profiles p JOIN likes l ON l.liker_id = p.id WHERE l.target_id = $1 ORDER BY l.created_at DESC`, [parseInt(req.params.userId)]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// взаимный лайк?
app.get('/api/mutual/:a/:b', async (req, res) => {
  try {
    const a = parseInt(req.params.a), b = parseInt(req.params.b);
    const r = await pool.query(`SELECT 1 FROM likes WHERE liker_id=$1 AND target_id=$2 UNION SELECT 1 FROM likes WHERE liker_id=$2 AND target_id=$1`, [a, b]);
    res.json({ mutual: r.rows.length >= 2 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== СООБЩЕНИЯ ====================
// список диалогов
app.get('/api/messages/dialogs/:userId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' });
    const me = req.userId;
    const rows = await pool.query(`
      SELECT DISTINCT
        CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id
      FROM messages
      WHERE (sender_id = $1 OR receiver_id = $1) AND deleted_by_sender = 0
    `, [me]);
    const dialogs = [];
    for (const r of rows.rows) {
      const other = await pool.query('SELECT id, name, age, photo, profile_banner, profile_color, nick_style FROM profiles WHERE id=$1', [r.other_id]);
      if (!other.rows.length) continue;
      const last = await pool.query(`
        SELECT * FROM messages
        WHERE ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)) AND deleted_by_sender=0
        ORDER BY created_at DESC LIMIT 1
      `, [me, r.other_id]);
      const unread = await pool.query(`SELECT COUNT(*)::int AS c FROM messages WHERE sender_id=$1 AND receiver_id=$2 AND is_read=0`, [r.other_id, me]);
      dialogs.push({ user: other.rows[0], last: last.rows[0] || null, unread: unread.rows[0].c });
    }
    dialogs.sort((a, b) => new Date(b.last ? b.last.created_at : 0) - new Date(a.last ? a.last.created_at : 0));
    res.json(dialogs);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// непрочитано всего
app.get('/api/messages/unread/:userId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только своё' });
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM messages WHERE receiver_id=$1 AND is_read=0', [req.userId]);
    res.json({ count: r.rows[0].c });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// история с юзером
app.get('/api/messages/:userId/:otherId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' });
    const me = req.userId, other = parseInt(req.params.otherId);
    const r = await pool.query(`
      SELECT * FROM messages
      WHERE ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)) AND deleted_by_sender=0
      ORDER BY created_at ASC
    `, [me, other]);
    await pool.query('UPDATE messages SET is_read=1 WHERE sender_id=$1 AND receiver_id=$2 AND is_read=0', [other, me]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// отправка
app.post('/api/messages', authUser, msgLimiter, async (req, res) => {
  try {
    const { receiverId, text } = req.body;
    const rid = parseInt(receiverId);
    const cleanText = sanitize(text, 1000);
    if (!rid || !cleanText) return res.status(400).json({ error: 'Пустое сообщение' });
    if (rid === req.userId) return res.status(400).json({ error: 'Нельзя себе' });
    const target = await pool.query('SELECT id FROM profiles WHERE id=$1', [rid]);
    if (!target.rows.length) return res.status(404).json({ error: 'Получатель не найден' });
    // проверка лайка в любую сторону
    const likeCheck = await pool.query(`
      SELECT 1 FROM likes WHERE (liker_id=$1 AND target_id=$2) OR (liker_id=$2 AND target_id=$1) LIMIT 1
    `, [req.userId, rid]);
    if (!likeCheck.rows.length) return res.status(403).json({ error: 'Нужен взаимный лайк или хотя бы один' });
    const r = await pool.query(`
      INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1,$2,$3) RETURNING *
    `, [req.userId, rid, cleanText]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка отправки' }); }
});

// удалить своё сообщение (в течение 5 минут)
app.post('/api/messages/delete/:id', authUser, async (req, res) => {
  try {
    const mid = parseInt(req.params.id);
    const r = await pool.query('SELECT * FROM messages WHERE id=$1', [mid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const m = r.rows[0];
    if (m.sender_id !== req.userId) return res.status(403).json({ error: 'Не твоё' });
    const age = Date.now() - new Date(m.created_at).getTime();
    if (age > 5 * 60 * 1000) return res.status(400).json({ error: 'Прошло больше 5 минут' });
    await pool.query('DELETE FROM messages WHERE id=$1', [mid]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== МАГАЗИН ОФОРМЛЕНИЯ ====================
app.get('/api/cosmetics', (req, res) => { res.json(COSMETICS); });

app.get('/api/cosmetics/owned/:userId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только своё' });
    const r = await pool.query('SELECT cosmetic_key FROM user_cosmetics WHERE user_id=$1', [req.userId]);
    res.json(r.rows.map(x => x.cosmetic_key));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/cosmetics/buy', authUser, actionLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Нужен ключ' });
    // ищем цену во всех категориях
    let item = null, category = '';
    for (const [cat, list] of Object.entries(COSMETICS)) {
      const f = list.find(x => x.key === key);
      if (f) { item = f; category = cat; break; }
    }
    if (!item) return res.status(404).json({ error: 'Такого украшения нет' });

    await client.query('BEGIN');
    const owned = await client.query('SELECT id FROM user_cosmetics WHERE user_id=$1 AND cosmetic_key=$2', [req.userId, key]);
    if (owned.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Уже куплено' }); }
    const u = await client.query('SELECT vide FROM profiles WHERE id=$1 FOR UPDATE', [req.userId]);
    if ((u.rows[0].vide || 0) < item.price) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Недостаточно вайдиков' }); }
    await client.query('UPDATE profiles SET vide = vide - $1 WHERE id=$2', [item.price, req.userId]);
    await client.query('INSERT INTO user_cosmetics (user_id, cosmetic_key) VALUES ($1,$2)', [req.userId, key]);
    await client.query('COMMIT');
    const nb = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
    res.json({ ok: true, balance: nb.rows[0].vide, category });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); res.status(500).json({ error: 'Ошибка покупки' }); }
  finally { client.release(); }
});

// ==================== ВАЙДИКИ / КОЛЕСО ====================
app.get('/api/vide/:userId', async (req, res) => {
  try { const r = await pool.query('SELECT vide FROM profiles WHERE id=$1', [parseInt(req.params.userId)]); if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' }); res.json({ vide: r.rows[0].vide || 0 }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/wheel/spin', authUser, actionLimiter, async (req, res) => {
  try {
    const me = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Анкета не найдена' });
    const COST = 10;
    const balance = me.rows[0].vide || 0;
    if (balance < COST) return res.status(400).json({ error: 'Недостаточно вайдиков' });
    const skin = rollSkin();
    await pool.query('UPDATE profiles SET vide = vide - $1 WHERE id = $2', [COST, req.userId]);
    const spin = await pool.query(`INSERT INTO wheel_spins (user_id, result_name, result_photo, result_skin_id) VALUES ($1,$2,$3,$4) RETURNING *`, [req.userId, skin.name, skin.photo, skin.id]);
    await pool.query('INSERT INTO inventory (user_id, skin_id) VALUES ($1,$2)', [req.userId, skin.id]);
    res.json({ spin: spin.rows[0], skin, balance: balance - COST });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка прокрутки' }); }
});

app.get('/api/inventory/:userId', async (req, res) => {
  try {
    const r = await pool.query('SELECT skin_id FROM inventory WHERE user_id=$1 ORDER BY obtained_at DESC', [parseInt(req.params.userId)]);
    const counts = {};
    r.rows.forEach(x => { counts[x.skin_id] = (counts[x.skin_id] || 0) + 1; });
    const items = Object.entries(counts).map(([sid, count]) => { const s = SKINS.find(x => x.id === parseInt(sid)); return s ? { ...s, count } : null; }).filter(Boolean);
    res.json(items);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/skins', (req, res) => { res.json(SKINS); });

// ==================== РЫНОК ====================
app.get('/api/market', async (req, res) => {
  try {
    const r = await pool.query(`SELECT m.id, m.skin_id, m.price, m.seller_id, m.created_at, p.name AS seller_name FROM market m JOIN profiles p ON p.id = m.seller_id WHERE m.is_sold = 0 ORDER BY m.created_at DESC`);
    res.json(r.rows.map(x => ({ ...x, skin: skinById(x.skin_id) })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка рынка' }); }
});

app.post('/api/market/list', authUser, actionLimiter, async (req, res) => {
  try {
    const skinId = parseInt(req.body.skinId), price = parseInt(req.body.price);
    if (isNaN(skinId) || !price || price < 1 || price > 100000) return res.status(400).json({ error: 'Некорректные данные' });
    const inv = await pool.query('SELECT id FROM inventory WHERE user_id=$1 AND skin_id=$2 LIMIT 1', [req.userId, skinId]);
    if (!inv.rows.length) return res.status(400).json({ error: 'Нет скина' });
    await pool.query('DELETE FROM inventory WHERE id=$1', [inv.rows[0].id]);
    const r = await pool.query('INSERT INTO market (seller_id, skin_id, price) VALUES ($1,$2,$3) RETURNING *', [req.userId, skinId, price]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/market/buy', authUser, actionLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parseInt(req.body.lotId);
    await client.query('BEGIN');
    const lot = await client.query('SELECT * FROM market WHERE id=$1 AND is_sold=0 FOR UPDATE', [lotId]);
    if (!lot.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Продан' }); }
    const l = lot.rows[0];
    if (l.seller_id === req.userId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Свой лот' }); }
    const b = await client.query('SELECT vide FROM profiles WHERE id=$1 FOR UPDATE', [req.userId]);
    if ((b.rows[0].vide || 0) < l.price) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Мало вайдиков' }); }
    await client.query('UPDATE profiles SET vide = vide - $1 WHERE id=$2', [l.price, req.userId]);
    await client.query('UPDATE profiles SET vide = vide + $1 WHERE id=$2', [l.price, l.seller_id]);
    await client.query('UPDATE market SET is_sold=1, buyer_id=$1 WHERE id=$2', [req.userId, lotId]);
    await client.query('INSERT INTO inventory (user_id, skin_id) VALUES ($1,$2)', [req.userId, l.skin_id]);
    await client.query('COMMIT');
    const nb = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
    res.json({ ok: true, balance: nb.rows[0].vide });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); res.status(500).json({ error: 'Ошибка' }); }
  finally { client.release(); }
});

app.post('/api/market/cancel', authUser, async (req, res) => {
  try {
    const lotId = parseInt(req.body.lotId);
    const l = await pool.query('SELECT * FROM market WHERE id=$1 AND is_sold=0', [lotId]);
    if (!l.rows.length) return res.status(404).json({ error: 'Нет' });
    if (l.rows[0].seller_id !== req.userId) return res.status(403).json({ error: 'Не твой' });
    await pool.query('DELETE FROM market WHERE id=$1', [lotId]);
    await pool.query('INSERT INTO inventory (user_id, skin_id) VALUES ($1,$2)', [req.userId, l.rows[0].skin_id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/market/my/:userId', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM market WHERE seller_id=$1 AND is_sold=0 ORDER BY created_at DESC', [parseInt(req.params.userId)]); res.json(r.rows.map(x => ({ ...x, skin: skinById(x.skin_id) }))); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== АДМИНКА ====================
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Неверный пароль' });
    res.json({ token: makeAdminToken() });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, age, photo, vide, is_admin, is_premium, reg_ip, device_id, created_at,
        (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles ORDER BY id DESC
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/give-vide', authAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const amt = parseInt(amount);
    if (!amt) return res.status(400).json({ error: 'Нет суммы' });
    await pool.query('UPDATE profiles SET vide = GREATEST(0, vide + $1) WHERE id = $2', [amt, userId]);
    const r = await pool.query('SELECT id, name, vide FROM profiles WHERE id=$1', [userId]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/toggle-premium', authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const e = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!e.rows.length) return res.status(404).json({ error: 'Нет' });
    const nv = e.rows[0].is_premium ? 0 : 1;
    await pool.query('UPDATE profiles SET is_premium=$1 WHERE id=$2', [nv, userId]);
    if (!nv) await pool.query(`UPDATE profiles SET card_color='', card_bg='', card_rgb=0, card_pinned=0 WHERE id=$1`, [userId]);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/delete-user', authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const e = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!e.rows.length) return res.status(404).json({ error: 'Нет' });
    if (e.rows[0].photo) { const fp = path.join(__dirname, 'public', e.rows[0].photo); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await pool.query('DELETE FROM likes WHERE target_id=$1 OR liker_id=$1', [userId]);
    await pool.query('DELETE FROM wheel_spins WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM inventory WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM market WHERE seller_id=$1 OR buyer_id=$1', [userId]);
    await pool.query('DELETE FROM messages WHERE sender_id=$1 OR receiver_id=$1', [userId]);
    await pool.query('DELETE FROM user_cosmetics WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [userId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/reset-password', authAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Пароль 6+ символов' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, userId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/purge-nopass', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('SELECT id FROM profiles WHERE password_hash IS NULL');
    const ids = t.rows.map(r => r.id);
    if (!ids.length) { await client.query('ROLLBACK'); return res.json({ ok: true, deleted: 0 }); }
    await client.query('DELETE FROM likes WHERE liker_id = ANY($1) OR target_id = ANY($1)', [ids]);
    await client.query('DELETE FROM wheel_spins WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM inventory WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM market WHERE seller_id = ANY($1) OR buyer_id = ANY($1)', [ids]);
    await client.query('DELETE FROM messages WHERE sender_id = ANY($1) OR receiver_id = ANY($1)', [ids]);
    await client.query('DELETE FROM user_cosmetics WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM audit_log WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM profiles WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); res.status(500).json({ error: 'Ошибка' }); }
  finally { client.release(); }
});

app.post('/api/admin/purge-by-ids', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Нужны ids' });
    const cleanIds = ids.map(x => parseInt(x)).filter(x => Number.isInteger(x) && x > 0);
    if (!cleanIds.length) return res.status(400).json({ error: 'Нет валидных' });
    await client.query('BEGIN');
    const e = await client.query('SELECT id FROM profiles WHERE id = ANY($1)', [cleanIds]);
    const okIds = e.rows.map(r => r.id);
    if (!okIds.length) { await client.query('ROLLBACK'); return res.json({ ok: true, deleted: 0 }); }
    await client.query('DELETE FROM likes WHERE liker_id = ANY($1) OR target_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM wheel_spins WHERE user_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM inventory WHERE user_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM market WHERE seller_id = ANY($1) OR buyer_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM messages WHERE sender_id = ANY($1) OR receiver_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM user_cosmetics WHERE user_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM audit_log WHERE user_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM profiles WHERE id = ANY($1)', [okIds]);
    await client.query('COMMIT');
    res.json({ ok: true, deleted: okIds.length, found: okIds });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); res.status(500).json({ error: 'Ошибка' }); }
  finally { client.release(); }
});

app.post('/api/admin/ban', authAdmin, async (req, res) => {
  try {
    const { userId, banIp, banDevice, reason } = req.body;
    const e = await pool.query('SELECT id, name, reg_ip, device_id FROM profiles WHERE id=$1', [userId]);
    if (!e.rows.length) return res.status(404).json({ error: 'Нет' });
    const u = e.rows[0];
    if (!banIp && !banDevice) return res.status(400).json({ error: 'Выбери что банить' });
    if (banIp && u.reg_ip) await pool.query('INSERT INTO bans (ip, reason) VALUES ($1,$2)', [u.reg_ip, (reason || '').slice(0, 200)]);
    if (banDevice && u.device_id) await pool.query('INSERT INTO bans (device_id, reason) VALUES ($1,$2)', [u.device_id, (reason || '').slice(0, 200)]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/bans', authAdmin, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM bans ORDER BY id DESC LIMIT 500'); res.json(r.rows); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/unban', authAdmin, async (req, res) => {
  try { await pool.query('DELETE FROM bans WHERE id=$1', [req.body.banId]); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/admin/log', authAdmin, async (req, res) => {
  try { const r = await pool.query(`SELECT a.*, p.name AS user_name FROM audit_log a LEFT JOIN profiles p ON p.id = a.user_id ORDER BY a.created_at DESC LIMIT 200`); res.json(r.rows); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

// === АДМИН: все диалоги ===
app.post('/api/admin/messages/dialogs', authAdmin, async (req, res) => {
  try {
    // группируем сообщения по парам (min, max)
    const r = await pool.query(`
      SELECT
        LEAST(sender_id, receiver_id) AS a,
        GREATEST(sender_id, receiver_id) AS b,
        COUNT(*)::int AS total,
        MAX(created_at) AS last_at
      FROM messages
      GROUP BY a, b
      ORDER BY last_at DESC
      LIMIT 200
    `);
    const dialogs = [];
    for (const row of r.rows) {
      const pa = await pool.query('SELECT id, name, photo FROM profiles WHERE id=$1', [row.a]);
      const pb = await pool.query('SELECT id, name, photo FROM profiles WHERE id=$1', [row.b]);
      dialogs.push({
        a: pa.rows[0] || { id: row.a, name: 'удалён' },
        b: pb.rows[0] || { id: row.b, name: 'удалён' },
        total: row.total,
        last_at: row.last_at
      });
    }
    res.json(dialogs);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/messages/:a/:b', authAdmin, async (req, res) => {
  try {
    const a = parseInt(req.params.a), b = parseInt(req.params.b);
    const r = await pool.query(`
      SELECT * FROM messages
      WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
      ORDER BY created_at ASC
    `, [a, b]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.listen(PORT, () => { console.log(`🚀 XIVIVIDE запущен: http://localhost:${PORT}`); });
