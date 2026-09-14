/**
 * Compresses a photo (from a file input or camera capture) down to a small
 * base64 JPEG data URI so it can travel through the same `FormData` pipe as
 * every other field — localStorage queue, Convex `data` string, QR chunks.
 *
 * Kept aggressive on purpose: a form's whole `data` blob has to fit inside a
 * single Convex document, and a scout's local queue lives in localStorage
 * (quota'd, shared with every other queued submission at the event).
 */

const MAX_DIMENSION = 900;
const JPEG_QUALITY = 0.6;

export function compressImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read image"));
    };
    img.src = objectUrl;
  });
}

/** Every photo field's value is a data URI — cheap to detect without needing the field's declared type. */
export function isPhotoDataUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}
