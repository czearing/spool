import { getModelCatalog } from "../../../lib/model-catalog";

export async function GET() {
  try { return Response.json(await getModelCatalog(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    console.error("Unable to list Copilot models.", error);
    const detail = error instanceof Error ? error.message : "";
    const message = /protocol version mismatch/i.test(detail)
      ? "Spool's Copilot runtime is incompatible. Update Spool and retry model loading."
      : /not authenticated|sign.?in|unauthorized|authentication|401/i.test(detail)
        ? "Copilot sign-in is required to load models. Sign in to Copilot and retry model loading."
        : /not found|missing required|could not resolve/i.test(detail)
          ? "Spool's bundled Copilot runtime is missing. Update or reinstall Spool."
          : /timed out/i.test(detail)
            ? "Loading Copilot models timed out. Retry model loading."
            : "Could not load Copilot models. Retry model loading. Other settings are still available.";
    return Response.json({ error: message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
