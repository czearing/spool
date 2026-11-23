import { runnerRoute, type RunnerRouteContext } from "../../../../../../../lib/runner-route";
export const POST = (request: Request, context: RunnerRouteContext) => runnerRoute(request, context, "webhook");
