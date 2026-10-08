import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 3000 is taken by the Next.js frontend (pos) in development.
  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
