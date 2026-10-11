import { trackRepositoryRefresh } from "./runner-details.mjs";

export function trackPreparation(call, getLifecycle, runtime) {
  return async (name, args) => {
    const lifecycle = getLifecycle();
    const preparation = {
      operation: name, repoRoot: args.repoRoot, branch: args.branch,
      prId: args.branch ? lifecycle.status?.pullRequests?.find(pr => pr.branch === args.branch)?.id : undefined,
      startedAt: new Date().toISOString(), progressAt: null,
    };
    lifecycle.observe({ preparation });
    try {
      return await trackRepositoryRefresh(runtime, lifecycle, name, args, () => call(name, args, {
        onProgress(progress) {
          lifecycle.observe({ preparation: { ...preparation,
            progressAt: new Date().toISOString(), message: progress.message } });
        },
      }));
    } finally {
      lifecycle.observe({ preparation: null });
    }
  };
}
