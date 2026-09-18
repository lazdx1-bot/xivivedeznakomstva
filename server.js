const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Папка для фото ---
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- База данных ---
const db = new Database(path.join(__dirname, 'database.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    bio TEXT DEFAULT '',
    contact_type TEXT DEFAULT 'telegram',
    contact_value TEXT DEFAULT '',
    photo TEXT,
    likes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    liker_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(liker_id, target_id)
  );
`);

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Загрузка фото ---
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

// ==================== API ====================

// Все анкеты (со счётчиком лайков)
app.get('/api/profiles', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, 
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id) AS likes
    FROM profiles p
    ORDER BY p.created_at DESC
  `).all();
  res.json(rows);
});

// Создать анкету
app.post('/api/profiles', upload.single('photo'), (req, res) => {
  try {
    const { name, age, bio, contactType, contactValue } = req.body;
    if (!name || !age) return res.status(400).json({ error: 'Имя и возраст обязательны' });

    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    const info = db.prepare(`
      INSERT INTO profiles (name, age, bio, contact_type, contact_value, photo)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      parseInt(age),
      (bio || '').trim(),
      contactType || 'telegram',
      (contactValue || '').trim(),
      photoPath
    );

    const created = db.prepare('SELECT * FROM profiles WHERE id = ?').get(info.lastInsertRowid);
    res.json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// Обновить анкету (только bio/имя/возраст/контакт — фото можно не менять)
app.put('/api/profiles/:id', upload.single('photo'), (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Не найдено' });

    const { name, age, bio, contactType, contactValue } = req.body;
    const photoPath = req.file ? `/uploads/${req.file.filename}` : row.photo;

    db.prepare(`
      UPDATE profiles
      SET name = ?, age = ?, bio = ?, contact_type = ?, contact_value = ?, photo = ?
      WHERE id = ?
    `).run(
      (name || row.name).trim(),
      parseInt(age) || row.age,
      (bio || '').trim(),
      contactType || row.contact_type,
      (contactValue || '').trim(),
      photoPath,
      id
    );

    const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

// Удалить анкету
app.delete('/api/profiles/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });

  if (row.photo) {
    const filePath = path.join(__dirname, 'public', row.photo);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM likes WHERE target_id = ? OR liker_id = ?').run(req.params.id, req.params.id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Поставить/снять лайк
app.post('/api/like', (req, res) => {
  try {
    const { likerId, targetId } = req.body;
    if (!likerId || !targetId) return res.status(400).json({ error: 'Нужны likerId и targetId' });
    if (likerId === targetId) return res.status(400).json({ error: 'Нельзя лайкнуть себя' });

    const existing = db.prepare(
      'SELECT * FROM likes WHERE liker_id = ? AND target_id = ?'
    ).get(likerId, targetId);

    if (existing) {
      db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
      res.json({ liked: false });
    } else {
      db.prepare('INSERT INTO likes (liker_id, target_id) VALUES (?, ?)').run(likerId, targetId);
      res.json({ liked: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка лайка' });
  }
});

// Кого лайкнул конкретный пользователь (список id)
app.get('/api/likes/:userId', (req, res) => {
  const rows = db.prepare('SELECT target_id FROM likes WHERE liker_id = ?').all(req.params.userId);
  res.json(rows.map(r => r.target_id));
});

// Кто лайкнул конкретного пользователя (полные анкеты)
app.get('/api/liked-by/:userId', (req, res) => {
  const rows = db.prepare(`
    SELECT p.* FROM profiles p
    JOIN likes l ON l.liker_id = p.id
    WHERE l.target_id = ?
    ORDER BY l.created_at DESC
  `).all(req.params.userId);
  res.json(rows);
});

// Восстановить вход по имени (простой логин)
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Введи имя' });
  const row = db.prepare('SELECT * FROM profiles WHERE LOWER(name) = LOWER(?)').get(name.trim());
  if (!row) return res.status(404).json({ error: 'Анкета не найдена' });
  res.json(row);
});

// ==================== Запуск ====================
app.listen(PORT, () => {
  console.log(`XIVIVIDE запущен: http://localhost:${PORT}`);
});