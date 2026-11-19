import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { testPackages, readDiagnosticGroundTruth } from "./test-runtime.mjs";

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function browserTestPlans(root, names, files) {
  if (!Array.isArray(files) || !files.length) throw new Error("Browser diagnostics require exact Playwright test files");
  const realRoot = fs.realpathSync(root);
  const packages = testPackages(root, names).map(pkg => ({ ...pkg, directory: fs.realpathSync(pkg.directory), files: [] }));
  for (const file of files) {
    if (typeof file !== "string" || !/^[\w@.\\/ -]+$/.test(file) || path.isAbsolute(file) ||
        path.win32.isAbsolute(file) || !/\.playwright-test\.[jt]s$/.test(file))
      throw new Error("Browser files must be literal repository-relative Playwright test paths");
    const absolute = fs.realpathSync(path.resolve(root, file));
    const pkg = packages.find(candidate => inside(realRoot, candidate.directory) &&
      inside(path.join(candidate.directory, "src"), absolute));
    if (!pkg || !fs.statSync(absolute).isFile()) throw new Error(`Browser test is outside the selected workspace: ${file}`);
    if (pkg.browserScript !== "playwright test" && !pkg.browserScript?.endsWith(" && playwright test"))
      throw new Error(`Unsupported repository browser test script for ${pkg.name}`);
    const config = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"]
      .map(name => path.join(pkg.directory, name)).find(file => fs.existsSync(file));
    if (!config || !inside(pkg.directory, fs.realpathSync(config)))
      throw new Error(`Missing workspace-owned Playwright configuration for ${pkg.name}`);
    pkg.config = fs.realpathSync(config);
    if (!pkg.files.includes(absolute)) pkg.files.push(absolute);
  }
  return packages.filter(pkg => pkg.files.length);
}

export function browserConfiguration(plan, directory, report) {
  return `const path = require("node:path");
const loaded = require(${JSON.stringify(plan.config)});
const stock = loaded.default ?? loaded;
const root = ${JSON.stringify(plan.directory)};
const files = ${JSON.stringify(plan.files)};
const literal = value => new RegExp("^" + value.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + "$");
const match = files.map(literal);
const resolve = value => Array.isArray(value) ? value.map(resolve) :
  typeof value === "string" && value.startsWith(".") ? path.resolve(root, value) : value;
const use = value => ({...value, headless: true,
  launchOptions: {...value?.launchOptions, headless: true}, screenshot: "on", trace: "on"});
const projects = (stock.projects ?? [{name: "", use: {}}]).filter(project =>
  (project.use?.browserName ?? project.use?.defaultBrowserType ??
   stock.use?.browserName ?? stock.use?.defaultBrowserType ?? "chromium") === "chromium");
if (projects.length !== 1 || projects[0].dependencies?.length)
  throw Error("Browser diagnostics require one independent stock Chromium project");
const servers = (Array.isArray(stock.webServer) ? stock.webServer : [stock.webServer]).map(server => {
  if (!server || !server.command || (!server.url && !server.port) ||
      server.url && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(server.url).hostname))
    throw Error("Browser diagnostics require the stock loopback web server");
  return {...server, cwd: path.resolve(root, server.cwd ?? "."), reuseExistingServer: false};
});
const reporters = Array.isArray(stock.reporter) ? stock.reporter : [[stock.reporter ?? "list"]];
module.exports = {...stock, testDir: path.resolve(root, stock.testDir ?? "."), testMatch: match,
  workers: 1, fullyParallel: false, outputDir: ${JSON.stringify(path.join(directory, "artifacts"))},
  use: use(stock.use), globalSetup: resolve(stock.globalSetup), globalTeardown: resolve(stock.globalTeardown),
  ...(stock.snapshotDir ? {snapshotDir: path.resolve(root, stock.snapshotDir)} : {}),
  projects: projects.map(project => ({...project, testDir: path.resolve(root, project.testDir ?? stock.testDir ?? "."),
    outputDir: ${JSON.stringify(path.join(directory, "artifacts"))},
    ...(project.snapshotDir ? {snapshotDir: path.resolve(root, project.snapshotDir)} : {}),
    testMatch: match, use: use({...stock.use, ...project.use})})),
  webServer: servers, reporter: [...reporters.map(([name, ...options]) => [resolve(name), ...options]),
    ["json", {outputFile: ${JSON.stringify(report)}}]]};
`;
}

function reportTests(suites) {
  return suites.flatMap(suite => [...(suite.specs || []).flatMap(spec =>
    (spec.tests || []).map(test => ({ ...test, file: spec.file }))), ...reportTests(suite.suites || [])]);
}

