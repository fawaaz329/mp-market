/**
 * MP MARKET BACKEND
 * Cloudflare Worker + D1 + R2 + Durable Objects + Yoco Hosted Checkouts + MailChannels Emails
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

// -------------------------------------------------------------
// MAILCHANNELS TRANSACTIONAL EMAIL DISPATCHER
// -------------------------------------------------------------
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
    console.error("MailChannels Dispatch Error:", err);
    return false;
  }
}

// EMAIL 1: CUSTOMER ORDER RECEIPT
function renderCustomerOrderEmail(order, items) {
  const itemsHtml = items.map(i => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #E8E3DA;">
        <strong>${i.product_name}</strong><br>
        <span style="font-size: 11px; color: #737373;">Source: ${i.supplier_name || 'Local Partner'}</span>
      </td>
      <td style="padding: 10px 0; border-bottom: 1px solid #E8E3DA; text-align: center;">${i.quantity}</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #E8E3DA; text-align: right; font-weight: 700;">R ${Number(i.unit_price).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F7F4EF; padding: 32px 16px; color: #171717;">
      <div style="max-width: 580px; margin: 0 auto; background: #FFFFFF; border-radius: 8px; border: 1px solid #E8E3DA; padding: 32px; box-shadow: 0 4px 14px rgba(0,0,0,0.04);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="font-size: 20px; font-weight: 800; letter-spacing: 0.5px; margin: 0; text-transform: uppercase;">MP MARKET</h1>
          <p style="font-size: 12px; color: #737373; margin: 4px 0 0;">Local sourcing, made simple.</p>
        </div>

        <p style="font-size: 15px; line-height: 1.5; margin-bottom: 16px;">Hi <strong>${order.customer_name}</strong>,</p>
        <p style="font-size: 14px; color: #404040; line-height: 1.5; margin-bottom: 24px;">
          Thank you for ordering with <strong>MP Market</strong>! We have received your payment, and our local concierge team is now preparing to source your items.
        </p>

        <div style="background: #FAF7F2; border: 1px solid #E8E3DA; border-radius: 6px; padding: 16px; margin-bottom: 24px; font-size: 13px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span><strong>Order Number:</strong></span>
            <span style="color: #C45A2C; font-weight: 800;">${order.order_number}</span>
          </div>
          <div style="margin-bottom: 6px;"><strong>Delivery Address:</strong> ${order.delivery_address}</div>
          <div><strong>WhatsApp:</strong> ${order.customer_whatsapp}</div>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
          <thead>
            <tr style="border-bottom: 2px solid #171717; text-align: left; font-size: 11px; text-transform: uppercase; color: #737373;">
              <th style="padding-bottom: 8px;">Item</th>
              <th style="padding-bottom: 8px; text-align: center;">Qty</th>
              <th style="padding-bottom: 8px; text-align: right;">Price</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>

        <div style="text-align: right; font-size: 13px; line-height: 1.6; margin-bottom: 24px;">
          <div>Subtotal: R ${Number(order.subtotal_amount).toFixed(2)}</div>
          <div>Delivery Fee: ${order.delivery_fee === 0 ? 'FREE' : 'R ' + Number(order.delivery_fee).toFixed(2)}</div>
          <div style="font-size: 16px; font-weight: 800; color: #171717; border-top: 2px solid #E8E3DA; padding-top: 8px; margin-top: 6px;">
            Total Paid: R ${Number(order.total_amount).toFixed(2)}
          </div>
        </div>

        <div style="background: #F3EBE3; border-left: 4px solid #C45A2C; padding: 12px 16px; border-radius: 4px; font-size: 12px; color: #404040; line-height: 1.5; margin-bottom: 28px;">
          <strong>Sourcing Policy Reminder:</strong><br>
          Because we source live from local retailers, stock moves fast. If any item turns out to be out of stock during our pickup run, you will be <strong>100% refunded immediately</strong> for that item as per our Sourcing & Delivery Terms.
        </div>

        <p style="font-size: 13px; color: #737373; margin-bottom: 4px;">We will email you the moment your driver is on the road!</p>
        <p style="font-size: 13px; font-weight: 700; color: #171717; margin: 0;">The MP Market Team</p>
      </div>
    </div>
  `;
}

// EMAIL 2: BUSINESS OWNER NOTIFICATION
function renderOwnerAlertEmail(order, items) {
  const itemsChecklist = items.map(i => `
    <li style="margin-bottom: 8px;">
      <strong>[${i.supplier_name || 'Local Partner'}]:</strong> ${i.quantity}x ${i.product_name} (R ${Number(i.unit_price).toFixed(2)})
    </li>
  `).join('');

  return `
    <div style="font-family: Arial, sans-serif; background-color: #F7F4EF; padding: 24px 16px; color: #171717;">
      <div style="max-width: 580px; margin: 0 auto; background: #FFFFFF; border-radius: 8px; border: 2px solid #C45A2C; padding: 24px;">
        <h2 style="font-size: 18px; color: #C45A2C; margin: 0 0 12px 0;">🚨 New Paid Sourcing Order!</h2>
        <p style="font-size: 14px; margin: 0 0 16px 0;">You have a new paid order ready for procurement and delivery.</p>

        <div style="background: #FAFAFA; border: 1px solid #E8E3DA; padding: 14px; border-radius: 6px; font-size: 13px; margin-bottom: 20px;">
          <div><strong>Order Number:</strong> ${order.order_number}</div>
          <div><strong>Customer Name:</strong> ${order.customer_name}</div>
          <div><strong>Email:</strong> ${order.customer_email || 'N/A'}</div>
          <div><strong>WhatsApp:</strong> <a href="https://wa.me/${order.customer_whatsapp.replace(/[^0-9]/g, '')}" target="_blank" style="color: #C45A2C; font-weight: bold;">${order.customer_whatsapp}</a></div>
          <div><strong>Delivery Address:</strong> ${order.delivery_address}</div>
        </div>

        <h3 style="font-size: 14px; margin: 0 0 10px 0; text-transform: uppercase;">🛒 Items to Pick Up (Grouped by Shop):</h3>
        <ul style="padding-left: 20px; font-size: 13px; margin: 0 0 20px 0; line-height: 1.5;">${itemsChecklist}</ul>

        <div style="background: #FAF7F2; padding: 12px; border-radius: 6px; font-size: 13px; margin-bottom: 20px;">
          <div><strong>Total Collected:</strong> R ${Number(order.total_amount).toFixed(2)}</div>
          <div><strong>Delivery Fee Earned:</strong> ${order.delivery_fee === 0 ? 'FREE' : 'R ' + Number(order.delivery_fee).toFixed(2)}</div>
          <div><strong>Payment Status:</strong> Paid via Yoco Online</div>
        </div>

        <p style="font-size: 12px; color: #737373; margin: 0;">Log into your Control Portal at /admin.html to print your single-page waybill and update delivery progress.</p>
      </div>
    </div>
  `;
}

// EMAIL 3: OUT FOR DELIVERY
function renderOutForDeliveryEmail(order) {
  return `
    <div style="font-family: Arial, sans-serif; background-color: #F7F4EF; padding: 32px 16px; color: #171717;">
      <div style="max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 8px; border: 1px solid #E8E3DA; padding: 32px;">
        <h2 style="font-size: 20px; font-weight: 800; margin: 0 0 12px 0;">Your order is on its way! 🚚</h2>
        <p style="font-size: 14px; line-height: 1.5; margin-bottom: 16px;">Hi <strong>${order.customer_name}</strong>,</p>
        <p style="font-size: 14px; color: #404040; line-height: 1.5; margin-bottom: 20px;">
          Great news! All items for your order <strong>#${order.order_number}</strong> have been successfully sourced and packed.
        </p>

        <div style="background: #FAF7F2; border: 1px solid #E8E3DA; border-radius: 6px; padding: 16px; margin-bottom: 20px; font-size: 13px;">
          <p style="margin: 0 0 6px 0; font-weight: bold; color: #C45A2C;">🚚 Driver En Route To:</p>
          <p style="margin: 0; font-size: 14px;">${order.delivery_address}</p>
        </div>

        <p style="font-size: 13px; color: #404040; line-height: 1.5; margin-bottom: 24px;">
          Please ensure someone is available at the address to receive the parcel. If you need to send specific gate instructions, reply directly to this email or send us a WhatsApp message.
        </p>

        <p style="font-size: 13px; font-weight: bold; margin: 0;">See you shortly!</p>
        <p style="font-size: 13px; color: #737373; margin: 4px 0 0;">The MP Market Delivery Team</p>
      </div>
    </div>
  `;
}

// EMAIL 4: DELIVERED & THANK YOU
function renderDeliveredEmail(order) {
  return `
    <div style="font-family: Arial, sans-serif; background-color: #F7F4EF; padding: 32px 16px; color: #171717;">
      <div style="max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 8px; border: 1px solid #E8E3DA; padding: 32px;">
        <h2 style="font-size: 20px; font-weight: 800; color: #171717; margin: 0 0 12px 0;">Order Delivered 🇿🇦</h2>
        <p style="font-size: 14px; line-height: 1.5; margin-bottom: 16px;">Hi <strong>${order.customer_name}</strong>,</p>
        <p style="font-size: 14px; color: #404040; line-height: 1.5; margin-bottom: 20px;">
          Your order <strong>#${order.order_number}</strong> has been successfully delivered. We hope you love your new items!
        </p>

        <div style="background: #FAF7F2; border-left: 4px solid #C45A2C; padding: 14px 16px; border-radius: 4px; font-size: 13px; color: #404040; line-height: 1.5; margin-bottom: 24px;">
          <strong>❤️ Thank You for Supporting Local</strong><br>
          By ordering through MP Market, you are directly supporting local suppliers, retailers, and community couriers in Mitchell's Plain. Sourcing close to home keeps our community thriving.
        </div>

        <div style="text-align: center; padding: 16px; background: #FAFAFA; border: 1px solid #E8E3DA; border-radius: 6px; margin-bottom: 24px;">
          <p style="font-size: 13px; font-weight: bold; margin: 0 0 6px 0;">⭐ How did we do?</p>
          <p style="font-size: 12px; color: #737373; margin: 0;">We would love to hear your thoughts! Feel free to visit our store to leave a quick star review on the items you received.</p>
        </div>

        <p style="font-size: 13px; color: #737373; margin: 0;">Thank you once again for choosing MP Market!</p>
        <p style="font-size: 13px; font-weight: 700; color: #171717; margin: 4px 0 0;">The MP Market Team</p>
      </div>
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
          delivery_base_fee: settingsMap.delivery_base_fee || 60.0,
          free_delivery_threshold: settingsMap.free_delivery_threshold || 600.0
        });
      }

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

        if (search && search.trim()) {
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
        if (!product_id || !customer_name || !rating || !comment) {
          return json({ error: "Missing required review fields" }, 400);
        }
        const revId = `rev-${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO reviews (id, product_id, customer_name, rating, comment) VALUES (?, ?, ?, ?, ?)"
        ).bind(revId, product_id, customer_name, parseInt(rating, 10), comment).run();

        return json({ success: true, id: revId }, 201);
      }

      // -------------------------------------------------------------
      // 🚀 SERVER-TO-SERVER YOCO HOSTED CHECKOUT CREATOR
      // -------------------------------------------------------------
      if (url.pathname === "/api/orders/create-checkout" && request.method === "POST") {
        const body = await request.json();
        const { customer_name, customer_email, customer_whatsapp, delivery_address, items } = body;

        if (!customer_name || !customer_email || !customer_whatsapp || !delivery_address || !items || !items.length) {
          return json({ error: "Missing required order information" }, 400);
        }

        const secretKey = (env.YOCO_SECRET_KEY || "").trim().replace(/['"]/g, "");
        if (!secretKey || !secretKey.startsWith("sk_")) {
          return json({ error: "YOCO_SECRET_KEY is not configured in Cloudflare Settings -> Variables and Secrets." }, 400);
        }

        const { results: settingsRows } = await env.DB.prepare("SELECT * FROM settings").all();
        const settingsMap = Object.fromEntries(settingsRows.map(r => [r.key, parseFloat(r.value)]));
        const baseFee = settingsMap.delivery_base_fee || 60.0;
        const freeThreshold = settingsMap.free_delivery_threshold || 600.0;

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
            supplierName: product.supplier_name || 'Local Partner',
            unitPrice: product.price,
            quantity: item.quantity,
            subtotal: sub
          });
        }

        const deliveryFee = computedSubtotal >= freeThreshold ? 0.0 : baseFee;
        const computedTotal = computedSubtotal + deliveryFee;

        const orderId = `ord-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        const orderNumber = `MPM-${Math.floor(100000 + Math.random() * 900000)}`;

        // Save Order as Pending Payment
        const statements = [
          env.DB.prepare(
            `INSERT INTO orders (id, order_number, customer_name, customer_email, customer_whatsapp, delivery_address, subtotal_amount, delivery_fee, total_amount, status, payment_status, payment_method) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Payment', 'Pending', 'Yoco Online')`
          ).bind(orderId, orderNumber, customer_name, customer_email.trim(), customer_whatsapp, delivery_address, computedSubtotal, deliveryFee, computedTotal)
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

        // Server-to-Server Call to Yoco Checkouts API
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
          return json({ error: yocoData.message || yocoData.displayMessage || "Could not generate Yoco payment session." }, 400);
        }

        return json({
          success: true,
          redirect_url: yocoData.redirectUrl,
          order_number: orderNumber
        }, 201);
      }

      // -------------------------------------------------------------
      // AUTOMATIC CONFIRMATION & EMAIL DISPATCH ON PAYMENT RETURN
      // -------------------------------------------------------------
      if (url.pathname === "/api/orders/confirm-payment" && request.method === "POST") {
        const { order_number } = await request.json();
        if (!order_number) return json({ error: "Missing order number" }, 400);

        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_number = ?").bind(order_number).first();
        if (!order) return json({ error: "Order not found" }, 404);

        // If not already processed, mark as Paid and dispatch emails
        if (order.payment_status !== "Paid") {
          await env.DB.prepare(
            "UPDATE orders SET payment_status = 'Paid', status = 'Sourced', payment_method = 'Yoco Online' WHERE id = ?"
          ).bind(order.id).run();

          const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(order.id).all();

          const updatedOrder = { ...order, status: "Sourced", payment_status: "Paid", items };

          // Real-time WebSocket ping to Admin
          const doId = env.REALTIME.idFromName("mp-market-global-room");
          const doObj = env.REALTIME.get(doId);
          await doObj.fetch(new Request("https://realtime/broadcast", {
            method: "POST",
            body: JSON.stringify({ event: "NEW_ORDER", order: updatedOrder })
          }));

          // DISPATCH EMAIL 1: Customer Receipt
          if (order.customer_email) {
            ctx.waitUntil(
              sendMailChannelsEmail(env, {
                to: order.customer_email,
                toName: order.customer_name,
                subject: `Order Confirmed: #${order.order_number} — MP Market`,
                htmlContent: renderCustomerOrderEmail(order, items)
              })
            );
          }

          // DISPATCH EMAIL 2: Owner Alert
          const ownerEmail = env.OWNER_NOTIFICATION_EMAIL || env.ADMIN_EMAIL;
          if (ownerEmail) {
            ctx.waitUntil(
              sendMailChannelsEmail(env, {
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

      // ADMIN ROUTES
      if (url.pathname.startsWith("/api/admin")) {
        if (!verifyAdmin(request, env)) {
          return json({ error: "Unauthorized. Invalid ADMIN_PASSWORD." }, 401);
        }

        if (url.pathname === "/api/admin/verify" && request.method === "POST") {
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
          const file = formData.get("file");
          if (!file || !(file instanceof File)) return json({ error: "No image file provided" }, 400);

          const ext = file.name.split(".").pop() || "jpg";
          const fileKey = `products/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.${ext}`;
          await env.IMAGES_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type } });
          return json({ success: true, imageUrl: `/api/images/${encodeURIComponent(fileKey)}` });
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

          const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();

          if (order && order.customer_email) {
            if (status === "Out for Delivery") {
              ctx.waitUntil(
                sendMailChannelsEmail(env, {
                  to: order.customer_email,
                  toName: order.customer_name,
                  subject: `Your MP Market order is on its way! 🚚 (#${order.order_number})`,
                  htmlContent: renderOutForDeliveryEmail(order)
                })
              );
            } else if (status === "Delivered") {
              ctx.waitUntil(
                sendMailChannelsEmail(env, {
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
          const { name, description, price, supplier_name, category_id, image_url, sourcing_time } = await request.json();
          const id = `prod-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
          await env.DB.prepare(
            `INSERT INTO products (id, name, description, price, supplier_name, is_available, sourcing_time, category_id, image_url, is_local_find)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`
          ).bind(id, name, description || "", parseFloat(price), supplier_name || "Local Partner", sourcing_time || "Dispatched in 24h", category_id, image_url || "").run();
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
