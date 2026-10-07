/**
 * The catalog's license field is free text. Only values that clearly grant redistribution and
 * derivative use are permissive; everything else (including unknown strings) is excluded by default.
 */
const PERMISSIVE_PATTERNS: readonly RegExp[] = [
  /^mit(?:-0)?(?:\s+license)?$/,
  /^cc0(?:[\s-]+1\.0)?(?:\s+universal)?$/,
  /^cc[\s-]+by(?:[\s-]+sa)?(?:[\s-]+\d\.\d)?(?:\s+international)?$/,
  /^pixabay(?:\s+content)?(?:\s+license)?$/,
  /^unsplash(?:\s+license)?$/,
  /^public\s+domain$/,
];

export function isPermissiveLicense(license: string): boolean {
  const normalized = license.trim().toLowerCase().replace(/\s+/g, " ");
  return PERMISSIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}
