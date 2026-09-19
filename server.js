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
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) { console.error('❌ НЕТ DATABASE_URL!'); process.exit(1); }
if (!process.env.JWT_SECRET) { console.error('❌ НЕТ JWT_SECRET!'); process.exit(1); }

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '148823242001';
const ADMIN_JWT_SECRET = JWT_SECRET + ':admin';

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, bio TEXT DEFAULT '',
        contact_type TEXT DEFAULT 'telegram', contact_value TEXT DEFAULT '', photo TEXT,
        vide INTEGER DEFAULT 100, password_hash TEXT, reg_ip TEXT, device_id TEXT,
        is_admin INTEGER DEFAULT 0, is_premium INTEGER DEFAULT 0, premium_until TIMESTAMP,
        card_color TEXT DEFAULT '', card_bg TEXT DEFAULT '', card_rgb INTEGER DEFAULT 0, card_pinned INTEGER DEFAULT 0,
        profile_banner TEXT DEFAULT '', profile_theme TEXT DEFAULT '', profile_color TEXT DEFAULT '',
        profile_font TEXT DEFAULT '', nick_style TEXT DEFAULT '', chat_bg TEXT DEFAULT '', music_url TEXT DEFAULT '',
        profile_layout TEXT DEFAULT '',
        ref_code TEXT UNIQUE, invited_by INTEGER,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, bonus_streak INTEGER DEFAULT 0,
        last_bonus_date DATE, show_gifts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE TABLE IF NOT EXISTS likes (id SERIAL PRIMARY KEY, liker_id INTEGER NOT NULL, target_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(liker_id, target_id));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wheel_spins (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, result_name TEXT NOT NULL, result_photo TEXT, result_skin_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, item_type TEXT DEFAULT 'skin', item_key TEXT NOT NULL, obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS market (id SERIAL PRIMARY KEY, seller_id INTEGER NOT NULL, item_type TEXT DEFAULT 'skin', item_key TEXT NOT NULL, price INTEGER NOT NULL, is_sold INTEGER DEFAULT 0, buyer_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, details TEXT, ip TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS bans (id SERIAL PRIMARY KEY, ip TEXT, device_id TEXT, reason TEXT DEFAULT '', banned_by TEXT DEFAULT 'admin', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender_id INTEGER NOT NULL, receiver_id INTEGER NOT NULL, text TEXT NOT NULL, is_read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS gifts (id SERIAL PRIMARY KEY, sender_id INTEGER NOT NULL, receiver_id INTEGER NOT NULL, item_key TEXT NOT NULL, item_type TEXT DEFAULT 'skin', shown INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, link_id INTEGER, is_read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, photo TEXT NOT NULL, caption TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS story_views (id SERIAL PRIMARY KEY, story_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(story_id, user_id));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY, target_id INTEGER NOT NULL, author_id INTEGER NOT NULL, text TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_bonus (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, date DATE NOT NULL, amount INTEGER NOT NULL, UNIQUE(user_id, date));`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shame_posts (
        id SERIAL PRIMARY KEY,
        author_id INTEGER NOT NULL,
        photo TEXT DEFAULT '',
        text TEXT NOT NULL,
        target_name TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const migr = [
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_banner TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_theme TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_color TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_font TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nick_style TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS chat_bg TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS music_url TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_layout TEXT DEFAULT ''`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ref_code TEXT`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invited_by INTEGER`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bonus_streak INTEGER DEFAULT 0`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_bonus_date DATE`,
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_gifts INTEGER DEFAULT 0`,
      `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS item_type TEXT DEFAULT 'skin'`,
      `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS item_key TEXT`,
      `ALTER TABLE market ADD COLUMN IF NOT EXISTS item_type TEXT DEFAULT 'skin'`,
      `ALTER TABLE market ADD COLUMN IF NOT EXISTS item_key TEXT`
    ];
    for (const q of migr) await pool.query(q);
    try { await pool.query(`ALTER TABLE inventory ALTER COLUMN skin_id DROP NOT NULL`); } catch {}
    try { await pool.query(`ALTER TABLE market ALTER COLUMN skin_id DROP NOT NULL`); } catch {}

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_expires ON stories(expires_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_user ON inventory(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_key ON inventory(user_id, item_type, item_key);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_likes_liker ON likes(liker_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_shame ON shame_posts(created_at DESC);`);
    console.log('✅ Таблицы готовы');
  } catch (err) { console.error('❌ Ошибка initDB:', err.message); }
}
initDB();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Слишком много попыток входа.' } });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 5, message: { error: 'Слишком много регистраций.' } });
const actionLimiter = rateLimit({ windowMs: 60*1000, max: 60, message: { error: 'Слишком много действий.' } });
const msgLimiter = rateLimit({ windowMs: 60*1000, max: 30, message: { error: 'Слишком много сообщений.' } });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `p_${Date.now()}_${Math.round(Math.random()*1e9)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 8*1024*1024 }, fileFilter: (req, f, cb) => cb(/jpeg|jpg|png|webp|gif/.test(f.mimetype) ? null : new Error('Только изображения'), /jpeg|jpg|png|webp|gif/.test(f.mimetype)) });

const SKINS = [
  { id: 0, name: 'Кролик',   rarity: 'common',    photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/f_auto,q_auto/8f150db30f01cc675e70ca4ac6f360bc' },
  { id: 1, name: 'Мадонна',  rarity: 'rare',      photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/f_auto,q_auto/8eaaed0977626bc105e1125bbfe22a37' },
  { id: 2, name: 'Кот',      rarity: 'epic',      photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/v1789725379/ab0c491837585a4bdf8320669dc2fe1c.jpg' },
  { id: 3, name: 'Анонимус', rarity: 'legendary', photo: 'https://res.cloudinary.com/qr9qdjxn/image/upload/v1789725482/fea5c0efc037f21668c8448b0a976544.jpg' }
];
function skinById(id) { return SKINS.find(s => s.id === parseInt(id)); }

const PROFILE_THEMES = [
  { key: 'theme_web', name: 'Паутина', price: 300 },
  { key: 'theme_cosmos', name: 'Космос', price: 350 },
  { key: 'theme_sunset', name: 'Закат', price: 250 },
  { key: 'theme_fire', name: 'Огонь', price: 300 },
  { key: 'theme_matrix', name: 'Матрица', price: 300 },
  { key: 'theme_night', name: 'Ночь', price: 200 },
  { key: 'theme_sakura', name: 'Сакура', price: 250 }
];
const CHAT_BGS = [
  { key: 'chat_web', name: 'Паутина', price: 150 },
  { key: 'chat_night', name: 'Ночь', price: 150 },
  { key: 'chat_forest', name: 'Лес', price: 150 },
  { key: 'chat_clouds', name: 'Облака', price: 150 }
];
const NICKS = [
  { key: 'nick_neon', name: 'Неон', price: 200, icon: '💡' },
  { key: 'nick_fire', name: 'Огонь', price: 250, icon: '🔥' },
  { key: 'nick_ice', name: 'Лёд', price: 250, icon: '❄️' },
  { key: 'nick_rgb', name: 'RGB', price: 400, icon: '🌈' },
  { key: 'nick_gold', name: 'Золото', price: 300, icon: '👑' }
];
const COLORS = [
  { key: 'color_red', name: 'Красный', price: 150, value: '#ff5c6e' },
  { key: 'color_blue', name: 'Синий', price: 150, value: '#5b9dff' },
  { key: 'color_purple', name: 'Фиолетовый', price: 150, value: '#b17aff' },
  { key: 'color_green', name: 'Зелёный', price: 150, value: '#4dd68a' }
];
const BANNERS = [
  { key: 'banner_web', name: 'Паутина', price: 300, preview: 'linear-gradient(135deg,#0d0d12,#050508)', icon: '🕸' },
  { key: 'banner_sunset', name: 'Закат', price: 250, preview: 'linear-gradient(135deg,#ff9a5c,#c45a1a)', icon: '🌅' },
  { key: 'banner_cosmos', name: 'Космос', price: 400, preview: 'linear-gradient(135deg,#1a0d33,#050510)', icon: '🌌' },
  { key: 'banner_fire', name: 'Огонь', price: 350, preview: 'linear-gradient(135deg,#ff5c6e,#7a1a1a)', icon: '🔥' },
  { key: 'banner_matrix', name: 'Матрица', price: 300, preview: 'linear-gradient(135deg,#001505,#000300)', icon: '🟢' }
];

const WHEEL_POOL = [
  ...SKINS.map(s => ({ type: 'skin', key: String(s.id), name: s.name, icon: s.photo, rarity: s.rarity })),
  ...PROFILE_THEMES.map(t => ({ type: 'theme', key: t.key, name: t.name, icon: '🎨', rarity: 'epic' })),
  ...CHAT_BGS.map(c => ({ type: 'chatbg', key: c.key, name: c.name, icon: '💬', rarity: 'rare' })),
  ...NICKS.map(n => ({ type: 'nick', key: n.key, name: n.name, icon: n.icon, rarity: 'rare' })),
  ...COLORS.map(c => ({ type: 'color', key: c.key, name: c.name, icon: '🎨', rarity: 'common' }))
];
function rollWheel() {
  const s = Math.random() * 100;
  if (s < 1) return { type: 'premium', key: 'forever', name: 'Премиум НАВСЕГДА', icon: '👑', rarity: 'mythic' };
  if (s < 4) return { type: 'premium', key: '7days', name: 'Премиум на 7 дней', icon: '⭐', rarity: 'legendary' };
  if (s < 8) return { type: 'coins', key: '1000', name: '1000 вайдиков', icon: '🪙', rarity: 'legendary' };
  const r = Math.random() * 100;
  let acc = 0, picked = 'common';
  for (const [rar, ch] of [['legendary', 4], ['epic', 12], ['rare', 28], ['common', 56]]) {
    acc += ch; if (r < acc) { picked = rar; break; }
  }
  const p = WHEEL_POOL.filter(x => x.rarity === picked);
  return p[Math.floor(Math.random() * p.length)] || WHEEL_POOL[0];
}

function sanitize(str, maxLen = 500) { if (typeof str !== 'string') return ''; return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen); }
function getIp(req) { const raw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString(); return raw.split(',')[0].trim().slice(0, 64); }
function getDeviceId(req) { return String(req.headers['x-device-id'] || req.body.deviceId || '').slice(0, 128); }
function makeUserToken(id) { return jwt.sign({ uid: id, type: 'user' }, JWT_SECRET, { expiresIn: '30d' }); }
function makeAdminToken() { return jwt.sign({ type: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '12h' }); }
function authUser(req, res, next) {
  const a = req.headers.authorization || ''; const t = a.startsWith('Bearer ') ? a.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Нужна авторизация' });
  try { const p = jwt.verify(t, JWT_SECRET); if (p.type !== 'user') throw 0; req.userId = p.uid; next(); }
  catch { return res.status(401).json({ error: 'Сессия истекла' }); }
}
function authAdmin(req, res, next) {
  const a = req.headers.authorization || ''; const t = a.startsWith('Bearer ') ? a.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Нужна авторизация админа' });
  try { const p = jwt.verify(t, ADMIN_JWT_SECRET); if (p.type !== 'admin') throw 0; next(); }
  catch { return res.status(401).json({ error: 'Сессия админа истекла' }); }
}
async function audit(uid, action, details, req) {
  try { await pool.query('INSERT INTO audit_log (user_id, action, details, ip) VALUES ($1,$2,$3,$4)', [uid||null, action, (details||'').slice(0,500), getIp(req)]); } catch {}
}
async function notify(userId, type, text, linkId) {
  try { await pool.query('INSERT INTO notifications (user_id, type, text, link_id) VALUES ($1,$2,$3,$4)', [userId, type, text, linkId || null]); } catch {}
}
function randomRef() { return 'x' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 5); }

async function checkBan(req, res, next) {
  try {
    const ip = getIp(req), dev = getDeviceId(req);
    if (!ip && !dev) return next();
    const r = await pool.query(`SELECT id FROM bans WHERE (ip IS NOT NULL AND ip=$1) OR (device_id IS NOT NULL AND device_id=$2 AND $2<>'') LIMIT 1`, [ip, dev]);
    if (r.rows.length) return res.status(403).json({ error: '🚫 Доступ запрещён.' });
    next();
  } catch { next(); }
}
['/api/register','/api/login','/api/profiles','/api/like','/api/messages','/api/shame'].forEach(p => app.use(p, checkBan));
async function touchSeen(userId) { try { await pool.query('UPDATE profiles SET last_seen = CURRENT_TIMESTAMP WHERE id=$1', [userId]); } catch {} }

function pickProfile(row) {
  return { id: row.id, name: row.name, age: row.age, bio: row.bio,
    contact_type: row.contact_type, contact_value: row.contact_value,
    photo: row.photo, vide: row.vide, is_premium: row.is_premium, premium_until: row.premium_until,
    card_color: row.card_color, card_bg: row.card_bg, card_rgb: row.card_rgb, card_pinned: row.card_pinned,
    profile_banner: row.profile_banner, profile_theme: row.profile_theme, profile_color: row.profile_color,
    profile_font: row.profile_font, profile_layout: row.profile_layout,
    nick_style: row.nick_style, chat_bg: row.chat_bg, music_url: row.music_url,
    ref_code: row.ref_code, show_gifts: row.show_gifts, last_seen: row.last_seen, created_at: row.created_at };
}

app.post('/api/register', registerLimiter, upload.single('photo'), async (req, res) => {
  try {
    const { name, age, bio, contactType, contactValue, password, ref } = req.body;
    const cleanName = sanitize(name, 40), cleanBio = sanitize(bio, 200), cleanContact = sanitize(contactValue, 60);
    const cleanCT = ['telegram','discord'].includes(contactType) ? contactType : 'telegram';
    const ageN = parseInt(age); const ip = getIp(req), dev = getDeviceId(req);
    if (!cleanName || cleanName.length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
    if (!ageN || ageN < 16 || ageN > 99) return res.status(400).json({ error: 'Возраст 16–99' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль 6+ символов' });
    if (ip) { const d = await pool.query('SELECT id FROM profiles WHERE reg_ip=$1 LIMIT 1', [ip]); if (d.rows.length) return res.status(403).json({ error: 'С этого IP уже есть анкета.' }); }
    if (dev) { const d = await pool.query('SELECT id FROM profiles WHERE device_id=$1 LIMIT 1', [dev]); if (d.rows.length) return res.status(403).json({ error: 'С этого устройства уже есть анкета.' }); }
    const ex = await pool.query('SELECT id FROM profiles WHERE LOWER(name)=LOWER($1)', [cleanName]);
    if (ex.rows.length) return res.status(400).json({ error: 'Имя занято.' });
    const hash = await bcrypt.hash(password, 10);
    const photo = req.body.photoUrl || (req.file ? `/uploads/${req.file.filename}` : null);
    let inviterId = null;
    if (ref) { const inv = await pool.query('SELECT id FROM profiles WHERE ref_code=$1', [sanitize(ref, 20)]); if (inv.rows.length) inviterId = inv.rows[0].id; }
    const myRef = randomRef();
    const result = await pool.query(`
      INSERT INTO profiles (name, age, bio, contact_type, contact_value, photo, password_hash, vide, reg_ip, device_id, ref_code, invited_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,100,$8,$9,$10,$11) RETURNING *
    `, [cleanName, ageN, cleanBio, cleanCT, cleanContact, photo, hash, ip || null, dev || null, myRef, inviterId]);
    const profile = result.rows[0];
    if (inviterId) {
      const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM profiles WHERE invited_by=$1', [inviterId]);
      if (cnt.rows[0].c === 3) { await pool.query('UPDATE profiles SET vide = vide + 300 WHERE id=$1', [inviterId]); await notify(inviterId, 'ref', '🎉 3 друга пришли по твоей ссылке! +300 🪙', null); }
      else await notify(inviterId, 'ref', '👥 По твоей ссылке зарегистрировался новый юзер', profile.id);
    }
    res.json({ profile: pickProfile(profile), token: makeUserToken(profile.id) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка регистрации' }); }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const cleanName = sanitize(req.body.name, 40);
    if (!cleanName || !req.body.password) return res.status(400).json({ error: 'Введи имя и пароль' });
    const r = await pool.query('SELECT * FROM profiles WHERE LOWER(name)=LOWER($1)', [cleanName]);
    if (!r.rows.length) return res.status(401).json({ error: 'Неверное имя или пароль' });
    const row = r.rows[0];
    if (!row.password_hash) return res.status(401).json({ error: 'У анкеты нет пароля' });
    if (!await bcrypt.compare(req.body.password, row.password_hash)) return res.status(401).json({ error: 'Неверное имя или пароль' });
    await touchSeen(row.id);
    res.json({ profile: pickProfile(row), token: makeUserToken(row.id) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка входа' }); }
});

app.get('/api/me', authUser, async (req, res) => {
  try {
    await touchSeen(req.userId);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    res.json(pickProfile(r.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/change-password', authUser, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль 6+' });
    const r = await pool.query('SELECT password_hash FROM profiles WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    if (!await bcrypt.compare(oldPassword || '', r.rows[0].password_hash)) return res.status(401).json({ error: 'Старый пароль неверный' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, req.userId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, is_premium,
             card_color, card_bg, card_rgb, card_pinned, profile_banner, profile_theme, profile_color, profile_font, nick_style,
             profile_layout, last_seen, show_gifts, created_at,
             (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles ORDER BY card_pinned DESC, created_at DESC
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/profiles/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, is_premium,
             profile_banner, profile_theme, profile_color, profile_font, profile_layout, nick_style, music_url, last_seen, show_gifts, created_at,
             (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles WHERE id=$1
    `, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const profile = r.rows[0];
    if (profile.show_gifts) {
      const g = await pool.query(`SELECT g.*, p.name AS sender_name, p.photo AS sender_photo FROM gifts g JOIN profiles p ON p.id=g.sender_id WHERE g.receiver_id=$1 ORDER BY g.created_at DESC LIMIT 50`, [id]);
      profile.gifts = g.rows;
    } else profile.gifts = [];
    const st = await pool.query('SELECT COUNT(*)::int AS c FROM stories WHERE user_id=$1 AND expires_at > CURRENT_TIMESTAMP', [id]);
    profile.stories_count = st.rows[0].c;
    res.json(profile);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/profiles/:id', authUser, upload.single('photo'), async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свою' });
    const ex = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = ex.rows[0];
    const { name, age, bio, contactType, contactValue, musicUrl } = req.body;
    const cleanName = sanitize(name, 40) || row.name;
    const cleanBio = sanitize(bio, 200);
    const cleanContact = sanitize(contactValue, 60);
    const cleanCT = ['telegram','discord'].includes(contactType) ? contactType : row.contact_type;
    const ageN = parseInt(age) || row.age;
    const cleanMusic = String(musicUrl || '').slice(0, 300);
    if (cleanName.toLowerCase() !== row.name.toLowerCase()) {
      const clash = await pool.query('SELECT id FROM profiles WHERE LOWER(name)=LOWER($1) AND id<>$2', [cleanName, req.userId]);
      if (clash.rows.length) return res.status(400).json({ error: 'Имя занято' });
    }
    const photo = req.body.photoUrl || (req.file ? `/uploads/${req.file.filename}` : row.photo);
    const result = await pool.query(`
      UPDATE profiles SET name=$1, age=$2, bio=$3, contact_type=$4, contact_value=$5, photo=$6, music_url=$7
      WHERE id=$8 RETURNING *
    `, [cleanName, ageN, cleanBio, cleanCT, cleanContact, photo, cleanMusic, req.userId]);
    res.json(pickProfile(result.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/profiles/:id', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свою' });
    await pool.query('DELETE FROM likes WHERE liker_id=$1 OR target_id=$1', [req.userId]);
    await pool.query('DELETE FROM messages WHERE sender_id=$1 OR receiver_id=$1', [req.userId]);
    await pool.query('DELETE FROM gifts WHERE sender_id=$1 OR receiver_id=$1', [req.userId]);
    await pool.query('DELETE FROM comments WHERE author_id=$1 OR target_id=$1', [req.userId]);
    await pool.query('DELETE FROM shame_posts WHERE author_id=$1', [req.userId]);
    for (const t of ['wheel_spins','inventory','market','notifications','stories','daily_bonus']) await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [req.userId]);
    await pool.query('DELETE FROM story_views WHERE user_id=$1', [req.userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [req.userId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/profiles/:id/appearance', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только своё' });
    const { cardColor, cardBg, cardRgb, cardPinned } = req.body;
    const safe = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); if (!s) return ''; return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : null; };
    await pool.query(`UPDATE profiles SET card_color=COALESCE($1,card_color), card_bg=COALESCE($2,card_bg), card_rgb=COALESCE($3,card_rgb), card_pinned=COALESCE($4,card_pinned) WHERE id=$5`,
      [safe(cardColor), safe(cardBg), cardRgb !== undefined ? (cardRgb?1:0) : null, cardPinned !== undefined ? (cardPinned?1:0) : null, req.userId]);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    res.json(pickProfile(r.rows[0]));
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/profiles/:id/profile-style', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свой' });
    const { profileBanner, profileTheme, profileColor, nickStyle, chatBg } = req.body;
    async function checkOwn(key) { if (!key) return true; const o = await pool.query('SELECT id FROM inventory WHERE user_id=$1 AND item_key=$2 LIMIT 1', [req.userId, key]); return o.rows.length > 0; }
    if (profileTheme && !await checkOwn(profileTheme)) return res.status(403).json({ error: 'Тема не куплена' });
    if (nickStyle && !await checkOwn(nickStyle)) return res.status(403).json({ error: 'Стиль не куплен' });
    if (profileColor && !await checkOwn(profileColor)) return res.status(403).json({ error: 'Цвет не куплен' });
    if (chatBg && !await checkOwn(chatBg)) return res.status(403).json({ error: 'Фон чата не куплен' });
    await pool.query(`
      UPDATE profiles SET profile_banner=COALESCE($1,profile_banner), profile_theme=COALESCE($2,profile_theme),
        profile_color=COALESCE($3,profile_color), nick_style=COALESCE($4,nick_style), chat_bg=COALESCE($5,chat_bg)
      WHERE id=$6
    `, [
      profileBanner !== undefined ? String(profileBanner).slice(0, 500) : null,
      profileTheme !== undefined ? String(profileTheme).slice(0, 60) : null,
      profileColor !== undefined ? String(profileColor).slice(0, 60) : null,
      nickStyle !== undefined ? String(nickStyle).slice(0, 60) : null,
      chatBg !== undefined ? String(chatBg).slice(0, 60) : null,
      req.userId
    ]);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    res.json(pickProfile(r.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/profiles/:id/profile-font', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свой' });
    const font = String(req.body.font || '').slice(0, 30);
    await pool.query('UPDATE profiles SET profile_font=$1 WHERE id=$2', [font, req.userId]);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    res.json(pickProfile(r.rows[0]));
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// === РАСКЛАДКА ПРОФИЛЯ ===
app.post('/api/profiles/:id/profile-layout', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свой' });
    const layout = req.body.layout;
    if (typeof layout !== 'object' || layout === null) return res.status(400).json({ error: 'Некорректный layout' });
    const safeLayout = {
      bannerHeight: Math.max(60, Math.min(300, parseInt(layout.bannerHeight) || 180)),
      bannerPosition: ['top', 'center', 'bottom'].includes(layout.bannerPosition) ? layout.bannerPosition : 'center',
      avatarSize: Math.max(60, Math.min(180, parseInt(layout.avatarSize) || 110)),
      avatarPosition: ['left', 'center', 'right'].includes(layout.avatarPosition) ? layout.avatarPosition : 'center',
      avatarBorderColor: /^#[0-9a-fA-F]{3,8}$/.test(layout.avatarBorderColor) ? layout.avatarBorderColor : '',
      avatarBorderWidth: Math.max(0, Math.min(8, parseInt(layout.avatarBorderWidth) || 4)),
      avatarGlow: !!layout.avatarGlow,
      panelColor: /^#[0-9a-fA-F]{3,8}$/.test(layout.panelColor) ? layout.panelColor : '',
      panelOpacity: Math.max(0, Math.min(100, parseInt(layout.panelOpacity) ?? 100)),
      panelRadius: Math.max(0, Math.min(40, parseInt(layout.panelRadius) || 22)),
      textAlign: ['left', 'center', 'right'].includes(layout.textAlign) ? layout.textAlign : 'center',
      elementOrder: Array.isArray(layout.elementOrder)
        ? layout.elementOrder.filter(x => ['bio','contact','music','stories','stats'].includes(x))
        : ['bio','contact','music','stories','stats']
    };
    await pool.query('UPDATE profiles SET profile_layout=$1 WHERE id=$2', [JSON.stringify(safeLayout), req.userId]);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    res.json(pickProfile(r.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/profiles/:id/toggle-gifts', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Только свой' });
    const r = await pool.query('UPDATE profiles SET show_gifts = 1 - show_gifts WHERE id=$1 RETURNING show_gifts', [req.userId]);
    res.json({ show_gifts: r.rows[0].show_gifts });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/like', authUser, actionLimiter, async (req, res) => {
  try {
    const tid = parseInt(req.body.targetId);
    if (!tid || tid === req.userId) return res.status(400).json({ error: 'Некорректно' });
    const ex = await pool.query('SELECT * FROM likes WHERE liker_id=$1 AND target_id=$2', [req.userId, tid]);
    if (ex.rows.length) { await pool.query('DELETE FROM likes WHERE liker_id=$1 AND target_id=$2', [req.userId, tid]); res.json({ liked: false }); }
    else {
      await pool.query('INSERT INTO likes (liker_id, target_id) VALUES ($1,$2)', [req.userId, tid]);
      const me = await pool.query('SELECT name FROM profiles WHERE id=$1', [req.userId]);
      await notify(tid, 'like', `❤️ ${me.rows[0]?.name || 'Кто-то'} лайкнул твою анкету`, req.userId);
      res.json({ liked: true });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/likes/:userId', async (req, res) => { try { const r = await pool.query('SELECT target_id FROM likes WHERE liker_id=$1', [parseInt(req.params.userId)]); res.json(r.rows.map(x => x.target_id)); } catch (err) { res.status(500).json({ error: 'Ошибка' }); } });
app.get('/api/liked-by/:userId', async (req, res) => { try { const r = await pool.query(`SELECT p.id, p.name, p.age, p.bio, p.photo, p.contact_type, p.contact_value FROM profiles p JOIN likes l ON l.liker_id=p.id WHERE l.target_id=$1 ORDER BY l.created_at DESC`, [parseInt(req.params.userId)]); res.json(r.rows); } catch (err) { res.status(500).json({ error: 'Ошибка' }); } });
app.get('/api/mutual/:a/:b', async (req, res) => { try { const a = parseInt(req.params.a), b = parseInt(req.params.b); const r = await pool.query(`SELECT 1 FROM likes WHERE liker_id=$1 AND target_id=$2 UNION SELECT 1 FROM likes WHERE liker_id=$2 AND target_id=$1`, [a, b]); res.json({ mutual: r.rows.length >= 2, any: r.rows.length >= 1 }); } catch (err) { res.status(500).json({ error: 'Ошибка' }); } });

// === ДОСКА ПОЗОРА ===
app.get('/api/shame', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, p.name AS author_name, p.photo AS author_photo, p.profile_font, p.nick_style
      FROM shame_posts s JOIN profiles p ON p.id = s.author_id
      ORDER BY s.created_at DESC LIMIT 100
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/shame', authUser, upload.single('photo'), async (req, res) => {
  try {
    const text = sanitize(req.body.text, 500);
    const target_name = sanitize(req.body.targetName, 60);
    if (!text || text.length < 3) return res.status(400).json({ error: 'Напиши хотя бы пару слов' });
    const photo = req.body.photoUrl || (req.file ? `/uploads/${req.file.filename}` : '');
    const r = await pool.query(`
      INSERT INTO shame_posts (author_id, photo, text, target_name)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.userId, photo, text, target_name]);
    await audit(req.userId, 'shame_post', `id=${r.rows[0].id}`, req);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/shame/:id', authUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await pool.query('SELECT * FROM shame_posts WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Нет' });
    if (r.rows[0].author_id !== req.userId) return res.status(403).json({ error: 'Не твой пост' });
    await pool.query('DELETE FROM shame_posts WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/shame/:id/report', authUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await audit(req.userId, 'shame_report', `post=${id}`, req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/shame/delete/:id', authAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM shame_posts WHERE id=$1', [id]);
    await audit(null, 'admin_shame_delete', `post=${id}`, req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/shame/list', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, p.name AS author_name FROM shame_posts s
      JOIN profiles p ON p.id = s.author_id
      ORDER BY s.created_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/writable/:userId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' });
    const me = req.userId;
    const r = await pool.query(`
      SELECT DISTINCT p.id, p.name, p.age, p.photo, p.profile_theme, p.profile_font, p.nick_style, p.last_seen
      FROM profiles p
      WHERE p.id <> $1
        AND (EXISTS (SELECT 1 FROM likes WHERE liker_id=$1 AND target_id=p.id)
          OR EXISTS (SELECT 1 FROM likes WHERE liker_id=p.id AND target_id=$1))
        AND NOT EXISTS (SELECT 1 FROM messages WHERE (sender_id=$1 AND receiver_id=p.id) OR (sender_id=p.id AND receiver_id=$1))
      ORDER BY p.last_seen DESC NULLS LAST LIMIT 100
    `, [me]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/messages/dialogs/:userId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' });
    const me = req.userId;
    const rows = await pool.query(`SELECT DISTINCT CASE WHEN sender_id=$1 THEN receiver_id ELSE sender_id END AS other_id FROM messages WHERE sender_id=$1 OR receiver_id=$1`, [me]);
    const dialogs = [];
    for (const r of rows.rows) {
      const other = await pool.query('SELECT id, name, age, photo, profile_theme, profile_color, profile_font, nick_style, chat_bg, last_seen FROM profiles WHERE id=$1', [r.other_id]);
      if (!other.rows.length) continue;
      const last = await pool.query(`SELECT * FROM messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY created_at DESC LIMIT 1`, [me, r.other_id]);
      const unread = await pool.query(`SELECT COUNT(*)::int AS c FROM messages WHERE sender_id=$1 AND receiver_id=$2 AND is_read=0`, [r.other_id, me]);
      dialogs.push({ user: other.rows[0], last: last.rows[0] || null, unread: unread.rows[0].c });
    }
    dialogs.sort((a,b) => new Date(b.last ? b.last.created_at : 0) - new Date(a.last ? a.last.created_at : 0));
    res.json(dialogs);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/messages/unread/:userId', authUser, async (req, res) => {
  try { if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только своё' }); const r = await pool.query('SELECT COUNT(*)::int AS c FROM messages WHERE receiver_id=$1 AND is_read=0', [req.userId]); res.json({ count: r.rows[0].c }); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/messages/:userId/:otherId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' });
    const me = req.userId, other = parseInt(req.params.otherId);
    const r = await pool.query(`SELECT * FROM messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY created_at ASC`, [me, other]);
    await pool.query('UPDATE messages SET is_read=1 WHERE sender_id=$1 AND receiver_id=$2 AND is_read=0', [other, me]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/messages', authUser, msgLimiter, async (req, res) => {
  try {
    const rid = parseInt(req.body.receiverId); const cleanText = sanitize(req.body.text, 1000);
    if (!rid || !cleanText || rid === req.userId) return res.status(400).json({ error: 'Пусто' });
    const likeC = await pool.query(`SELECT 1 FROM likes WHERE (liker_id=$1 AND target_id=$2) OR (liker_id=$2 AND target_id=$1) LIMIT 1`, [req.userId, rid]);
    if (!likeC.rows.length) return res.status(403).json({ error: 'Нужен взаимный лайк' });
    const r = await pool.query('INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1,$2,$3) RETURNING *', [req.userId, rid, cleanText]);
    const me = await pool.query('SELECT name FROM profiles WHERE id=$1', [req.userId]);
    await notify(rid, 'message', `💬 Новое сообщение от ${me.rows[0]?.name || 'кого-то'}`, req.userId);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/messages/delete/:id', authUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM messages WHERE id=$1', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Нет' });
    const m = r.rows[0];
    if (m.sender_id !== req.userId) return res.status(403).json({ error: 'Не твоё' });
    if (Date.now() - new Date(m.created_at).getTime() > 5*60*1000) return res.status(400).json({ error: 'Больше 5 минут' });
    await pool.query('DELETE FROM messages WHERE id=$1', [m.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/notifications/:userId', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' });
    const r = await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.userId]);
    const u = await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND is_read=0', [req.userId]);
    res.json({ list: r.rows, unread: u.rows[0].c });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/notifications/read-all', authUser, async (req, res) => {
  try { await pool.query('UPDATE notifications SET is_read=1 WHERE user_id=$1', [req.userId]); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/daily-bonus', authUser, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const p = await pool.query('SELECT last_bonus_date, bonus_streak FROM profiles WHERE id=$1', [req.userId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Нет' });
    const lastDate = p.rows[0].last_bonus_date ? new Date(p.rows[0].last_bonus_date).toISOString().slice(0, 10) : null;
    if (lastDate === today) return res.status(400).json({ error: 'Уже получено сегодня' });
    let streak = p.rows[0].bonus_streak || 0;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (lastDate === yesterday) streak += 1; else streak = 1;
    let amount = 5; if (streak >= 7) amount = 100;
    await pool.query('UPDATE profiles SET vide = vide + $1, bonus_streak = $2, last_bonus_date = $3 WHERE id=$4', [amount, streak, today, req.userId]);
    const r = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
    res.json({ amount, streak, balance: r.rows[0].vide });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/daily-bonus/status', authUser, async (req, res) => {
  try {
    const p = await pool.query('SELECT last_bonus_date, bonus_streak FROM profiles WHERE id=$1', [req.userId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Нет' });
    const today = new Date().toISOString().slice(0, 10);
    const lastDate = p.rows[0].last_bonus_date ? new Date(p.rows[0].last_bonus_date).toISOString().slice(0, 10) : null;
    res.json({ available: lastDate !== today, streak: p.rows[0].bonus_streak || 0 });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/wheel/last/:userId', authUser, async (req, res) => {
  try { if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только своё' }); const r = await pool.query('SELECT result_name, created_at FROM wheel_spins WHERE user_id=$1 ORDER BY id DESC LIMIT 10', [req.userId]); res.json(r.rows); } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/wheel/tape', authUser, async (req, res) => {
  try {
    const tape = [];
    for (let i = 0; i < 60; i++) { const item = WHEEL_POOL[Math.floor(Math.random() * WHEEL_POOL.length)]; tape.push({ name: item.name, icon: item.icon, rarity: item.rarity }); }
    res.json(tape);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/wheel/spin', authUser, actionLimiter, async (req, res) => {
  try {
    const COST = 100;
    const me = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Нет' });
    if ((me.rows[0].vide || 0) < COST) return res.status(400).json({ error: 'Недостаточно вайдиков (нужно 100)' });
    const prize = rollWheel();
    const winnerIndex = 40 + Math.floor(Math.random() * 10);
    const tape = [];
    for (let i = 0; i < 60; i++) {
      if (i === winnerIndex) tape.push({ name: prize.name, icon: prize.icon, rarity: prize.rarity, isWinner: true });
      else { const item = WHEEL_POOL[Math.floor(Math.random() * WHEEL_POOL.length)]; tape.push({ name: item.name, icon: item.icon, rarity: item.rarity }); }
    }
    await pool.query('UPDATE profiles SET vide = vide - $1 WHERE id=$2', [COST, req.userId]);
    await pool.query('INSERT INTO wheel_spins (user_id, result_name, result_photo, result_skin_id) VALUES ($1,$2,$3,$4)',
      [req.userId, prize.name, prize.icon, prize.type === 'skin' ? parseInt(prize.key) : null]);
    if (prize.type === 'skin') await pool.query('INSERT INTO inventory (user_id, item_type, item_key) VALUES ($1,$2,$3)', [req.userId, 'skin', String(prize.key)]);
    else if (prize.type === 'coins') await pool.query('UPDATE profiles SET vide = vide + $1 WHERE id=$2', [1000, req.userId]);
    else if (prize.type === 'premium') {
      if (prize.key === 'forever') await pool.query('UPDATE profiles SET is_premium=1, premium_until=NULL WHERE id=$1', [req.userId]);
      else await pool.query(`UPDATE profiles SET is_premium=1, premium_until=COALESCE(premium_until, CURRENT_TIMESTAMP) + INTERVAL '7 days' WHERE id=$1`, [req.userId]);
    } else if (['theme','nick','color','chatbg'].includes(prize.type)) {
      await pool.query('INSERT INTO inventory (user_id, item_type, item_key) VALUES ($1,$2,$3)', [req.userId, prize.type, String(prize.key)]);
    }
    const nb = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
    await notify(req.userId, 'wheel', `🎰 Ты выбил: ${prize.name}`, null);
    res.json({ tape, winnerIndex, prize, balance: nb.rows[0].vide });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка прокрутки' }); }
});

app.get('/api/inventory/:userId', async (req, res) => {
  try {
    const r = await pool.query('SELECT item_type, item_key, COUNT(*)::int AS count FROM inventory WHERE user_id=$1 GROUP BY item_type, item_key ORDER BY MAX(obtained_at) DESC', [parseInt(req.params.userId)]);
    const items = r.rows.map(x => {
      if (x.item_type === 'skin') { const s = skinById(x.item_key); return s ? { ...s, type: 'skin', key: String(s.id), count: x.count } : null; }
      const all = [...PROFILE_THEMES, ...CHAT_BGS, ...NICKS, ...COLORS, ...BANNERS];
      const found = all.find(a => a.key === x.item_key);
      return found ? { type: x.item_type, key: x.item_key, name: found.name, icon: found.icon || '🎨', rarity: x.item_type === 'theme' ? 'epic' : 'rare', count: x.count } : null;
    }).filter(Boolean);
    res.json(items);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/inventory/owned/:userId', authUser, async (req, res) => {
  try { if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Только свои' }); const r = await pool.query('SELECT DISTINCT item_key FROM inventory WHERE user_id=$1', [req.userId]); res.json(r.rows.map(x => x.item_key)); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/gifts/send', authUser, actionLimiter, async (req, res) => {
  try {
    const rid = parseInt(req.body.receiverId);
    const { itemKey, itemType } = req.body;
    if (!rid || !itemKey || rid === req.userId) return res.status(400).json({ error: 'Некорректно' });
    const it = await pool.query('SELECT id FROM inventory WHERE user_id=$1 AND item_key=$2 AND item_type=$3 LIMIT 1', [req.userId, String(itemKey), String(itemType || 'skin')]);
    if (!it.rows.length) return res.status(400).json({ error: 'У тебя нет этого предмета' });
    await pool.query('DELETE FROM inventory WHERE id=$1', [it.rows[0].id]);
    await pool.query('INSERT INTO gifts (sender_id, receiver_id, item_key, item_type) VALUES ($1,$2,$3,$4)', [req.userId, rid, String(itemKey), String(itemType || 'skin')]);
    await pool.query('INSERT INTO inventory (user_id, item_type, item_key) VALUES ($1,$2,$3)', [rid, String(itemType || 'skin'), String(itemKey)]);
    const me = await pool.query('SELECT name FROM profiles WHERE id=$1', [req.userId]);
    await notify(rid, 'gift', `🎁 ${me.rows[0]?.name || 'Кто-то'} подарил тебе подарок`, req.userId);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка подарка' }); }
});

app.post('/api/stories', authUser, async (req, res) => {
  try {
    const photo = String(req.body.photo || '').slice(0, 500);
    const caption = sanitize(req.body.caption, 200);
    if (!photo) return res.status(400).json({ error: 'Нужно фото' });
    const r = await pool.query('INSERT INTO stories (user_id, photo, caption) VALUES ($1,$2,$3) RETURNING *', [req.userId, photo, caption]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/stories', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, p.name, p.photo AS user_photo,
        (SELECT COUNT(*)::int FROM story_views WHERE story_id=s.id) AS views
      FROM stories s JOIN profiles p ON p.id=s.user_id
      WHERE s.expires_at > CURRENT_TIMESTAMP ORDER BY s.created_at DESC LIMIT 50
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/stories/user/:userId', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, p.name, p.photo AS user_photo,
        (SELECT COUNT(*)::int FROM story_views WHERE story_id=s.id) AS views
      FROM stories s JOIN profiles p ON p.id=s.user_id
      WHERE s.user_id=$1 AND s.expires_at > CURRENT_TIMESTAMP ORDER BY s.created_at DESC
    `, [parseInt(req.params.userId)]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/stories/:id/view', authUser, async (req, res) => {
  try { await pool.query('INSERT INTO story_views (story_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [parseInt(req.params.id), req.userId]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/stories/:id/views', authUser, async (req, res) => {
  try {
    const sid = parseInt(req.params.id);
    const owner = await pool.query('SELECT user_id FROM stories WHERE id=$1', [sid]);
    if (!owner.rows.length || owner.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Не твоя' });
    const r = await pool.query(`SELECT p.id, p.name, p.photo FROM story_views v JOIN profiles p ON p.id=v.user_id WHERE v.story_id=$1`, [sid]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/stories/cleanup', async (req, res) => { try { await pool.query('DELETE FROM stories WHERE expires_at <= CURRENT_TIMESTAMP'); res.json({ ok: true }); } catch { res.json({ ok: true }); } });

app.get('/api/comments/:targetId', async (req, res) => {
  try { const r = await pool.query(`SELECT c.*, p.name, p.photo FROM comments c JOIN profiles p ON p.id=c.author_id WHERE c.target_id=$1 ORDER BY c.created_at DESC`, [parseInt(req.params.targetId)]); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/comments', authUser, actionLimiter, async (req, res) => {
  try {
    const tid = parseInt(req.body.targetId); const cleanText = sanitize(req.body.text, 500);
    if (!tid || !cleanText) return res.status(400).json({ error: 'Пусто' });
    const r = await pool.query('INSERT INTO comments (target_id, author_id, text) VALUES ($1,$2,$3) RETURNING *', [tid, req.userId, cleanText]);
    const me = await pool.query('SELECT name FROM profiles WHERE id=$1', [req.userId]);
    await notify(tid, 'comment', `💬 ${me.rows[0]?.name || 'Кто-то'} оставил комментарий`, req.userId);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/comments/:id', authUser, async (req, res) => {
  try {
    const cid = parseInt(req.params.id);
    const c = await pool.query('SELECT * FROM comments WHERE id=$1', [cid]);
    if (!c.rows.length) return res.status(404).json({ error: 'Нет' });
    if (c.rows[0].author_id !== req.userId && c.rows[0].target_id !== req.userId) return res.status(403).json({ error: 'Нельзя' });
    await pool.query('DELETE FROM comments WHERE id=$1', [cid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/shop', (req, res) => {
  res.json({ banners: BANNERS, nicks: NICKS, colors: COLORS, themes: PROFILE_THEMES, chatbgs: CHAT_BGS });
});
app.post('/api/shop/buy', authUser, actionLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { key, category } = req.body;
    const all = { banners: BANNERS, nicks: NICKS, colors: COLORS, themes: PROFILE_THEMES, chatbgs: CHAT_BGS };
    const list = all[category] || [];
    const item = list.find(x => x.key === key);
    if (!item) return res.status(404).json({ error: 'Не найдено' });
    await client.query('BEGIN');
    const own = await client.query('SELECT id FROM inventory WHERE user_id=$1 AND item_key=$2', [req.userId, key]);
    if (own.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Уже куплено' }); }
    const u = await client.query('SELECT vide FROM profiles WHERE id=$1 FOR UPDATE', [req.userId]);
    if ((u.rows[0].vide || 0) < item.price) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Мало вайдиков' }); }
    await client.query('UPDATE profiles SET vide = vide - $1 WHERE id=$2', [item.price, req.userId]);
    const itemType = category === 'banners' ? 'banner' : category.slice(0,-1);
    await client.query('INSERT INTO inventory (user_id, item_type, item_key) VALUES ($1,$2,$3)', [req.userId, itemType, String(key)]);
    await client.query('COMMIT');
    const nb = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
        res.json({ ok: true, balance: nb.rows[0].vide });
  } catch (err) { await client.query('ROLLBACK').catch(()=>{}); console.error(err); res.status(500).json({ error: 'Ошибка: ' + err.message }); }
  finally { client.release(); }
});

app.get('/api/market', async (req, res) => {
  try { const r = await pool.query(`SELECT m.id, m.item_key, m.item_type, m.price, m.seller_id, m.created_at, p.name AS seller_name FROM market m JOIN profiles p ON p.id=m.seller_id WHERE m.is_sold=0 ORDER BY m.created_at DESC`); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/market/list', authUser, actionLimiter, async (req, res) => {
  try {
    const sid = String(req.body.skinId ?? '').trim();
    const p = parseInt(req.body.price);
    if (!sid || !Number.isFinite(p) || p < 1 || p > 100000) return res.status(400).json({ error: 'Некорректные данные' });
    const it = await pool.query('SELECT id FROM inventory WHERE user_id=$1 AND item_type=$2 AND item_key=$3 LIMIT 1', [req.userId, 'skin', sid]);
    if (!it.rows.length) return res.status(400).json({ error: 'У тебя нет этого скина' });
    await pool.query('DELETE FROM inventory WHERE id=$1', [it.rows[0].id]);
    const r = await pool.query('INSERT INTO market (seller_id, item_type, item_key, price) VALUES ($1,$2,$3,$4) RETURNING *', [req.userId, 'skin', sid, p]);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});
app.post('/api/market/buy', authUser, actionLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parseInt(req.body.lotId);
    if (!lotId) return res.status(400).json({ error: 'Нет lotId' });
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
    await client.query('INSERT INTO inventory (user_id, item_type, item_key) VALUES ($1,$2,$3)', [req.userId, String(l.item_type), String(l.item_key)]);
    await client.query('COMMIT');
    const nb = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
    res.json({ ok: true, balance: nb.rows[0].vide });
  } catch (err) { await client.query('ROLLBACK').catch(()=>{}); console.error(err); res.status(500).json({ error: 'Ошибка' }); }
  finally { client.release(); }
});
app.post('/api/market/cancel', authUser, async (req, res) => {
  try {
    const lotId = parseInt(req.body.lotId);
    const l = await pool.query('SELECT * FROM market WHERE id=$1 AND is_sold=0', [lotId]);
    if (!l.rows.length) return res.status(404).json({ error: 'Нет' });
    if (l.rows[0].seller_id !== req.userId) return res.status(403).json({ error: 'Не твой' });
    await pool.query('DELETE FROM market WHERE id=$1', [lotId]);
    await pool.query('INSERT INTO inventory (user_id, item_type, item_key) VALUES ($1,$2,$3)', [req.userId, String(l.rows[0].item_type), String(l.rows[0].item_key)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/market/my/:userId', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM market WHERE seller_id=$1 AND is_sold=0 ORDER BY created_at DESC', [parseInt(req.params.userId)]); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// === АДМИНКА ===
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try { if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Неверный пароль' }); res.json({ token: makeAdminToken() }); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/users', authAdmin, async (req, res) => {
  try { const r = await pool.query(`SELECT id, name, age, photo, vide, is_admin, is_premium, premium_until, reg_ip, device_id, created_at, (SELECT COUNT(*)::int FROM likes WHERE target_id=profiles.id) AS likes FROM profiles ORDER BY id DESC`); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/give-vide', authAdmin, async (req, res) => {
  try { const amt = parseInt(req.body.amount); if (!amt) return res.status(400).json({ error: 'Нет суммы' }); await pool.query('UPDATE profiles SET vide = GREATEST(0, vide + $1) WHERE id=$2', [amt, req.body.userId]); const r = await pool.query('SELECT id, name, vide FROM profiles WHERE id=$1', [req.body.userId]); res.json(r.rows[0]); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/toggle-premium', authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const e = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!e.rows.length) return res.status(404).json({ error: 'Нет' });
    const nv = e.rows[0].is_premium ? 0 : 1;
    await pool.query('UPDATE profiles SET is_premium=$1, premium_until=NULL WHERE id=$2', [nv, userId]);
    if (!nv) await pool.query(`UPDATE profiles SET card_color='', card_bg='', card_rgb=0, card_pinned=0 WHERE id=$1`, [userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/delete-user', authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    await pool.query('DELETE FROM likes WHERE liker_id=$1 OR target_id=$1', [userId]);
    await pool.query('DELETE FROM messages WHERE sender_id=$1 OR receiver_id=$1', [userId]);
    await pool.query('DELETE FROM gifts WHERE sender_id=$1 OR receiver_id=$1', [userId]);
    await pool.query('DELETE FROM comments WHERE author_id=$1 OR target_id=$1', [userId]);
    await pool.query('DELETE FROM shame_posts WHERE author_id=$1', [userId]);
    for (const t of ['wheel_spins','inventory','market','notifications','stories','daily_bonus']) await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [userId]);
    await pool.query('DELETE FROM story_views WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/reset-password', authAdmin, async (req, res) => {
  try { const { userId, newPassword } = req.body; if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Пароль 6+' }); const hash = await bcrypt.hash(newPassword, 10); await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, userId]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/purge-nopass', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('SELECT id FROM profiles WHERE password_hash IS NULL');
    const ids = t.rows.map(r => r.id);
    if (!ids.length) { await client.query('ROLLBACK'); return res.json({ ok: true, deleted: 0 }); }
    await client.query('DELETE FROM likes WHERE liker_id = ANY($1) OR target_id = ANY($1)', [ids]);
    await client.query('DELETE FROM messages WHERE sender_id = ANY($1) OR receiver_id = ANY($1)', [ids]);
    await client.query('DELETE FROM gifts WHERE sender_id = ANY($1) OR receiver_id = ANY($1)', [ids]);
    await client.query('DELETE FROM comments WHERE author_id = ANY($1) OR target_id = ANY($1)', [ids]);
    await client.query('DELETE FROM shame_posts WHERE author_id = ANY($1)', [ids]);
    for (const tb of ['wheel_spins','inventory','market','notifications','stories','daily_bonus']) await client.query(`DELETE FROM ${tb} WHERE user_id = ANY($1)`, [ids]);
    await client.query('DELETE FROM story_views WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM audit_log WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM profiles WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({ error: 'Ошибка' }); }
  finally { client.release(); }
});
app.post('/api/admin/purge-by-ids', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const ids = (req.body.ids||[]).map(x => parseInt(x)).filter(x => Number.isInteger(x) && x > 0);
    if (!ids.length) return res.status(400).json({ error: 'Нет валидных' });
    await client.query('BEGIN');
    const e = await client.query('SELECT id FROM profiles WHERE id = ANY($1)', [ids]);
    const okIds = e.rows.map(r => r.id);
    if (!okIds.length) { await client.query('ROLLBACK'); return res.json({ ok: true, deleted: 0 }); }
    await client.query('DELETE FROM likes WHERE liker_id = ANY($1) OR target_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM messages WHERE sender_id = ANY($1) OR receiver_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM gifts WHERE sender_id = ANY($1) OR receiver_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM comments WHERE author_id = ANY($1) OR target_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM shame_posts WHERE author_id = ANY($1)', [okIds]);
    for (const tb of ['wheel_spins','inventory','market','notifications','stories','daily_bonus']) await client.query(`DELETE FROM ${tb} WHERE user_id = ANY($1)`, [okIds]);
    await client.query('DELETE FROM story_views WHERE user_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM audit_log WHERE user_id = ANY($1)', [okIds]);
    await client.query('DELETE FROM profiles WHERE id = ANY($1)', [okIds]);
    await client.query('COMMIT');
    res.json({ ok: true, deleted: okIds.length, found: okIds });
  } catch (err) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({ error: 'Ошибка' }); }
  finally { client.release(); }
});
app.post('/api/admin/ban', authAdmin, async (req, res) => {
  try {
    const { userId, banIp, banDevice, reason } = req.body;
    const e = await pool.query('SELECT id, reg_ip, device_id FROM profiles WHERE id=$1', [userId]);
    if (!e.rows.length) return res.status(404).json({ error: 'Нет' });
    const u = e.rows[0];
    if (banIp && u.reg_ip) await pool.query('INSERT INTO bans (ip, reason) VALUES ($1,$2)', [u.reg_ip, (reason || '').slice(0, 200)]);
    if (banDevice && u.device_id) await pool.query('INSERT INTO bans (device_id, reason) VALUES ($1,$2)', [u.device_id, (reason || '').slice(0, 200)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/bans', authAdmin, async (req, res) => { try { const r = await pool.query('SELECT * FROM bans ORDER BY id DESC LIMIT 500'); res.json(r.rows); } catch (err) { res.status(500).json({ error: 'Ошибка' }); } });
app.post('/api/admin/unban', authAdmin, async (req, res) => { try { await pool.query('DELETE FROM bans WHERE id=$1', [req.body.banId]); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: 'Ошибка' }); } });
app.get('/api/admin/log', authAdmin, async (req, res) => { try { const r = await pool.query(`SELECT a.*, p.name AS user_name FROM audit_log a LEFT JOIN profiles p ON p.id=a.user_id ORDER BY a.created_at DESC LIMIT 200`); res.json(r.rows); } catch (err) { res.status(500).json({ error: 'Ошибка' }); } });
app.post('/api/admin/messages/dialogs', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT LEAST(sender_id, receiver_id) AS a, GREATEST(sender_id, receiver_id) AS b, COUNT(*)::int AS total, MAX(created_at) AS last_at FROM messages GROUP BY a, b ORDER BY last_at DESC LIMIT 200`);
    const out = [];
    for (const row of r.rows) {
      const pa = await pool.query('SELECT id, name FROM profiles WHERE id=$1', [row.a]);
      const pb = await pool.query('SELECT id, name FROM profiles WHERE id=$1', [row.b]);
      out.push({ a: pa.rows[0] || { id: row.a, name: 'удалён' }, b: pb.rows[0] || { id: row.b, name: 'удалён' }, total: row.total, last_at: row.last_at });
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/messages/:a/:b', authAdmin, async (req, res) => {
  try {
    const a = parseInt(req.params.a), b = parseInt(req.params.b);
    const r = await pool.query(`SELECT * FROM messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY created_at ASC`, [a, b]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.listen(PORT, () => console.log(`🚀 XIVIVIDE запущен: http://localhost:${PORT}`));
