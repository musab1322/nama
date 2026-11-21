import { test } from "node:test";
import assert from "node:assert/strict";
import { documentType } from "../apps/web/src/lib/documents";

test("licence documents are recognised by their bytes, not their name", () => {
  assert.equal(documentType(new TextEncoder().encode("%PDF-1.7 ..."))?.mime, "application/pdf");
  assert.equal(documentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext, "png");
  assert.equal(documentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext, "jpg");
  assert.equal(documentType(new TextEncoder().encode("<html>")), null);
});
