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

if (!process.env.DATABASE_URL) {
  console.error('❌ НЕТ DATABASE_URL!');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('❌ НЕТ JWT_SECRET! Добавь переменную окружения.');
  process.exit(1);
}

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
        is_admin INTEGER DEFAULT 0,
        is_premium INTEGER DEFAULT 0,
        card_color TEXT DEFAULT '',
        card_bg TEXT DEFAULT '',
        card_rgb INTEGER DEFAULT 0,
        card_pinned INTEGER DEFAULT 0,
        theme_web INTEGER DEFAULT 0,
        theme_glass INTEGER DEFAULT 0,
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
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vide INTEGER DEFAULT 100;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_premium INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS card_color TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS card_bg TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS card_rgb INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS card_pinned INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS theme_web INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS theme_glass INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
    console.log('✅ Таблицы готовы');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}
initDB();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Слишком много попыток входа. Попробуй через 15 минут.' },
  standardHeaders: true, legacyHeaders: false
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Слишком много регистраций с этого IP. Попробуй позже.' }
});
const actionLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  message: { error: 'Слишком много действий. Подожди минуту.' }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `photo_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|webp|gif/.test(file.mimetype);
    cb(ok ? null : new Error('Только изображения'), ok);
  }
});

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
  for (const r of ['legendary', 'epic', 'rare', 'common']) {
    acc += RARITY_CHANCE[r];
    if (roll < acc) { picked = r; break; }
  }
  const pool = SKINS.filter(s => s.rarity === picked);
  return pool[Math.floor(Math.random() * pool.length)] || SKINS[0];
}
function skinById(id) { return SKINS.find(s => s.id === parseInt(id)); }

function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}
function makeUserToken(profileId) {
  return jwt.sign({ uid: profileId, type: 'user' }, JWT_SECRET, { expiresIn: '30d' });
}
function makeAdminToken() {
  return jwt.sign({ type: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '12h' });
}
function authUser(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нужна авторизация' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'user') throw new Error('bad type');
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Сессия истекла. Войди заново.' });
  }
}
function authAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нужна авторизация админа' });
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload.type !== 'admin') throw new Error('bad type');
    next();
  } catch {
    return res.status(401).json({ error: 'Сессия админа истекла' });
  }
}
async function audit(userId, action, details, req) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 64);
    await pool.query(
      'INSERT INTO audit_log (user_id, action, details, ip) VALUES ($1, $2, $3, $4)',
      [userId || null, action, (details || '').slice(0, 500), ip]
    );
  } catch {}
}

// ==================== РЕГИСТРАЦИЯ / ВХОД ====================
app.post('/api/register', registerLimiter, upload.single('photo'), async (req, res) => {
  try {
    const { name, age, bio, contactType, contactValue, password } = req.body;
    const cleanName = sanitize(name, 40);
    const cleanBio = sanitize(bio, 200);
    const cleanContact = sanitize(contactValue, 60);
    const cleanContactType = ['telegram', 'discord'].includes(contactType) ? contactType : 'telegram';
    const ageNum = parseInt(age);

    if (!cleanName || cleanName.length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
    if (!ageNum || ageNum < 16 || ageNum > 99) return res.status(400).json({ error: 'Возраст 16–99' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const exist = await pool.query('SELECT id FROM profiles WHERE LOWER(name)=LOWER($1)', [cleanName]);
    if (exist.rows.length) return res.status(400).json({ error: 'Имя занято. Выбери другое.' });

    const hash = await bcrypt.hash(password, 10);
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(`
      INSERT INTO profiles (name, age, bio, contact_type, contact_value, photo, password_hash, vide)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 100)
      RETURNING id, name, age, bio, contact_type, contact_value, photo, vide, is_premium,
                card_color, card_bg, card_rgb, card_pinned, theme_web, theme_glass, created_at
    `, [cleanName, ageNum, cleanBio, cleanContactType, cleanContact, photoPath, hash]);

    const profile = result.rows[0];
    const token = makeUserToken(profile.id);
    await audit(profile.id, 'register', `name=${cleanName}`, req);
    res.json({ profile, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { name, password } = req.body;
    const cleanName = sanitize(name, 40);
    if (!cleanName || !password) return res.status(400).json({ error: 'Введи имя и пароль' });

    const result = await pool.query('SELECT * FROM profiles WHERE LOWER(name)=LOWER($1)', [cleanName]);
    if (!result.rows.length) {
      await audit(null, 'login_fail', `name=${cleanName} (not found)`, req);
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }
    const row = result.rows[0];
    if (!row.password_hash) {
      return res.status(401).json({ error: 'У этой анкеты нет пароля. Обратись к админу.' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      await audit(row.id, 'login_fail', `name=${cleanName} (wrong pw)`, req);
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }
    const token = makeUserToken(row.id);
    const profile = {
      id: row.id, name: row.name, age: row.age, bio: row.bio,
      contact_type: row.contact_type, contact_value: row.contact_value,
      photo: row.photo, vide: row.vide, is_premium: row.is_premium,
      card_color: row.card_color, card_bg: row.card_bg, card_rgb: row.card_rgb,
      card_pinned: row.card_pinned, theme_web: row.theme_web, theme_glass: row.theme_glass,
      created_at: row.created_at
    };
    await audit(row.id, 'login_ok', `name=${cleanName}`, req);
    res.json({ profile, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.get('/api/me', authUser, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, vide, is_premium,
             card_color, card_bg, card_rgb, card_pinned, theme_web, theme_glass, created_at
      FROM profiles WHERE id=$1
    `, [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Профиль не найден' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/change-password', authUser, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
    }
    const r = await pool.query('SELECT password_hash FROM profiles WHERE id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const ok = await bcrypt.compare(oldPassword || '', r.rows[0].password_hash);
    if (!ok) {
      await audit(req.userId, 'change_pw_fail', '', req);
      return res.status(401).json({ error: 'Старый пароль неверный' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, req.userId]);
    await audit(req.userId, 'change_pw_ok', '', req);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ==================== ПРОФИЛИ ====================
app.get('/api/profiles', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, is_premium,
             card_color, card_bg, card_rgb, card_pinned, created_at,
             (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles
      ORDER BY card_pinned DESC, created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.put('/api/profiles/:id', authUser, upload.single('photo'), async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) {
      await audit(req.userId, 'edit_foreign_attempt', `target=${req.params.id}`, req);
      return res.status(403).json({ error: 'Можно редактировать только свою анкету' });
    }
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
      UPDATE profiles
      SET name=$1, age=$2, bio=$3, contact_type=$4, contact_value=$5, photo=$6
      WHERE id=$7
      RETURNING id, name, age, bio, contact_type, contact_value, photo, vide, is_premium,
                card_color, card_bg, card_rgb, card_pinned, theme_web, theme_glass, created_at
    `, [cleanName, ageNum, cleanBio, cleanContactType, cleanContact, photoPath, req.userId]);
    await audit(req.userId, 'edit_profile', '', req);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

app.delete('/api/profiles/:id', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) {
      await audit(req.userId, 'delete_foreign_attempt', `target=${req.params.id}`, req);
      return res.status(403).json({ error: 'Можно удалить только свою анкету' });
    }
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    if (row.photo) {
      const fp = path.join(__dirname, 'public', row.photo);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await pool.query('DELETE FROM likes WHERE target_id=$1 OR liker_id=$1', [req.userId]);
    await pool.query('DELETE FROM wheel_spins WHERE user_id=$1', [req.userId]);
    await pool.query('DELETE FROM inventory WHERE user_id=$1', [req.userId]);
    await pool.query('DELETE FROM market WHERE seller_id=$1 OR buyer_id=$1', [req.userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [req.userId]);
    await audit(null, 'delete_own', `id=${req.userId}`, req);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.post('/api/profiles/:id/appearance', authUser, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) {
      return res.status(403).json({ error: 'Только своё' });
    }
    const { cardColor, cardBg, cardRgb, cardPinned, themeWeb, themeGlass } = req.body;
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [req.userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    if (!existing.rows[0].is_premium) return res.status(403).json({ error: 'Только для Premium' });

    const safeColor = (v) => {
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      if (!s) return '';
      return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : null;
    };

    await pool.query(`
      UPDATE profiles
      SET card_color  = COALESCE($1, card_color),
          card_bg     = COALESCE($2, card_bg),
          card_rgb    = COALESCE($3, card_rgb),
          card_pinned = COALESCE($4, card_pinned),
          theme_web   = COALESCE($5, theme_web),
          theme_glass = COALESCE($6, theme_glass)
      WHERE id = $7
    `, [
      safeColor(cardColor),
      safeColor(cardBg),
      cardRgb !== undefined ? (cardRgb ? 1 : 0) : null,
      cardPinned !== undefined ? (cardPinned ? 1 : 0) : null,
      themeWeb !== undefined ? (themeWeb ? 1 : 0) : null,
      themeGlass !== undefined ? (themeGlass ? 1 : 0) : null,
      req.userId
    ]);
    await audit(req.userId, 'appearance', '', req);
    const r = await pool.query(`
      SELECT id, name, age, bio, contact_type, contact_value, photo, vide, is_premium,
             card_color, card_bg, card_rgb, card_pinned, theme_web, theme_glass, created_at
      FROM profiles WHERE id=$1
    `, [req.userId]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ==================== ЛАЙКИ ====================
app.post('/api/like', authUser, actionLimiter, async (req, res) => {
  try {
    const targetId = parseInt(req.body.targetId);
    if (!targetId) return res.status(400).json({ error: 'Нужен targetId' });
    if (targetId === req.userId) return res.status(400).json({ error: 'Нельзя лайкнуть себя' });

    const existing = await pool.query(
      'SELECT * FROM likes WHERE liker_id=$1 AND target_id=$2',
      [req.userId, targetId]
    );
    if (existing.rows.length) {
      await pool.query('DELETE FROM likes WHERE liker_id=$1 AND target_id=$2', [req.userId, targetId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO likes (liker_id, target_id) VALUES ($1,$2)', [req.userId, targetId]);
      res.json({ liked: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка лайка' });
  }
});

app.get('/api/likes/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT target_id FROM likes WHERE liker_id=$1', [parseInt(req.params.userId)]);
    res.json(result.rows.map(r => r.target_id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/liked-by/:userId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.age, p.bio, p.photo, p.contact_type, p.contact_value
      FROM profiles p
      JOIN likes l ON l.liker_id = p.id
      WHERE l.target_id = $1
      ORDER BY l.created_at DESC
    `, [parseInt(req.params.userId)]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ==================== ВАЙДИКИ / КОЛЕСО ====================
app.get('/api/vide/:userId', async (req, res) => {
  try {
    const r = await pool.query('SELECT vide FROM profiles WHERE id=$1', [parseInt(req.params.userId)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    res.json({ vide: r.rows[0].vide || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
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
    const spin = await pool.query(`
      INSERT INTO wheel_spins (user_id, result_name, result_photo, result_skin_id)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.userId, skin.name, skin.photo, skin.id]);
    await pool.query(`INSERT INTO inventory (user_id, skin_id) VALUES ($1, $2)`, [req.userId, skin.id]);

    res.json({ spin: spin.rows[0], skin, balance: balance - COST });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка прокрутки' });
  }
});

// ==================== ИНВЕНТАРЬ ====================
app.get('/api/inventory/:userId', async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT skin_id FROM inventory WHERE user_id=$1 ORDER BY obtained_at DESC',
      [parseInt(req.params.userId)]
    );
    const counts = {};
    rows.rows.forEach(r => { counts[r.skin_id] = (counts[r.skin_id] || 0) + 1; });
    const items = Object.entries(counts).map(([skinId, count]) => {
      const skin = SKINS.find(s => s.id === parseInt(skinId));
      return skin ? { ...skin, count } : null;
    }).filter(Boolean);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/skins', (req, res) => { res.json(SKINS); });

// ==================== РЫНОК ====================
app.get('/api/market', async (req, res) => {
  try {
    const rows = await pool.query(`
      SELECT m.id, m.skin_id, m.price, m.seller_id, m.created_at,
             p.name AS seller_name, p.photo AS seller_photo
      FROM market m
      JOIN profiles p ON p.id = m.seller_id
      WHERE m.is_sold = 0
      ORDER BY m.created_at DESC
    `);
    res.json(rows.rows.map(r => ({ ...r, skin: skinById(r.skin_id) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка рынка' });
  }
});

app.post('/api/market/list', authUser, actionLimiter, async (req, res) => {
  try {
    const skinId = parseInt(req.body.skinId);
    const price = parseInt(req.body.price);
    if (isNaN(skinId) || !price || price < 1 || price > 100000) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
    const inv = await pool.query(
      'SELECT id FROM inventory WHERE user_id=$1 AND skin_id=$2 LIMIT 1',
      [req.userId, skinId]
    );
    if (!inv.rows.length) return res.status(400).json({ error: 'У тебя нет этого скина' });

    await pool.query('DELETE FROM inventory WHERE id=$1', [inv.rows[0].id]);
    const r = await pool.query(
      'INSERT INTO market (seller_id, skin_id, price) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, skinId, price]
    );
    await audit(req.userId, 'market_list', `skin=${skinId} price=${price}`, req);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка выставления' });
  }
});

app.post('/api/market/buy', authUser, actionLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parseInt(req.body.lotId);
    if (!lotId) return res.status(400).json({ error: 'Нужен lotId' });

    await client.query('BEGIN');
    const lotRes = await client.query('SELECT * FROM market WHERE id=$1 AND is_sold=0 FOR UPDATE', [lotId]);
    if (!lotRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Лот уже продан' });
    }
    const lot = lotRes.rows[0];
    if (lot.seller_id === req.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Нельзя купить свой лот' });
    }
    const buyer = await client.query('SELECT vide FROM profiles WHERE id=$1 FOR UPDATE', [req.userId]);
    if ((buyer.rows[0].vide || 0) < lot.price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Недостаточно вайдиков' });
    }
    await client.query('UPDATE profiles SET vide = vide - $1 WHERE id=$2', [lot.price, req.userId]);
    await client.query('UPDATE profiles SET vide = vide + $1 WHERE id=$2', [lot.price, lot.seller_id]);
    await client.query('UPDATE market SET is_sold=1, buyer_id=$1 WHERE id=$2', [req.userId, lotId]);
    await client.query('INSERT INTO inventory (user_id, skin_id) VALUES ($1, $2)', [req.userId, lot.skin_id]);
    await client.query('COMMIT');

    await audit(req.userId, 'market_buy', `lot=${lotId} price=${lot.price}`, req);
    const nb = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.userId]);
    res.json({ ok: true, balance: nb.rows[0].vide });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Ошибка покупки' });
  } finally {
    client.release();
  }
});

app.post('/api/market/cancel', authUser, async (req, res) => {
  try {
    const lotId = parseInt(req.body.lotId);
    if (!lotId) return res.status(400).json({ error: 'Нужен lotId' });
    const lot = await pool.query('SELECT * FROM market WHERE id=$1 AND is_sold=0', [lotId]);
    if (!lot.rows.length) return res.status(404).json({ error: 'Лот не найден' });
    if (lot.rows[0].seller_id !== req.userId) return res.status(403).json({ error: 'Не твой лот' });

    await pool.query('DELETE FROM market WHERE id=$1', [lotId]);
    await pool.query('INSERT INTO inventory (user_id, skin_id) VALUES ($1, $2)', [req.userId, lot.rows[0].skin_id]);
    await audit(req.userId, 'market_cancel', `lot=${lotId}`, req);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/market/my/:userId', async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT * FROM market WHERE seller_id=$1 AND is_sold=0 ORDER BY created_at DESC',
      [parseInt(req.params.userId)]
    );
    res.json(rows.rows.map(r => ({ ...r, skin: skinById(r.skin_id) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ==================== АДМИНКА ====================
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      await audit(null, 'admin_login_fail', '', req);
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    const token = makeAdminToken();
    await audit(null, 'admin_login_ok', '', req);
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, age, photo, vide, is_admin, is_premium, card_color, card_bg, card_rgb, card_pinned,
        theme_web, theme_glass, created_at,
        (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/give-vide', authAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const amt = parseInt(amount);
    if (!amt) return res.status(400).json({ error: 'Сумма не указана' });
    await pool.query('UPDATE profiles SET vide = GREATEST(0, vide + $1) WHERE id = $2', [amt, userId]);
    await audit(null, 'admin_give_vide', `user=${userId} amount=${amt}`, req);
    const r = await pool.query('SELECT id, name, vide FROM profiles WHERE id=$1', [userId]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/toggle-premium', authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const newVal = existing.rows[0].is_premium ? 0 : 1;
    await pool.query('UPDATE profiles SET is_premium=$1 WHERE id=$2', [newVal, userId]);
    if (!newVal) {
      await pool.query(`UPDATE profiles SET card_color='', card_bg='', card_rgb=0, card_pinned=0, theme_web=0, theme_glass=0 WHERE id=$1`, [userId]);
    }
    await audit(null, 'admin_toggle_premium', `user=${userId} to=${newVal}`, req);
    const r = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/delete-user', authAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    if (row.photo) {
      const fp = path.join(__dirname, 'public', row.photo);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await pool.query('DELETE FROM likes WHERE target_id=$1 OR liker_id=$1', [userId]);
    await pool.query('DELETE FROM wheel_spins WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM inventory WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM market WHERE seller_id=$1 OR buyer_id=$1', [userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [userId]);
    await audit(null, 'admin_delete_user', `user=${userId}`, req);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.post('/api/admin/reset-password', authAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, userId]);
    await audit(null, 'admin_reset_pw', `user=${userId}`, req);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/purge-nopass', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targets = await client.query('SELECT id FROM profiles WHERE password_hash IS NULL');
    const ids = targets.rows.map(r => r.id);
    if (!ids.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, deleted: 0 });
    }
    await client.query('DELETE FROM likes WHERE liker_id = ANY($1) OR target_id = ANY($1)', [ids]);
    await client.query('DELETE FROM wheel_spins WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM inventory WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM market WHERE seller_id = ANY($1) OR buyer_id = ANY($1)', [ids]);
    await client.query('DELETE FROM audit_log WHERE user_id = ANY($1)', [ids]);
    await client.query('DELETE FROM profiles WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    await audit(null, 'admin_purge_nopass', `deleted=${ids.length}`, req);
    res.json({ ok: true, deleted: ids.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Ошибка очистки' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/log', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, p.name AS user_name
      FROM audit_log a
      LEFT JOIN profiles p ON p.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 XIVIVIDE запущен: http://localhost:${PORT}`);
});
