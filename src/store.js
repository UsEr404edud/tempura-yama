/**
 * Regras de negócio e consultas do totem.
 */
import crypto from 'node:crypto';
import { execute, one, query, transaction } from './db.js';

export const ORDER_STATUSES = ['recebido', 'preparando', 'pronto', 'entregue', 'cancelado'];

export const STATUS_FLOW = {
  recebido: ['preparando', 'cancelado'],
  preparando: ['pronto', 'cancelado'],
  pronto: ['entregue', 'cancelado'],
  entregue: [],
  cancelado: [],
};

const ORDER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeOrderCode(length = 4) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += ORDER_CODE_ALPHABET[bytes[i] % ORDER_CODE_ALPHABET.length];
  }
  return code;
}

function mapProduct(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    priceCents: Number(row.price_cents),
    emoji: row.emoji,
    prepMinutes: Number(row.prep_minutes),
    available: Number(row.available) === 1,
    featured: Number(row.featured) === 1,
  };
}

function mapOrder(orderRow, itemRows) {
  return {
    id: orderRow.id,
    code: orderRow.code,
    customerName: orderRow.customer_name,
    serviceType: orderRow.service_type,
    tableNumber: orderRow.table_number,
    paymentMethod: orderRow.payment_method,
    notes: orderRow.notes,
    status: orderRow.status,
    subtotalCents: Number(orderRow.subtotal_cents),
    totalCents: Number(orderRow.total_cents),
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at,
    items: itemRows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      name: item.name,
      emoji: item.emoji,
      unitPriceCents: Number(item.unit_price_cents),
      quantity: Number(item.quantity),
      notes: item.notes,
    })),
  };
}

async function itemsForOrders(orders) {
  if (orders.length === 0) return new Map();
  const placeholders = orders.map(() => '?').join(', ');
  const rows = await query(
    `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY sort_order ASC, name ASC`,
    orders.map((order) => order.id),
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.order_id)) grouped.set(row.order_id, []);
    grouped.get(row.order_id).push(row);
  }
  return grouped;
}

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export async function getMenu() {
  const categoryRows = await query('SELECT * FROM categories ORDER BY sort_order ASC, name ASC');
  const productRows = await query(
    'SELECT * FROM products ORDER BY sort_order ASC, name ASC',
  );
  return {
    categories: categoryRows.map((category) => ({
      id: category.id,
      name: category.name,
      tagline: category.tagline,
      products: productRows.filter((p) => p.category_id === category.id).map(mapProduct),
    })),
    featured: productRows
      .filter((p) => Number(p.featured) === 1 && Number(p.available) === 1)
      .map(mapProduct),
    updatedAt: new Date().toISOString(),
  };
}

export async function getOrderByCode(code) {
  const row = await one('SELECT * FROM orders WHERE code = ?', [code]);
  if (!row) return null;
  const items = await query('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order ASC, name ASC', [
    row.id,
  ]);
  return mapOrder(row, items);
}

export async function getOrderById(code) {
  const row = await one('SELECT * FROM orders WHERE id = ?', [code]);
  if (!row) return null;
  const items = await query('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order ASC, name ASC', [
    row.id,
  ]);
  return mapOrder(row, items);
}

