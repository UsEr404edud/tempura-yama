import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'tempura-test-'));
process.env.ADMIN_PIN = '2468';
process.env.TZ = 'America/Sao_Paulo';

const { initDatabase, closeDatabase } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

await initDatabase();
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
});

async function call(pathname, options = {}) {
  const { pin, body, method = 'GET' } = options;
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (pin) headers['x-admin-pin'] = pin;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, headers: response.headers };
}

const orderPayload = {
  customerName: 'Ana Teste',
  serviceType: 'mesa',
  tableNumber: '4',
  paymentMethod: 'pix',
  notes: 'Sem cebolinha',
  items: [
    { productId: 'tempura-camarao', quantity: 2 },
    { productId: 'cha-verde', quantity: 1, notes: 'Sem gelo' },
  ],
};

let createdOrder = null;

test('health check responde com o banco ativo', async () => {
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.status, 'ok');
  assert.equal(data.database, 'sqlite');
});

test('cardápio traz categorias, produtos e destaques', async () => {
  const { status, data } = await call('/api/menu');
  assert.equal(status, 200);
  assert.ok(data.categories.length >= 5);
  assert.ok(data.featured.length >= 3);
  const camarao = data.categories
    .flatMap((category) => category.products)
    .find((product) => product.id === 'tempura-camarao');
  assert.equal(camarao.priceCents, 3290);
  assert.equal(camarao.available, true);
});

test('cria pedido calculando o total no servidor', async () => {
  const { status, data } = await call('/api/orders', { method: 'POST', body: orderPayload });
  assert.equal(status, 201);
  createdOrder = data.order;
  assert.match(createdOrder.code, /^[A-Z0-9]{4}$/);
  assert.equal(createdOrder.status, 'recebido');
  assert.equal(createdOrder.totalCents, 3290 * 2 + 790);
  assert.equal(createdOrder.tableNumber, '04');
  assert.equal(createdOrder.items.length, 2);
});

test('consulta pública pelo código do pedido', async () => {
  const { status, data } = await call(`/api/orders/${createdOrder.code}`);
  assert.equal(status, 200);
  assert.equal(data.order.id, createdOrder.id);
  assert.equal(data.order.customerName, 'Ana Teste');
});

test('rejeita pedido sem nome e quantidade inválida', async () => {
  const semNome = await call('/api/orders', {
    method: 'POST',
    body: { ...orderPayload, customerName: '' },
  });
  assert.equal(semNome.status, 400);

  const quantidadeInvalida = await call('/api/orders', {
    method: 'POST',
    body: {
      ...orderPayload,
      items: [{ productId: 'tempura-camarao', quantity: 0 }],
    },
  });
  assert.equal(quantidadeInvalida.status, 400);
});

test('painel exige PIN correto', async () => {
  const semPin = await call('/api/admin/orders');
  assert.equal(semPin.status, 401);

  const pinErrado = await call('/api/admin/orders', { pin: '0000' });
  assert.equal(pinErrado.status, 401);

  const login = await call('/api/admin/login', {
    method: 'POST',
    body: { pin: '2468' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.ok, true);
});

test('cozinha lista e avança o status do pedido', async () => {
  const list = await call('/api/admin/orders?view=active', { pin: '2468' });
  assert.equal(list.status, 200);
  assert.ok(list.data.orders.some((order) => order.id === createdOrder.id));

  const invalido = await call(`/api/admin/orders/${createdOrder.id}/status`, {
    method: 'PATCH',
    pin: '2468',
    body: { status: 'entregue' },
  });
  assert.equal(invalido.status, 409);

  for (const status of ['preparando', 'pronto', 'entregue']) {
    const result = await call(`/api/admin/orders/${createdOrder.id}/status`, {
      method: 'PATCH',
      pin: '2468',
      body: { status },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.order.status, status);
  }
});

test('estatísticas refletem o pedido do dia', async () => {
  const { status, data } = await call('/api/admin/stats', { pin: '2468' });
  assert.equal(status, 200);
  assert.ok(data.stats.ordersToday >= 1);
  assert.ok(data.stats.revenueCents >= 7370);
  assert.ok(Array.isArray(data.stats.topProducts));
});

test('produto esgotado não pode ser vendido e volta a ficar disponível', async () => {
  const off = await call('/api/admin/products/tempura-shitake', {
    method: 'PATCH',
    pin: '2468',
    body: { available: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.data.product.available, false);

  const attempt = await call('/api/orders', {
    method: 'POST',
    body: {
      ...orderPayload,
      items: [{ productId: 'tempura-shitake', quantity: 1 }],
    },
  });
  assert.equal(attempt.status, 409);

  const menu = await call('/api/menu');
  const shitake = menu.data.categories
    .flatMap((category) => category.products)
    .find((product) => product.id === 'tempura-shitake');
  assert.equal(shitake.available, false);

  const on = await call('/api/admin/products/tempura-shitake', {
    method: 'PATCH',
    pin: '2468',
    body: { available: true },
  });
  assert.equal(on.status, 200);
  assert.equal(on.data.product.available, true);
});

test('404 amigável para pedido inexistente e rota desconhecida', async () => {
  const pedido = await call('/api/orders/ZZZZ');
  assert.equal(pedido.status, 404);
  const rota = await call('/api/nao-existe');
  assert.equal(rota.status, 404);
});

test('manifest e service worker são servidos corretamente', async () => {
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type') || '', /manifest\+json|application\/json/);
  const manifestData = await manifest.json();
  assert.equal(manifestData.display, 'standalone');
  assert.ok(manifestData.icons.length >= 3);

  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type') || '', /javascript/);
  const swBody = await sw.text();
  assert.match(swBody, /addEventListener\('fetch'/);
});

test('rotas do app devolvem o index (SPA fallback)', async () => {
  const response = await fetch(`${base}/qualquer-rota`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Tempura Yama/);
  assert.match(html, /manifest.webmanifest/);
});
