export const displayDuration = (seconds: number) => `${Math.round(seconds)}s`;

export function localOutputSize(width: number, height: number, families: string[]) {
  const sizes = families.map(family => {
    if (family.toLowerCase() === "minimax h3") return [Math.ceil(width / 32) * 32, Math.ceil(height / 32) * 32];
    if (family === "LTX 2.5") return [Math.max(64, Math.floor(width / 64) * 64), Math.max(64, Math.floor(height / 64) * 64)];
    return [width, height];
  });
  const unique = [...new Set(sizes.map(([w, h]) => `${w} × ${h}`))];
  return unique.length === 1 ? unique[0] : `${width} × ${height} requested`;
}
