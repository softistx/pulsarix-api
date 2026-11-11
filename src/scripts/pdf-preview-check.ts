import { renderPdfFirstPage } from "@softistx/image/pdf";

// Proves the native half of the PDF previews: renders the first page of a tiny
// PDF through @softistx/image/pdf (pdfjs-dist and the platform's
// @napi-rs/canvas binary). The Dockerfile runs it in the final image, so a
// missing or wrong-libc binary fails the build, not the first upload.
// Exit 0 and one line on success; exit 1 with the reason otherwise.

/** A one-page PDF with a line of text, xref offsets computed. */
export function tinyPdf(): Uint8Array {
  const stream = "BT /F1 24 Tf 20 60 Td (pulsarix) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export async function checkPdfPreview() {
  const image = await renderPdfFirstPage(tinyPdf(), {
    width: 200,
    format: "png",
  });
  if (image.width !== 200 || image.bytes.byteLength < 100)
    throw new Error(`unexpected preview ${image.width}x${image.height}`);
  return image;
}

if (import.meta.main) {
  try {
    const image = await checkPdfPreview();
    console.log(
      `pdf preview ok: ${image.width}x${image.height} ${image.contentType}, ${image.bytes.byteLength} bytes`,
    );
  } catch (error) {
    console.error("pdf preview FAILED:", error);
    process.exit(1);
  }
}
