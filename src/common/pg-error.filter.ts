import {
  type ArgumentsHost,
  Catch,
  ConflictException,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

interface PgError {
  code: string;
  constraint?: string;
  detail?: string;
}

/** Human messages for constraints users can actually hit. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  users_username_lower_uq: 'Username sudah dipakai',
  roles_name_unique: 'Nama role sudah dipakai',
  categories_parent_name_uq: 'Nama kategori sudah ada',
  brands_name_uq: 'Nama merek sudah ada',
  units_code_uq: 'Kode satuan sudah ada',
  suppliers_code_unique: 'Kode supplier sudah dipakai',
  skus_code_uq: 'Kode SKU sudah dipakai',
  barcodes_pkey: 'Barcode sudah dipakai produk lain',
  sku_units_sku_unit_uq: 'Satuan ini sudah ada di SKU tersebut',
  members_phone_unique: 'Nomor HP sudah terdaftar sebagai member',
  members_card_no_unique: 'Nomor kartu member sudah dipakai',
};

function findPgError(error: unknown): PgError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 3; depth++) {
    const candidate = current as Partial<PgError> & { cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate as PgError;
    }
    current = candidate.cause;
  }
  return null;
}

/**
 * Turns unique/foreign-key violations that slip past service checks into 409s
 * instead of 500s. Everything else falls through to Nest's default handling.
 */
@Catch()
export class PgErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PgErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (!(exception instanceof HttpException)) {
      const pg = findPgError(exception);
      if (pg?.code === '23505') {
        return super.catch(
          new ConflictException(
            CONSTRAINT_MESSAGES[pg.constraint ?? ''] ?? 'Data sudah ada',
          ),
          host,
        );
      }
      if (pg?.code === '23503') {
        return super.catch(
          new ConflictException('Data masih dipakai atau rujukannya tidak ditemukan'),
          host,
        );
      }
      if (pg) this.logger.error(`Postgres ${pg.code} ${pg.constraint ?? ''}`, exception as Error);
    }
    return super.catch(exception, host);
  }
}
