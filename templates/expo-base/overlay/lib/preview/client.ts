/** Native builds never run the preview: it lives in the builder's browser frame. */
export async function previewFetch(): Promise<typeof fetch> {
  throw new Error("The preview runs on the web only");
}
