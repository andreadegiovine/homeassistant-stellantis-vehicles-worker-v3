const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");

const app = express();
app.use(express.json());

let browserProcessId = null;
let processStart = null;
let browserStart = null;
let contextStart = null;

let forceDebug = false;
let okCount = 0;
let koCount = 0;

let browser = null;
let browserLock = Promise.resolve();

function withBrowserLock(fn) {
  const run = browserLock.then(() => fn());
  browserLock = run.catch(() => {});
  return run;
}

function logProcess(message, processId, force = forceDebug) {
  if (force) {
    console.log(`[${processId}] ${message}`);
  }
}

function logStartProcess(processId) {
  processStart = performance.now();
  logProcess("Process start", processId, true);
}

function logEndProcess(processId) {
  if (processStart) {
    logProcess(
      `Process end: ${((performance.now() - processStart) / 1000).toFixed(2)}s`,
      processId,
      true
    );
    logProcess(`Totals OK: ${okCount}`, processId, true);
    logProcess(`Totals KO: ${koCount}`, processId, true);
  }
}

function logStartBrowser() {
  browserProcessId = crypto.randomBytes(4).toString("hex");
  browserStart = performance.now();
  logProcess("Browser start", browserProcessId, true);
}

function logEndBrowser() {
  if (browserStart) {
    logProcess(
      `Browser end: ${((performance.now() - browserStart) / 1000).toFixed(2)}s`,
      browserProcessId,
      true
    );
  }
}

function logStartContext(processId) {
  contextStart = performance.now();
  logProcess("Context start", processId);
}

function logEndContext(processId) {
  if (contextStart) {
    logProcess(
      `Context end: ${((performance.now() - contextStart) / 1000).toFixed(2)}s`,
      processId
    );
  }
}

async function startBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--disable-notifications",
      "--disable-default-apps",
      "--mute-audio",
      "--no-first-run",
      "--no-zygote",
    ],
  });
  logStartBrowser();
}

function httpResponse(res, message, processId, status = 400) {
  let body;

  if (status === 200) {
    okCount++;
    body = { code: message };
  } else {
    koCount++;
    body = { message: `${message} [${processId}]`, code: status };
    logProcess(`Response: ${message}`, processId);
  }

  logEndProcess(processId);

  res.status(status).set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  return res.json(body);
}

app.post("/", async (req, res) => {
  const processId = crypto.randomBytes(4).toString("hex");

  logStartProcess(processId);
  let context = null;
  let capturedCode = null;

  try {
    const {
      url,
      email,
      password,
      timeout_page = 50000,
      timeout_input = 50000,
      debug = false,
    } = req.body;

    forceDebug = debug;

    if (!url || !email || !password) {
      return httpResponse(res, "Missing required params", processId);
    }

    await withBrowserLock(async () => {
      logStartContext(processId);

      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        viewport: { width: 1024, height: 600 },
        javaScriptEnabled: true,
        bypassCSP: true,
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();

      page.on("requestfailed", (req) => {
        if (req.url().startsWith("mym")) {
          try {
            const query = req.url().split("?", 2)[1];
            const params = Object.fromEntries(
              query.split("&").map((p) => p.split("="))
            );
            const code = params["code"];
            if (code) {
              capturedCode = code;
              logProcess("Code captured!", processId);
            }
          } catch (e) {
            logProcess(`URL parse error: ${e}`, processId);
          }
        }
      });

      logProcess(`Navigating to login: ${url}`, processId);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeout_page,
      });

      const SELECTORS = {
        email: '#gigya-login-form input[name="username"]',
        password: '#gigya-login-form input[name="password"]',
        submit: '#gigya-login-form input[type="submit"]',
        authorize: '#cvs_from input[type="submit"]',
      };

      logProcess("Waiting for login form...", processId);
      await page.waitForSelector(SELECTORS.email, {
        timeout: timeout_input,
      });
      await page.waitForSelector(SELECTORS.password, {
        timeout: timeout_input,
      });

      logProcess("Filling credentials...", processId);
      await page.type(SELECTORS.email, email, { delay: 50 });
      await page.type(SELECTORS.password, password, { delay: 50 });

      logProcess("Submitting login form...", processId);
      await page.click(SELECTORS.submit);

      logProcess("Waiting for redirects...", processId);
      await page.waitForLoadState("domcontentloaded", {
        timeout: timeout_page,
      });

      logProcess("Waiting for confirm form...", processId);
      await page.waitForSelector(SELECTORS.authorize, {
        timeout: timeout_input,
      });

      logProcess("Submitting confirm form...", processId);
      await page.click(SELECTORS.authorize);

      logProcess("Waiting for code capture...", processId);

      const start = Date.now();
      while (!capturedCode) {
        if (Date.now() - start > timeout_page) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await context.close();
      logEndContext(processId);
    });

    if (capturedCode) {
      return httpResponse(res, capturedCode, processId, 200);
    }

    return httpResponse(res, "Code not found", processId);
  } catch (e) {
    logProcess(`Error: ${e}`, processId, true);

    if (context) {
      await context.close();
      logEndContext(processId);
    }

    if (capturedCode) {
      return httpResponse(res, capturedCode, processId, 200);
    }

    return httpResponse(res, String(e), processId);
  }
});

app.get("/health", async (req, res) => {
  const processId = crypto.randomBytes(4).toString("hex");

  logStartProcess(processId);

  await withBrowserLock(async () => {
    logProcess("Check browser", processId, true);
    try {
      const context = await Promise.race([
        browser.newContext(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 10000)
        ),
      ]);

      const page = await context.newPage();
      await page.goto("about:blank", { timeout: 10000 });
      await context.close();
    } catch (e) {
      logProcess(`Restarting browser: ${e}`, processId, true);

      try {
        if (browser) await browser.close();
      } catch {}

      await startBrowser();
    }
  });

  logEndProcess(processId);

  return res.json({ status: "ok" });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  await startBrowser();
  console.log(`Server running on port ${PORT}`);
});
