/**
 * MP MARKET BACKEND
 * Cloudflare Worker + D1 + R2 + Durable Objects + Yoco + Brevo + Google Auth + Zero-Leak Directory
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

// BREVO EMAIL DISPATCHER
async function sendSystemEmail(env, { to, toName, subject, htmlContent }) {
  try {
    const apiKey = (env.BREVO_API_KEY || "").trim();
    if (!apiKey) return false;

    const fromEmail = env.SENDER_EMAIL || "orders@mp-marketplace.co.za";
    const fromName = env.SENDER_NAME || "MP Market";

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        replyTo: { email: "docfloweditor@gmail.com", name: fromName },
        to: [{ email: to, name: toName || to }],
        subject: subject,
        htmlContent: htmlContent
      })
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function renderCustomerOrderEmail(order, items) {
  const itemsHtml = (items || []).map(i => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #E8E3DA;">
        <strong>${i.product_name}</strong> 
        ${i.selected_size ? `<span style="color:#C45A2C;">[Size: ${i.selected_size}]</span> ` : ''}
        ${i.selected_color ? `<span style="color:#087A58;">[Color: ${i.selected_color}]</span>` : ''}<br>
        <span style="font-size: 11px; color: #737373;">Source: ${i.public_source || 'Local Partner'}</span>
      </td>
      <td style="padding: 10px 0; border-bottom: 1px solid #E8E3DA; text-align: center;">${i.quantity}</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #E8E3DA; text-align: right; font-weight: 700;">R ${Number(i.unit_price).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family: Arial, sans-serif; background-color: #F7F4EF; padding: 32px 16px; color: #171717;">
      <div style="max-width: 580px; margin: 0 auto; background: #FFFFFF; border-radius: 8px; border: 1px solid #E8E3DA; padding: 32px;">
        <h1 style="font-size: 20px; font-weight: 800; text-align: center; text-transform: uppercase;">MP MARKET</h1>
        <p style="font-size: 14px; margin-bottom: 20px;">Hi <strong>${order.customer_name}</strong>, thank you for ordering with MP Market! We have received your payment.</p>
        <div style="background: #FAF7F2; padding: 14px; border-radius: 6px; font-size: 13px; margin-bottom: 20px;">
          <div><strong>Order Number:</strong> #${order.order_number}</div>
          <div><strong>Delivery Address:</strong> ${order.delivery_address}</div>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
          <thead>
            <tr style="border-bottom: 2px solid #171717; text-align: left; font-size: 11px; text-transform: uppercase;">
              <th>Item</th><th style="text-align: center;">Qty</th><th style="text-align: right;">Price</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align: right; font-size: 13px; line-height: 1.6;">
          <div>Subtotal: R ${Number(order.subtotal_amount).toFixed(2)}</div>
          <div>Delivery Fee: ${order.delivery_fee === 0 ? 'FREE / Collection' : 'R ' + Number(order.delivery_fee).toFixed(2)}</div>
          <div style="font-size: 16px; font-weight: 800; margin-top: 6px;">Total Paid: R ${Number(order.total_amount).toFixed(2)}</div>
        </div>
      </div>
    </div>
  `;
}

function renderOwnerAlertEmail(order, items) {
  const itemsList = (items || []).map(i => `<li><strong>[${i.internal_supplier || 'Local Partner'}]:</strong> ${i.quantity}x ${i.product_name} ${i.selected_size ? `(Size: ${i.selected_size}) ` : ''}${i.selected_color ? `(Color: ${i.selected_color})` : ''} - R ${Number(i.unit_price).toFixed(2)}</li>`).join('');
  return `
    <div style="font-family: Arial, sans-serif; padding: 24px; color: #171717;">
      <h2 style="color: #C45A2C;">🚨 New Paid Sourcing Order #${order.order_number}</h2>
      <p>Customer: ${order.customer_name} (${order.customer_whatsapp})</p>
      <p>Address: ${order.delivery_address}</p>
      <ul>${itemsList}</ul>
      <p><strong>Total: R ${Number(order.total_amount).toFixed(2)}</strong> (Delivery: R ${Number(order.delivery_fee).toFixed(2)})</p>
    </div>
  `;
}

function renderOutForDeliveryEmail(order) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 24px;">
      <h2>Your MP Market order is on its way! 🚚</h2>
      <p>Hi ${order.customer_name}, your items for order #${order.order_number} are packed and en route to:</p>
      <p><strong>${order.delivery_address}</strong></p>
      <p>Please ensure someone is available to receive the delivery.</p>
    </div>
  `;
}

function renderDeliveredEmail(order) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 24px;">
      <h2>Order Delivered 🇿🇦</h2>
      <p>Hi ${order.customer_name}, your order #${order.order_number} has been delivered! Thank you for supporting local business in Cape Town.</p>
    </div>
  `;
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
      // ⚡ WEBSOCKET REALTIME
      if (url.pathname === "/api/ws" || url.pathname === "/api/ws/admin") {
        const id = env.REALTIME.idFromName("mp-market-global-room");
        const obj = env.REALTIME.get(id);
        return obj.fetch(new Request("https://realtime/ws", { headers: request.headers }));
      }

      // 🔵 GOOGLE OAUTH ORDER SYNC
      if (url.pathname === "/api/auth/google" && request.method === "POST") {
        try {
          const { credential } = await request.json();
          if (!credential) return json({ error: "Missing credential" }, 400);

          const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
          if (!verifyRes.ok) return json({ error: "Invalid Google token" }, 401);

          const tokenData = await verifyRes.json();
          if (tokenData.aud !== "1091285001207-n6gpbe3s1d20tcgqqo6enj3ukm827vc9.apps.googleusercontent.com") {
            return json({ error: "Client ID mismatch" }, 401);
          }

          const verifiedEmail = (tokenData.email || "").toLowerCase().trim();

          const { results: orders } = await env.DB.prepare(
            `SELECT id, order_number, status, total_amount, delivery_fee, created_at 
             FROM orders 
             WHERE LOWER(customer_email) = ? AND payment_status = 'Paid' 
             ORDER BY created_at DESC`
          ).bind(verifiedEmail).all();

          const { results: allItems } = await env.DB.prepare(
            "SELECT id, order_id, product_name, selected_size, selected_color, quantity, unit_price FROM order_items"
          ).all();

          const sanitizedOrders = (orders || []).map(o => ({
            ...o,
            items: (allItems || []).filter(i => i.order_id === o.id)
          }));

          return json({
            user: {
              name: tokenData.name || "Customer",
              given_name: tokenData.given_name || tokenData.name || "Customer",
              email: tokenData.email,
              picture: tokenData.picture || ""
            },
            orders: sanitizedOrders
          });
        } catch (err) {
          return json({ error: "Google verification failed" }, 500);
        }
      }

      // 🖼️ R2 IMAGE SERVING
      if (
        url.pathname.startsWith("/api/images/") ||
        url.pathname.startsWith("/images/") ||
        (url.pathname.startsWith("/products/") && (url.pathname.includes("%2F") || url.pathname.includes("1789") || /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(url.pathname)))
      ) {
        let rawKey = url.pathname.replace(/^\/api\/images\//, "").replace(/^\/images\//, "").replace(/^\/products\//, "");
        try { rawKey = decodeURIComponent(rawKey); } catch (e) {}

        let cleanKey = rawKey.replace(/^[\/\%2F]+/, "").trim();
        let object = await env.IMAGES_BUCKET.get(cleanKey);

        if (!object && !cleanKey.startsWith("products/") && !cleanKey.startsWith("directory/")) {
          object = await env.IMAGES_BUCKET.get(`products/${cleanKey}`);
        }
        if (!object && cleanKey.startsWith("products/")) {
          object = await env.IMAGES_BUCKET.get(cleanKey.replace(/^products\//, ""));
        }

        if (!object) return new Response("Image Not Found", { status: 404 });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        if (!headers.get("Content-Type")) {
          if (cleanKey.endsWith(".png")) headers.set("Content-Type", "image/png");
          else if (cleanKey.endsWith(".webp")) headers.set("Content-Type", "image/webp");
          else headers.set("Content-Type", "image/jpeg");
        }
        return new Response(object.body, { headers });
      }

      // ⚙️ CONFIG WITH HIDDEN CATEGORIES & MITCHELL'S PLAIN ONLY MODE
      if (url.pathname === "/api/config" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM settings").all();
        const settingsMap = Object.fromEntries((results || []).map(r => [r.key, r.value]));
        return json({
          delivery_base_fee: parseFloat(settingsMap.delivery_base_fee) || 30.0,
          free_delivery_threshold: parseFloat(settingsMap.free_delivery_threshold) || 600.0,
          hidden_categories: settingsMap.hidden_categories || "",
          mitchells_plain_only: parseInt(settingsMap.mitchells_plain_only, 10) === 1 ? 1 : 0
        });
      }

      if (url.pathname === "/api/categories" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM categories ORDER BY name ASC").all();
        return json(results || []);
      }

      if (url.pathname === "/api/areas" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM areas ORDER BY name ASC").all();
        return json(results || []);
      }

      // PRODUCTS
      if ((url.pathname === "/api/products" || url.pathname === "/products") && request.method === "GET") {
        const category = url.searchParams.get("category");
        const search = url.searchParams.get("search");
        const isNewArrival = url.searchParams.get("new_arrivals");

        let query = `
          SELECT p.id, p.name, p.description, p.price, p.public_source, p.internal_supplier,
                 p.available_sizes, p.available_colors, p.is_available, p.is_new_arrival,
                 p.sourcing_time, p.category_id, p.image_url, p.created_at,
                 COALESCE(AVG(r.rating), 5.0) as avg_rating,
                 COUNT(r.id) as review_count
          FROM products p
          LEFT JOIN reviews r ON p.id = r.product_id
          WHERE 1=1
        `;
        const params = [];

        if (isNewArrival === "1" || category === "cat-new-arrivals") {
          query += " AND p.is_new_arrival = 1";
        } else if (search && search.trim()) {
          const term = `%${search.trim().toLowerCase()}%`;
          query += ` AND (LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.public_source) LIKE ?)`;
          params.push(term, term, term);
        } else if (category && category !== "cat-all" && category !== "ALL") {
          query += " AND p.category_id = ?";
          params.push(category);
        }

        query += " GROUP BY p.id ORDER BY p.created_at DESC";
        const { results } = await env.DB.prepare(query).bind(...params).all();
        return json(results || []);
      }

      if (url.pathname.startsWith("/api/reviews/") && request.method === "GET") {
        const productId = url.pathname.replace("/api/reviews/", "");
        const { results } = await env.DB.prepare("SELECT id, product_id, customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? ORDER BY created_at DESC").bind(productId).all();
        return json(results || []);
      }

      if (url.pathname === "/api/reviews" && request.method === "POST") {
        const { product_id, customer_name, rating, comment } = await request.json();
        if (!product_id || !customer_name || !rating || !comment) return json({ error: "Missing fields" }, 400);
        const revId = `rev-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO reviews (id, product_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)"
        ).bind(revId, product_id, customer_name.trim(), parseInt(rating, 10), comment.trim()).run();
        return json({ success: true, id: revId }, 201);
      }

      if (url.pathname === "/api/contact" && request.method === "POST") {
        const { first_name, last_name, email, message } = await request.json();
        if (!first_name || !last_name || !email || !message) return json({ error: "Missing fields" }, 400);

        const inquiryId = `inq-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO inquiries (id, first_name, last_name, email, message) VALUES (?, ?, ?, ?, ?)"
        ).bind(inquiryId, first_name.trim(), last_name.trim(), email.trim(), message.trim()).run();

        const ownerEmail = env.OWNER_NOTIFICATION_EMAIL || env.ADMIN_EMAIL;
        if (ownerEmail) {
          ctx.waitUntil(
            sendSystemEmail(env, {
              to: ownerEmail,
              toName: "MP Market Admin",
              subject: `💬 New Inquiry from ${first_name} ${last_name}`,
              htmlContent: `<p><strong>From:</strong> ${first_name} ${last_name} (${email})</p><p><strong>Message:</strong></p><div>${message}</div>`
            })
          );
        }

        return json({ success: true, id: inquiryId }, 201);
      }

      // 💳 CHECKOUT SESSION CREATOR (YOCO) WITH STRICT R200 MINIMUM CHECK
      if (url.pathname === "/api/orders/create-checkout" && request.method === "POST") {
        const body = await request.json();
        const { customer_name, customer_email, customer_whatsapp, delivery_address, delivery_fee, is_collection, items } = body;

        if (!customer_name || !customer_email || !customer_whatsapp || !delivery_address || !items || !items.length) {
          return json({ error: "Missing required order information" }, 400);
        }

        const secretKey = (env.YOCO_SECRET_KEY || "").trim().replace(/['"]/g, "");
        if (!secretKey || !secretKey.startsWith("sk_")) {
          return json({ error: "YOCO_SECRET_KEY is not configured in Cloudflare Settings." }, 400);
        }

        const { results: settingsRows } = await env.DB.prepare("SELECT * FROM settings").all();
        const settingsMap = Object.fromEntries((settingsRows || []).map(r => [r.key, parseFloat(r.value)]));
        const freeThreshold = settingsMap.free_delivery_threshold || 600.0;

        const productIds = items.map(i => `'${i.id.replace(/'/g, "''")}'`).join(",");
        const { results: dbProducts } = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${productIds})`).all();
        const productMap = new Map((dbProducts || []).map(p => [p.id, p]));

        let computedSubtotal = 0;
        const verifiedItems = [];

        for (const item of items) {
          const product = productMap.get(item.id);
          if (!product) return json({ error: `Product ${item.id} not found.` }, 400);
          if (product.is_available === 0) return json({ error: `${product.name} is currently unavailable.` }, 400);

          const sub = product.price * item.quantity;
          computedSubtotal += sub;

          verifiedItems.push({
            id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            productId: product.id,
            productName: product.name,
            selectedSize: item.size || '',
            selectedColor: item.color || '',
            internalSupplier: product.internal_supplier || 'Local Partner',
            unitPrice: product.price,
            quantity: item.quantity,
            subtotal: sub
          });
        }

        // 🔒 SERVER-SIDE MINIMUM ORDER ENFORCEMENT (R200)
        const MIN_ORDER_THRESHOLD = 200.0;
        if (computedSubtotal < MIN_ORDER_THRESHOLD) {
          return json({ error: `Minimum order value is R${MIN_ORDER_THRESHOLD.toFixed(2)}. Your current basket subtotal is R ${computedSubtotal.toFixed(2)}.` }, 400);
        }

        const isFree = computedSubtotal >= freeThreshold;
        const calculatedDeliveryFee = (is_collection || isFree) ? 0 : Number(delivery_fee || 0);
        const computedTotal = computedSubtotal + calculatedDeliveryFee;

        const orderId = `ord-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        const orderNumber = `MPM-${Math.floor(100000 + Math.random() * 900000)}`;

        const statements = [
          env.DB.prepare(
            `INSERT INTO orders (id, order_number, customer_name, customer_email, customer_whatsapp, delivery_address, subtotal_amount, delivery_fee, total_amount, status, payment_status, payment_method) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Payment', 'Pending', 'Yoco Online')`
          ).bind(orderId, orderNumber, customer_name, customer_email.trim(), customer_whatsapp, delivery_address, computedSubtotal, calculatedDeliveryFee, computedTotal)
        ];

        for (const item of verifiedItems) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO order_items (id, order_id, product_id, product_name, selected_size, selected_color, internal_supplier, unit_price, quantity, subtotal)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(item.id, orderId, item.productId, item.productName, item.selectedSize, item.selectedColor, item.internalSupplier, item.unitPrice, item.quantity, item.subtotal)
          );
        }

        await env.DB.batch(statements);

        const siteOrigin = url.origin;
        const yocoRes = await fetch("https://payments.yoco.com/api/checkouts", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${secretKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: Math.round(computedTotal * 100),
            currency: "ZAR",
            cancelUrl: `${siteOrigin}/?payment=cancelled`,
            successUrl: `${siteOrigin}/?payment=success&order=${orderNumber}`,
            failureUrl: `${siteOrigin}/?payment=failed`,
            metadata: {
              orderId,
              orderNumber,
              customerName: customer_name,
              customerEmail: customer_email.trim(),
              customerPhone: customer_whatsapp
            }
          })
        });

        const yocoData = await yocoRes.json();
        if (!yocoRes.ok || !yocoData.redirectUrl) {
          return json({ error: yocoData.message || "Could not generate Yoco payment session." }, 400);
        }

        return json({ success: true, redirect_url: yocoData.redirectUrl, order_number: orderNumber }, 201);
      }

      if (url.pathname === "/api/orders/confirm-payment" && request.method === "POST") {
        const { order_number } = await request.json();
        if (!order_number) return json({ error: "Missing order number" }, 400);

        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_number = ?").bind(order_number).first();
        if (!order) return json({ error: "Order not found" }, 404);

        if (order.payment_status !== "Paid") {
          await env.DB.prepare(
            "UPDATE orders SET payment_status = 'Paid', status = 'Sourced', payment_method = 'Yoco Online' WHERE id = ?"
          ).bind(order.id).run();

          const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(order.id).all();
          const updatedOrder = { ...order, status: "Sourced", payment_status: "Paid", items };

          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "NEW_ORDER", order: updatedOrder })
          }));

          if (order.customer_email) {
            ctx.waitUntil(
              sendSystemEmail(env, {
                to: order.customer_email,
                toName: order.customer_name,
                subject: `Order Confirmed: #${order.order_number} — MP Market`,
                htmlContent: renderCustomerOrderEmail(order, items)
              })
            );
          }

          const ownerEmail = env.OWNER_NOTIFICATION_EMAIL || env.ADMIN_EMAIL;
          if (ownerEmail) {
            ctx.waitUntil(
              sendSystemEmail(env, {
                to: ownerEmail,
                toName: "MP Market Admin",
                subject: `🚨 New Sourcing Order: #${order.order_number} — ${order.customer_name} (R ${Number(order.total_amount).toFixed(2)})`,
                htmlContent: renderOwnerAlertEmail(order, items)
              })
            );
          }
        }

        return json({ success: true, order });
      }

      // ADMIN CORE ROUTES
      if (url.pathname.startsWith("/api/admin")) {
        if (!verifyAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

        if (url.pathname === "/api/admin/verify" && request.method === "POST") return json({ success: true });

        // POPIA ERASURE
        if (url.pathname.startsWith("/api/admin/orders/") && request.method === "DELETE") {
          const orderId = url.pathname.replace("/api/admin/orders/", "");
          await env.DB.batch([
            env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(orderId),
            env.DB.prepare("DELETE FROM orders WHERE id = ?").bind(orderId)
          ]);
          return json({ success: true });
        }

        if (url.pathname === "/api/admin/areas" && request.method === "POST") {
          const { name, zone_name, fee, is_collection } = await request.json();
          if (!name) return json({ error: "Area name required" }, 400);

          const areaId = `area-${Date.now()}`;
          await env.DB.prepare(
            `INSERT INTO areas (id, name, zone_name, fee, is_collection) VALUES (?, ?, ?, ?, ?)`
          ).bind(areaId, name.trim(), zone_name || 'Zone 1', Number(fee || 0), is_collection ? 1 : 0).run();

          return json({ success: true, id: areaId }, 201);
        }

        if (url.pathname.startsWith("/api/admin/areas/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/areas/", "");
          await env.DB.prepare("DELETE FROM areas WHERE id = ?").bind(id).run();
          return json({ success: true });
        }

        if (url.pathname === "/api/admin/inquiries" && request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM inquiries ORDER BY created_at DESC").all();
          return json(results || []);
        }

        if (url.pathname.startsWith("/api/admin/inquiries/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/inquiries/", "");
          await env.DB.prepare("DELETE FROM inquiries WHERE id = ?").bind(id).run();
          return json({ success: true });
        }

        // ⚙️ SAVE STORE SETTINGS (INCLUDING MITCHELL'S PLAIN TOGGLE)
        if (url.pathname === "/api/admin/settings" && request.method === "POST") {
          const { delivery_base_fee, free_delivery_threshold, hidden_categories, mitchells_plain_only } = await request.json();
          await env.DB.batch([
            env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'delivery_base_fee'").bind(String(delivery_base_fee)),
            env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'free_delivery_threshold'").bind(String(free_delivery_threshold)),
            env.DB.prepare("DELETE FROM settings WHERE key = 'hidden_categories'"),
            env.DB.prepare("INSERT INTO settings (key, value) VALUES ('hidden_categories', ?)").bind(String(hidden_categories || '')),
            env.DB.prepare("DELETE FROM settings WHERE key = 'mitchells_plain_only'"),
            env.DB.prepare("INSERT INTO settings (key, value) VALUES ('mitchells_plain_only', ?)").bind(String(mitchells_plain_only ? 1 : 0))
          ]);
          return json({ success: true });
        }

        if (url.pathname === "/api/admin/upload" && request.method === "POST") {
          const formData = await request.formData();
          const files = formData.getAll("file");
          if (!files || files.length === 0) return json({ error: "No files provided" }, 400);

          const uploadedUrls = [];
          for (const file of files) {
            if (file instanceof File) {
              const ext = file.name.split(".").pop() || "jpg";
              const fileKey = `products/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.${ext}`;
              await env.IMAGES_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type } });
              uploadedUrls.push(`/api/images/${fileKey}`);
            }
          }
          return json({ success: true, imageUrls: uploadedUrls });
        }

        if (url.pathname === "/api/admin/orders" && request.method === "GET") {
          const { results: orders } = await env.DB.prepare("SELECT * FROM orders WHERE payment_status = 'Paid' ORDER BY created_at DESC").all();
          const { results: allItems } = await env.DB.prepare("SELECT * FROM order_items").all();
          return json((orders || []).map(o => ({ ...o, items: (allItems || []).filter(i => i.order_id === o.id) })));
        }

        if (url.pathname.startsWith("/api/admin/orders/") && request.method === "PUT") {
          const orderId = url.pathname.replace("/api/admin/orders/", "");
          const { status } = await request.json();
          await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, orderId).run();

          const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();

          if (order && order.customer_email) {
            if (status === "Out for Delivery") {
              ctx.waitUntil(
                sendSystemEmail(env, {
                  to: order.customer_email,
                  toName: order.customer_name,
                  subject: `Your MP Market order is on its way! 🚚 (#${order.order_number})`,
                  htmlContent: renderOutForDeliveryEmail(order)
                })
              );
            } else if (status === "Delivered") {
              ctx.waitUntil(
                sendSystemEmail(env, {
                  to: order.customer_email,
                  toName: order.customer_name,
                  subject: `Delivered: Order #${order.order_number} — Thank you for supporting local! 🇿🇦`,
                  htmlContent: renderDeliveredEmail(order)
                })
              );
            }
          }

          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "ORDER_STATUS_UPDATED", orderId, status })
          }));

          return json({ success: true });
        }

        if (url.pathname === "/api/admin/orders/purge-delivered" && request.method === "POST") {
          const { results: deliveredOrders } = await env.DB.prepare("SELECT id FROM orders WHERE status = 'Delivered'").all();
          if (deliveredOrders && deliveredOrders.length > 0) {
            const ids = deliveredOrders.map(o => `'${o.id}'`).join(",");
            await env.DB.batch([
              env.DB.prepare(`DELETE FROM order_items WHERE order_id IN (${ids})`),
              env.DB.prepare("DELETE FROM orders WHERE status = 'Delivered'")
            ]);
          }
          return json({ success: true, count: (deliveredOrders || []).length });
        }

        if (url.pathname.startsWith("/api/admin/products/toggle/") && request.method === "POST") {
          const id = url.pathname.replace("/api/admin/products/toggle/", "");
          await env.DB.prepare("UPDATE products SET is_available = CASE WHEN is_available = 1 THEN 0 ELSE 1 END WHERE id = ?").bind(id).run();
          
          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "CATALOGUE_UPDATED" })
          }));

          return json({ success: true });
        }

        if (url.pathname === "/api/admin/products" && request.method === "POST") {
          const { name, description, price, public_source, internal_supplier, available_sizes, available_colors, category_id, image_url, sourcing_time, is_new_arrival } = await request.json();
          const id = `prod-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
          
          await env.DB.prepare(
            `INSERT INTO products (id, name, description, price, public_source, internal_supplier, available_sizes, available_colors, is_available, is_new_arrival, sourcing_time, category_id, image_url, is_local_find)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`
          ).bind(id, name, description || "", parseFloat(price), public_source || "Local Partner", internal_supplier || "Local Partner", available_sizes || "", available_colors || "", is_new_arrival ? 1 : 0, sourcing_time || "Dispatched in 48h", category_id, image_url || "").run();

          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "CATALOGUE_UPDATED" })
          }));

          return json({ success: true, id }, 201);
        }

        if (url.pathname.startsWith("/api/admin/products/") && request.method === "PUT") {
          const id = url.pathname.replace("/api/admin/products/", "");
          const { name, description, price, public_source, internal_supplier, available_sizes, available_colors, category_id, image_url, sourcing_time, is_new_arrival } = await request.json();

          await env.DB.prepare(
            `UPDATE products 
             SET name = ?, description = ?, price = ?, public_source = ?, internal_supplier = ?, available_sizes = ?, available_colors = ?, category_id = ?, image_url = ?, sourcing_time = ?, is_new_arrival = ?
             WHERE id = ?`
          ).bind(name, description || "", parseFloat(price), public_source || "Local Partner", internal_supplier || "Local Partner", available_sizes || "", available_colors || "", category_id, image_url || "", sourcing_time || "Dispatched in 48h", is_new_arrival ? 1 : 0, id).run();

          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "CATALOGUE_UPDATED" })
          }));

          return json({ success: true, id });
        }

        if (url.pathname.startsWith("/api/admin/products/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/products/", "");
          await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();

          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "CATALOGUE_UPDATED" })
          }));

          return json({ success: true });
        }

        // DIRECTORY ADMIN APPROVALS & MODERATION
        if (url.pathname === "/api/admin/directory" && request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM directory_listings ORDER BY created_at DESC").all();
          return json(results || []);
        }

        if (url.pathname.startsWith("/api/admin/directory/") && url.pathname.endsWith("/status") && request.method === "PUT") {
          const id = url.pathname.replace("/api/admin/directory/", "").replace("/status", "");
          const { status } = await request.json();
          await env.DB.prepare("UPDATE directory_listings SET status = ? WHERE id = ?").bind(status, id).run();
          return json({ success: true });
        }

        if (url.pathname.startsWith("/api/admin/directory/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/directory/", "");
          await env.DB.batch([
            env.DB.prepare("DELETE FROM directory_reviews WHERE listing_id = ?").bind(id),
            env.DB.prepare("DELETE FROM directory_listings WHERE id = ?").bind(id)
          ]);
          return json({ success: true });
        }
      }

      // -------------------------------------------------------------
      // 📍 ZERO-LEAK PUBLIC DIRECTORY API
      // -------------------------------------------------------------
      if (url.pathname === "/api/directory/listings" && request.method === "GET") {
        const search = url.searchParams.get("search");
        const suburb = url.searchParams.get("suburb");
        const category = url.searchParams.get("category");
        const shop = url.searchParams.get("shop");

        let query = `
          SELECT d.id, d.business_name, d.slug, d.category, d.suburb, 
                 d.about_text, d.logo_url, d.showcase_items, d.created_at,
                 COALESCE(AVG(r.rating), 5.0) as avg_rating,
                 COUNT(r.id) as review_count
          FROM directory_listings d
          LEFT JOIN directory_reviews r ON d.id = r.listing_id
          WHERE d.status = 'active'
        `;
        const params = [];

        if (shop) {
          query += " AND (d.slug = ? OR d.id = ?)";
          params.push(shop, shop);
        } else {
          if (suburb && suburb !== "ALL") {
            query += " AND LOWER(d.suburb) = ?";
            params.push(suburb.toLowerCase());
          }
          if (category && category !== "ALL") {
            query += " AND d.category = ?";
            params.push(category);
          }
          if (search && search.trim()) {
            const term = `%${search.trim().toLowerCase()}%`;
            query += " AND (LOWER(d.business_name) LIKE ? OR LOWER(d.suburb) LIKE ? OR LOWER(d.category) LIKE ? OR LOWER(d.about_text) LIKE ? OR LOWER(d.showcase_items) LIKE ?)";
            params.push(term, term, term, term, term);
          }
        }

        query += " GROUP BY d.id ORDER BY d.created_at DESC";
        const { results } = await env.DB.prepare(query).bind(...params).all();

        const { results: suburbRows } = await env.DB.prepare("SELECT DISTINCT suburb FROM directory_listings WHERE status = 'active' ORDER BY suburb ASC").all();
        const activeSuburbs = (suburbRows || []).map(r => r.suburb).filter(Boolean);

        return json({ listings: results || [], suburbs: activeSuburbs });
      }

      if (url.pathname.startsWith("/api/directory/contact/") && request.method === "GET") {
        const id = url.pathname.replace("/api/directory/contact/", "").trim();
        const itemTitle = url.searchParams.get("item");
        const itemPrice = url.searchParams.get("price");

        const listing = await env.DB.prepare("SELECT business_name, whatsapp_number FROM directory_listings WHERE (id = ? OR slug = ?) AND status = 'active'").bind(id, id).first();
        if (!listing || !listing.whatsapp_number) {
          return new Response("Seller contact not available", { status: 404 });
        }

        let clean = (listing.whatsapp_number || '').replace(/[^0-9]/g, '');
        if (clean.startsWith('0')) clean = '27' + clean.slice(1);
        else if (!clean.startsWith('27')) clean = '27' + clean;

        let message = `Hi ${listing.business_name}! I saw your listing on the MP Market Community Directory. Are you available for orders?`;
        if (itemTitle) {
          message = `Hi ${listing.business_name}! I saw your ${itemTitle} ${itemPrice ? `(R${itemPrice})` : ''} on MP Market. Can I place an order?`;
        }

        return Response.redirect(`https://wa.me/${clean}?text=${encodeURIComponent(message)}`, 302);
      }

      if (url.pathname.startsWith("/api/directory/reviews/") && request.method === "GET") {
        const listingId = url.pathname.replace("/api/directory/reviews/", "");
        const { results } = await env.DB.prepare("SELECT id, listing_id, customer_name, rating, comment, created_at FROM directory_reviews WHERE listing_id = ? ORDER BY created_at DESC").bind(listingId).all();
        return json(results || []);
      }

      if (url.pathname === "/api/directory/reviews" && request.method === "POST") {
        const { listing_id, customer_name, rating, comment } = await request.json();
        if (!listing_id || !customer_name || !rating) return json({ error: "Missing rating" }, 400);

        const revId = `drev-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO directory_reviews (id, listing_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)"
        ).bind(revId, listing_id, customer_name.trim(), parseInt(rating, 10), (comment || '').trim()).run();

        return json({ success: true, id: revId }, 201);
      }

      if (url.pathname === "/api/directory/my-listing" && request.method === "POST") {
        const { email } = await request.json();
        if (!email) return json({ error: "Missing email" }, 400);
        const { results } = await env.DB.prepare("SELECT * FROM directory_listings WHERE LOWER(owner_email) = ? LIMIT 1").bind(email.toLowerCase().trim()).all();
        return json(results && results.length > 0 ? results[0] : null);
      }

      if (url.pathname === "/api/directory/submit" && request.method === "POST") {
        const body = await request.json();
        const { owner_email, business_name, category, suburb, whatsapp_number, about_text, logo_url, showcase_items, consent_agreed } = body;

        if (!owner_email || !business_name || !category || !suburb || !whatsapp_number) {
          return json({ error: "Please fill in all required fields." }, 400);
        }

        if (!consent_agreed) {
          return json({ error: "You must agree to the directory information notice." }, 400);
        }

        const slug = business_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `shop-${Date.now()}`;
        const cleanPhone = whatsapp_number.replace(/[^0-9]/g, "");

        const existing = await env.DB.prepare("SELECT id FROM directory_listings WHERE LOWER(owner_email) = ?").bind(owner_email.toLowerCase().trim()).first();

        if (existing) {
          await env.DB.prepare(`
            UPDATE directory_listings SET
              business_name = ?, slug = ?, category = ?, suburb = ?, whatsapp_number = ?,
              about_text = ?, logo_url = ?, showcase_items = ?, status = 'pending_approval'
            WHERE id = ?
          `).bind(business_name, slug, category, suburb.trim(), cleanPhone, about_text || "", logo_url || "", JSON.stringify(showcase_items || []), existing.id).run();

          return json({ success: true, id: existing.id, updated: true });
        } else {
          const id = `dir-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
          await env.DB.prepare(`
            INSERT INTO directory_listings (id, owner_email, business_name, slug, category, suburb, whatsapp_number, about_text, logo_url, showcase_items, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval')
          `).bind(id, owner_email.toLowerCase().trim(), business_name, slug, category, suburb.trim(), cleanPhone, about_text || "", logo_url || "", JSON.stringify(showcase_items || [])).run();

          const ownerAlertEmail = env.OWNER_NOTIFICATION_EMAIL || "docfloweditor@gmail.com";
          ctx.waitUntil(
            sendSystemEmail(env, {
              to: ownerAlertEmail,
              toName: "MP Market Admin",
              subject: `📢 New Directory Submission: ${business_name} (${suburb})`,
              htmlContent: `
                <div style="font-family: sans-serif; padding: 20px;">
                  <h2>New Community Listing Submitted for Review</h2>
                  <p><strong>Business:</strong> ${business_name}</p>
                  <p><strong>Owner Email:</strong> ${owner_email}</p>
                  <p><strong>Suburb:</strong> ${suburb}</p>
                  <p><strong>Category:</strong> ${category}</p>
                  <p>Log into Admin to inspect photos and tap <strong>Approve</strong>.</p>
                </div>
              `
            })
          );

          return json({ success: true, id }, 201);
        }
      }

      if (url.pathname === "/api/directory/upload" && request.method === "POST") {
        try {
          const formData = await request.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File)) return json({ error: "No image file provided" }, 400);

          const ext = file.name.split(".").pop() || "jpg";
          const fileKey = `directory/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.${ext}`;
          await env.IMAGES_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type } });
          return json({ success: true, imageUrl: `/api/images/${fileKey}` });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      return json({ error: "Endpoint not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "Internal Server Error" }, 500);
    }
  }
};
