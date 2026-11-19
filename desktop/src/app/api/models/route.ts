import { getModelCatalog } from "../../../lib/model-catalog";

export async function GET() {
  try { return Response.json(await getModelCatalog(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    console.error("Unable to list Copilot models.", error);
    return Response.json({ error: "The model list is unavailable. Your saved model and other settings can still be used." }, { status: 503 });
  }
}
