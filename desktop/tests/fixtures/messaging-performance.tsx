import { createRoot } from "react-dom/client";
import { PerformanceDemo } from "../../src/components/ui/messaging/performance-demo";
import "../../src/app/globals.css";

const count = Number(new URLSearchParams(location.search).get("count") || 100);
if (![100, 500, 1000].includes(count)) throw new Error("Unsupported performance fixture size.");
createRoot(document.getElementById("root")!).render(<PerformanceDemo count={count} />);
