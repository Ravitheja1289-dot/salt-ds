import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { auditPackageOwnership } from "./build/auditPackageOwnership.js";
import { buildRegistry } from "./build/buildRegistry.js";
import { createSaltMcpServer } from "./server/createServer.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "serve", flags: {} };
  }

  const [first, ...rest] = argv;
  const command = first.startsWith("--") ? "serve" : first;
  const valueTokens = first.startsWith("--") ? argv : rest;
  const flags: Record<string, string> = {};

  for (let index = 0; index < valueTokens.length; index += 1) {
    const token = valueTokens[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = valueTokens[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "true";
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { command, flags };
}

async function runBuildRegistry(flags: Record<string, string>): Promise<void> {
  const sourceRoot = flags["source-root"]
    ? path.resolve(flags["source-root"])
    : undefined;
  const outputDir = flags["output-dir"]
    ? path.resolve(flags["output-dir"])
    : undefined;

  const registry = await buildRegistry({
    sourceRoot,
    outputDir,
  });

  console.error(
    `Built registry at ${outputDir ?? "default output"}: ${registry.packages.length} packages, ${registry.components.length} components, ${registry.icons.length} icons, ${registry.country_symbols.length} country symbols, ${registry.patterns.length} patterns, ${registry.tokens.length} tokens.`,
  );
}

async function runAuditOwnership(flags: Record<string, string>): Promise<void> {
  const sourceRoot = flags["source-root"]
    ? path.resolve(flags["source-root"])
    : undefined;
  const failOnMismatch = flags["fail-on-mismatch"] === "true";

  const { mismatches } = await auditPackageOwnership({ sourceRoot });
  if (mismatches.length === 0) {
    console.error("No component package ownership mismatches found.");
    return;
  }

  console.error(
    `Found ${mismatches.length} component package ownership mismatch(es):`,
  );
  console.error(JSON.stringify(mismatches, null, 2));

  if (failOnMismatch) {
    throw new Error(
      `Component package ownership audit failed with ${mismatches.length} mismatch(es).`,
    );
  }
}

async function runServe(flags: Record<string, string>): Promise<void> {
  const registryDir = flags["registry-dir"]
    ? path.resolve(flags["registry-dir"])
    : undefined;
  const siteBaseUrl = flags["site-base-url"]?.trim() || undefined;
  const server = await createSaltMcpServer({ registryDir, siteBaseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("salt-mcp server running on stdio");
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const { command, flags } = parseArgs(argv);

  if (command === "build-registry") {
    await runBuildRegistry(flags);
    return;
  }

  if (command === "audit-ownership") {
    await runAuditOwnership(flags);
    return;
  }

  if (command === "serve") {
    await runServe(flags);
    return;
  }

  console.error(
    `Unknown command: ${command}. Supported commands: serve, build-registry, audit-ownership.`,
  );
  throw new Error(
    `Unknown command: ${command}. Supported commands: serve, build-registry, audit-ownership.`,
  );
}
