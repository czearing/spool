import { useLayoutEffect } from "react";
import type { Decorator } from "@storybook/react-vite";
import { applyTheme, parseTheme } from "../src/lib/theme";

export const withTheme: Decorator = (Story, context) => {
  const theme = parseTheme(context.globals.theme ?? null);
  useLayoutEffect(() => { applyTheme(theme); }, [theme]);
  return <Story />;
};