export async function createOrder(input) {
  const now = new Date().toISOString();
  const productIds = [...new Set(input.items.map((item) => item.productId))];
  const placeholders = productIds.map(() => '?').join(', ');
  const productRows = await query(
    `SELECT * FROM products WHERE id IN (${placeholders})`,
    productIds,
  );
  const productsById = new Map(productRows.map((row) => [row.id, row]));

  for (const item of input.items) {
    const product = productsById.get(item.productId);
    if (!product) {
      const error = new Error(`Item indisponível no cardápio: ${item.productId}`);
      error.status = 400;
      error.code = 'PRODUCT_NOT_FOUND';
      throw error;
    }
    if (Number(product.available) !== 1) {
      const error = new Error(`O item "${product.name}" está esgotado no momento.`);
      error.status = 409;
      error.code = 'PRODUCT_UNAVAILABLE';
      throw error;
    }
  }

  const orderItems = input.items.map((item) => {
    const product = productsById.get(item.productId);
    return {
      id: crypto.randomUUID(),
      productId: product.id,
      name: product.name,
      emoji: product.emoji,
      unitPriceCents: Number(product.price_cents),
      quantity: item.quantity,
      notes: item.notes || null,
    };
  });

  const subtotalCents = orderItems.reduce(
    (total, item) => total + item.unitPriceCents * item.quantity,
    0,
  );
  const id = crypto.randomUUID();

  return transaction(async (tx) => {
    let code = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = makeOrderCode();
      const existing = await tx.one('SELECT id FROM orders WHERE code = ?', [candidate]);
      if (!existing) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      const error = new Error('Não foi possível gerar o código do pedido. Tente novamente.');
      error.status = 503;
      throw error;
    }

    await tx.execute(
      `INSERT INTO orders
        (id, code, customer_name, service_type, table_number, payment_method, notes, status,
         subtotal_cents, total_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'recebido', ?, ?, ?, ?)`,
      [
        id,
        code,
        input.customerName,
        input.serviceType,
        input.tableNumber || null,
        input.paymentMethod,
        input.notes || null,
        subtotalCents,
        subtotalCents,
        now,
        now,
      ],
    );

    for (const [index, item] of orderItems.entries()) {
      await tx.execute(
        `INSERT INTO order_items
          (id, order_id, product_id, name, emoji, unit_price_cents, quantity, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          id,
          item.productId,
          item.name,
          item.emoji,
          item.unitPriceCents,
          item.quantity,
          item.notes,
          index,
        ],
      );
    }

    return mapOrder(
      {
        id,
        code,
        customer_name: input.customerName,
        service_type: input.serviceType,
        table_number: input.tableNumber || null,
        payment_method: input.paymentMethod,
        notes: input.notes || null,
        status: 'recebido',
        subtotal_cents: subtotalCents,
        total_cents: subtotalCents,
        created_at: now,
        updated_at: now,
      },
      orderItems.map((item) => ({
        id: item.id,
        product_id: item.productId,
        name: item.name,
        emoji: item.emoji,
        unit_price_cents: item.unitPriceCents,
        quantity: item.quantity,
        notes: item.notes,
      })),
    );
  });
}

export async function listOrders({ view = 'active', limit = 60 } = {}) {
  const safeLimit = parseLimit(limit, 60, 200);
  let rows;
  if (view === 'active') {
    rows = await query(
      `SELECT * FROM orders
       WHERE status IN ('recebido', 'preparando', 'pronto')
       ORDER BY created_at ASC
       LIMIT ?`,
      [safeLimit],
    );
  } else if (view === 'history') {
    rows = await query(
      `SELECT * FROM orders
       WHERE status IN ('entregue', 'cancelado')
       ORDER BY created_at DESC
       LIMIT ?`,
      [safeLimit],
    );
  } else {
    rows = await query('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [safeLimit]);
  }
  const grouped = await itemsForOrders(rows);
  return rows.map((row) => mapOrder(row, grouped.get(row.id) || []));
}

export async function updateOrderStatus(id, nextStatus) {
  if (!ORDER_STATUSES.includes(nextStatus)) {
    const error = new Error('Status inválido.');
    error.status = 400;
    error.code = 'INVALID_STATUS';
    throw error;
  }
  const row = await one('SELECT * FROM orders WHERE id = ?', [id]);
  if (!row) {
    const error = new Error('Pedido não encontrado.');
    error.status = 404;
    error.code = 'ORDER_NOT_FOUND';
    throw error;
  }
  const allowed = STATUS_FLOW[row.status] || [];
  if (!allowed.includes(nextStatus)) {
    const error = new Error(
      `Não é possível mudar de "${row.status}" para "${nextStatus}".`,
    );
    error.status = 409;
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
  const now = new Date().toISOString();
  await execute('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [
    nextStatus,
    now,
    id,
  ]);
  return getOrderById(id);
}

export async function setProductAvailability(productId, available) {
  const product = await one('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) {
    const error = new Error('Produto não encontrado.');
    error.status = 404;
    error.code = 'PRODUCT_NOT_FOUND';
    throw error;
  }
  await execute('UPDATE products SET available = ? WHERE id = ?', [available ? 1 : 0, productId]);
  const updated = await one('SELECT * FROM products WHERE id = ?', [productId]);
  return mapProduct(updated);
}

export async function listAdminProducts() {
  const rows = await query(
    `SELECT p.*, c.name AS category_name FROM products p
     JOIN categories c ON c.id = p.category_id
     ORDER BY c.sort_order ASC, p.sort_order ASC`,
  );
  return rows.map((row) => ({
    ...mapProduct(row),
    categoryName: row.category_name,
  }));
}

export async function getStats(sinceIso) {
  const totals = await one(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue
     FROM orders WHERE created_at >= ? AND status <> 'cancelado'`,
    [sinceIso],
  );
  const active = await one(
    `SELECT COUNT(*) AS total FROM orders
     WHERE status IN ('recebido', 'preparando', 'pronto')`,
  );
  const byStatusRows = await query(
    `SELECT status, COUNT(*) AS total FROM orders
     WHERE created_at >= ? GROUP BY status`,
    [sinceIso],
  );
  const topRows = await query(
    `SELECT oi.name, oi.emoji, SUM(oi.quantity) AS quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.created_at >= ? AND o.status <> 'cancelado'
     GROUP BY oi.name, oi.emoji
     ORDER BY quantity DESC
     LIMIT 5`,
    [sinceIso],
  );

  const orderCount = Number(totals.orders);
  const revenue = Number(totals.revenue);

  return {
    ordersToday: orderCount,
    revenueCents: revenue,
    averageTicketCents: orderCount > 0 ? Math.round(revenue / orderCount) : 0,
    activeOrders: Number(active.total),
    byStatus: Object.fromEntries(byStatusRows.map((row) => [row.status, Number(row.total)])),
    topProducts: topRows.map((row) => ({
      name: row.name,
      emoji: row.emoji,
      quantity: Number(row.quantity),
    })),
    generatedAt: new Date().toISOString(),
  };
}

export async function countOrders() {
  const row = await one('SELECT COUNT(*) AS total FROM orders');
  return Number(row.total);
}
