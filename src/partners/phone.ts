/**
 * Indonesian mobile numbers to one canonical form (62…, digits only), so
 * "0812-3456-789", "+62 812 3456 789" and "62812…" find the same member.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let normalized: string;
  if (digits.startsWith('62')) normalized = digits;
  else if (digits.startsWith('0')) normalized = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) normalized = `62${digits}`;
  else return null;
  return /^628\d{7,11}$/.test(normalized) ? normalized : null;
}
