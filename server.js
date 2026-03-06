const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 25 * 1024 * 1024 // 25MB
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Хранение онлайн пользователей и комнат в памяти
const users = new Map();   // socketId -> { name, color, room }
const rooms = new Map();   // roomName -> Set of socketIds

const DEFAULT_ROOMS = ['Общий', 'Рабочий', 'Случайный'];
DEFAULT_ROOMS.forEach(r => rooms.set(r, new Set()));

// Цвета для аватаров
const COLORS = ['#25D366','#2196F3','#FF9800','#E91E63','#9C27B0','#00BCD4','#FF5722','#607D8B'];
function getColor(name) {
  let hash = 0;
  for (let c of name) hash = (hash << 5) - hash + c.charCodeAt(0);
  return COLORS[Math.abs(hash) % COLORS.length];
}

// Шифрование AES-256 на сервере (сервер не хранит ключ — только транзит)
const SERVER_KEY = crypto.randomBytes(32); // новый ключ каждый запуск
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', SERVER_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}
function decrypt(data) {
  try {
    const [ivHex, enc] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', SERVER_KEY, iv);
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch { return data; }
}

// Multer для файлов до 20MB
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Запрет исполняемых файлов
    const blocked = ['.exe', '.bat', '.cmd', '.sh', '.ps1'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) return cb(new Error('Файл запрещён'));
    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Загрузка файла
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// Socket.IO
io.on('connection', (socket) => {

  // Войти в чат
  socket.on('join', ({ name, room }) => {
    if (!name || name.length > 32) return;
    const cleanName = name.trim().replace(/[<>]/g, '');
    const cleanRoom = DEFAULT_ROOMS.includes(room) ? room : DEFAULT_ROOMS[0];

    users.set(socket.id, {
      name: cleanName,
      color: getColor(cleanName),
      room: cleanRoom
    });

    socket.join(cleanRoom);
    if (rooms.has(cleanRoom)) rooms.get(cleanRoom).add(socket.id);

    // Сообщить всем в комнате
    socket.to(cleanRoom).emit('system', {
      text: `${cleanName} вошёл в чат`
    });

    // Отправить список комнат и онлайн
    socket.emit('rooms', getRoomList());
    io.emit('online_count', getOnlineCount());
  });

  // Сменить комнату
  socket.on('change_room', (newRoom) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (!DEFAULT_ROOMS.includes(newRoom)) return;

    const oldRoom = user.room;
    socket.leave(oldRoom);
    if (rooms.has(oldRoom)) rooms.get(oldRoom).delete(socket.id);

    socket.to(oldRoom).emit('system', { text: `${user.name} покинул комнату` });

    user.room = newRoom;
    socket.join(newRoom);
    if (rooms.has(newRoom)) rooms.get(newRoom).add(socket.id);

    socket.to(newRoom).emit('system', { text: `${user.name} вошёл в комнату` });
    socket.emit('rooms', getRoomList());
  });

  // Текстовое сообщение
  socket.on('message', ({ text, room }) => {
    const user = users.get(socket.id);
    if (!user || !text || text.length > 4000) return;

    const clean = text.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const encrypted = encrypt(clean);

    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      type: 'text',
      name: user.name,
      color: user.color,
      text: encrypted,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    };

    io.to(user.room).emit('message', msg);
  });

  // Файл/фото
  socket.on('file_message', ({ url, name, size, mimetype, room }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const isImage = mimetype && mimetype.startsWith('image/');
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      type: isImage ? 'image' : 'file',
      name: user.name,
      color: user.color,
      url,
      fileName: name,
      fileSize: formatSize(size),
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    };

    io.to(user.room).emit('message', msg);
  });

  // Печатает...
  socket.on('typing', () => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit('typing', { name: user.name });
  });
  socket.on('stop_typing', () => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit('stop_typing', { name: user.name });
  });

  // Отключение
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.room).emit('system', { text: `${user.name} вышел` });
      if (rooms.has(user.room)) rooms.get(user.room).delete(socket.id);
      users.delete(socket.id);
      io.emit('online_count', getOnlineCount());
    }
  });
});

function getRoomList() {
  return DEFAULT_ROOMS.map(r => ({
    name: r,
    count: rooms.has(r) ? rooms.get(r).size : 0
  }));
}

function getOnlineCount() {
  return users.size;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

// Удаление старых файлов каждые 24ч
setInterval(() => {
  const files = fs.readdirSync(UPLOAD_DIR);
  const now = Date.now();
  files.forEach(f => {
    const fpath = path.join(UPLOAD_DIR, f);
    const stat = fs.statSync(fpath);
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(fpath);
    }
  });
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
