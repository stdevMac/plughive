// Types for check-pack.mjs (plain JS so it runs without a build).
export interface PackedFile {
  path: string;
  size?: number;
}
export interface PackedEntry {
  files: PackedFile[];
  [key: string]: unknown;
}
export const ALLOWED_TOP: Set<string>;
export const ALLOWED_DIST: Set<string>;
export function targetsOf(pkg: Record<string, unknown>): { where: string; path: string }[];
export function checkPack(pkg: Record<string, unknown>, packed: PackedEntry): string[];
