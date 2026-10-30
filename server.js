import { createApp } from './src/app.js';
import { closeDatabase, initDatabase } from './src/db.js';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  await initDatabase();
  const app = createApp();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🍤 Tempura Yama no ar em http://localhost:${PORT}`);
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} recebido, encerrando...`);
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[server] falha ao iniciar:', error);
  process.exit(1);
});
