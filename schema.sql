-- Drop existing tables if rebuilding
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS settings;

-- 1. Store Settings (Admin Editable: Delivery Base Fee & Free Delivery Threshold)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES 
('delivery_base_fee', '60.00'),
('free_delivery_threshold', '600.00');

-- 2. 7 Non-Food Sourcing Categories
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (id, name, icon) VALUES 
('cat-all', 'All Products', '🏪'),
('cat-hardware', 'Hardware & DIY', '🔨'),
('cat-electronics', 'Electronics & Gadgets', '🔌'),
('cat-home', 'Home & Living', '🛋️'),
('cat-clothing', 'Clothing & Apparel', '👕'),
('cat-beauty', 'Beauty & Personal Care', '💄'),
('cat-gaming', 'Gaming & Accessories', '🎮'),
('cat-gifts', 'Gifts & General', '🎁');

-- 3. Products Table (Zero-Inventory / Local Sourcing Mode)
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- 4. Orders Table (Includes Subtotal, Delivery Fee, Status & Payment Verification)
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

-- 5. Order Items Table
CREATE TABLE order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    subtotal REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- 6. Product Reviews Table
CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Seed Starter Non-Food Sourced Products
INSERT INTO products (id, name, description, price, is_available, sourcing_time, category_id, image_url, is_local_find) VALUES
('prod-1', 'Heavy Duty Multi-Bit Screwdriver Set (24-in-1)', 'Magnetic precision alloy bits for electronics, DIY home repairs, and gadget servicing.', 185.00, 1, 'Dispatched in 24h', 'cat-hardware', '', 1),
('prod-2', 'Braided 65W Fast-Charging Type-C to Type-C Cable (2m)', 'Ultra-durable nylon braided cable with real-time LED wattage indicator display.', 140.00, 1, 'Dispatched in 24h', 'cat-electronics', '', 1),
('prod-3', 'RGB Mechanical Gaming Keyboard & Mouse Combo', 'Tactile switches with vibrant backlighting modes and ergonomic textured grip.', 499.00, 1, 'Dispatched in 24h', 'cat-gaming', '', 1),
('prod-4', 'Minimalist Ceramic Diffuser & Essential Oil Set', 'Modern matte ceramic essential oil burner with natural lemongrass and eucalyptus oils.', 220.00, 1, 'Dispatched in 24h', 'cat-home', '', 1);

-- Seed Starter Customer Reviews
INSERT INTO reviews (id, product_id, customer_name, rating, comment) VALUES
('rev-1', 'prod-1', 'Sipho N.', 5, 'Great quality tools, sourced and delivered the next morning!'),
('rev-2', 'prod-3', 'Liam K.', 5, 'Super responsive keys. Awesome local service.');