export function runBrowserTests(root, names, files, directory, run = spawnSync) {
  const plans = browserTestPlans(root, names, files);
  const { getTestEnvironment, verifyTestRun } = createRequire(import.meta.url)(
    path.join(root, "common", "scripts", "ftgTestRun.js"));
  fs.mkdirSync(directory, { recursive: true });
  const packages = [];
  for (const plan of plans) {
    const runId = randomUUID(), resultsDirectory = path.join(directory, runId);
    fs.mkdirSync(resultsDirectory);
    const execution = { runId, taskKey: `${path.relative(root, plan.directory)}#test:e2e:diagnostic`,
      resultsDirectory, evidenceFile: path.join(resultsDirectory, "ftg-evidence.json") };
    const report = path.join(resultsDirectory, "playwright.json");
    const config = path.join(resultsDirectory, "playwright.config.cjs");
    fs.writeFileSync(config, browserConfiguration(plan, resultsDirectory, report), { flag: "wx" });
    const result = run("node", ["--run", "test:e2e", "--", "--config", config],
      { cwd: plan.directory, encoding: "utf8", windowsHide: true, stdio: "inherit",
        env: { ...process.env, CI: "1", PWDEBUG: "0", ...getTestEnvironment(execution) } });
    if (result.error || result.status !== 0)
      throw new Error(`Browser diagnostics failed for ${plan.name}; ${report}: ${result.error?.message || `exit ${result.status}`}`);
    if (!fs.existsSync(report)) throw new Error(`Missing fresh browser report: ${report}`);
    verifyTestRun(execution);
    const evidence = JSON.parse(fs.readFileSync(report, "utf8")), tests = reportTests(evidence.suites || []);
    const actual = new Set(tests.map(test => fs.realpathSync(path.resolve(evidence.config.rootDir, test.file))));
    const passed = tests.filter(test => test.status === "expected" && test.expectedStatus === "passed" &&
      test.results?.length && test.results.every(result => result.status === "passed"));
    if (evidence.errors?.length || !passed.length || actual.size !== plan.files.length ||
        [...actual].some(file => !plan.files.includes(file)) ||
        tests.some(test => !passed.includes(test) && !(test.status === "skipped" &&
          test.results?.length && test.results.every(result => result.status === "skipped"))) ||
        plan.files.some(file => !passed.some(test => fs.realpathSync(path.resolve(evidence.config.rootDir, test.file)) === file)))
      throw new Error(`Browser report does not prove passing tests for exactly the selected files: ${report}`);
    const groundTruth = path.join(resultsDirectory, "junit-with-failures.xml");
    const original = readDiagnosticGroundTruth(groundTruth, run);
    if (original.tests !== tests.length || original.failed !== 0 || original.declaredFailed !== 0)
      throw new Error(`Browser ground truth includes failed or missing tests: ${groundTruth}: ${original.details}`);
    const screenshots = [];
    for (const test of passed) {
      const images = test.results.flatMap(result => result.attachments || [])
        .filter(attachment => attachment.contentType === "image/png" && attachment.path);
      if (!images.length) throw new Error(`Browser test produced no screenshot: ${test.file}`);
      for (const image of images) {
        const file = fs.realpathSync(image.path);
        if (!inside(resultsDirectory, file) || !fs.statSync(file).isFile())
          throw new Error(`Invalid isolated browser screenshot: ${image.path}`);
        const handle = fs.openSync(file, "r"), header = Buffer.alloc(8);
        try { fs.readSync(handle, header, 0, 8, 0); } finally { fs.closeSync(handle); }
        if (header.toString("hex") !== "89504e470d0a1a0a")
          throw new Error(`Invalid isolated browser screenshot: ${image.path}`);
        screenshots.push(file);
      }
    }
    packages.push({ name: plan.name, files: plan.files, report, groundTruth, passed: passed.length,
      total: tests.length, screenshots: [...new Set(screenshots)] });
  }
  return { diagnostic: true, requiredChecksSatisfied: false, framework: "playwright", directory, packages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2]), names = (process.argv[3] || "").split(",").filter(Boolean);
  const files = JSON.parse(Buffer.from(process.argv[5], "base64").toString("utf8"));
  if (process.argv[4] === "--browser-plan") browserTestPlans(root, names, files);
  else if (process.argv[4] === "--browser-tests") {
    const result = runBrowserTests(root, names, files, process.argv[6]);
    fs.writeFileSync(path.join(process.argv[6], "result.json"), JSON.stringify(result), { flag: "wx" });
  } else throw new Error("Unknown browser diagnostic operation");
}
