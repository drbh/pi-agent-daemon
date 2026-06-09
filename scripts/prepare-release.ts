const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const IMPORT_KEY = PI_PACKAGE;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const args = parseArgs(Deno.args);
const piVersion = required(args["pi-version"], "--pi-version");
const daemonVersion = args["daemon-version"] || piVersion;

validateVersions(piVersion, daemonVersion);

const packageJson = JSON.parse(await Deno.readTextFile("package.json"));
packageJson.version = daemonVersion;
packageJson.dependencies[PI_PACKAGE] = piVersion;
await writeJson("package.json", packageJson);

const denoJson = JSON.parse(await Deno.readTextFile("deno.json"));
denoJson.imports[IMPORT_KEY] = `npm:${PI_PACKAGE}@${piVersion}`;
await writeJson("deno.json", denoJson);

let protocol = await Deno.readTextFile("src/protocol.ts");
protocol = replaceConst(protocol, "DAEMON_VERSION", daemonVersion);
protocol = replaceConst(protocol, "PI_AGENT_VERSION", piVersion);
await Deno.writeTextFile("src/protocol.ts", protocol);

let readme = await Deno.readTextFile("README.md");
readme = readme.replace(
  /"version": "[^"]+"/,
  `"version": "${daemonVersion}"`,
);
readme = readme.replace(
  /"pi_agent_version": "[^"]+"/,
  `"pi_agent_version": "${piVersion}"`,
);
await Deno.writeTextFile("README.md", readme);

console.log(`Prepared ${daemonVersion} with ${PI_PACKAGE} ${piVersion}`);

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    parsed[key] = value;
  }
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`missing required ${flag}`);
  }
  return value;
}

function validateVersions(piVersion: string, daemonVersion: string) {
  if (!SEMVER.test(piVersion)) {
    throw new Error(`invalid Pi agent SemVer: ${piVersion}`);
  }
  if (!SEMVER.test(daemonVersion)) {
    throw new Error(`invalid daemon SemVer: ${daemonVersion}`);
  }
  if (
    daemonVersion !== piVersion &&
    !daemonVersion.startsWith(`${piVersion}+dev.`)
  ) {
    throw new Error(
      `daemon version must be ${piVersion} or ${piVersion}+dev.N`,
    );
  }
}

async function writeJson(path: string, value: unknown) {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceConst(source: string, name: string, value: string): string {
  const pattern = new RegExp(`export const ${name} = "[^"]+";`);
  if (!pattern.test(source)) {
    throw new Error(`missing ${name} in src/protocol.ts`);
  }
  return source.replace(pattern, `export const ${name} = "${value}";`);
}
