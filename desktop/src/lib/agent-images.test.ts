import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { decodeAgentImage, readAgentAppearance } from "./agent-icons";
import { isAgentImage } from "./agent-settings";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "spool-images-")); await mkdir(join(root, "agents")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("reads quoted images and descriptions without leaking payloads in image revisions", async () => {
  const file = join(root, "agents", "engineer.md");
  await writeFile(file, `---\ndescription: "Research --- carefully"\nimage: ${JSON.stringify(image)}\n---\nInstructions`);
  const value = await readAgentAppearance(root, "engineer");
  expect(value).toEqual({ icon: "bot", image, imageVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(decodeAgentImage(image).type).toBe("image/png");
  await writeFile(file, "# Instructions only");
  expect(await readAgentAppearance(root, "engineer")).toEqual({ icon: "bot", image: null, imageVersion: null });
});
it("rejects unsafe types, external URLs, invalid encodings and oversized images", () => {
  for (const value of ["https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,!!",
    `data:image/png;base64,${"A".repeat(65536)}`]) {
    expect(isAgentImage(value)).toBe(false);
    expect(() => decodeAgentImage(value)).toThrow();
  }
  expect(() => decodeAgentImage("data:image/png;base64,AAAA")).toThrow();
});
it("rejects duplicate image headers rather than silently choosing one", async () => {
  await writeFile(join(root, "agents", "engineer.md"), `---\nimage: "${image}"\nimage: "${image}"\n---\nInstructions`);
  await expect(readAgentAppearance(root, "engineer")).rejects.toThrow("Duplicate image");
});
