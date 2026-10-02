/** Browser filenames/MIME labels are advisory; store recognized raster bytes as their actual type. */
export function referenceImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) return "image/png";
  if (bytes.length >= 12 && [82,73,70,70].every((v,i)=>bytes[i]===v)
    && [87,69,66,80].every((v,i)=>bytes[i+8]===v)) return "image/webp";
  return null;
}