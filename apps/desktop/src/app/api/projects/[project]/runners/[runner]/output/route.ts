import { runnerRoute, type RunnerRouteContext } from "../../../../../../../lib/runner-route";
export const GET = (request: Request, context: RunnerRouteContext) => runnerRoute(request, context, "logs");
