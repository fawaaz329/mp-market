/**
 * MP MARKET BACKEND
 * Cloudflare Worker + D1 + R2 + Durable Objects + Yoco Checkouts + Contact Inquiries
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

// EMAIL DISPATCHER
async function sendMailChannelsEmail(env, { to, toName, subject, htmlContent, textContent }) {
  try {
    const fromEmail = env.SENDER_EMAIL || "orders@mp-market.co.za";
    const fromName = env.SENDER_NAME || "MP Market";

    const payload = {
      personalizations: [{ to: [{ email: to, name: toName || to }] }],
      from: { email: fromEmail, name: fromName },
      subject: subject,
      content: [
        { type: "text/plain", value: textContent || "MP Market notification" },
        { type: "text/html", value: htmlContent }
      ]
    };

    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    return res.ok;
  } catch (err) {
    return false;
  }
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
      if (url.pathname === "/api/ws/admin") {
        const id = env.REALTIME.idFromName("mp-market-global-room");
        const obj = env.REALTIME.get(id);
        return obj.fetch(new Request("https://realtime/ws", { headers: request.headers }));
      }

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

      if (url.pathname === "/api/config" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM settings").all();
        const settingsMap = Object.fromEntries(results.map(r => [r.key, parseFloat(r.value)]));
        return json({
          delivery_base_fee: settingsMap.delivery_base_fee || 30.0,
          free_delivery_threshold: settingsMap.free_delivery_threshold || 600.0
        });
      }

      if (url.pathname === "/api/categories" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM categories ORDER BY name ASC").all();
        return json(results);
      }

      // CUSTOMER CONTACT FORM SUBMISSION
      if (url.pathname === "/api/contact" && request.method === "POST") {
        const { first_name, last_name, email, message } = await request.json();
        if (!first_name || !last_name || !email || !message) {
          return json({ error: "Missing required contact fields" }, 400);
        }

        const inquiryId = `inq-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO inquiries (id, first_name, last_name, email, message) VALUES (?, ?, ?, ?, ?)"
        ).bind(inquiryId, first_name.trim(), last_name.trim(), email.trim(), message.trim()).run();

        // Email Alert to Store Owner
        const ownerEmail = env.OWNER_NOTIFICATION_EMAIL || env.ADMIN_EMAIL;
        if (ownerEmail) {
          ctx.waitUntil(
            sendMailChannelsEmail(env, {
              to: ownerEmail,
              toName: "MP Market Admin",
              subject: `💬 New Customer Inquiry from ${first_name} ${last_name}`,
              htmlContent: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #171717;">
                  <h3 style="color: #C45A2C; margin-top:0;">New Inquiry Submitted on MP Market</h3>
                  <p><strong>From:</strong> ${first_name} ${last_name} (${email})</p>
                  <p><strong>Message:</strong></p>
                  <div style="background: #F7F4EF; border-left: 4px solid #C45A2C; padding: 12px; margin: 12px 0;">${message}</div>
                  <p style="font-size: 12px; color: #737373;">You can reply directly to: <a href="mailto:${email}">${email}</a></p>
                </div>
              `
            })
          );
        }

        return json({ success: true, id: inquiryId }, 201);
      }

      // PRODUCTS QUERY
      if (url.pathname === "/api/products" && request.method === "GET") {
        const category = url.searchParams.get("category");
        const search = url.searchParams.get("search");
        const isNewArrival = url.searchParams.get("new_arrivals");

        let query = `
          SELECT p.*, 
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
          query += ` AND (LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.supplier_name) LIKE ?)`;
          params.push(term, term, term);
        } else if (category && category !== "cat-all") {
          query += " AND p.category_id = ?";
          params.push(category);
        }

        query += " GROUP BY p.id ORDER BY p.created_at DESC";
        const { results } = await env.DB.prepare(query).bind(...params).all();
        return json(results);
      }

      if (url.pathname.startsWith("/api/reviews/") && request.method === "GET") {
        const productId = url.pathname.replace("/api/reviews/", "");
        const { results } = await env.DB.prepare("SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC").bind(productId).all();
        return json(results);
      }

      if (url.pathname === "/api/reviews" && request.method === "POST") {
        const { product_id, customer_name, rating, comment } = await request.json();
        if (!product_id || !customer_name || !rating || !comment) return json({ error: "Missing fields" }, 400);
        const revId = `rev-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO reviews (id, product_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)"
        ).bind(revId, product_id, customer_name, parseInt(rating, 10), comment).run();
        return json({ success: true, id: revId }, 201);
      }

      // CHECKOUT SESSION GENERATOR
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

        const productIds = items.map(i => `'${i.id.replace(/'/g, "''")}'`).join(",");
        const { results: dbProducts } = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${productIds})`).all();
        const productMap = new Map(dbProducts.map(p => [p.id, p]));

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
            supplierName: product.supplier_name || 'Local Partner',
            unitPrice: product.price,
            quantity: item.quantity,
            subtotal: sub
          });
        }

        const calculatedDeliveryFee = is_collection ? 0 : Number(delivery_fee || 0);
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
              `INSERT INTO order_items (id, order_id, product_id, product_name, supplier_name, unit_price, quantity, subtotal)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(item.id, orderId, item.productId, item.productName, item.supplierName, item.unitPrice, item.quantity, item.subtotal)
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

      // PAYMENT CONFIRMATION
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
            ctx.waitUntil(sendMailChannelsEmail(env, {
              to: order.customer_email,
              toName: order.customer_name,
              subject: `Order Confirmed: #${order.order_number} — MP Market`,
              htmlContent: `Order #${order.order_number} confirmed. Sourcing in progress.`
            }));
          }
        }

        return json({ success: true, order });
      }

      if (url.pathname.startsWith("/api/orders/customer/") && request.method === "GET") {
        const phone = decodeURIComponent(url.pathname.replace("/api/orders/customer/", "")).trim();
        const { results: orders } = await env.DB.prepare(
          "SELECT * FROM orders WHERE customer_whatsapp = ? ORDER BY created_at DESC"
        ).bind(phone).all();

        const { results: allItems } = await env.DB.prepare("SELECT * FROM order_items").all();
        return json(orders.map(o => ({ ...o, items: allItems.filter(i => i.order_id === o.id) })));
      }

      // ADMIN ROUTES
      if (url.pathname.startsWith("/api/admin")) {
        if (!verifyAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

        if (url.pathname === "/api/admin/verify" && request.method === "POST") return json({ success: true });

        // ADMIN INQUIRIES LIST
        if (url.pathname === "/api/admin/inquiries" && request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM inquiries ORDER BY created_at DESC").all();
          return json(results);
        }

        // DELETE INQUIRY
        if (url.pathname.startsWith("/api/admin/inquiries/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/inquiries/", "");
          await env.DB.prepare("DELETE FROM inquiries WHERE id = ?").bind(id).run();
          return json({ success: true });
        }

        if (url.pathname === "/api/admin/settings" && request.method === "POST") {
          const { delivery_base_fee, free_delivery_threshold } = await request.json();
          await env.DB.batch([
            env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'delivery_base_fee'").bind(String(delivery_base_fee)),
            env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'free_delivery_threshold'").bind(String(free_delivery_threshold))
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
              uploadedUrls.push(`/api/images/${encodeURIComponent(fileKey)}`);
            }
          }

          return json({ success: true, imageUrls: uploadedUrls });
        }

        if (url.pathname === "/api/admin/orders" && request.method === "GET") {
          const { results: orders } = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
          const { results: allItems } = await env.DB.prepare("SELECT * FROM order_items").all();
          return json(orders.map(o => ({ ...o, items: allItems.filter(i => i.order_id === o.id) })));
        }

        if (url.pathname.startsWith("/api/admin/orders/") && request.method === "PUT") {
          const orderId = url.pathname.replace("/api/admin/orders/", "");
          const { status } = await request.json();
          await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, orderId).run();
          return json({ success: true });
        }

        if (url.pathname === "/api/admin/orders/purge-delivered" && request.method === "POST") {
          const { results: deliveredOrders } = await env.DB.prepare("SELECT id FROM orders WHERE status = 'Delivered'").all();
          if (deliveredOrders.length > 0) {
            const ids = deliveredOrders.map(o => `'${o.id}'`).join(",");
            await env.DB.batch([
              env.DB.prepare(`DELETE FROM order_items WHERE order_id IN (${ids})`),
              env.DB.prepare("DELETE FROM orders WHERE status = 'Delivered'")
            ]);
          }
          return json({ success: true, count: deliveredOrders.length });
        }

        if (url.pathname.startsWith("/api/admin/products/toggle/") && request.method === "POST") {
          const id = url.pathname.replace("/api/admin/products/toggle/", "");
          await env.DB.prepare("UPDATE products SET is_available = CASE WHEN is_available = 1 THEN 0 ELSE 1 END WHERE id = ?").bind(id).run();
          return json({ success: true });
        }

        if (url.pathname === "/api/admin/products" && request.method === "POST") {
          const { name, description, price, supplier_name, category_id, image_url, sourcing_time, is_new_arrival } = await request.json();
          const id = `prod-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
          await env.DB.prepare(
            `INSERT INTO products (id, name, description, price, supplier_name, is_available, is_new_arrival, sourcing_time, category_id, image_url, is_local_find)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`
          ).bind(id, name, description || "", parseFloat(price), supplier_name || "Local Partner", is_new_arrival ? 1 : 0, sourcing_time || "Dispatched in 24h", category_id, image_url || "").run();
          return json({ success: true, id }, 201);
        }

        if (url.pathname.startsWith("/api/admin/products/") && request.method === "DELETE") {
          const id = url.pathname.replace("/api/admin/products/", "");
          await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
          return json({ success: true });
        }
      }

      return json({ error: "Endpoint not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "Internal Server Error" }, 500);
    }
  }
};
