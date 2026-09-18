const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('❌ НЕТ DATABASE_URL!');
  process.exit(1);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

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
        is_admin INTEGER DEFAULT 0,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vide INTEGER DEFAULT 100;`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin INTEGER DEFAULT 0;`);
    console.log('✅ Таблицы готовы');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}
initDB();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/profiles', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*,
        (SELECT COUNT(*)::int FROM likes WHERE target_id = p.id) AS likes
      FROM profiles p
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

app.post('/api/profiles', upload.single('photo'), async (req, res) => {
  try {
    const { name, age, bio, contactType, contactValue } = req.body;
    if (!name || !age) return res.status(400).json({ error: 'Имя и возраст обязательны' });
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(`
      INSERT INTO profiles (name, age, bio, contact_type, contact_value, photo, vide)
      VALUES ($1, $2, $3, $4, $5, $6, 100)
      RETURNING *
    `, [name.trim(), parseInt(age), (bio || '').trim(),
        contactType || 'telegram', (contactValue || '').trim(), photoPath]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

app.put('/api/profiles/:id', upload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM profiles WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    const { name, age, bio, contactType, contactValue } = req.body;
    const photoPath = req.file ? `/uploads/${req.file.filename}` : row.photo;
    const result = await pool.query(`
      UPDATE profiles
      SET name=$1, age=$2, bio=$3, contact_type=$4, contact_value=$5, photo=$6
      WHERE id=$7 RETURNING *
    `, [(name || row.name).trim(), parseInt(age) || row.age, (bio || '').trim(),
        contactType || row.contact_type, (contactValue || '').trim(), photoPath, id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM profiles WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    if (row.photo) {
      const fp = path.join(__dirname, 'public', row.photo);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await pool.query('DELETE FROM likes WHERE target_id=$1 OR liker_id=$1', [req.params.id]);
    await pool.query('DELETE FROM wheel_spins WHERE user_id=$1', [req.params.id]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.post('/api/like', async (req, res) => {
  try {
    const { likerId, targetId } = req.body;
    if (!likerId || !targetId) return res.status(400).json({ error: 'Нужны likerId и targetId' });
    if (likerId === targetId) return res.status(400).json({ error: 'Нельзя лайкнуть себя' });
    const existing = await pool.query(
      'SELECT * FROM likes WHERE liker_id=$1 AND target_id=$2',
      [likerId, targetId]
    );
    if (existing.rows.length) {
      await pool.query('DELETE FROM likes WHERE liker_id=$1 AND target_id=$2', [likerId, targetId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO likes (liker_id, target_id) VALUES ($1,$2)', [likerId, targetId]);
      res.json({ liked: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка лайка' });
  }
});

app.get('/api/likes/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT target_id FROM likes WHERE liker_id=$1', [req.params.userId]);
    res.json(result.rows.map(r => r.target_id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/liked-by/:userId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.* FROM profiles p
      JOIN likes l ON l.liker_id = p.id
      WHERE l.target_id = $1
      ORDER BY l.created_at DESC
    `, [req.params.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Введи имя' });
    const result = await pool.query('SELECT * FROM profiles WHERE LOWER(name)=LOWER($1)', [name.trim()]);
    if (!result.rows.length) return res.status(404).json({ error: 'Анкета не найдена' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ==================== ВАЙДИКИ / КОЛЕСО ====================
app.get('/api/vide/:userId', async (req, res) => {
  try {
    const r = await pool.query('SELECT vide FROM profiles WHERE id=$1', [req.params.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
    res.json({ vide: r.rows[0].vide || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/wheel/:userId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM wheel_spins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.params.userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

const ALTY = [
  { name: 'Юки',    photo: 'https://i.pravatar.cc/300?img=47' },
  { name: 'Мио',    photo: 'https://i.pravatar.cc/300?img=45' },
  { name: 'Рин',    photo: 'https://i.pravatar.cc/300?img=44' },
  { name: 'Сакура', photo: 'https://i.pravatar.cc/300?img=49' },
  { name: 'Хина',   photo: 'https://i.pravatar.cc/300?img=32' },
  { name: 'Аяка',   photo: 'https://i.pravatar.cc/300?img=26' },
  { name: 'Рэй',    photo: 'https://i.pravatar.cc/300?img=16' },
  { name: 'Нао',    photo: 'https://i.pravatar.cc/300?img=20' },
  { name: 'Кира',   photo: 'https://i.pravatar.cc/300?img=25' },
  { name: 'Лина',   photo: 'https://i.pravatar.cc/300?img=29' },
];

app.post('/api/wheel/spin', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Нужен userId' });
    const me = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Анкета не найдена' });
    const COST = 10;
    const balance = me.rows[0].vide || 0;
    if (balance < COST) return res.status(400).json({ error: 'Недостаточно вайдиков' });
    const pick = ALTY[Math.floor(Math.random() * ALTY.length)];
    await pool.query('UPDATE profiles SET vide = vide - $1 WHERE id = $2', [COST, userId]);
    const spin = await pool.query(`
      INSERT INTO wheel_spins (user_id, result_name, result_photo)
      VALUES ($1, $2, $3) RETURNING *
    `, [userId, pick.name, pick.photo]);
    res.json({ spin: spin.rows[0], balance: balance - COST });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка прокрутки' });
  }
});

// ==================== АДМИНКА ====================
function checkAdmin(password) {
  return password === ADMIN_PASSWORD;
}

app.post('/api/admin/users', async (req, res) => {
  try {
    const { password } = req.body;
    if (!checkAdmin(password)) return res.status(403).json({ error: 'Неверный пароль' });
    const result = await pool.query(`
      SELECT id, name, age, photo, vide, is_admin, created_at,
        (SELECT COUNT(*)::int FROM likes WHERE target_id = profiles.id) AS likes
      FROM profiles ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/give-vide', async (req, res) => {
  try {
    const { password, userId, amount } = req.body;
    if (!checkAdmin(password)) return res.status(403).json({ error: 'Неверный пароль' });
    const amt = parseInt(amount);
    if (!amt) return res.status(400).json({ error: 'Сумма не указана' });
    await pool.query('UPDATE profiles SET vide = GREATEST(0, vide + $1) WHERE id = $2', [amt, userId]);
    const r = await pool.query('SELECT id, name, vide FROM profiles WHERE id=$1', [userId]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { password, userId } = req.body;
    if (!checkAdmin(password)) return res.status(403).json({ error: 'Неверный пароль' });
    const existing = await pool.query('SELECT * FROM profiles WHERE id=$1', [userId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Не найдено' });
    const row = existing.rows[0];
    if (row.photo) {
      const fp = path.join(__dirname, 'public', row.photo);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await pool.query('DELETE FROM likes WHERE target_id=$1 OR liker_id=$1', [userId]);
    await pool.query('DELETE FROM wheel_spins WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM profiles WHERE id=$1', [userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 XIVIVIDE запущен: http://localhost:${PORT}`);
});
