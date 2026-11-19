import assert from "node:assert/strict";

export async function assertTurnPrompt(request, target, project) {
  const url = `${target}?scope=turn`, turn = await request(url);
  assert.equal(turn.body.prompt, "");
  const prompt = "Check every message.\nKeep it concise.";
  const saved = await request(url, "PUT", JSON.stringify({ ...turn.body, prompt }));
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal((await request(url)).body.prompt, prompt);
  assert.equal((await request(target)).body.prompt, "# Shared designer");
  const page = await request(`/api/desktop/page?path=/${project}/agents/designer/turn-prompt`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.page, { kind: "prompt", document: saved.body });
  assert.equal((await request(url, "PUT", JSON.stringify({ ...turn.body, prompt: "Stale" }))).status, 409);
}
