/**
 * MP MARKET BACKEND
 * Cloudflare Worker + D1 + R2 + Durable Object WebSockets + Yoco Verification
 */

export class MPMarketRealtime {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      server.accept();
      this.sockets.add(server);
      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.text();
      for (const ws of this.sockets) {
        try { ws.send(payload); } catch (err) { this.sockets.delete(ws); }
      }
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not Found", { status: 404 });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function verifyAdmin(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const configuredPassword = env.ADMIN_PASSWORD || "admin123";
  return token === configuredPassword;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    try {
      // 1. WEBSOCKET ROUTE (Admin Live Notifications)
      if (url.pathname === "/api/ws/admin") {
        const id = env.REALTIME.idFromName("mp-market-global-room");
        const obj = env.REALTIME.get(id);
        return obj.fetch(new Request("https://realtime/ws", { headers: request.headers }));
      }

      // 2. R2 IMAGE SERVING ROUTE
      if (url.pathname.startsWith("/api/images/")) {
        const key = decodeURIComponent(url.pathname.replace("/api/images/", ""));
        const object = await env.IMAGES_BUCKET.get(key);
        if (!object) return new Response("Image Not Found", { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(object.body, { headers });
      }

      // 3. PUBLIC CONFIGURATION (Yoco Public Key & Delivery Settings)
      if (url.pathname === "/api/config" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM settings").all();
        const settingsMap = Object.fromEntries(results.map(r => [r.key, parseFloat(r.value)]));
        return json({
          yoco_public_key: env.YOCO_PUBLIC_KEY || "",
          delivery_base_fee: settingsMap.delivery_base_fee || 60.0,
          free_delivery_threshold: settingsMap.free_delivery_threshold || 600.0
        });
      }

      // 4. CATEGORIES & PRODUCTS
      if (url.pathname === "/api/categories" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM categories ORDER BY name ASC").all();
        return json(results);
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        const category = url.searchParams.get("category");
        const search = url.searchParams.get("search");

        let query = `
          SELECT p.*, 
                 COALESCE(AVG(r.rating), 5.0) as avg_rating,
                 COUNT(r.id) as review_count
          FROM products p
          LEFT JOIN reviews r ON p.id = r.product_id
          WHERE 1=1
        `;
        const params = [];

        if (category && category !== "cat-all") {
          query += " AND p.category_id = ?";
          params.push(category);
        }
        if (search) {
          query += " AND (p.name LIKE ? OR p.description LIKE ?)";
          params.push(`%${search}%`, `%${search}%`);
        }
        query += " GROUP BY p.id ORDER BY p.created_at DESC";

        const { results } = await env.DB.prepare(query).bind(...params).all();
        return json(results);
      }

      // 5. REVIEWS
      if (url.pathname.startsWith("/api/reviews/") && request.method === "GET") {
        const productId = url.pathname.replace("/api/reviews/", "");
        const { results } = await env.DB.prepare("SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC").bind(productId).all();
        return json(results);
      }

      if (url.pathname === "/api/reviews" && request.method === "POST") {
        const { product_id, customer_name, rating, comment } = await request.json();
        if (!product_id || !customer_name || !rating || !comment) {
          return json({ error: "Missing required review fields" }, 400);
        }
        const revId = `rev-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO reviews (id, product_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)"
        ).bind(revId, product_id, customer_name, parseInt(rating, 10), comment).run();

        return json({ success: true, id: revId }, 201);
      }

      // 6. ORDER CHECKOUT & STRICT PRICE VERIFICATION
      if (url.pathname === "/api/orders" && request.method === "POST") {
        const body = await request.json();
        const { customer_name, customer_whatsapp, delivery_address, items, yoco_token } = body;

        if (!customer_name || !customer_whatsapp || !delivery_address || !items || !items.length) {
          return json({ error: "Missing required order information" }, 400);
        }

        // Fetch authoritative delivery settings from D1
        const { results: settingsRows } = await env.DB.prepare("SELECT * FROM settings").all();
        const settingsMap = Object.fromEntries(settingsRows.map(r => [r.key, parseFloat(r.value)]));
        const baseFee = settingsMap.delivery_base_fee || 60.0;
        const freeThreshold = settingsMap.free_delivery_threshold || 600.0;

        // Verify items in D1
        const productIds = items.map(i => `'${i.id.replace(/'/g, "''")}'`).join(",");
        const { results: dbProducts } = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${productIds})`).all();
        const productMap = new Map(dbProducts.map(p => [p.id, p]));

        let computedSubtotal = 0;
        const verifiedItems = [];

        for (const item of items) {
          const product = productMap.get(item.id);
          if (!product) return json({ error: `Product ${item.id} not found.` }, 400);
          if (product.is_available === 0) return json({ error: `${product.name} is currently unavailable for sourcing.` }, 400);

          const sub = product.price * item.quantity;
          computedSubtotal += sub;

          verifiedItems.push({
            id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            productId: product.id,
            productName: product.name,
            unitPrice: product.price,
            quantity: item.quantity,
            subtotal: sub
          });
        }

        const deliveryFee = computedSubtotal >= freeThreshold ? 0.0 : baseFee;
        const computedTotal = computedSubtotal + deliveryFee;

        let paymentStatus = "Pending";
        let paymentMethod = "Cash/EFT on Delivery";

        // Yoco Backend Card Charge Verification (if token is provided and secret is configured)
        if (yoco_token && env.YOCO_SECRET_KEY) {
          try {
            const yocoRes = await fetch("https://online.yoco.com/v1/charges/", {
              method: "POST",
              headers: {
                "X-Auth-Secret-Key": env.YOCO_SECRET_KEY,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                token: yoco_token,
                amountInCents: Math.round(computedTotal * 100),
                currency: "ZAR"
              })
            });

            const yocoData = await yocoRes.json();
            if (yocoRes.ok && yocoData.status === "successful") {
              paymentStatus = "Paid";
              paymentMethod = "Yoco Online Card";
            } else {
              return json({ error: yocoData.displayMessage || "Yoco card payment declined by bank." }, 400);
            }
          } catch (err) {
            return json({ error: "Failed to process card payment with Yoco." }, 500);
          }
        }

        const orderId = `ord-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        const orderNumber = `MPM-${Math.floor(100000 + Math.random() * 900000)}`;
        const initialStatus = paymentStatus === "Paid" ? "Sourced" : "Pending Sourcing";

        const statements = [
          env.DB.prepare(
            `INSERT INTO orders (id, order_number, customer_name, customer_whatsapp, delivery_address, subtotal_amount, delivery_fee, total_amount, status, payment_status, payment_method) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(orderId, orderNumber, customer_name, customer_whatsapp, delivery_address, computedSubtotal, deliveryFee, computedTotal, initialStatus, paymentStatus, paymentMethod)
        ];

        for (const item of verifiedItems) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(item.id, orderId, item.productId, item.productName, item.unitPrice, item.quantity, item.subtotal)
          );
        }

        await env.DB.batch(statements);

        // Realtime Broadcast to Admin Dashboard via Durable Object
        const doId = env.REALTIME.idFromName("mp-market-global-room");
        const doObj = env.REALTIME.get(doId);
        await doObj.fetch(new Request("https://realtime/broadcast", {
          method: "POST",
          body: JSON.stringify({
            event: "NEW_ORDER",
            order: {
              id: orderId,
              order_number: orderNumber,
              customer_name,
              customer_whatsapp,
              delivery_address,
              subtotal_amount: computedSubtotal,
              delivery_fee: deliveryFee,
              total_amount: computedTotal,
              status: initialStatus,
              payment_status: paymentStatus,
              payment_method: paymentMethod,
              items: verifiedItems,
              created_at: new Date().toISOString()
            }
          })
        }));

        return json({
          success: true,
          order_id: orderId,
          order_number: orderNumber,
          subtotal: computedSubtotal,
          delivery_fee: deliveryFee,
          total_amount: computedTotal,
          payment_status: paymentStatus
        }, 201);
      }

      // 7. CUSTOMER ORDER LOOKUP ("My Orders")
      if (url.pathname.startsWith("/api/orders/customer/") && request.method === "GET") {
        const phone = decodeURIComponent(url.pathname.replace("/api/orders/customer/", "")).trim();
        const { results: orders } = await env.DB.prepare(
          "SELECT * FROM orders WHERE customer_whatsapp = ? ORDER BY created_at DESC"
        ).bind(phone).all();

        const { results: allItems } = await env.DB.prepare("SELECT * FROM order_items").all();
        const ordersWithItems = orders.map(o => ({
          ...o,
          items: allItems.filter(i => i.order_id === o.id)
        }));

        return json(ordersWithItems);
      }

      // 8. ADMIN AUTHENTICATED ENDPOINTS
      if (url.pathname.startsWith("/api/admin")) {
        if (!verifyAdmin(request, env)) {
          return json({ error: "Unauthorized. Invalid ADMIN_PASSWORD." }, 401);
        }

        if (url.pathname === "/api/admin/verify" && request.method === "POST") {
          return json({ success: true });
        }

        // Update Store Delivery Pricing
        if (url.pathname === "/api/admin/settings" && request.method === "POST") {
          const { delivery_base_fee, free_delivery_threshold } = await request.json();
          await env.DB.batch([
            env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'delivery_base_fee'").bind(String(delivery_base_fee)),
            env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'free_delivery_threshold'").bind(String(free_delivery_threshold))
          ]);
          return json({ success: true });
        }

        // Direct R2 Image Upload
        if (url.pathname === "/api/admin/upload" && request.method === "POST") {
          const formData = await request.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File)) return json({ error: "No image file provided" }, 400);

          const ext = file.name.split(".").pop() || "jpg";
          const fileKey = `products/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.${ext}`;
          await env.IMAGES_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type } });
          return json({ success: true, imageUrl: `/api/images/${encodeURIComponent(fileKey)}` });
        }

        // Get All Admin Orders
        if (url.pathname === "/api/admin/orders" && request.method === "GET") {
          const { results: orders } = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
          const { results: allItems } = await env.DB.prepare("SELECT * FROM order_items").all();
          return json(orders.map(o => ({ ...o, items: allItems.filter(i => i.order_id === o.id) })));
        }

        // Update Order Status
        if (url.pathname.startsWith("/api/admin/orders/") && request.method === "PUT") {
          const orderId = url.pathname.replace("/api/admin/orders/", "");
          const { status } = await request.json();
          await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, orderId).run();

          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "ORDER_STATUS_UPDATED", orderId, status })
          }));

          return json({ success: true });
        }

        // Toggle Product Availability
        if (url.pathname.startsWith("/api/admin/products/toggle/") && request.method === "POST") {
          const id = url.pathname.replace("/api/admin/products/toggle/", "");
          await env.DB.prepare("UPDATE products SET is_available = CASE WHEN is_available = 1 THEN 0 ELSE 1 END WHERE id = ?").bind(id).run();
          return json({ success: true });
        }

        // Add Product
        if (url.pathname === "/api/admin/products" && request.method === "POST") {
          const { name, description, price, category_id, image_url, sourcing_time } = await request.json();
          const id = `prod-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
          await env.DB.prepare(
            `INSERT INTO products (id, name, description, price, is_available, sourcing_time, category_id, image_url, is_local_find)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)`
          ).bind(id, name, description || "", parseFloat(price), sourcing_time || "Dispatched in 24h", category_id, image_url || "").run();
          return json({ success: true, id }, 201);
        }

        // Delete Product
        if (url.pathname.startsWith("/api/admin/products/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/products/", "");
          await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
          return json({ success: true });
        }
      }

      // Default fallback for unmatched routes
      return json({ error: "Endpoint not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "Internal Server Error" }, 500);
    }
  }
};
