// 生成元: thkt/feedback-loop scripts/feedback-loop/build.ts。直接編集せず、正本を変更して再生成してください
// scripts/feedback-loop/runtime.ts
import assert5 from "node:assert/strict";
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname as dirname2, join as join5 } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL2 } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";

// scripts/feedback-loop/config.ts
import assert2 from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// scripts/feedback-loop/command.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
function startCommand(argv, options) {
  const { runtime, cwd, env, monitorParent, captureStdout, retryCommand } = options;
  const stdout = captureStdout ? "pipe" : "inherit";
  const [command, ...args] = argv;
  assert(command, "実行コマンドがありません");
  if (monitorParent) {
    assert(process.connected, "検査の開始前に親との接続が切れました");
  } else {
    const log = captureStdout ? console.error : console.log;
    const operation = captureStdout ? "収集" : "実行";
    log(`${operation}: ${argv.join(" ")}; 再実行: ${retryCommand}`);
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
      cleanupError ??= new Error("テスト収集の出力が64MiBを超えました");
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
    assert(cleanupError === undefined, `子プロセスの終了を確認できません: ${String(cleanupError)}`);
    assert(!cancelled && result.code === 0, `検査失敗または取消: ${result.signal ?? result.code}`);
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
var reviewPath = ".feedback-loop-review.json";
function object(value) {
  assert2(typeof value === "object" && value !== null && !Array.isArray(value), "オブジェクトが必要です");
}
function strings(value) {
  assert2(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0), "文字列配列が必要です");
}
function localPath(path) {
  assert2(!isAbsolute(path) && !path.split("/").includes("..") && !path.startsWith("./") && !path.includes("\\"), `repo相対パスが必要です: ${path}`);
}
function readConfig(root) {
  const value = JSON.parse(readFileSync(join(root, ".feedback-loop.json"), "utf8"));
  object(value);
  assert2(value.version === 1, "未対応の設定versionです");
  assert2(value.runner === "bun" || value.runner === "vitest", "runnerはbunまたはvitestです");
  assert2(typeof value.base === "string" && value.base.trim().length > 0, "比較元baseが必要です");
  const { collect, testGlobs, fullCheck, prepare, testArgs, globalChanges } = value;
  strings(collect);
  strings(testGlobs);
  strings(fullCheck);
  strings(prepare);
  strings(testArgs);
  strings(globalChanges);
  assert2(collect.length > 0 && fullCheck.length > 0 && testGlobs.length > 0, "収集・通常check・テストglobは必須です");
  const bunArgs = value.bunArgs ?? [];
  const allowSkipped = value.allowSkipped === undefined ? true : value.allowSkipped;
  assert2(typeof allowSkipped === "boolean", "allowSkippedはbooleanです");
  strings(bunArgs);
  assert2(value.runner === "bun" || bunArgs.length === 0, "VitestにはbunArgsを指定できません");
  const bunWorkers = value.bunWorkers === undefined ? 4 : value.bunWorkers;
  assert2(typeof bunWorkers === "number" && Number.isSafeInteger(bunWorkers) && bunWorkers > 0, "bunWorkersは正の安全な整数で指定してください");
  assert2(value.runner === "bun" || value.bunWorkers === undefined, "VitestにはbunWorkersを指定できません");
  if (value.runner === "bun") {
    assert2(![...bunArgs, ...testArgs].some((arg) => /^--(?:no-)?(?:isolate|parallel)(?:=|$)/.test(arg)), "Bunの隔離は固定です。並列数はbunWorkersで指定してください");
  }
  assert2(Array.isArray(value.assurance), "assurance配列が必要です");
  const assurance = value.assurance.map((item) => {
    object(item);
    assert2(typeof item.path === "string" && typeof item.reason === "string" && item.reason.trim().length > 0, "assuranceにはpathと指定理由が必要です");
    localPath(item.path);
    return { path: item.path, reason: item.reason };
  });
  assert2(Array.isArray(value.dependencies), "dependencies配列が必要です");
  const dependencies = value.dependencies.map((item) => {
    object(item);
    strings(item.inputs);
    strings(item.tests);
    assert2(item.inputs.length > 0 && item.tests.length > 0, "依存対応は空にできません");
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
function readReview(root) {
  const target = join(root, reviewPath);
  if (!existsSync(target)) {
    return [];
  }
  let value;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    object(parsed);
    value = parsed;
  } catch (error) {
    throw new Error(`${reviewPath}: JSONオブジェクトを読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert2(value.version === 1, `${reviewPath}: 未対応のversionです`);
  assert2(Array.isArray(value.files), `${reviewPath}: files配列が必要です`);
  return value.files.map((item) => {
    object(item);
    assert2(typeof item.path === "string", `${reviewPath}: pathが必要です`);
    localPath(item.path);
    assert2(item.class === "quality" || item.class === "assurance", `${reviewPath}: classはqualityまたはassuranceです: ${item.path}`);
    assert2(typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256), `${reviewPath}: sha256は小文字16進64文字です: ${item.path}`);
    if (item.class === "quality") {
      assert2(typeof item.reason === "string" && item.reason.trim().length > 0, `${reviewPath}: qualityには確認した理由のreasonが必要です: ${item.path}`);
    } else {
      assert2(item.reason === undefined, `${reviewPath}: assuranceにはreasonを書かず、理由は.feedback-loop.jsonだけに置きます: ${item.path}`);
    }
    return { path: item.path, class: item.class, sha256: item.sha256 };
  });
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
  assert2(new Set(actual).size === actual.length, "収集結果が重複しています");
  assert2(JSON.stringify([...actual].sort()) === JSON.stringify(expected), `通常収集とtestGlobsの集合が一致しません
collect=${JSON.stringify(actual)}
glob=${JSON.stringify(expected)}`);
  const assurance = new Set(config.assurance.map((item) => item.path));
  assert2(assurance.size === config.assurance.length, "assurance指定が重複しています");
  assert2([...assurance].every((path) => expected.includes(path)), "assuranceに存在しないテストか集合外の指定があります");
  assert2(config.dependencies.every((item) => item.tests.every((path) => expected.includes(path))), "依存対応に集合外のテストがあります");
  return {
    all: expected,
    quality: expected.filter((path) => !assurance.has(path)),
    assurance: [...assurance]
  };
}
function review(root, classes) {
  const records = readReview(root);
  const recorded = new Map(records.map((record) => [record.path, record]));
  assert2(recorded.size === records.length, `${reviewPath}: 同じpathの記録が重複しています`);
  const assurance = new Set(classes.assurance);
  const files = classes.all.map((path) => {
    const sha256 = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    const kind = assurance.has(path) ? "assurance" : "quality";
    const record = recorded.get(path);
    const status = !record ? "unreviewed" : record.class !== kind ? "mismatch" : record.sha256 === sha256 ? "reviewed" : "stale";
    return { path, class: kind, sha256, status };
  });
  const orphans = records.map((record) => record.path).filter((path) => !classes.all.includes(path));
  return {
    complete: orphans.length === 0 && files.every((file) => file.status === "reviewed"),
    files,
    orphans
  };
}

// scripts/feedback-loop/vitest.ts
import assert3 from "node:assert/strict";
import { existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";
function vitestAPI(value) {
  object(value);
  assert3(typeof value.parseCLI === "function" && typeof value.createVitest === "function", "導入版Vitestの公開収集APIを利用できません");
}
async function selectVitest(root, config, quality, changed, apiPath) {
  const relative = changed.map((path) => path.slice(root.length + 1));
  const global = [
    "package.json",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
    ".feedback-loop.json",
    "scripts/feedback-loop/**",
    ...config.globalChanges
  ];
  const reasons = relative.filter((path) => global.some((glob) => matches(path, glob)) || !existsSync2(join2(root, path)));
  const selected = new Set(quality.filter((path) => relative.includes(path)));
  const pending = [];
  const mappedInputs = new Set;
  for (const path of relative) {
    const mapped = config.dependencies.filter((entry) => entry.inputs.some((glob) => matches(path, glob)));
    if (mapped.length > 0) {
      mappedInputs.add(path);
      mapped.forEach((entry) => entry.tests.forEach((test) => selected.add(test)));
    }
    if (!quality.includes(path)) {
      pending.push(path);
    }
  }
  if (reasons.length === 0 && pending.length > 0) {
    const api = await import(pathToFileURL(apiPath).href);
    vitestAPI(api);
    const exclude = config.assurance.flatMap((entry) => ["--exclude", join2(root, entry.path)]);
    const parsed = api.parseCLI([
      "vitest",
      "related",
      ...pending,
      ...config.testArgs,
      ...exclude,
      "--run"
    ]);
    const context = await api.createVitest("test", { ...parsed.options, watch: false });
    try {
      for (const path of pending) {
        context.config.related = [join2(root, path)];
        const specs = await context.getRelevantTestSpecifications();
        const files = specs.map((spec) => spec.moduleId.slice(root.length + 1));
        const reached = files.filter((file) => quality.includes(file));
        assert3(reached.length === files.length, `Vitestの到達先がquality集合と一致しません: ${files.filter((file) => !quality.includes(file)).join(", ")}`);
        if (reached.length === 0 && !mappedInputs.has(path)) {
          reasons.push(path);
        }
        reached.forEach((file) => selected.add(file));
      }
    } finally {
      await context.close();
    }
  }
  return {
    files: reasons.length > 0 ? quality : quality.filter((path) => selected.has(path)),
    reasons
  };
}

// scripts/test-runtime/affected.ts
import { spawnSync } from "node:child_process";
import { join as join3 } from "node:path";
var fixedAllPaths = ["package.json", "bun.lock", "tsconfig.json"];
function selectAffected(input) {
  const { root, changed, testFiles, records } = input;
  const fixed = new Set(fixedAllPaths.map((path) => `${root}/${path}`));
  const testSet = new Set(testFiles);
  const selected = new Set(testFiles.filter((file) => !records.has(file)));
  const reasons = [];
  for (const path of changed) {
    if (testSet.has(path)) {
      selected.add(path);
      continue;
    }
    const reached = fixed.has(path) ? [] : testFiles.filter((file) => records.get(file)?.has(path));
    if (reached.length === 0) {
      reasons.push(path);
    }
    for (const file of reached) {
      selected.add(file);
    }
  }
  if (reasons.length > 0) {
    return { kind: "all", reasons };
  }
  return { kind: "tests", tests: testFiles.filter((file) => selected.has(file)) };
}
function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}
function nulSeparated(text) {
  return text.split("\x00").filter((path) => path !== "");
}
function mergeBase(root, base) {
  return git(root, ["merge-base", base, "HEAD"]).trim();
}
function changedFiles({ root, base }) {
  const comparison = mergeBase(root, base);
  const tracked = git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--relative",
    "-z",
    comparison
  ]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])].map((path) => join3(root, path));
}

// scripts/test-runtime/affected-records.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as join4, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/shared/values.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// scripts/test-runtime/affected-records.ts
function recordsPath(root) {
  const result = spawnSync2("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git rev-parse --git-dir failed: ${result.stderr}`);
  }
  return join4(resolve(root, result.stdout.trim()), "feedback-loop", "test-deps.json");
}
function parseRecords(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return;
  }
  const records = new Map;
  for (const [file, modules] of Object.entries(parsed)) {
    if (!Array.isArray(modules) || !modules.every((m) => typeof m === "string")) {
      return;
    }
    records.set(file, new Set(modules));
  }
  return records;
}
function loadRecords(root, trusted = false, changed = [], testFiles) {
  const { records, warning } = loadRecordsAtPath(root, recordsPath(root), trusted, changed, testFiles);
  return { records, warning };
}
function loadRecordsAtPath(root, path, trusted = false, changed = [], testFiles) {
  let original;
  try {
    original = readFileSync2(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { records: new Map, warning: undefined };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      records: new Map,
      warning: `${path} を読めないため、記録なしとして扱います: ${reason}`,
      readError: error
    };
  }
  const records = parseRecords(original.toString("utf8"));
  if (records === undefined) {
    return {
      records: new Map,
      warning: `${path} の形が不正なため、記録なしとして扱います`,
      original
    };
  }
  if (trusted) {
    if (existsSync3(`${path}.pending`)) {
      return { records: new Map, warning: "前回の実行が未完了のため全件へ広げます", original };
    }
    return { ...validatedRecords(root, path, records, changed, testFiles), original };
  }
  return { records, warning: undefined, original };
}
function digest(path, digests) {
  const cached = digests.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const hash = existsSync3(path) ? createHash2("sha256").update(readFileSync2(path)).digest("hex") : "missing";
  digests.set(path, hash);
  return hash;
}
function sourceBasis(root, digests) {
  const head = spawnSync2("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) {
    throw new Error(`記録の基点を取得できません: ${head.stderr}`);
  }
  return JSON.stringify([
    head.stdout.trim(),
    process.version,
    process.versions.bun,
    ...[
      ...new Set([
        fileURLToPath(import.meta.url),
        ...["affected-records.ts", "affected.ts", "record-modules.ts"].map((name) => join4(dirname(fileURLToPath(import.meta.url)), name))
      ])
    ].map((path) => digest(path, digests)),
    ...[
      ".feedback-loop.json",
      "bunfig.toml",
      "package.json",
      "bun.lock",
      "bun.lockb",
      "package-lock.json"
    ].map((name) => digest(join4(root, name), digests))
  ]);
}
function readProvenance(recordsFile) {
  const path = `${recordsFile}.basis.json`;
  if (!existsSync3(path)) {
    return new Map;
  }
  const parsed = JSON.parse(readFileSync2(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`記録の基点が不正です: ${path}`);
  }
  const result = new Map;
  for (const [file, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.basis !== "string" || !isRecord(value.files)) {
      throw new Error(`記録の基点が不正です: ${path}`);
    }
    const files = {};
    for (const [module, hash] of Object.entries(value.files)) {
      if (typeof hash !== "string") {
        throw new Error(`記録のhashが不正です: ${path}`);
      }
      files[module] = hash;
    }
    result.set(file, { basis: value.basis, files });
  }
  return result;
}
function validatedRecords(root, path, records, changed, testFiles) {
  try {
    const provenance = readProvenance(path);
    const digests = new Map;
    const basis = sourceBasis(root, digests);
    const accounted = new Set(changed);
    const current = testFiles === undefined ? undefined : new Set(testFiles);
    const relevant = [...records].filter(([file]) => current === undefined || current.has(file));
    const valid = new Map(relevant.filter(([file, modules]) => {
      const entry = provenance.get(file);
      return entry?.basis === basis && [...modules].every((module) => accounted.has(module) || entry.files[module] === digest(module, digests));
    }));
    return valid.size === relevant.length ? { records: valid, warning: undefined } : { records: new Map, warning: "古い、または基点不明の依存記録は採用せず全件へ広げます" };
  } catch (error) {
    return { records: new Map, warning: `依存記録の基点を確認できません: ${String(error)}` };
  }
}
function saveRecords({ root, ran, failed, trusted = false }) {
  const path = recordsPath(root);
  const { records, original, readError } = loadRecordsAtPath(root, path);
  if (failed.length > 0 || existsSync3(`${path}.pending`)) {
    if (readError !== undefined) {
      throw readError;
    }
    if (original !== undefined) {
      const hash = createHash2("sha256").update(original).digest("hex");
      writeFileSync(`${path}.${hash}.previous`, original);
    }
  }
  for (const [file, modules] of ran) {
    records.set(file, modules);
  }
  for (const file of failed) {
    records.delete(file);
  }
  const body = Object.fromEntries([...records].map(([file, modules]) => [file, [...modules].sort()]));
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}
`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (!trusted) {
    return;
  }
  let provenance = new Map;
  try {
    provenance = readProvenance(path);
  } catch {}
  const digests = new Map;
  const basis = sourceBasis(root, digests);
  for (const [file, modules] of ran) {
    provenance.set(file, {
      basis,
      files: Object.fromEntries([...modules].map((module) => [module, digest(module, digests)]))
    });
  }
  for (const file of failed) {
    provenance.delete(file);
  }
  writeFileSync(`${path}.basis.json`, `${JSON.stringify(Object.fromEntries(provenance), null, 2)}
`);
  rmSync(`${path}.pending`, { force: true });
}

// scripts/feedback-loop/bun-report.ts
import assert4 from "node:assert/strict";
import { resolve as resolve2 } from "node:path";
function elements(node, name) {
  return node.children.filter((child) => typeof child !== "string" && ("name" in child) && child.name === name);
}
function count(node, name, fallback) {
  const value = node.attributes[name] ?? fallback;
  assert4(value !== undefined && /^\d+$/.test(value), `JUnitの${name}が不正です`);
  const result = Number(value);
  assert4(Number.isSafeInteger(result), `JUnitの${name}が不正です`);
  return result;
}
function counts(node, allowSkipped) {
  const tests = count(node, "tests");
  const skipped = count(node, "skipped");
  assert4(tests > 0 && skipped <= tests, "JUnitの完了件数が不正または0件です");
  assert4(allowSkipped || skipped === 0, "許可されていないskipがあります");
  assert4(count(node, "failures") === 0 && count(node, "errors", "0") === 0, "JUnitに失敗が記録されています");
  return { tests, skipped };
}
function readBunReport(text, root, candidates, allowSkipped) {
  const report = Bun.XML.parse(text, { compact: false });
  assert4(report.name === "testsuites", "Bun JUnitのrootがありません");
  const total = counts(report, allowSkipped);
  const completed = new Map;
  let tests = 0;
  let skipped = 0;
  for (const suite of elements(report, "testsuite")) {
    const file = suite.attributes.file;
    assert4(file && file.trim(), "JUnitのテストファイルがありません");
    const owner = resolve2(root, file);
    assert4(candidates.has(owner), `JUnitに候補外のファイルがあります: ${file}`);
    assert4(!completed.has(owner), `JUnitのファイルが重複しています: ${file}`);
    const summary = counts(suite, allowSkipped);
    const cases = elements(suite, "testcase");
    assert4(cases.length === summary.tests, `JUnitのファイル別件数が一致しません: ${file}`);
    let skippedCases = 0;
    for (const item of cases) {
      assert4(item.attributes.file && resolve2(root, item.attributes.file) === owner, `JUnitのtestcaseのファイルが一致しません: ${file}`);
      assert4(elements(item, "failure").length === 0 && elements(item, "error").length === 0, `JUnitのtestcaseが失敗しています: ${file}`);
      if (elements(item, "skipped").length > 0) {
        skippedCases++;
      }
    }
    assert4(skippedCases === summary.skipped, `JUnitのskip件数が一致しません: ${file}`);
    tests += summary.tests;
    skipped += summary.skipped;
    completed.set(owner, summary.tests - summary.skipped);
  }
  assert4(tests === total.tests && skipped === total.skipped, "JUnitのファイル別件数と全体件数が一致しません");
  return completed;
}

// scripts/feedback-loop/runtime.ts
var runtime = fileURLToPath2(import.meta.url);
function recorderModule(value) {
  object(value);
  assert5(typeof value.recorderEnv === "function" && typeof value.readRecords === "function", "記録器を読み込めません");
}
function select(root, config, quality, changed) {
  const fixed = [
    "package.json",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
    ".feedback-loop.json",
    "scripts/feedback-loop/**"
  ];
  const relative = changed.map((path) => path.slice(root.length + 1));
  const global = relative.filter((path) => [...fixed, ...config.globalChanges].some((glob) => matches(path, glob)));
  const testFiles = quality.map((path) => join5(root, path));
  const { records, warning } = loadRecords(root, true, changed, testFiles);
  const dependencies = new Map(records);
  for (const path of relative) {
    for (const dependency of config.dependencies) {
      if (dependency.inputs.some((glob) => matches(path, glob))) {
        dependency.tests.forEach((test) => {
          const file = join5(root, test);
          dependencies.set(file, new Set([...dependencies.get(file) ?? [], join5(root, path)]));
        });
      }
    }
  }
  const selection = selectAffected({
    root,
    changed,
    testFiles,
    records: dependencies
  });
  const unreached = selection.kind === "all" ? selection.reasons.map((path) => path.slice(root.length + 1)) : [];
  const reasons = [...new Set([...global, ...warning ? [warning] : [], ...unreached])];
  if (records.size === 0) {
    reasons.push("信頼できる依存記録なし");
  }
  if (reasons.length > 0) {
    console.log(`quality全件の理由: ${reasons.join(", ")}`);
    return { files: quality, all: true };
  }
  assert5(selection.kind === "tests");
  return { files: selection.tests.map((path) => path.slice(root.length + 1)), all: false };
}
async function runBunBatch(root, config, batch) {
  const candidates = new Set(batch.files.map((file) => join5(root, file)));
  const report = join5(batch.dir, "results.xml");
  const recordDir = join5(batch.dir, "records");
  await mkdir(recordDir, { recursive: true });
  const argv = [
    process.versions.bun ? process.execPath : "bun",
    ...config.bunArgs,
    "test",
    ...batch.files.map((file) => `./${file}`),
    ...config.testArgs,
    "--no-orphans",
    "--isolate",
    `--parallel=${config.bunWorkers}`,
    "--reporter=junit",
    "--reporter-outfile",
    report,
    ...batch.comparison === undefined ? [] : [`--changed=${batch.comparison}`]
  ];
  const { stderr } = await execute(argv, {
    runtime,
    retryCommand: `${"bun"} run test:affected`,
    env: batch.recorder.recorderEnv(process.env, recordDir, batch.recorderFile)
  });
  const recorded = await batch.recorder.readRecords(recordDir);
  const excluded = batch.comparison !== undefined && !existsSync4(report) && recorded.size === 0 && /^--changed: (?:\d+ changed files?, but no test files are affected|no changed files, nothing to run)\r?$/m.test(stripVTControlCharacters(stderr));
  const results = excluded ? new Map : readBunReport(await readFile(report, "utf8"), root, candidates, config.allowSkipped);
  assert5(recorded.size === results.size && [...recorded.keys()].every((file) => results.has(file)), "読み込んだテストとJUnitのファイル集合が一致しません");
  assert5(batch.comparison !== undefined || results.size === candidates.size, "指定したテストの結果が欠落しています");
  return new Map([...results].map(([owner, count]) => {
    const modules = recorded.get(owner);
    assert5(modules, `完了したテストの依存記録がありません: ${owner}`);
    return [owner, { count, modules }];
  }));
}
async function bunTests(root, config, quality, changed) {
  const selected = select(root, config, quality, changed);
  const comparison = mergeBase(root, config.base);
  const dir = await mkdtemp(join5(tmpdir(), "feedback-loop-"));
  const recorderFile = join5(root, "scripts/feedback-loop/record-modules.ts");
  const recorder = await import(pathToFileURL2(recorderFile).href);
  recorderModule(recorder);
  const ran = new Map;
  const attempted = new Set;
  let completed = 0;
  let succeeded = false;
  try {
    const pending = `${recordsPath(root)}.pending`;
    await mkdir(dirname2(pending), { recursive: true });
    await writeFile(pending, `incomplete
`);
    const batches = [{ files: quality, changed: !selected.all }];
    for (const [index, batch] of batches.entries()) {
      const candidates = new Set(batch.files.map((file) => join5(root, file)));
      candidates.forEach((file) => attempted.add(file));
      const results = await runBunBatch(root, config, {
        files: batch.files,
        comparison: batch.changed ? comparison : undefined,
        dir: join5(dir, String(index)),
        recorderFile,
        recorder
      });
      candidates.forEach((file) => {
        if (!results.has(file)) {
          attempted.delete(file);
        }
      });
      results.forEach(({ count, modules }, owner) => {
        completed += count;
        if (count > 0) {
          ran.set(owner, modules);
        }
      });
      if (batch.changed) {
        const remaining = selected.files.filter((file) => !results.has(join5(root, file)));
        if (remaining.length > 0) {
          batches.push({ files: remaining, changed: false });
        }
      }
    }
    console.log(`quality選択: ${attempted.size}件（Bunの実行結果と補完依存の和集合）`);
    assert5(attempted.size > 0, "候補0件: 関連テストがありません");
    assert5(completed > 0, "未実行: 選択したテストがすべてskipされています");
    succeeded = true;
  } finally {
    saveRecords({
      root,
      ran: succeeded ? ran : new Map,
      failed: [...attempted].filter((file) => !succeeded || !ran.has(file)),
      trusted: true
    });
    await rm(dir, { recursive: true, force: true });
  }
}
async function vitestTests(root, config, quality, changed) {
  const require2 = createRequire(join5(root, "package.json"));
  const packagePath = require2.resolve("vitest/package.json");
  const installed = JSON.parse(readFileSync3(packagePath, "utf8"));
  object(installed);
  object(installed.bin);
  assert5(typeof installed.bin.vitest === "string", "Vitestの公開CLIがありません");
  const cli = join5(dirname2(packagePath), installed.bin.vitest);
  const selected = await selectVitest(root, config, quality, changed, require2.resolve("vitest/node"));
  assert5(selected.files.length > 0, "候補0件: Vitestの関連qualityがありません");
  const exclude = config.assurance.flatMap((entry) => ["--exclude", join5(root, entry.path)]);
  const selection = selected.reasons.length > 0 ? ["run", ...quality] : ["related", ...selected.files, "--run"];
  if (selected.reasons.length > 0) {
    console.log(`quality全件の理由: 設定変更、削除、または依存先不明: ${selected.reasons.join(", ")}`);
  }
  const dir = await mkdtemp(join5(tmpdir(), "feedback-vitest-"));
  try {
    const report = join5(dir, "results.json");
    await execute([
      process.execPath,
      cli,
      ...selection,
      ...config.testArgs,
      ...exclude,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ], { runtime, retryCommand: "bun run test:affected" });
    const result = JSON.parse(await readFile(report, "utf8"));
    object(result);
    assert5(result.success === true && typeof result.numTotalTests === "number" && result.numTotalTests > 0, "Vitestが完了していません。候補0件または結果欠落");
    assert5(Array.isArray(result.testResults), "Vitestのファイル結果がありません");
    assert5(typeof result.numPassedTests === "number" && result.numPassedTests > 0, "未実行: Vitestで成功したテストがありません");
    if (!config.allowSkipped) {
      assert5(result.numPassedTests === result.numTotalTests, "未実行: Vitestにskipまたはtodoがあります");
    }
    const executed = result.testResults.map((item) => {
      object(item);
      assert5(typeof item.name === "string", "Vitest結果のファイル名が不正です");
      return item.name.startsWith(root + "/") ? item.name.slice(root.length + 1) : item.name;
    });
    assert5(executed.length > 0 && executed.every((file) => quality.includes(file)), "Vitestの実行結果がquality集合と一致しません");
    const completed = new Set(executed);
    assert5(selected.files.every((file) => completed.has(file)), "Vitestの選択したテストの結果が欠落しています");
    console.log(`quality選択: ${new Set(executed).size}件（Vitestの実行結果）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
try {
  const root = process.cwd();
  const operation = process.argv[2];
  if (operation === "execute-child") {
    assert5(process.connected && typeof process.send === "function", "内部の検査監視には親とのIPC接続が必要です");
    const input = await new Promise((done, fail) => {
      const disconnected = () => {
        process.off("message", received);
        fail(new Error("検査の開始前に親との接続が切れました"));
      };
      const received = (value) => {
        process.off("disconnect", disconnected);
        done(value);
      };
      process.once("disconnect", disconnected);
      process.once("message", received);
    });
    object(input);
    const { argv, env } = input;
    assert5(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string"));
    object(env);
    const environment = {};
    for (const [key, value] of Object.entries(env)) {
      assert5(typeof value === "string");
      environment[key] = value;
    }
    process.stderr.on("error", () => {
      process.exitCode = 1;
      if (process.connected) {
        process.disconnect?.();
      }
    });
    await execute(argv, { runtime, env: environment, monitorParent: true });
  } else {
    assert5(operation === "classification" || operation === "affected", "操作はclassificationまたはaffectedです");
    const config = readConfig(root);
    const classes = await classification(root, config, runtime, "bun run test:affected");
    if (operation === "classification") {
      const options = process.argv.slice(3).filter((arg) => arg !== "--");
      assert5(options.every((arg) => arg === "--complete"), `classificationの指定は--completeだけです: ${options.join(" ")}`);
      const reviewed = review(root, classes);
      console.log(JSON.stringify({ ...classes, review: reviewed }, null, 2));
      const pending = [
        ...reviewed.files.filter((file) => file.status !== "reviewed"),
        ...reviewed.orphans.map((path) => ({ path, status: "orphan" }))
      ];
      if (pending.length > 0) {
        const count = (status) => pending.filter((file) => file.status === status).length;
        console.error(`分類の確認記録が未完了です（unreviewed ${count("unreviewed")}件・stale ${count("stale")}件・mismatch ${count("mismatch")}件・orphan ${count("orphan")}件）
` + pending.map((file) => `${file.status}: ${file.path}`).join(`
`));
        assert5(!options.includes("--complete"), "全件分類は完了していません");
      }
    } else {
      const changed = changedFiles({ root, base: config.base }).filter((path) => path !== join5(root, reviewPath));
      console.log(`quality候補: ${classes.quality.length}件（全体checkではありません）`);
      assert5(changed.length > 0, "変更なし: テストを実行しません");
      assert5(classes.quality.length > 0, "候補0件: qualityがありません");
      if (config.prepare.length > 0) {
        await execute(config.prepare, {
          runtime,
          retryCommand: "bun run test:affected"
        });
      }
      if (config.runner === "bun") {
        await bunTests(root, config, classes.quality, changed);
      } else {
        await vitestTests(root, config, classes.quality, changed);
      }
      console.log("選択したqualityが成功しました。全体checkの成功ではありません");
    }
  }
} catch (error) {
  console.error(`feedback-loop未完了: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
