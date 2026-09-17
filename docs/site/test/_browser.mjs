import { chromium } from "playwright";

export async function openPage(url, { width = 1440, height = 900 } = {}) {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (m.location()?.url?.endsWith("/favicon.ico")) return;
    errors.push(m.text());
  });
  await page.goto(url, { waitUntil: "load" });
  return { browser, page, errors, close: () => browser.close() };
}

export const settle = (page, ms = 1000) => page.waitForTimeout(ms);
