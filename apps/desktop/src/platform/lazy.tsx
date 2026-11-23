import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Stack } from "../components/ui/stack";
import { Text } from "../components/ui/text";
import { loadView } from "./load-view";

class ViewBoundary extends Component<{ children: ReactNode; retry: () => void }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("Spool view failed to load.", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <Stack gap={3} style={{ padding: 24 }}>
      <Text role="alert">This view could not load. {this.state.error.message}</Text>
      <Stack direction="row" gap={2}>
        <Button onClick={this.props.retry}>Retry loading view</Button>
        <Button onClick={() => window.location.reload()}>Reload app view</Button>
      </Stack>
    </Stack>;
  }
}

export default function dynamic<P extends object>(
  load: () => Promise<ComponentType<P> | { default: ComponentType<P> }>,
  options?: { ssr?: boolean; loading?: () => ReactNode },
) {
  const create = () => lazy(async () => {
    const module = await loadView(load);
    return { default: "default" in module ? module.default : module };
  });
  // Suspense may discard initial hook state; keep its pending load stable across render attempts.
  const initial = create();
  return function LazyComponent(props: P) {
    const [{ Loaded, attempt }, setView] = useState(() => ({ Loaded: initial, attempt: 0 }));
    return <ViewBoundary key={attempt} retry={() => setView(value => ({ Loaded: create(), attempt: value.attempt + 1 }))}>
      <Suspense fallback={options?.loading?.() ?? null}><Loaded {...props} /></Suspense>
    </ViewBoundary>;
  };
}
