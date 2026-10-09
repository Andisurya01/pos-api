import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** `@Body(new ZodValidationPipe(schema))` — rejects with 400 and per-field messages. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Data tidak valid',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
