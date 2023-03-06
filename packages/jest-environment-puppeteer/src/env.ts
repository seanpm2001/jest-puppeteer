import { join } from "node:path";
import NodeEnvironment from "jest-environment-node";
import { mkdir } from "node:fs/promises";
import { readConfig } from "./config";
import { blockStdin } from "./stdin";
import { connectBrowserFromWorker } from "./browsers";
import type { JestPuppeteerGlobal } from "./globals";

const testTimeoutSymbol = Symbol.for("TEST_TIMEOUT_SYMBOL");

const handlePageError = (error: Error) => {
  process.emit("uncaughtException", error);
};

const getBrowser = (global: JestPuppeteerGlobal) => {
  if (!global.browser) {
    throw new Error("Cannot access browser before launching browser.");
  }
  return global.browser;
};

const getContext = (global: JestPuppeteerGlobal) => {
  if (!global.context) {
    throw new Error("Cannot access context before launching context.");
  }
  return global.context;
};

const connectBrowser = async (global: JestPuppeteerGlobal) => {
  if (global.browser) {
    throw new Error("Cannot connect browser before closing previous browser.");
  }
  global.browser = await connectBrowserFromWorker(global.puppeteerConfig);
};

const disconnectBrowser = async (global: JestPuppeteerGlobal) => {
  if (!global.browser) return;
  await global.browser.disconnect();
  global.browser = undefined;
};

const getPage = (global: JestPuppeteerGlobal) => {
  if (!global.page) {
    throw new Error("Cannot access page before launching browser.");
  }
  return global.page;
};

const openPage = async (global: JestPuppeteerGlobal) => {
  if (global.page) {
    throw new Error("Cannot open page before closing previous page.");
  }
  const page = await getContext(global).newPage();
  if (global.puppeteerConfig.exitOnPageError) {
    page.on("pageerror", handlePageError);
  }
  global.page = page;
};

const closePage = async (global: JestPuppeteerGlobal) => {
  if (!global.page) return;
  if (global.puppeteerConfig.exitOnPageError) {
    global.page.off("pageerror", handlePageError);
  }
  await global.page.close({
    runBeforeUnload: Boolean(global.puppeteerConfig.runBeforeUnloadOnClose),
  });
  global.page = undefined;
};

const createContext = async (global: JestPuppeteerGlobal) => {
  if (global.context) {
    throw new Error("Cannot create context before closing previous context.");
  }
  const configBrowserContext =
    global.puppeteerConfig.browserContext ?? "default";
  const browser = getBrowser(global);
  switch (configBrowserContext) {
    case "default":
      global.context = browser.defaultBrowserContext();
      break;
    case "incognito":
      global.context = await browser.createIncognitoBrowserContext();
      break;
    default:
      throw new Error(
        `browserContext should be either 'incognito' or 'default'. Received '${configBrowserContext}'`
      );
  }
};

const closeContext = async (global: JestPuppeteerGlobal) => {
  if (!global.context) return;
  if (global.context.isIncognito()) {
    await global.context.close();
  }
  global.context = undefined;
};

const initAll = async (global: JestPuppeteerGlobal) => {
  await connectBrowser(global);
  await createContext(global);
  await openPage(global);
};

const closeAll = async (global: JestPuppeteerGlobal) => {
  await closePage(global);
  await closeContext(global);
  await disconnectBrowser(global);
};

export class PuppeteerEnvironment extends NodeEnvironment {
  // Jest is not available here, so we have to reverse engineer
  // the setTimeout function, see https://github.com/facebook/jest/blob/ffe2352c781703b427fab10777043fb76d0d4267/packages/jest-runtime/src/index.ts#L2331
  setTimeout(timeout: number) {
    this.global[testTimeoutSymbol] = timeout;
  }

  async setup(): Promise<void> {
    const config = await readConfig();
    const global = this.global as unknown as JestPuppeteerGlobal;
    global.puppeteerConfig = config;

    global.jestPuppeteer = {
      debug: async () => {
        // Set timeout to 4 days
        this.setTimeout(345600000);
        // Run a debugger (in case Puppeteer has been launched with `{ devtools: true }`)
        await getPage(global).evaluate(() => {
          debugger;
        });
        return blockStdin();
      },
      resetPage: async () => {
        await closePage(global);
        await openPage(global);
      },
      resetBrowser: async () => {
        await closeAll(global);
        await initAll(global);
      },
    };

    await Promise.all([
      initAll(global),
      mkdir(join(process.cwd(), "screenshots"), { recursive: true }),
    ]);
  }

  async teardown() {
    const global = this.global as unknown as JestPuppeteerGlobal;
    await closeAll(global);
  }
}