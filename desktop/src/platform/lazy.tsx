import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

export default function dynamic<P extends object>(
  load: () => Promise<ComponentType<P> | { default: ComponentType<P> }>,
  options?: { ssr?: boolean; loading?: () => ReactNode },
) {
  const Component = lazy(async () => {
    const module = await load();
    return { default: "default" in module ? module.default : module };
  });
  return function LazyComponent(props: P) {
    return <Suspense fallback={options?.loading?.() ?? null}><Component {...props} /></Suspense>;
  };
}
