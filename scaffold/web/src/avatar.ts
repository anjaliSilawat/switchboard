// Every contact gets its own avatar color, always the same one for the same
// phone number (a tiny hash picks from a fixed palette).
const COLORS = ['#e76f51', '#2a9d8f', '#457b9d', '#8a5a83', '#c08a2e', '#3d5a80', '#b5654b', '#4f772d'];

export function avatarColor(key: string) {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 1000;
  return COLORS[hash % COLORS.length];
}

// "Ben Ortiz" -> "BO", "+14155550101" -> "01"
export function initials(name: string) {
  if (name.startsWith('+')) return name.slice(-2);
  const parts = name.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
