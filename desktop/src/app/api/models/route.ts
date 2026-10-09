import { getModelCatalog } from "../../../lib/model-catalog";

export async function GET() {
  try { return Response.json(await getModelCatalog(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    console.error("Unable to list Copilot models.", error);
    return Response.json({ error: "Models are unavailable. Check Copilot sign-in and retry." }, { status: 503 });
  }
}
