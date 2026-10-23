require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000; 
const JWT_SECRET = process.env.JWT_SECRET || 'SECRET_KEY';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'eduvos_marketplace',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};
if (process.env.DB_SSL === 'true') dbConfig.ssl = { rejectUnauthorized: false };

const dbPromise = mysql.createPool(dbConfig).promise();

// --- AUTH ---
app.post('/api/signup', async (req, res) => {
    const { firstName, lastName, email, password, gender, role, location } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'Seller' ? 'seller' : 'student';
        await dbPromise.query(
            "INSERT INTO users (first_name, last_name, email, password, gender, role, location) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [firstName, lastName, email, hashedPassword, gender, userRole, location || 'Pretoria']
        );
        res.status(201).json({ message: "User created successfully" });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [results] = await dbPromise.query("SELECT * FROM users WHERE email = ?", [email]);
        if (results.length === 0) return res.status(401).json({ message: "No account found." });
        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ token, userId: user.id, firstName: user.first_name, role: user.role });
        } else { res.status(401).json({ message: "Incorrect password." }); }
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// --- USERS & PROFILES ---
app.get('/api/users/role/:role', async (req, res) => {
    const role = req.params.role === 'seller' ? 'seller' : 'student';
    const [results] = await dbPromise.query("SELECT id, first_name, last_name, role, profile_pic FROM users WHERE role = ?", [role]);
    res.json(results);
});

app.get('/api/user/:id', async (req, res) => {
    const [results] = await dbPromise.query("SELECT id, first_name, last_name, role, bio, location, profile_pic FROM users WHERE id = ?", [req.params.id]);
    res.json(results[0] || {});
});

app.put('/api/user/:id', upload.single('profile_pic'), async (req, res) => {
    const { bio, location } = req.body;
    let query = "UPDATE users SET bio = ?, location = ? WHERE id = ?";
    let params = [bio, location, req.params.id];
    if (req.file) {
        query = "UPDATE users SET bio = ?, location = ?, profile_pic = ? WHERE id = ?";
        params = [bio, location, `/uploads/${req.file.filename}`, req.params.id];
    }
    await dbPromise.query(query, params);
    res.json({ success: true });
});

// --- PRODUCTS ---
app.get('/api/products', async (req, res) => {
    const [results] = await dbPromise.query(`
        SELECT p.*, c.name as cat, u.first_name, u.last_name FROM products p JOIN categories c ON p.category_id = c.id JOIN users u ON p.seller_id = u.id ORDER BY p.created_at DESC
    `);
    res.json(results);
});

app.post('/api/products', upload.single('image'), async (req, res) => {
    const { seller_id, title, category_id, price, stock, location, description, delivery_fee } = req.body;
    const img_url = req.file ? `/uploads/${req.file.filename}` : 'https://images.unsplash.com/photo-1523275335684-37898b6baf30';
    try {
        await dbPromise.query(
            "INSERT INTO products (seller_id, category_id, title, price, stock, location, description, delivery_fee, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [seller_id, category_id, title, price, stock, location, description, delivery_fee || 0, img_url]
        );
        const [buyers] = await dbPromise.query("SELECT id FROM users WHERE role = 'student'");
        for (let buyer of buyers) {
            await dbPromise.query("INSERT INTO notifications (user_id, message) VALUES (?, ?)", [buyer.id, `New product: ${title}`]);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/products/:id', async (req, res) => {
    const [results] = await dbPromise.query(`
        SELECT p.*, c.name as cat, u.first_name, u.last_name, u.location as seller_location, u.bio FROM products p JOIN categories c ON p.category_id = c.id JOIN users u ON p.seller_id = u.id WHERE p.id = ?
    `, [req.params.id]);
    res.json(results[0] || {});
});

// --- ORDERS ---
app.post('/api/orders', async (req, res) => {
    const { buyer_id, items } = req.body; 
    try {
        for (let item of items) {
            await dbPromise.query(
                "INSERT INTO orders (buyer_id, seller_id, product_id, quantity, total_price) VALUES (?, ?, ?, ?, ?)",
                [buyer_id, item.seller_id, item.product_id, item.quantity, item.price * item.quantity]
            );
            await dbPromise.query("UPDATE products SET stock = stock - ? WHERE id = ?", [item.quantity, item.product_id]);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/orders/seller/:sellerId', async (req, res) => {
    const [results] = await dbPromise.query(`
        SELECT o.*, u.first_name as buyer_name, p.title as product_name FROM orders o JOIN users u ON o.buyer_id = u.id JOIN products p ON o.product_id = p.id WHERE o.seller_id = ? ORDER BY o.created_at DESC
    `, [req.params.sellerId]);
    res.json(results);
});

app.get('/api/orders/:id', async (req, res) => {
    const [results] = await dbPromise.query(`
        SELECT o.*, p.title as product_name, u.first_name as seller_name, b.first_name as buyer_name, b.location as buyer_location FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.seller_id = u.id JOIN users b ON o.buyer_id = b.id WHERE o.id = ?
    `, [req.params.id]);
    res.json(results[0] || {});
});

app.put('/api/orders/:id/track', async (req, res) => {
    const { status, expected_delivery } = req.body;
    await dbPromise.query("UPDATE orders SET tracking_status = ?, expected_delivery = ? WHERE id = ?", [status, expected_delivery, req.params.id]);
    res.json({ success: true });
});

// --- CHAT ---
app.get('/api/chat', async (req, res) => {
    const { user1, user2 } = req.query;
    const [results] = await dbPromise.query(`
        SELECT c.*, u.first_name as sender_name FROM chats c JOIN users u ON c.sender_id = u.id WHERE ((sender_id = ? AND receiver_id = ? AND is_deleted_for_sender = 0) OR (sender_id = ? AND receiver_id = ? AND is_deleted_for_receiver = 0)) ORDER BY c.created_at ASC
    `, [user1, user2, user2, user1]);
    res.json(results);
});

app.post('/api/chat', async (req, res) => {
    const { sender_id, receiver_id, message, file_url } = req.body;
    try {
        await dbPromise.query("INSERT INTO chats (sender_id, receiver_id, message, file_url) VALUES (?, ?, ?, ?)", [sender_id, receiver_id, message, file_url || null]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/chat/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

app.delete('/api/chat/:id', async (req, res) => {
    const { id } = req.params; const { type, userId } = req.query;
    if (type === 'everyone') {
        await dbPromise.query("DELETE FROM chats WHERE id = ?", [id]);
    } else {
        const [msg] = await dbPromise.query("SELECT * FROM chats WHERE id = ?", [id]);
        if (msg[0].sender_id == userId) await dbPromise.query("UPDATE chats SET is_deleted_for_sender = 1 WHERE id = ?", [id]);
        else await dbPromise.query("UPDATE chats SET is_deleted_for_receiver = 1 WHERE id = ?", [id]);
    }
    res.json({ success: true });
});

app.get('/api/notifications/:userId', async (req, res) => {
    const [results] = await dbPromise.query("SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC", [req.params.userId]);
    res.json(results);
});

app.put('/api/notifications/:userId/read', async (req, res) => {
    await dbPromise.query("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.params.userId]);
    res.json({ success: true });
});

// --- STATIC FILES & ROUTING ---
app.use(express.static(__dirname));
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Eduvos Marketplace running on port ${PORT}`);
});