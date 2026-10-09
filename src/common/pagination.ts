import { z } from 'zod';

export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** Same envelope as the KCE API: `{ data, pagination }`. */
export function paginated<T>(data: T[], total: number, query: ListQuery) {
  return {
    data,
    pagination: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export const offsetOf = (query: ListQuery) => (query.page - 1) * query.limit;

/** Escapes LIKE wildcards in user input. */
export const likePattern = (q: string) =>
  `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
