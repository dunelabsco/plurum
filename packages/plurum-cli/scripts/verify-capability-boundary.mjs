import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAst } from "rolldown/parseAst";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, "src");

const allowedExternalImports = new Map([
  ["src/cli.ts", new Map([["node:util", ["parseArgs"]]])],
  [
    "src/adapters/node/random.ts",
    new Map([["node:crypto", ["randomBytes", "randomUUID"]]]),
  ],
  [
    "src/adapters/node/hash.ts",
    new Map([["node:crypto", ["createHash"]]]),
  ],
  [
    "src/adapters/node/platform.ts",
    new Map([
      ["node:path", ["posix", "win32"]],
      ["node:process", ["default:process"]],
    ]),
  ],
]);

const allowedProcessMembers = new Map([
  ["src/runtime.ts", new Set(["stdin", "stdout", "stderr"])],
  ["src/index.ts", new Set(["argv", "exitCode", "stderr"])],
  [
    "src/adapters/node/platform.ts",
    new Set([
      "platform",
      "arch",
      "cwd",
      "env",
      "getuid",
      "geteuid",
      "getgid",
      "getegid",
      "getgroups",
    ]),
  ],
]);

const reservedGlobals = new Map([
  ["require", "commonjs-require"],
  ["module", "commonjs-require"],
  ["createRequire", "commonjs-require"],
  ["fetch", "network-global"],
  ["WebSocket", "network-global"],
  ["EventSource", "network-global"],
  ["crypto", "random-global"],
  ["setTimeout", "timer-global"],
  ["setInterval", "timer-global"],
  ["setImmediate", "timer-global"],
  ["queueMicrotask", "timer-global"],
  ["Function", "dynamic-code"],
  ["eval", "dynamic-code"],
  ["Reflect", "dynamic-code"],
  ["Bun", "runtime-global"],
  ["Deno", "runtime-global"],
  ["console", "diagnostic-global"],
]);
const unwiredNativeBoundaryStem =
  "src/adapters/node/native-credential-store";
const sourceModuleExtensions = Object.freeze([
  "",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

function isUnwiredNativeBoundaryModule(resolvedModule) {
  return sourceModuleExtensions.some(
    (extension) => resolvedModule === `${unwiredNativeBoundaryStem}${extension}`,
  );
}

function isAllowedNativeReflectReference(node, parent) {
  return (
    node.name === "Reflect" &&
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    parent.computed === false &&
    parent.optional === false &&
    parent.property.type === "Identifier" &&
    ["apply", "ownKeys"].includes(parent.property.name)
  );
}

function normalizedRelative(filePath) {
  return relative(packageRoot, filePath).split(sep).join("/");
}

function walkSource(directory, result = { files: [], findings: [] }) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const target = join(directory, entry.name);
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) {
      result.findings.push({
        file: normalizedRelative(target),
        line: 1,
        column: 1,
        rule: "source-symlink",
        reason: "production source paths must not be symbolic links",
      });
    } else if (entry.isDirectory()) {
      walkSource(target, result);
    } else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      const relativeTarget = normalizedRelative(target);
      if (relativeTarget !== relativeTarget.toLowerCase()) {
        result.findings.push({
          file: relativeTarget,
          line: 1,
          column: 1,
          rule: "source-casing",
          reason: "production source paths must use canonical lowercase casing",
        });
      }
      result.files.push(target);
    }
  }
  return result;
}

function isExternalSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function importBindings(node) {
  if (node.specifiers.length === 0) {
    return ["side-effect"];
  }
  return node.specifiers
    .map((specifier) => {
      if (specifier.type === "ImportDefaultSpecifier") {
        return `default:${specifier.local.name}`;
      }
      if (specifier.type === "ImportNamespaceSpecifier") {
        return `namespace:${specifier.local.name}`;
      }
      const imported = specifier.imported.name ?? specifier.imported.value;
      const typeOnly =
        node.importKind === "type" || specifier.importKind === "type";
      return typeOnly ? `type:${imported}` : imported;
    })
    .sort();
}

function isTypeOnlyImport(node) {
  return (
    node.importKind === "type" ||
    (node.specifiers.length > 0 &&
      node.specifiers.every(
        (specifier) =>
          specifier.type === "ImportSpecifier" && specifier.importKind === "type",
      ))
  );
}

