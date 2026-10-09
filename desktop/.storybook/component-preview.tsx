import type { Decorator } from "@storybook/react-vite";
import styles from "./component-preview.module.css";

export const componentPreview: Decorator = (Story) => <div className={styles.preview}><Story /></div>;
export const wideComponentPreview: Decorator = (Story) => <div className={`${styles.preview} ${styles.wide}`}><Story /></div>;
