import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../access/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { clientMeta } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { passwordSchema, usernameSchema } from './credentials.js';

const ownerSchema = z.object({
  username: usernameSchema,
  fullName: z.string().trim().min(1, 'Nama wajib diisi').max(100),
  password: passwordSchema,
});

/** First-run wizard (docs/alur/01). Locks itself once an owner exists. */
@Controller('setup')
export class SetupController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('status')
  async status() {
    return { needsOwner: await this.auth.needsOwner() };
  }

  @Public()
  @Post('owner')
  createOwner(
    @Body(new ZodValidationPipe(ownerSchema)) body: z.infer<typeof ownerSchema>,
    @Req() req: Request,
  ) {
    return this.auth.createFirstOwner(body, clientMeta(req));
  }
}
