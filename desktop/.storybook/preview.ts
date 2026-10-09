import type { Preview } from "@storybook/react-vite";
import "../src/app/globals.css";
import { withTheme } from "./with-theme";

const preview: Preview = {
  initialGlobals: { theme: "system" },
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme", icon: "circlehollow", dynamicTitle: true,
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  decorators: [withTheme],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
  },
};

export default preview;
