// 生成元: thkt/feedback-loop scripts/feedback-loop/build.ts。直接編集せず、正本を変更して再生成してください
// @bun
// scripts/feedback-loop/setup.ts
import assert3 from "assert/strict";
import { spawnSync } from "child_process";
import {
  existsSync as existsSync2,
  mkdirSync,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  realpathSync,
  writeFileSync
} from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute as isAbsolute2, join as join2 } from "path";

// scripts/feedback-loop/config.ts
import assert2 from "assert/strict";
import { existsSync, readdirSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

// scripts/feedback-loop/command.ts
import assert from "assert/strict";
import { spawn } from "child_process";
function startCommand(argv, options) {
  const { runtime, cwd, env, monitorParent, captureStdout, retryCommand } = options;
  const stdout = captureStdout ? "pipe" : "inherit";
  const [command, ...args] = argv;
  assert(command, "\u5B9F\u884C\u30B3\u30DE\u30F3\u30C9\u304C\u3042\u308A\u307E\u305B\u3093");
  if (monitorParent) {
    assert(process.connected, "\u691C\u67FB\u306E\u958B\u59CB\u524D\u306B\u89AA\u3068\u306E\u63A5\u7D9A\u304C\u5207\u308C\u307E\u3057\u305F");
  } else {
    const log = captureStdout ? console.error : console.log;
    const operation = captureStdout ? "\u53CE\u96C6" : "\u5B9F\u884C";
    log(`${operation}: ${argv.join(" ")}; \u518D\u5B9F\u884C: ${retryCommand}`);
  }
  const startupEnv = { ...env };
  if (!monitorParent) {
    delete startupEnv.BUN_OPTIONS;
    delete startupEnv.NODE_OPTIONS;
  }
  const child = spawn(monitorParent ? command : process.execPath, monitorParent ? args : [...process.versions.bun ? ["--no-env-file"] : [], runtime, "execute-child"], {
    stdio: monitorParent ? ["inherit", "inherit", "pipe"] : ["inherit", stdout, "pipe", "ipc"],
    cwd,
    env: startupEnv,
    detached: true,
    serialization: "json"
  });
  return child;
}
async function execute(argv, options) {
  const {
    runtime,
    cwd = process.cwd(),
    env = process.env,
    monitorParent = false,
    captureStdout = false,
    retryCommand = `${process.versions.bun ? "bun" : "npm"} run test:affected`
  } = options;
  const child = startCommand(argv, {
    runtime,
    cwd,
    env,
    monitorParent,
    captureStdout,
    retryCommand
  });
  assert(child.stderr);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (!process.stderr.destroyed) {
      process.stderr.write(chunk);
    }
    stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
  });
  let cancelled = false;
  let cleanupError;
  let killTimer;
  const stop = (signal) => {
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && ("code" in error) && error.code === "ESRCH")) {
        cleanupError = error;
      }
    }
  };
  const forward = (signal) => {
    cancelled = true;
    stop(signal);
    if (monitorParent) {
      killTimer ??= setTimeout(() => stop("SIGKILL"), 1000);
      killTimer.unref();
    }
  };
  let stdout = "";
  let stdoutBytes = 0;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > 64 * 1024 * 1024) {
      cleanupError ??= new Error("\u30C6\u30B9\u30C8\u53CE\u96C6\u306E\u51FA\u529B\u304C64MiB\u3092\u8D85\u3048\u307E\u3057\u305F");
      forward("SIGTERM");
    } else {
      stdout += chunk;
    }
  });
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  child.once("exit", () => stop("SIGKILL"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  if (monitorParent) {
    process.on("disconnect", terminate);
  } else {
    child.send({ argv, env }, (error) => {
      if (error) {
        cleanupError = error;
        stop("SIGKILL");
      }
    });
  }
  try {
    const result = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    assert(cleanupError === undefined, `\u5B50\u30D7\u30ED\u30BB\u30B9\u306E\u7D42\u4E86\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093: ${String(cleanupError)}`);
    assert(!cancelled && result.code === 0, `\u691C\u67FB\u5931\u6557\u307E\u305F\u306F\u53D6\u6D88: ${result.signal ?? result.code}`);
    return { stdout, stderr };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    clearTimeout(killTimer);
    if (monitorParent) {
      process.off("disconnect", terminate);
      if (process.connected) {
        process.disconnect?.();
      }
    }
  }
}

// scripts/feedback-loop/config.ts
var packageManagerToken = "__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__";
function object(value) {
  assert2(typeof value === "object" && value !== null && !Array.isArray(value), "\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u304C\u5FC5\u8981\u3067\u3059");
}
function strings(value) {
  assert2(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), "\u6587\u5B57\u5217\u914D\u5217\u304C\u5FC5\u8981\u3067\u3059");
}
function localPath(path) {
  assert2(!isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\"), `repo\u76F8\u5BFE\u30D1\u30B9\u304C\u5FC5\u8981\u3067\u3059: ${path}`);
}
function readConfig(root) {
  const value = JSON.parse(readFileSync(join(root, ".feedback-loop.json"), "utf8"));
  object(value);
  assert2(value.version === 1, "\u672A\u5BFE\u5FDC\u306E\u8A2D\u5B9Aversion\u3067\u3059");
  assert2(value.runner === "bun" || value.runner === "vitest", "runner\u306Fbun\u307E\u305F\u306Fvitest\u3067\u3059");
  assert2(typeof value.base === "string" && value.base.trim().length > 0, "\u6BD4\u8F03\u5143base\u304C\u5FC5\u8981\u3067\u3059");
  const { collect, testGlobs, fullCheck, prepare, testArgs, globalChanges } = value;
  strings(collect);
  strings(testGlobs);
  strings(fullCheck);
  strings(prepare);
  strings(testArgs);
  strings(globalChanges);
  assert2(collect.length > 0 && fullCheck.length > 0 && testGlobs.length > 0, "\u53CE\u96C6\u30FB\u901A\u5E38check\u30FB\u30C6\u30B9\u30C8glob\u306F\u5FC5\u9808\u3067\u3059");
  const bunArgs = value.bunArgs ?? [];
  const allowSkipped = value.allowSkipped === undefined ? true : value.allowSkipped;
  assert2(typeof allowSkipped === "boolean", "allowSkipped\u306Fboolean\u3067\u3059");
  strings(bunArgs);
  assert2(value.runner === "bun" || bunArgs.length === 0, "Vitest\u306B\u306FbunArgs\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
  const bunWorkers = value.bunWorkers === undefined ? 4 : value.bunWorkers;
  assert2(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkers\u306F\u6B63\u306E\u5B89\u5168\u306A\u6574\u6570\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  assert2(value.runner === "bun" || value.bunWorkers === undefined, "Vitest\u306B\u306FbunWorkers\u3092\u6307\u5B9A\u3067\u304D\u307E\u305B\u3093");
  if (value.runner === "bun") {
    assert2(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "Bun\u306E\u9694\u96E2\u306F\u56FA\u5B9A\u3067\u3059\u3002\u4E26\u5217\u6570\u306FbunWorkers\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  }
  assert2(Array.isArray(value.assurance), "assurance\u914D\u5217\u304C\u5FC5\u8981\u3067\u3059");
  const assurance = value.assurance.map((item) => {
    object(item);
    assert2(typeof item.path === "string" && typeof item.reason === "string" && item.reason.trim().length > 0, "assurance\u306B\u306Fpath\u3068\u6307\u5B9A\u7406\u7531\u304C\u5FC5\u8981\u3067\u3059");
    localPath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert2(Array.isArray(value.dependencies), "dependencies\u914D\u5217\u304C\u5FC5\u8981\u3067\u3059");
  const dependencies = value.dependencies.map((item) => {
    object(item);
    strings(item.inputs);
    strings(item.tests);
    assert2(item.inputs.length > 0 && item.tests.length > 0, "\u4F9D\u5B58\u5BFE\u5FDC\u306F\u7A7A\u306B\u3067\u304D\u307E\u305B\u3093");
    item.inputs.forEach(localPath);
    item.tests.forEach(localPath);
    return { inputs: item.inputs, tests: item.tests };
  });
  testGlobs.forEach(localPath);
  globalChanges.forEach(localPath);
  return {
    version: 1,
    runner: value.runner,
    base: value.base,
    collect,
    testGlobs,
    assurance,
    fullCheck,
    prepare,
    bunArgs,
    bunWorkers,
    testArgs,
    allowSkipped,
    globalChanges,
    dependencies
  };
}
function matches(path, glob) {
  let pattern = "^";
  for (let i = 0;i < glob.length; i++) {
    const char = glob[i] ?? "";
    if (glob.slice(i, i + 3) === "**/") {
      pattern += "(?:.*/)?";
      i += 2;
    } else if (glob.slice(i, i + 2) === "**") {
      pattern += ".*";
      i++;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`).test(path);
}
function filesUnder(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.name === ".git" || entry.name === "node_modules") {
      return [];
    }
    return entry.isDirectory() ? filesUnder(root, `${path}/`) : entry.isFile() ? [path] : [];
  });
}
async function classification(root, config, runtime, retryCommand) {
  const expected = filesUnder(root).filter((path) => config.testGlobs.some((glob) => matches(path, glob))).sort();
  const { stdout } = await execute(config.collect, {
    runtime,
    cwd: root,
    captureStdout: true,
    retryCommand
  });
  const actual = JSON.parse(stdout);
  strings(actual);
  actual.forEach(localPath);
  assert2(new Set(actual).size === actual.length, "\u53CE\u96C6\u7D50\u679C\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
  assert2(JSON.stringify([...actual].sort()) === JSON.stringify(expected), `\u901A\u5E38\u53CE\u96C6\u3068testGlobs\u306E\u96C6\u5408\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093
collect=${JSON.stringify(actual)}
glob=${JSON.stringify(expected)}`);
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert2(assurance.size === config.assurance.length, "assurance\u6307\u5B9A\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
  assert2([...assurance].every((path) => expected.includes(path)), "assurance\u306B\u5B58\u5728\u3057\u306A\u3044\u30C6\u30B9\u30C8\u304B\u96C6\u5408\u5916\u306E\u6307\u5B9A\u304C\u3042\u308A\u307E\u3059");
  assert2(config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))), "\u4F9D\u5B58\u5BFE\u5FDC\u306B\u96C6\u5408\u5916\u306E\u30C6\u30B9\u30C8\u304C\u3042\u308A\u307E\u3059");
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance]
  };
}

// scripts/feedback-loop/setup.ts
function stringMap(value) {
  object(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    assert3(typeof item === "string", `${key}\u306F\u6587\u5B57\u5217\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`);
    result[key] = item;
  }
  return result;
}
function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function defaultBase(root) {
  const remoteHead = gitOutput(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  if (remoteHead) {
    return remoteHead;
  }
  for (const prefix of ["refs/remotes/origin/", "refs/heads/"]) {
    const found = ["main", "master"].filter((name) => gitOutput(root, ["rev-parse", "--verify", "--quiet", `${prefix}${name}`]) !== undefined);
    if (found.length > 0) {
      return found.length === 1 ? `${prefix === "refs/heads/" ? "" : "origin/"}${found[0]}` : null;
    }
  }
  return null;
}
function inspect(root) {
  const pkg = JSON.parse(readFileSync2(join2(root, "package.json"), "utf8"));
  object(pkg);
  const scripts = stringMap(pkg.scripts ?? {});
  const devDependencies = stringMap(pkg.devDependencies ?? {});
  const dependencies = stringMap(pkg.dependencies ?? {});
  const hints = new Set;
  if (typeof pkg.packageManager === "string") {
    hints.add(pkg.packageManager.split("@")[0] ?? "unknown");
  }
  for (const [path, manager] of [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "unknown"],
    ["pnpm-lock.yaml", "unknown"]
  ]) {
    if (path && manager && existsSync2(join2(root, path))) {
      hints.add(manager);
    }
  }
  const first = [...hints][0];
  const packageManager = hints.size === 1 && (first === "bun" || first === "npm") ? first : null;
  const configFiles = readdirSync2(root, { withFileTypes: true }).filter((entry) => entry.isFile() && (/(?:config|lock|mise|bunfig|feedback-loop|eslint|prettier|biome|fallow|tsconfig)/.test(entry.name) || entry.name === ".dotagents.json")).map((entry) => entry.name);
  const workflow = join2(root, ".github/workflows");
  if (existsSync2(workflow)) {
    configFiles.push(...readdirSync2(workflow).map((name) => `.github/workflows/${name}`));
  }
  const base = defaultBase(root);
  return {
    packageManager,
    base,
    scripts,
    devDependencies,
    dependencies,
    configFiles: configFiles.sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) => /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name)),
    diagnostics: [
      [packageManager, "package manager\u304C\u672A\u6307\u5B9A\u3001\u7AF6\u5408\u3001\u307E\u305F\u306F\u672A\u5BFE\u5FDC\u3067\u3059"],
      [
        base,
        "\u6BD4\u8F03\u5143\u3092\u6C7A\u3081\u3089\u308C\u307E\u305B\u3093\u3002origin/HEAD\u304C\u306A\u304F\u3001main\u3068master\u304C\u4E21\u65B9\u3042\u308B\u304B\u3001\u3069\u3061\u3089\u3082\u3042\u308A\u307E\u305B\u3093"
      ]
    ].filter(([found]) => !found).map(([, message]) => message),
    pkg
  };
}
function install(root, inspected, packages) {
  assert3(inspected.packageManager, "package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093");
  assert3(packages.length > 0, "--package NAME@\u56FA\u5B9A\u7248\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const missing = [];
  const requested = new Map;
  for (const spec of packages) {
    const match = /^(oxlint|oxfmt|fallow)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    assert3(match, `\u81EA\u52D5\u5C0E\u5165\u306Foxlint\u30FBoxfmt\u30FBfallow\u306E\u56FA\u5B9A\u7248\u3060\u3051\u306B\u5BFE\u5FDC\u3057\u307E\u3059: ${spec}`);
    const [, name = "", version] = match;
    assert3(version);
    assert3(!requested.has(name) || requested.get(name) === version, `\u8907\u6570\u306E\u7248\u304C\u6307\u5B9A\u3055\u308C\u3066\u3044\u307E\u3059: ${name}`);
    requested.set(name, version);
    const current = inspected.devDependencies[name] ?? inspected.dependencies[name];
    assert3(current === undefined || current === version, `\u65E2\u5B58\u7248\u3092\u7F6E\u63DB\u3057\u307E\u305B\u3093: ${name}=${current}`);
    if (current === undefined && !missing.includes(spec)) {
      missing.push(spec);
    }
  }
  if (missing.length === 0) {
    console.log("\u6307\u5B9A\u3057\u305F\u56FA\u5B9A\u7248\u306F\u5C0E\u5165\u6E08\u307F\u3067\u3059\u3002\u5909\u66F4\u3057\u307E\u305B\u3093");
    return;
  }
  const args = inspected.packageManager === "bun" ? ["add", "--dev", "--exact", ...missing] : ["install", "--save-dev", "--save-exact", ...missing];
  console.log(`\u5C0E\u5165: ${inspected.packageManager} ${args.join(" ")}`);
  const result = spawnSync(inspected.packageManager, args, { cwd: root, stdio: "inherit" });
  assert3(!result.error && result.status === 0, `\u4F9D\u5B58\u5C0E\u5165\u672A\u5B8C\u4E86: ${missing.join(", ")}; ${String(result.error ?? result.signal ?? result.status)}\u3002\u90E8\u5206\u5909\u66F4\u3092\u4FDD\u6301\u3057\u3066\u3044\u307E\u3059\u3002package.json\u3068lockfile\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`);
  const after = inspect(root);
  assert3(missing.every((spec) => {
    const [name = "", version] = spec.split("@");
    return after.devDependencies[name] === version;
  }), "\u5C0E\u5165\u5F8C\u306EdevDependencies\u304C\u6307\u5B9A\u3057\u305F\u56FA\u5B9A\u7248\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093");
}
function readDotagents(root) {
  const target = join2(root, ".dotagents.json");
  if (!existsSync2(target)) {
    return;
  }
  const dotagents = JSON.parse(readFileSync2(target, "utf8"));
  object(dotagents);
  return dotagents;
}
function connectFeedbackCheck(dotagents, feedbackCheck) {
  const current = dotagents.feedbackCheck;
  assert3(current === undefined || JSON.stringify(current) === JSON.stringify(feedbackCheck) || current === feedbackCheck.join(" "), "\u65E2\u5B58feedbackCheck\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059");
  return current === undefined ? `${JSON.stringify({ ...dotagents, feedbackCheck }, null, 2)}
` : undefined;
}
function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}
var generatedRecord = "scripts/feedback-loop/generated.json";
function generatedFiles(config, packageManager) {
  const generated = new Map([
    [
      "scripts/feedback-loop/runtime.mjs",
      readFileSync2(join2(import.meta.dir, "runtime.mjs"), "utf8").replaceAll(packageManagerToken, packageManager)
    ]
  ]);
  if (config.runner === "bun") {
    generated.set("scripts/feedback-loop/record-modules.ts", readFileSync2(join2(import.meta.dir, "record-modules.ts"), "utf8"));
  }
  const source = JSON.parse(readFileSync2(join2(import.meta.dir, "source.json"), "utf8"));
  object(source);
  generated.set(generatedRecord, JSON.stringify({
    generator: source.generator,
    bun: Bun.version,
    sources: source.sources,
    files: Object.fromEntries([...generated].map(([path, body]) => [path, sha256(body)]))
  }, null, 2) + `
`);
  return generated;
}
function runtimeCommands(config) {
  let runtime = { bun: "bun", vitest: "node" }[config.runner];
  if (config.bunArgs.includes("--no-env-file")) {
    runtime += " --no-env-file";
  }
  return {
    "test:affected": `${runtime} scripts/feedback-loop/runtime.mjs affected`,
    "check:classification": `${runtime} scripts/feedback-loop/runtime.mjs classification`
  };
}
function writeFiles(root, updates) {
  for (const [path, body] of updates) {
    console.log(`\u914D\u7F6E: ${path}`);
    mkdirSync(dirname(join2(root, path)), { recursive: true });
    writeFileSync(join2(root, path), body);
  }
}
function reportConnectionDiffs(root, inspected, commands) {
  for (const [name, command] of Object.entries(commands)) {
    if (inspected.scripts[name] !== command) {
      console.log(`package.json\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5DEE\u5206: ${name}: ${inspected.scripts[name] ?? "(\u672A\u5B9A\u7FA9)"} \u2192 ${command}`);
    }
  }
  if (inspected.scripts["check:feedback"] === undefined) {
    console.log("package.json\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5DEE\u5206: check:feedback: (\u672A\u5B9A\u7FA9)");
  }
  const dotagents = readDotagents(root);
  const feedbackCheck = [inspected.packageManager ?? "", "run", "check:feedback"];
  if (dotagents && JSON.stringify(dotagents.feedbackCheck) !== JSON.stringify(feedbackCheck) && dotagents.feedbackCheck !== feedbackCheck.join(" ")) {
    console.log(`.dotagents.json\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002\u5DEE\u5206: feedbackCheck: ${JSON.stringify(dotagents.feedbackCheck) ?? "(\u672A\u5B9A\u7FA9)"} \u2192 ${feedbackCheck.join(" ")}`);
  }
}
function update(root, inspected) {
  assert3(inspected.packageManager, "package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093");
  const config = readConfig(root);
  assert3(existsSync2(join2(root, generatedRecord)), `${generatedRecord}\u304C\u306A\u3044\u305F\u3081\u3001\u751F\u6210\u7269\u304B\u624B\u3067\u7DE8\u96C6\u3057\u305F\u30D5\u30A1\u30A4\u30EB\u304B\u3092\u533A\u5225\u3067\u304D\u307E\u305B\u3093`);
  const record = JSON.parse(readFileSync2(join2(root, generatedRecord), "utf8"));
  object(record);
  assert3(record.files !== undefined, `${generatedRecord}\u306Bfiles\u304C\u306A\u3044\u305F\u3081\u3001\u751F\u6210\u7269\u304B\u624B\u3067\u7DE8\u96C6\u3057\u305F\u30D5\u30A1\u30A4\u30EB\u304B\u3092\u533A\u5225\u3067\u304D\u307E\u305B\u3093`);
  const recorded = stringMap(record.files);
  const generated = generatedFiles(config, inspected.packageManager);
  const updates = new Map;
  const edited = [];
  for (const [path, body] of generated) {
    const target = join2(root, path);
    const current = existsSync2(target) ? readFileSync2(target, "utf8") : undefined;
    if (current === body) {
      continue;
    }
    if (path === generatedRecord || current === undefined || recorded[path] === sha256(current)) {
      updates.set(path, body);
    } else {
      edited.push(path);
    }
  }
  assert3(edited.length === 0, `\u8A18\u9332\u3068\u5185\u5BB9\u304C\u4E00\u81F4\u3057\u306A\u3044\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308B\u305F\u3081\u3001\u3069\u306E\u30D5\u30A1\u30A4\u30EB\u3082\u66F4\u65B0\u3057\u307E\u305B\u3093: ${edited.join(", ")}`);
  reportConnectionDiffs(root, inspected, runtimeCommands(config));
  writeFiles(root, updates);
  console.log(updates.size === 0 ? "\u751F\u6210\u7269\u306F\u6700\u65B0\u3067\u3059\u3002\u5909\u66F4\u3057\u307E\u305B\u3093" : "\u751F\u6210\u7269\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F\u3002check:classification\u3068check:feedback\u3092\u5B9F\u884C\u3057\u3066\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044");
}
async function apply(root, inspected, feedback) {
  assert3(inspected.packageManager, "package manager\u3092\u9078\u629E\u3067\u304D\u307E\u305B\u3093");
  assert3(feedback && feedback.trim(), "--feedback-command\u306B\u8A3A\u65AD\u7528\u30B3\u30DE\u30F3\u30C9\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const config = readConfig(root);
  const retryCommand = [
    process.execPath,
    ...process.execArgv,
    import.meta.path,
    "apply",
    "--repo",
    root,
    "--feedback-command",
    feedback
  ].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  await classification(root, config, join2(import.meta.dir, "runtime.mjs"), retryCommand);
  const dotagents = readDotagents(root);
  const commands = { ...runtimeCommands(config), "check:feedback": feedback };
  for (const [name, command] of Object.entries(commands)) {
    assert3(inspected.scripts[name] === undefined || inspected.scripts[name] === command, `\u65E2\u5B58\u30B3\u30DE\u30F3\u30C9\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${name}`);
  }
  const feedbackCheck = [inspected.packageManager, "run", "check:feedback"];
  const nextDotagents = dotagents && connectFeedbackCheck(dotagents, feedbackCheck);
  const updates = new Map;
  for (const [path, body] of generatedFiles(config, inspected.packageManager)) {
    if (existsSync2(join2(root, path))) {
      assert3(readFileSync2(join2(root, path), "utf8") === body, `\u914D\u7F6E\u6E08\u307F\u30D5\u30A1\u30A4\u30EB\u3068\u885D\u7A81\u3057\u3066\u3044\u307E\u3059: ${path}`);
    } else {
      updates.set(path, body);
    }
  }
  const nextPackage = { ...inspected.pkg, scripts: { ...inspected.scripts, ...commands } };
  if (JSON.stringify(nextPackage) !== JSON.stringify(inspected.pkg)) {
    updates.set("package.json", `${JSON.stringify(nextPackage, null, 2)}
`);
  }
  if (nextDotagents) {
    updates.set(".dotagents.json", nextDotagents);
  }
  console.log(JSON.stringify({ scripts: commands, feedbackCheck: dotagents ? feedbackCheck : null }));
  writeFiles(root, updates);
  console.log(placedMessage(dotagents !== undefined));
  console.log("\u9759\u7684\u691C\u67FB\u30FB\u901A\u5E38check\u30FBCI\u306E\u63A5\u7D9A\u3068\u52D5\u4F5C\u78BA\u8A8D\u306F\u5C0E\u5165\u62C5\u5F53\u304C\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044");
}
var usage = `\u4F7F\u3044\u65B9: bun setup.mjs <\u64CD\u4F5C> --repo <Git checkout\u306E\u7D76\u5BFE\u30D1\u30B9> [\u5F15\u6570]

\u64CD\u4F5C:
  inspect   \u69CB\u6210\u3092\u8ABF\u3079\u3066JSON\u3067\u8868\u793A\u3057\u307E\u3059\u3002\u30D5\u30A1\u30A4\u30EB\u306F\u5909\u66F4\u3057\u307E\u305B\u3093
  install   \u4E0D\u8DB3\u3059\u308B\u56FA\u5B9A\u7248\u306E\u4F9D\u5B58\u3092\u5C0E\u5165\u3057\u307E\u3059
            --package <oxlint|oxfmt|fallow>@<\u7248>\uFF08\u8907\u6570\u6307\u5B9A\u53EF\uFF09
  apply     .feedback-loop.json\u3092\u8AAD\u307F\u3001\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3068package scripts\u3092\u914D\u7F6E\u3057\u307E\u3059
            --feedback-command <check:feedback\u306B\u8A2D\u5B9A\u3059\u308B\u8A3A\u65AD\u7528\u30B3\u30DE\u30F3\u30C9>
            --update  \u5C0E\u5165\u6E08\u307F\u306E\u751F\u6210\u7269\u3092\u66F4\u65B0\u3057\u307E\u3059\u3002--feedback-command\u3068\u306F\u4F75\u7528\u3057\u307E\u305B\u3093

\u5171\u901A:
  --repo <\u30D1\u30B9>   \u5BFE\u8C61Git checkout\u306E\u30EB\u30FC\u30C8\u306E\u7D76\u5BFE\u30D1\u30B9
  -h, --help      \u3053\u306E\u4E00\u89A7\u3092\u8868\u793A\u3057\u307E\u3059`;
function placedMessage(connected) {
  if (connected) {
    return "\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3092\u914D\u7F6E\u3057\u3001.dotagents.json\u306EfeedbackCheck\u3092\u63A5\u7D9A\u3057\u307E\u3057\u305F";
  }
  return "\u88DC\u52A9\u30D5\u30A1\u30A4\u30EB\u3092\u914D\u7F6E\u3057\u307E\u3057\u305F\u3002.dotagents.json\u304C\u306A\u3044\u305F\u3081\u3001feedbackCheck\u306E\u63A5\u7D9A\u3092\u7701\u304D\u307E\u3057\u305F";
}
try {
  assert3(true, "\u6B63\u672C\u306Esetup.ts\u306F\u76F4\u63A5\u5B9F\u884C\u3067\u304D\u307E\u305B\u3093\u3002\u751F\u6210\u3057\u305Fplugins/setup-feedback-loop/skills/setup-feedback-loop/scripts/setup.mjs\u3092\u540C\u3058\u5F15\u6570\u3067\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044");
  assert3(process.versions.bun === "1.4.4", `Bun ${"1.4.4"}\u3067\u8D77\u52D5\u3057\u3066\u304F\u3060\u3055\u3044\uFF08\u73FE\u5728: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.version}`}\uFF09`);
  const [operation, ...args] = process.argv.slice(2);
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    console.log(usage);
    process.exit(0);
  }
  let root, feedback, updating = false;
  const packages = [];
  for (let i = 0;i < args.length; i += 1) {
    const key = args[i];
    if (key === "--update") {
      updating = true;
      continue;
    }
    i += 1;
    const value = args[i];
    assert3(value, `${key}\u306E\u5024\u304C\u3042\u308A\u307E\u305B\u3093`);
    if (key === "--repo") {
      assert3(root === undefined, "--repo\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
      root = value;
    } else if (key === "--feedback-command") {
      assert3(feedback === undefined, "--feedback-command\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059");
      feedback = value;
    } else {
      assert3(key === "--package", `\u672A\u5BFE\u5FDC\u306E\u5F15\u6570: ${key}`);
      packages.push(value);
    }
  }
  assert3(root && isAbsolute2(root), "--repo\u306BGit checkout\u306E\u7D76\u5BFE\u30D1\u30B9\u304C\u5FC5\u8981\u3067\u3059");
  assert3(!updating || operation === "apply", "--update\u306Fapply\u3060\u3051\u3067\u6307\u5B9A\u3067\u304D\u307E\u3059");
  assert3(!updating || feedback === undefined, "--update\u3068--feedback-command\u306F\u4F75\u7528\u3067\u304D\u307E\u305B\u3093");
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  assert3(git.status === 0, "--repo\u306FGit checkout\u306E\u30EB\u30FC\u30C8\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const repo = realpathSync(root);
  assert3(realpathSync(git.stdout.trim()) === repo, "--repo\u306FGit checkout\u306E\u30EB\u30FC\u30C8\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const inspected = inspect(repo);
  if (operation === "inspect") {
    const { pkg: _pkg, ...report } = inspected;
    console.log(JSON.stringify(report, null, 2));
  } else if (operation === "install") {
    install(repo, inspected, packages);
  } else {
    assert3(operation === "apply", "\u64CD\u4F5C\u306Finspect\u30FBinstall\u30FBapply\u3067\u3059");
    if (updating) {
      update(repo, inspected);
    } else {
      await apply(repo, inspected, feedback);
    }
  }
} catch (error) {
  console.error(`setup-feedback-loop\u672A\u5B8C\u4E86: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
