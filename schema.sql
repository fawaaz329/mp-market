DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS settings;

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES 
('delivery_base_fee', '60.00'),
('free_delivery_threshold', '600.00');

CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (id, name, icon) VALUES 
('cat-all', 'All Products', ''),
('cat-hardware', 'Hardware & DIY', ''),
('cat-electronics', 'Electronics & Gadgets', ''),
('cat-home', 'Home & Living', ''),
('cat-clothing', 'Clothing & Apparel', ''),
('cat-beauty', 'Personal Care', ''),
('cat-gaming', 'Gaming & Accessories', ''),
('cat-gifts', 'Gifts & General', '');

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    is_available INTEGER NOT NULL DEFAULT 1,
    sourcing_time TEXT NOT NULL DEFAULT 'Dispatched in 24h',
    category_id TEXT NOT NULL,
    image_url TEXT,
    is_local_find INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    order_number TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    customer_whatsapp TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    subtotal_amount REAL NOT NULL,
    delivery_fee REAL NOT NULL,
    total_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending Sourcing',
    payment_status TEXT NOT NULL DEFAULT 'Pending',
    payment_method TEXT NOT NULL DEFAULT 'Cash/EFT on Delivery',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    subtotal REAL NOT NULL
);

CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
