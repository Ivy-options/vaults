import { chromium } from "playwright";

export async function openPage(url, { width = 1440, height = 900, beforeNavigate } = {}) {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (m.location()?.url?.endsWith("/favicon.ico")) return;
    errors.push(m.text());
  });
  // Runs before any of the target page's own scripts, on this and every
  // later navigation in the page — needed for tests that seed localStorage
  // ahead of a boot-time read (e.g. the shell's remembered view).
  if (beforeNavigate) await page.addInitScript(beforeNavigate);
  await page.goto(url, { waitUntil: "load" });
  return { browser, page, errors, close: () => browser.close() };
}

export const settle = (page, ms = 1000) => page.waitForTimeout(ms);
