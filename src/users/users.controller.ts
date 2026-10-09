import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import {
  passwordSchema,
  pinSchema,
  usernameSchema,
} from '../auth/credentials.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UsersService } from './users.service.js';

const fullNameSchema = z.string().trim().min(1, 'Nama wajib diisi').max(100);
const roleIdsSchema = z.array(z.uuid()).min(1, 'Pilih minimal satu role');

const createSchema = z.object({
  username: usernameSchema,
  fullName: fullNameSchema,
  temporaryPassword: passwordSchema,
  roleIds: roleIdsSchema,
});

const updateSchema = z.object({
  fullName: fullNameSchema,
  roleIds: roleIdsSchema,
});

const resetSchema = z.object({ temporaryPassword: passwordSchema });
const pinBodySchema = z.object({ pin: pinSchema });

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('pengaturan.pengguna.lihat')
  list() {
    return this.users.list();
  }

  @Post()
  @RequirePermission('pengaturan.pengguna.buat')
  create(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    return this.users.create(actor, body);
  }

  /** Own PIN; declared before ':id' routes so "me" is not parsed as an id. */
  @Put('me/pin')
  @HttpCode(204)
  async setOwnPin(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(pinBodySchema)) body: z.infer<typeof pinBodySchema>,
  ) {
    await this.users.setOwnPin(actor, body.pin);
  }

  @Put(':id')
  @HttpCode(204)
  @RequirePermission('pengaturan.pengguna.ubah')
  async update(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    await this.users.update(actor, id, body);
  }

  @Post(':id/reset-password')
  @HttpCode(204)
  @RequirePermission('pengaturan.pengguna.ubah')
  async resetPassword(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(resetSchema)) body: z.infer<typeof resetSchema>,
  ) {
    await this.users.resetPassword(actor, id, body.temporaryPassword);
  }

  @Post(':id/deactivate')
  @HttpCode(204)
  @RequirePermission('pengaturan.pengguna.nonaktifkan')
  async deactivate(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.users.setActive(actor, id, false);
  }

  @Post(':id/activate')
  @HttpCode(204)
  @RequirePermission('pengaturan.pengguna.nonaktifkan')
  async activate(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.users.setActive(actor, id, true);
  }
}
