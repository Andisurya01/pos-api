import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['0812-3456-7890', '6281234567890'],
    ['+62 812 3456 7890', '6281234567890'],
    ['6281234567890', '6281234567890'],
    ['81234567890', '6281234567890'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', '12345', '021-555-1234', '0812'])('rejects %j', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});