function isNode(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    Number.isInteger(value.start)
  );
}

function isIdentifierReference(node, parent, key) {
  if (parent === undefined) {
    return true;
  }
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (
    [
      "ImportSpecifier",
      "ImportDefaultSpecifier",
      "ImportNamespaceSpecifier",
      "ExportSpecifier",
      "TSTypeReference",
      "TSQualifiedName",
    ].includes(parent.type)
  ) {
    return false;
  }
  if (
    [
      "VariableDeclarator",
      "FunctionDeclaration",
      "FunctionExpression",
      "ClassDeclaration",
      "ClassExpression",
      "TSInterfaceDeclaration",
      "TSTypeAliasDeclaration",
      "TSModuleDeclaration",
    ].includes(parent.type) &&
    (key === "id" || key === "name")
  ) {
    return false;
  }
  if (
    [
      "Property",
      "MethodDefinition",
      "PropertyDefinition",
      "TSPropertySignature",
      "TSMethodSignature",
    ].includes(parent.type) &&
    key === "key" &&
    !parent.computed
  ) {
    return false;
  }
  return true;
}

function scanText(relativePath, text) {
  let program;
  try {
    program = parseAst(text, { lang: "ts" }, relativePath);
  } catch {
    return [
      {
        file: relativePath,
        line: 1,
        column: 1,
        rule: "parse-error",
        reason: "production source must be parseable by the capability verifier",
      },
    ];
  }

  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  const findings = [];
  const seen = new Set();

  function location(offset) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  }

  function report(node, rule, reason) {
    const position = location(node.start);
    const key = `${position.line}:${position.column}:${rule}:${reason}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push({ file: relativePath, ...position, rule, reason });
  }

  function validateModule(node, specifier, importNode) {
    let resolvedModule;
    if (specifier.toLowerCase().endsWith(".node")) {
      report(
        node,
        "native-binary-import",
        "native binaries require a separately reviewed fixed-package bridge",
      );
    }
    if (specifier.startsWith(".")) {
      const sourceDirectory = posix.dirname(relativePath);
      resolvedModule = posix.normalize(posix.join(sourceDirectory, specifier));
      const relativeModule = posix.relative(sourceDirectory, resolvedModule);
      const canonicalSpecifier = relativeModule.startsWith(".")
        ? relativeModule
        : `./${relativeModule}`;
      if (
        /[%\\?#\0]/u.test(specifier) ||
        specifier !== canonicalSpecifier ||
        specifier !== specifier.toLowerCase() ||
        (resolvedModule !== "src" && !resolvedModule.startsWith("src/"))
      ) {
        report(
          node,
          "source-boundary",
          "relative imports must resolve canonically within production source",
        );
      }
    } else if (specifier.startsWith("/")) {
      report(
        node,
        "source-boundary",
        "absolute imports are outside the production source boundary",
      );
    }

    if (isExternalSpecifier(specifier)) {
      const allowed = allowedExternalImports.get(relativePath)?.get(specifier);
      const actual = importNode === undefined ? [] : importBindings(importNode);
      if (
        allowed === undefined ||
        JSON.stringify(actual) !== JSON.stringify([...allowed].sort())
      ) {
        report(
          node,
          "external-module",
          "external modules require an exact file and binding allowlist",
        );
      }
    }

    if (resolvedModule?.startsWith("src/adapters/node/")) {
      const insideAdapter = relativePath.startsWith("src/adapters/node/");
      const approvedBridge =
        relativePath === "src/runtime.ts" &&
        resolvedModule === "src/adapters/node/production.js" &&
        specifier === "./adapters/node/production.js";
      if (!insideAdapter && !approvedBridge) {
        report(
          node,
          "adapter-boundary",
          "Node adapters may only be composed by the runtime boundary",
        );
      }
    }

    if (
      resolvedModule !== undefined &&
      isUnwiredNativeBoundaryModule(resolvedModule)
    ) {
      report(
        node,
        "native-credential-wiring",
        "the native credential boundary must remain unwired until native platform suites pass",
      );
    }

    if (
      relativePath.startsWith("src/commands/") &&
      resolvedModule === "src/runtime.js" &&
      importNode !== undefined &&
      !isTypeOnlyImport(importNode)
    ) {
      report(
        node,
        "command-runtime",
        "commands may only type-import command runtime contracts",
      );
    }
  }

  function visit(node, parent, key) {
    if (node.type === "ImportDeclaration") {
      validateModule(node.source, node.source.value, node);
      if (
        relativePath !== "src/index.ts" &&
        node.specifiers.some(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            node.importKind !== "type" &&
            (specifier.imported.name ?? specifier.imported.value) ===
              "createProcessRuntime",
        )
      ) {
        report(
          node,
          "runtime-composition",
          "only the executable entrypoint may import createProcessRuntime",
        );
      }
    } else if (
      (node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      node.source !== null &&
      node.source !== undefined
    ) {
      validateModule(node.source, node.source.value, undefined);
    } else if (node.type === "TSImportEqualsDeclaration") {
      report(
        node,
        "commonjs-require",
        "CommonJS module loading is outside the capability boundary",
      );
    } else if (node.type === "ImportExpression") {
      report(
        node,
        "dynamic-import",
        "dynamic imports are outside the static capability boundary",
      );
    }

    if (node.type === "CallExpression") {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        report(
          node,
          "commonjs-require",
          "CommonJS module loading is outside the capability boundary",
        );
      }
      if (
        node.callee.type === "Identifier" &&
        (node.callee.name === "eval" || node.callee.name === "Function")
      ) {
        report(
          node,
          "dynamic-code",
          "dynamic code execution is outside the capability boundary",
        );
      }
      if (node.callee.type === "Identifier" && node.callee.name === "Date") {
        report(node, "clock-global", "wall-clock access must use the clock adapter");
      }
    }

    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Function"
    ) {
      report(
        node,
        "dynamic-code",
        "dynamic code execution is outside the capability boundary",
      );
    }
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Date" &&
      node.arguments.length === 0
    ) {
      report(node, "clock-global", "wall-clock access must use the clock adapter");
    }

    if (node.type === "MemberExpression" && !node.computed) {
      const objectName =
        node.object.type === "Identifier" ? node.object.name : undefined;
      const propertyName =
        node.property.type === "Identifier" ? node.property.name : undefined;
      if (objectName === "Math" && propertyName === "random") {
        report(node, "random-global", "randomness must use the random adapter");
      }
      if (
        objectName === "Date" &&
        propertyName === "now" &&
        relativePath !== "src/adapters/node/clock.ts"
      ) {
        report(node, "clock-global", "wall-clock access must use the clock adapter");
      }
      if (objectName === "performance" && propertyName === "now") {
        report(node, "clock-global", "monotonic time must use an injected adapter");
      }
      if (objectName === "AbortSignal" && propertyName === "timeout") {
        report(node, "timer-global", "timeouts must use an injected adapter");
      }
    }

    if (node.type === "MemberExpression") {
      const objectName =
        node.object.type === "Identifier" ? node.object.name : undefined;
      const propertyName = node.computed
        ? node.property.type === "Literal"
          ? node.property.value
          : undefined
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
      if (propertyName === "constructor" || propertyName === "__proto__") {
        report(
          node,
          "dynamic-code",
          "prototype constructors can bypass the capability boundary",
        );
      }
      if (
        objectName === "Object" &&
        [
          "getPrototypeOf",
          "getOwnPropertyDescriptor",
          "getOwnPropertyDescriptors",
          "setPrototypeOf",
        ].includes(propertyName) &&
        !(
          relativePath ===
            "src/adapters/node/native-credential-store.ts" &&
          ["getPrototypeOf", "getOwnPropertyDescriptor"].includes(
            propertyName,
          ) &&
          node.computed === false &&
          node.optional === false &&
          parent?.type === "CallExpression" &&
          parent.callee === node &&
          parent.optional === false
        )
      ) {
        report(
          node,
          "dynamic-code",
          "prototype reflection can bypass the capability boundary",
        );
      }
      if (node.computed && (objectName === "Date" || objectName === "Math")) {
        report(
          node,
          objectName === "Date" ? "clock-global" : "random-global",
          "computed global access can bypass the capability boundary",
        );
      }
      if (
        relativePath === "src/adapters/node/native-credential-store.ts" &&
        objectName === "Reflect" &&
        ["apply", "ownKeys"].includes(propertyName) &&
        !(
          node.computed === false &&
          node.optional === false &&
          parent?.type === "CallExpression" &&
          parent.callee === node &&
          parent.optional === false
        )
      ) {
        report(
          node,
          "dynamic-code",
          "Reflect.apply and Reflect.ownKeys are allowed only as direct noncomputed calls in the native credential boundary",
        );
      }
    }

    if (node.type === "Identifier" && isIdentifierReference(node, parent, key)) {
      if (node.name === "process") {
        const member =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier"
            ? parent.property.name
            : undefined;
        if (member === undefined || !allowedProcessMembers.get(relativePath)?.has(member)) {
          report(
            node,
            "process-global",
            "process access is restricted to exact composition members",
          );
        }
      } else if (node.name === "global" || node.name === "globalThis") {
        report(
          node,
          "global-object",
          "global object access can bypass the capability boundary",
        );
      } else if (node.name === "Date") {
        const allowedMember =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier" &&
          (["parse", "UTC"].includes(parent.property.name) ||
            (parent.property.name === "now" &&
              relativePath === "src/adapters/node/clock.ts"));
        const deterministicConstruction =
          parent?.type === "NewExpression" &&
          parent.callee === node &&
          parent.arguments.length > 0;
        if (!allowedMember && !deterministicConstruction) {
          report(node, "clock-global", "wall-clock access must use the clock adapter");
        }
      } else if (node.name === "Math") {
        const deterministicMember =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier" &&
          parent.property.name !== "random";
        if (!deterministicMember) {
          report(node, "random-global", "randomness must use the random adapter");
        }
      } else {
        const rule = reservedGlobals.get(node.name);
        const allowedNativeReflect =
          relativePath === "src/adapters/node/native-credential-store.ts" &&
          isAllowedNativeReflectReference(node, parent);
        if (rule !== undefined && !allowedNativeReflect) {
          report(
            node,
            rule,
            "the global capability must be accessed through an injected adapter",
          );
        }
      }
    }

    for (const [childKey, value] of Object.entries(node)) {
      if (["type", "start", "end", "raw"].includes(childKey)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) {
            visit(child, node, childKey);
          }
        }
      } else if (isNode(value)) {
        visit(value, node, childKey);
      }
    }
  }

  visit(program, undefined, undefined);
  return findings;
}

const negativeFixtures = [
  ["src/example.ts", 'import { readFile } from "node:fs/promises";', "external-module"],
  ["src/example.ts", 'import fs from "fs";', "external-module"],
  ["src/example.ts", 'export * from "node:https";', "external-module"],
  [
    "src/credentials/paths.ts",
    'import { posix } from "node:path";',
    "external-module",
  ],
  [
    "src/adapters/node/platform.ts",
    'import path from "node:path";',
    "external-module",
  ],
  [
    "src/adapters/node/platform.ts",
    'import * as path from "node:path";',
    "external-module",
  ],
  [
    "src/adapters/node/hash.ts",
    'import { randomBytes } from "node:crypto";',
    "external-module",
  ],
  [
    "src/example.ts",
    'import { createHash } from "node:crypto";',
    "external-module",
  ],
  [
    "src/adapters/node/hash.ts",
    'import crypto from "node:crypto";',
    "external-module",
  ],
  [
    "src/adapters/node/hash.ts",
    'import * as crypto from "node:crypto";',
    "external-module",
  ],
  ["src/example.ts", 'void import("node:child_process");', "dynamic-import"],
  ["src/example.ts", "const name = './local.js'; void import(name);", "dynamic-import"],
  ["src/example.ts", 'require("node:fs");', "commonjs-require"],
  [
    "src/example.ts",
    'require.call(null, "node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    '(0, require)("node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    'module.require("node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    'const load = createRequire(import.meta.url); load("node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    'process.dlopen({}, "./credential-store.node");',
    "process-global",
  ],
  [
    "src/adapters/node/example.ts",
    'import { createRequire } from "node:module";',
    "external-module",
  ],
  [
    "src/adapters/node/example.ts",
    'import "./credential-store.node";',
    "native-binary-import",
  ],
  [
    "src/commands/example.ts",
    'import "../adapters/node/production.js";',
    "adapter-boundary",
  ],
  [
    "src/commands/example.ts",
    'import "../adapters//node/production.js";',
    "adapter-boundary",
  ],
  [
    "src/commands/example.ts",
    'import "../ADAPTERS/NODE/production.js";',
    "source-boundary",
  ],
  [
    "src/runtime.ts",
    'import "./adapters/Node/production.js";',
    "source-boundary",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.js";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.ts";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'export * from "./native-credential-store.mjs";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.jsx";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.tsx";',
    "native-credential-wiring",
  ],
  ["src/example.ts", 'import "/tmp/outside.js";', "source-boundary"],
  ["src/example.ts", 'import "../outside.js";', "source-boundary"],
  ["src/example.ts", 'import "./module%2ejs";', "source-boundary"],
  [
    "src/example.ts",
    'import { createProcessRuntime } from "./runtime.js";',
    "runtime-composition",
  ],
  ["src/example.ts", "process.env.SECRET;", "process-global"],
  ["src/example.ts", 'globalThis["fetch"]("http://example.test");', "global-object"],
  ["src/example.ts", 'fetch("http://example.test");', "network-global"],
  ["src/example.ts", "Date.now();", "clock-global"],
  ["src/example.ts", "new Date();", "clock-global"],
  ["src/example.ts", "Math.random();", "random-global"],
  ["src/example.ts", "setTimeout(() => {}, 1);", "timer-global"],
  ["src/example.ts", 'eval("1");', "dynamic-code"],
  ["src/example.ts", 'new Function("return 1");', "dynamic-code"],
  [
    "src/example.ts",
    'Function.call(null, "return process")();',
    "dynamic-code",
  ],
  [
    "src/example.ts",
    'Reflect.construct(Function, ["return process"])();',
    "dynamic-code",
  ],
  [
    "src/example.ts",
    "Reflect.apply(() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect['apply'](() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect['ownKeys']({});",
    "dynamic-code",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "const apply = Reflect.apply; apply(() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/example.ts",
    "Object.getPrototypeOf(() => {}).call(null, 'return process')();",
    "dynamic-code",
  ],
  ["src/example.ts", "(() => {}).constructor('return process')();", "dynamic-code"],
  ["src/example.ts", 'Date["now"]();', "clock-global"],
  ["src/example.ts", 'Math["random"]();', "random-global"],
];

const positiveFixtures = [
  ["src/cli.ts", 'import { parseArgs } from "node:util"; parseArgs({ args: [] });'],
  [
    "src/adapters/node/random.ts",
    'import { randomBytes, randomUUID } from "node:crypto"; randomBytes(1); randomUUID();',
  ],
  [
    "src/adapters/node/hash.ts",
    'import { createHash } from "node:crypto"; createHash("sha256");',
  ],
  [
    "src/adapters/node/platform.ts",
    'import process from "node:process"; process.platform; process.getuid?.();',
  ],
  [
    "src/adapters/node/platform.ts",
    'import { posix, win32 } from "node:path"; posix.join("/a", "b"); win32.join("C:\\\\a", "b");',
  ],
  ["src/adapters/node/clock.ts", "Date.now();"],
  ["src/example.ts", "new Date(0); Date.parse('2026-01-01'); Date.UTC(2026, 0);"],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect.apply(() => 1, undefined, []);",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect.ownKeys(Object.freeze({}));",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");',
  ],
];

for (const [file, fixture, expectedRule] of negativeFixtures) {
  const rules = new Set(scanText(file, fixture).map(({ rule }) => rule));
  if (!rules.has(expectedRule)) {
    throw new Error(`Capability verifier self-test failed (${expectedRule}).`);
  }
}
for (const [file, fixture] of positiveFixtures) {
  if (scanText(file, fixture).length !== 0) {
    throw new Error("Capability verifier positive self-test failed.");
  }
}

const walked = walkSource(sourceRoot);
const findings = [...walked.findings];
for (const sourcePath of walked.files) {
  findings.push(
    ...scanText(normalizedRelative(sourcePath), readFileSync(sourcePath, "utf8")),
  );
}

findings.sort((left, right) =>
  [left.file, left.line, left.column, left.rule]
    .join(":")
    .localeCompare([right.file, right.line, right.column, right.rule].join(":")),
);

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.reason}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `capability boundary verified (${walked.files.length} source files, ${negativeFixtures.length} negative fixtures)\n`,
  );
}
