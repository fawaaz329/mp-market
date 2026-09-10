DROP TABLE IF EXISTS inquiries;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS areas;

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES 
('delivery_base_fee', '30.00'),
('free_delivery_threshold', '600.00');

CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (id, name, icon) VALUES 
('cat-all', 'All Products', ''),
('cat-new-arrivals', 'New Arrivals', ''),
('cat-stationery', 'Stationery & Office', ''),
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
    public_source TEXT NOT NULL DEFAULT 'Local Partner',
    internal_supplier TEXT NOT NULL DEFAULT 'Local Partner',
    available_sizes TEXT DEFAULT '',
    is_available INTEGER NOT NULL DEFAULT 1,
    is_new_arrival INTEGER NOT NULL DEFAULT 0,
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
    customer_email TEXT NOT NULL DEFAULT '',
    customer_whatsapp TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    subtotal_amount REAL NOT NULL,
    delivery_fee REAL NOT NULL,
    total_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending Sourcing',
    payment_status TEXT NOT NULL DEFAULT 'Pending',
    payment_method TEXT NOT NULL DEFAULT 'Yoco Online',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    selected_size TEXT DEFAULT '',
    internal_supplier TEXT NOT NULL DEFAULT 'Local Partner',
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

CREATE TABLE inquiries (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE areas (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    zone_name TEXT,
    fee REAL NOT NULL DEFAULT 0,
    is_collection INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
