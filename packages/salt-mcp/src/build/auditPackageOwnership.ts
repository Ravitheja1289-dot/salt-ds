import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import { findSaltRepoRoot, toPosixPath } from "../registry/paths.js";

export interface PackageOwnershipMismatch {
  component: string;
  docs_path: string;
  docs_package: string;
  source_package: string;
  source_repo_path: string;
  source_code_url: string;
}

export interface AuditPackageOwnershipOptions {
  sourceRoot?: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseSourceRepoPath(sourceCodeUrl: string | null): string | null {
  if (!sourceCodeUrl) {
    return null;
  }

  const normalized = sourceCodeUrl.replace(/\\/g, "/");
  const branchPathMatch = normalized.match(/\/(?:blob|tree)\/[^/]+\/(.+)$/);
  if (!branchPathMatch) {
    return null;
  }

  return branchPathMatch[1];
}

function parsePackageNameFromRepoPath(repoPath: string | null): string | null {
  if (!repoPath) {
    return null;
  }

  const normalized = toPosixPath(repoPath);
  const match = normalized.match(/^packages\/([^/]+)/);
  if (!match) {
    return null;
  }

  return `@salt-ds/${match[1]}`;
}

export async function auditPackageOwnership(
  options: AuditPackageOwnershipOptions = {},
): Promise<{ repoRoot: string; mismatches: PackageOwnershipMismatch[] }> {
  const startRoot = options.sourceRoot ?? process.cwd();
  const repoRoot = await findSaltRepoRoot(startRoot);
  if (!repoRoot) {
    throw new Error(
      `Unable to locate Salt repository root from ${path.resolve(startRoot)}.`,
    );
  }

  const componentIndexPaths = await fg("site/docs/components/**/index.mdx", {
    cwd: repoRoot,
    absolute: true,
    onlyFiles: true,
  });

  const mismatches: PackageOwnershipMismatch[] = [];
  for (const componentIndexPath of componentIndexPaths) {
    const raw = await fs.readFile(componentIndexPath, "utf8");
    const parsed = matter(raw);
    if (asString(parsed.data.layout) !== "DetailComponent") {
      continue;
    }

    const title = asString(parsed.data.title);
    if (!title) {
      continue;
    }

    const data = parsed.data.data as Record<string, unknown> | undefined;
    const packageData = data?.package as Record<string, unknown> | undefined;
    const docsPackage = asString(packageData?.name);
    const sourceCodeUrl = asString(data?.sourceCodeUrl);
    const sourceRepoPath = parseSourceRepoPath(sourceCodeUrl);
    const sourcePackage = parsePackageNameFromRepoPath(sourceRepoPath);

    if (
      docsPackage &&
      sourcePackage &&
      docsPackage !== sourcePackage &&
      sourceCodeUrl &&
      sourceRepoPath
    ) {
      mismatches.push({
        component: title,
        docs_path: toPosixPath(path.relative(repoRoot, componentIndexPath)),
        docs_package: docsPackage,
        source_package: sourcePackage,
        source_repo_path: sourceRepoPath,
        source_code_url: sourceCodeUrl,
      });
    }
  }

  mismatches.sort((left, right) =>
    left.component.localeCompare(right.component),
  );
  return { repoRoot, mismatches };
}
