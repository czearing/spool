import { runnerRoute, type RunnerRouteContext } from "../../../../../../../lib/runner-route";
const route = (request: Request, context: RunnerRouteContext) => runnerRoute(request, context, "runs");
export { route as GET, route as POST };
