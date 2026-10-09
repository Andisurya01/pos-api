import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { pinSchema } from '../auth/credentials.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AccessService } from './access.service.js';
import { CurrentPrincipal, RequirePermission } from './decorators.js';
import { PinService } from './pin.service.js';
import type { Principal } from './principal.js';
import { isPermissionCode, RolesService } from './roles.service.js';

const permissionCodeSchema = z
  .string()
  .refine(isPermissionCode, 'Kode izin tidak dikenal');

const roleSchema = z.object({
  name: z.string().trim().min(1, 'Nama role wajib diisi').max(50),
  description: z.string().trim().max(200).nullish(),
  permissions: z.array(permissionCodeSchema),
});

const approverQuerySchema = z.object({ permission: permissionCodeSchema });

const pinApprovalSchema = z.object({
  permissionCode: permissionCodeSchema,
  approverId: z.uuid(),
  pin: pinSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});

@Controller('access')
export class AccessController {
  constructor(
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly pins: PinService,
  ) {}

  @Get('permissions')
  @RequirePermission('pengaturan.hak_akses.lihat')
  listPermissions() {
    return this.access.listPermissionTree();
  }

  @Get('roles')
  @RequirePermission('pengaturan.hak_akses.lihat')
  listRoles() {
    return this.access.listRoles();
  }

  @Post('roles')
  @RequirePermission('pengaturan.hak_akses.ubah')
  createRole(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(roleSchema)) body: z.infer<typeof roleSchema>,
  ) {
    return this.roles.create(actor, body);
  }

  @Put('roles/:id')
  @RequirePermission('pengaturan.hak_akses.ubah')
  updateRole(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(roleSchema)) body: z.infer<typeof roleSchema>,
  ) {
    return this.roles.update(actor, id, body);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermission('pengaturan.hak_akses.ubah')
  async deleteRole(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.roles.remove(actor, id);
  }

  /** Any logged-in user (typically a cashier) may ask who can approve an action. */
  @Get('pin-approvers')
  listApprovers(
    @Query(new ZodValidationPipe(approverQuerySchema))
    query: z.infer<typeof approverQuerySchema>,
  ) {
    return this.pins.listApprovers(query.permission);
  }

  @Post('pin-approvals')
  approve(
    @CurrentPrincipal() requester: Principal,
    @Body(new ZodValidationPipe(pinApprovalSchema))
    body: z.infer<typeof pinApprovalSchema>,
  ) {
    return this.pins.approve(requester, body);
  }
}
