import { timestamp } from 'drizzle-orm/pg-core';

/** timestamptz; all instants are stored in UTC (business dates are WIB `date` columns). */
export const timestamptz = () => timestamp({ withTimezone: true });
