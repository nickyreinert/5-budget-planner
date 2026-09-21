// --- keypad.js ---
// Digit-buffer math for the custom on-screen numeric keypad (quick-entry
// amount input). The buffer is just the raw digits typed so far, read as an
// integer number of cents - "1234" means 12,34 EUR, exactly like a POS
// terminal's amount entry. This avoids a separate decimal key/position
// entirely. Display formatting is left to the caller (index.html reuses its
// existing fmt_eur(buffer_to_cents(buffer))) - this module has no currency
// formatting of its own.

const MAX_DIGITS = 8; // up to 999999,99

export function push_digit(buffer, digit) {
  if (buffer.length >= MAX_DIGITS) return buffer;
  if (buffer === '0') return digit; // drop a stray leading zero
  return buffer + digit;
}

export function pop_digit(buffer) {
  return buffer.slice(0, -1);
}

export function buffer_to_cents(buffer) {
  return buffer === '' ? 0 : parseInt(buffer, 10);
}
