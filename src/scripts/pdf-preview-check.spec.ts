import { expect, test } from "bun:test";
import { checkPdfPreview, tinyPdf } from "./pdf-preview-check";

// The same check the Dockerfile runs in the final image, here on the host's
// own @napi-rs/canvas binary.
test("the tiny PDF renders as a PNG preview at the requested width", async () => {
  const pdf = tinyPdf();
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  const image = await checkPdfPreview();
  expect(image.contentType).toBe("image/png");
  expect(image.width).toBe(200);
  expect(image.source.pages).toBe(1);
}, 30_000);
