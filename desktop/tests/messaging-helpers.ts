import { expect, type Page } from "@playwright/test";
export const input = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
export const submitted = async (page: Page): Promise<{ id: string; markdown: string }[]> =>
  JSON.parse(await page.getByLabel("Submitted messages").innerText());
export async function openStory(page: Page, component: string, story = "default", theme = "light") {
  await page.goto(`${process.env.MESSAGING_STORYBOOK_URL || "http://127.0.0.1:6006"}/iframe.html?id=components-${component}--${story}&viewMode=story&globals=theme:${theme}`);
  await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: 15_000 });
}
export async function paste(page: Page, text: string) {
  await input(page).evaluate((element, value) => {
    const data = new DataTransfer(); data.setData("text/plain", value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // Firefox drops clipboardData passed to the synthetic event constructor.
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  }, text);
}
