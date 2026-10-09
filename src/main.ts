import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const API_PREFIX = 'api/v1';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(API_PREFIX);
  // Closes the database pool cleanly when the Windows service is stopped.
  app.enableShutdownHooks();
  // 3000 is taken by the Next.js frontend (pos) in development.
  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
