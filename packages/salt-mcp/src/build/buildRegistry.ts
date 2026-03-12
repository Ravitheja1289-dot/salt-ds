import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import semver from "semver";
import ts from "typescript";
import { extractMdxTextBlocks } from "./pageTextExtractor.js";
import { buildSerializedPageSearchIndex } from "../search/pageSearchIndex.js";
import {
  type RegistryArrayCollections,
  REGISTRY_ARRAY_ARTIFACTS,
  REGISTRY_METADATA_ARTIFACT,
  REGISTRY_PAGE_SEARCH_INDEX_ARTIFACT,
  REGISTRY_SEARCH_INDEX_ARTIFACT,
  serializeJsonLines,
  writeJsonFile,
} from "../registry/artifacts.js";
import {
  findSaltRepoRoot,
  getPackageRoot,
  toPosixPath,
} from "../registry/paths.js";
import type {
  AccessibilityRule,
  BuildRegistryOptions,
  ChangeRecord,
  ComponentDeprecationInference,
  ComponentDocgenInference,
  ComponentProp,
  ComponentRecord,
  ComponentTokenInference,
  CountrySymbolRecord,
  DeprecationRecord,
  ExampleRecord,
  GuideRecord,
  GuideSnippet,
  IconRecord,
  PackageRecord,
  PageKind,
  PageRecord,
  PatternRecord,
  RegistryBuildInfo,
  RegistrySourceArtifact,
  SaltRegistry,
  SaltStatus,
  SearchIndexEntry,
  TokenRecord,
} from "../types.js";

const REGISTRY_VERSION = "0.1.0";
const MAX_COMPONENT_TOKENS = 40;
const EXCLUDED_REGISTRY_PACKAGES = new Set(["@salt-ds/mcp"]);
const DOCGEN_PACKAGE_FILE_MAP: Record<string, string> = {
  "ag-grid-theme-props.json": "@salt-ds/ag-grid-theme",
  "core-props.json": "@salt-ds/core",
  "countries-props.json": "@salt-ds/countries",
  "data-grid-props.json": "@salt-ds/data-grid",
  "embla-carousel-props.json": "@salt-ds/embla-carousel",
  "icons-props.json": "@salt-ds/icons",
  "lab-props.json": "@salt-ds/lab",
  "react-resizable-panel-theme-props.json":
    "@salt-ds/react-resizable-panels-theme",
  "react-resziable-panel-theme-props.json":
    "@salt-ds/react-resizable-panels-theme",
};

type DocgenTypeValue =
  | string
  | number
  | boolean
  | null
  | {
      value?: unknown;
      computed?: boolean;
    };

interface DocgenTypeShape {
  name?: unknown;
  value?: unknown;
}

interface DocgenPropShape {
  defaultValue?: unknown;
  description?: unknown;
  required?: unknown;
  type?: DocgenTypeShape;
}

interface DocgenComponentShape {
  displayName?: unknown;
  props?: unknown;
}

interface PropMetadata {
  byPackage: Map<string, Map<string, DocgenComponentShape[]>>;
}

interface PackageChangelogMetadata {
  deprecatedBySymbol: Map<string, string>;
}

interface ParsedChangelogItem {
  version: string;
  release_type: ChangeRecord["release_type"];
  text: string;
}

interface ComponentMentionPattern {
  component: ComponentRecord;
  regex: RegExp;
  phrase_length: number;
}

interface IconSynonymMetadata {
  iconName: string;
  synonym: string[];
  category: string;
}

interface CountrySymbolMetadata {
  countryCode: string;
  countryName: string;
}

interface DocgenSelection {
  candidate: DocgenComponentShape | null;
  inference: ComponentDocgenInference;
}

interface SiteSearchPageShape {
  title?: unknown;
  route?: unknown;
  content?: unknown;
  keywords?: unknown;
}

interface MarkdownPageMetadata {
  summary: string | null;
  section_headings: string[];
}

interface MarkdownPageSource extends MarkdownPageMetadata {
  content: string[];
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function toMatchKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toPascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function splitPascalCase(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function pascalToKebabCase(input: string): string {
  return splitPascalCase(input)
    .map((part) => part.toLowerCase())
    .join("-");
}

function pascalToLabel(input: string): string {
  return splitPascalCase(input).join(" ");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const valid = semver.valid(trimmed);
  if (valid) {
    return valid;
  }

  const min = semver.minVersion(trimmed)?.version;
  if (min) {
    return min;
  }

  return semver.coerce(trimmed)?.version ?? null;
}

function preferEarlierVersion(
  current: string | null | undefined,
  candidate: string | null | undefined,
): string | null {
  const normalizedCurrent = normalizeVersion(current);
  const normalizedCandidate = normalizeVersion(candidate);

  if (!normalizedCurrent) {
    return normalizedCandidate;
  }
  if (!normalizedCandidate) {
    return normalizedCurrent;
  }

  return semver.lte(normalizedCurrent, normalizedCandidate)
    ? normalizedCurrent
    : normalizedCandidate;
}

function cleanMarkdownText(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/^\s*[-*]\s+/g, "")
      .replace(/^\s*\d+\.\s+/g, "")
      .replace(/\s*\\\s*/g, " ")
      .replace(/^\s*\{\/\*.*\*\/\}\s*$/gm, ""),
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingCommitHash(input: string): string {
  return input.replace(/^[a-f0-9]{7,}:\s*/i, "").trim();
}

function classifyReleaseType(
  heading: string,
): ChangeRecord["release_type"] {
  const normalized = heading.trim().toLowerCase();
  if (normalized.includes("major")) {
    return "major";
  }
  if (normalized.includes("minor")) {
    return "minor";
  }
  if (normalized.includes("patch")) {
    return "patch";
  }
  return "unknown";
}

function parseChangelogItems(content: string): ParsedChangelogItem[] {
  const items: ParsedChangelogItem[] = [];
  let currentVersion: string | null = null;
  let currentReleaseType: ChangeRecord["release_type"] = "unknown";
  let currentLines: string[] = [];
  let inCodeBlock = false;

  const flushItem = () => {
    if (!currentVersion || currentLines.length === 0) {
      currentLines = [];
      return;
    }

    const text = cleanMarkdownText(
      stripLeadingCommitHash(currentLines.join(" ")),
    );
    if (text.length > 0) {
      items.push({
        version: currentVersion,
        release_type: currentReleaseType,
        text,
      });
    }
    currentLines = [];
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    const versionMatch = trimmed.match(/^##\s+([0-9][^\s]*)\s*$/);
    if (versionMatch) {
      flushItem();
      currentVersion = normalizeVersion(versionMatch[1]);
      currentReleaseType = "unknown";
      continue;
    }

    const releaseTypeMatch = trimmed.match(/^###\s+(.+?)\s*$/);
    if (releaseTypeMatch) {
      flushItem();
      currentReleaseType = classifyReleaseType(releaseTypeMatch[1]);
      continue;
    }

    if (!currentVersion) {
      continue;
    }

    if (/^- /.test(rawLine)) {
      flushItem();
      currentLines = [rawLine.replace(/^- /, "").trim()];
      continue;
    }

    if (currentLines.length === 0 || trimmed.length === 0) {
      continue;
    }

    currentLines.push(trimmed.replace(/^- /, ""));
  }

  flushItem();
  return items;
}

function summarizeChangeText(text: string): string {
  const normalized = stripLeadingCommitHash(cleanMarkdownText(text));
  return normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
}

function classifyChangeKind(text: string): ChangeRecord["kind"] {
  const normalized = stripLeadingCommitHash(cleanMarkdownText(text))
    .toLowerCase()
    .trim();

  if (normalized.includes("deprecated")) {
    return "deprecated";
  }
  if (/^removed\b/.test(normalized)) {
    return "removed";
  }
  if (/^(fix|fixed)\b/.test(normalized)) {
    return "fixed";
  }
  if (
    /^(add|added|introduce|introduced|create|created)\b/.test(normalized)
  ) {
    return "added";
  }
  return "changed";
}

function buildComponentMentionPatterns(
  components: ComponentRecord[],
): ComponentMentionPattern[] {
  const seen = new Set<string>();
  const patterns: ComponentMentionPattern[] = [];

  for (const component of components) {
    const phrases = uniqueStrings(
      [
        component.name,
        component.source.export_name
          ? pascalToLabel(component.source.export_name)
          : null,
      ].filter((value): value is string => Boolean(value)),
    );

    for (const phrase of phrases) {
      const normalizedPhrase = cleanMarkdownText(phrase).toLowerCase();
      if (!normalizedPhrase) {
        continue;
      }

      const words = normalizedPhrase.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        continue;
      }

      const lastWord = words[words.length - 1];
      const leadingWords = words.slice(0, -1).map(escapeRegExp);
      const patternSource = leadingWords.length > 0
        ? `\\b${leadingWords.join("[-\\\\s]+")}[-\\\\s]+${escapeRegExp(lastWord)}(?:'s|s)?\\b`
        : `\\b${escapeRegExp(lastWord)}(?:'s|s)?\\b`;
      const dedupeKey = `${component.id}:${patternSource}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      patterns.push({
        component,
        regex: new RegExp(patternSource, "gi"),
        phrase_length: normalizedPhrase.length,
      });
    }
  }

  return patterns.sort(
    (left, right) => right.phrase_length - left.phrase_length,
  );
}

function findMatchedComponentsForChange(
  text: string,
  components: ComponentRecord[],
): Array<{
  component: ComponentRecord;
  inference: NonNullable<ChangeRecord["inference"]>;
}> {
  const occupiedRanges: Array<{ start: number; end: number }> = [];
  const matchedComponents = new Map<
    string,
    {
      component: ComponentRecord;
      inference: NonNullable<ChangeRecord["inference"]>;
    }
  >();
  const normalizedText = stripLeadingCommitHash(cleanMarkdownText(text));
  const patterns = buildComponentMentionPatterns(components);

  for (const candidate of patterns) {
    candidate.regex.lastIndex = 0;
    let match: RegExpExecArray | null = candidate.regex.exec(normalizedText);
    while (match) {
      const start = match.index;
      const end = start + match[0].length;
      const overlapsExisting = occupiedRanges.some(
        (range) => start < range.end && end > range.start,
      );
      if (!overlapsExisting) {
        occupiedRanges.push({ start, end });
        matchedComponents.set(candidate.component.id, {
          component: candidate.component,
          inference: {
            matched_by: "component_name",
            confidence: candidate.phrase_length >= 10 ? "high" : "medium",
          },
        });
      }

      match = candidate.regex.exec(normalizedText);
    }
  }

  return [...matchedComponents.values()];
}

function buildChangeId(
  packageName: string,
  version: string,
  targetType: ChangeRecord["target_type"],
  targetName: string,
  ordinal: number,
): string {
  return `chg.${toKebabCase(packageName)}.${toKebabCase(version)}.${targetType}.${toKebabCase(targetName)}.${ordinal}`;
}

function parseDocgenDefaultValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "value" in (value as Record<string, unknown>)
  ) {
    const inner = (value as Record<string, unknown>).value;
    return typeof inner === "string" ? inner.trim() : null;
  }
  return null;
}

function parsePrimitiveValue(raw: string): string | number | boolean | null {
  const value = raw.trim();
  if (value === "null") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function parseAllowedValuesFromType(
  typeShape: DocgenTypeShape | undefined,
): Array<string | number | boolean> {
  if (!typeShape) {
    return [];
  }

  const typeName = asString(typeShape.name);
  const typeValue = typeShape.value as DocgenTypeValue[] | string | undefined;
  const allowedValues: Array<string | number | boolean> = [];

  if (Array.isArray(typeValue)) {
    for (const candidate of typeValue) {
      if (typeof candidate === "string") {
        const cleaned = candidate.trim().replace(/^['"`]|['"`]$/g, "");
        if (cleaned.length > 0) {
          allowedValues.push(
            parsePrimitiveValue(cleaned) as string | number | boolean,
          );
        }
        continue;
      }

      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "value" in candidate
      ) {
        const raw = (candidate as { value?: unknown }).value;
        if (typeof raw === "string") {
          const cleaned = raw.trim().replace(/^['"`]|['"`]$/g, "");
          if (cleaned.length > 0) {
            const parsed = parsePrimitiveValue(cleaned);
            if (parsed !== null) {
              allowedValues.push(parsed as string | number | boolean);
            }
          }
        }
      }
    }
  }

  if (allowedValues.length > 0) {
    return uniqueStrings(allowedValues.map((value) => String(value))).map(
      (value) => parsePrimitiveValue(value) as string | number | boolean,
    );
  }

  if (!typeName || !typeName.includes("|")) {
    return [];
  }

  const unionParts = typeName.split("|").map((part) => part.trim());
  for (const part of unionParts) {
    const quoteMatch = part.match(/^['"`](.*)['"`]$/);
    if (quoteMatch) {
      allowedValues.push(quoteMatch[1]);
      continue;
    }
    if (part === "true" || part === "false") {
      allowedValues.push(part === "true");
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(part)) {
      allowedValues.push(Number(part));
    }
  }

  return allowedValues;
}

function parseDocgenType(typeShape: DocgenTypeShape | undefined): string {
  const typeName = asString(typeShape?.name);
  if (!typeName) {
    return "unknown";
  }
  return normalizeWhitespace(typeName);
}

function parseDeprecationNote(description: string): string | null {
  const markerIndex = description.toLowerCase().indexOf("@deprecated");
  if (markerIndex === -1) {
    return null;
  }

  const trailing = description.slice(markerIndex + "@deprecated".length).trim();
  if (!trailing) {
    return "Deprecated.";
  }

  return cleanMarkdownText(trailing.split(/\r?\n/)[0] ?? trailing);
}

function toComponentProps(docgenProps: unknown): ComponentProp[] {
  if (!docgenProps || typeof docgenProps !== "object") {
    return [];
  }

  const entries = Object.entries(
    docgenProps as Record<string, DocgenPropShape>,
  );
  const props = entries
    .map(([propName, propValue]) => {
      const description = cleanMarkdownText(
        asString(propValue.description) ?? "",
      );
      const deprecationNote = parseDeprecationNote(description);
      const sanitizedDescription =
        deprecationNote == null
          ? description
          : cleanMarkdownText(
              description.replace(/@deprecated[\s\S]*$/i, "").trim(),
            ) || "Deprecated.";
      const allowedValues = parseAllowedValuesFromType(propValue.type);

      const parsedProp: ComponentProp = {
        name: propName,
        type: parseDocgenType(propValue.type),
        required: Boolean(propValue.required),
        description: sanitizedDescription || "No description provided.",
        deprecated: deprecationNote != null,
      };

      const defaultValue = parseDocgenDefaultValue(propValue.defaultValue);
      if (defaultValue !== null) {
        parsedProp.default = defaultValue;
      }
      if (allowedValues.length > 0) {
        parsedProp.allowed_values = allowedValues;
      }
      if (deprecationNote) {
        parsedProp.deprecation_note = deprecationNote;
      }

      return parsedProp;
    })
    .filter((prop) => prop.name.trim().length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));

  return props;
}

function extractFirstParagraph(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("<"));

  const paragraphLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#")) {
      if (paragraphLines.length > 0) {
        break;
      }
      continue;
    }

    if (line.startsWith("```")) {
      break;
    }

    paragraphLines.push(line);
    if (line.endsWith(".")) {
      break;
    }
  }

  return cleanMarkdownText(paragraphLines.join(" "));
}

function parseSection(content: string | null, heading: string): string {
  if (!content) {
    return "";
  }

  const lines = content.split(/\r?\n/);
  const headingMatcher = new RegExp(
    `^#{2,4}\\s+${escapeRegExp(heading)}\\s*$`,
    "i",
  );
  let startIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (headingMatcher.test(lines[index].trim())) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  const sectionLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmedLine = lines[index].trim();
    if (/^#{2,4}\s+/.test(trimmedLine)) {
      break;
    }
    sectionLines.push(lines[index]);
  }

  return sectionLines.join("\n");
}

function extractStatementsFromSection(content: string): string[] {
  const statements: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      line.length === 0 ||
      line.startsWith("<") ||
      line.startsWith("{/*") ||
      line.startsWith("```")
    ) {
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      statements.push(cleanMarkdownText(line));
      continue;
    }

    if (line.endsWith(".")) {
      statements.push(cleanMarkdownText(line));
    }
  }

  return uniqueStrings(
    statements
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
  );
}

function parseSectionStatements(
  content: string | null,
  heading: string,
): string[] {
  const section = parseSection(content, heading);
  if (!section) {
    return [];
  }

  return extractStatementsFromSection(section);
}

function parseMarkdownSections(
  content: string,
  headingLevel: number,
): Array<{ title: string; content: string }> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ title: string; content: string }> = [];
  let activeSection: { title: string; lines: string[] } | null = null;

  const flushSection = () => {
    if (!activeSection) {
      return;
    }

    sections.push({
      title: cleanMarkdownText(activeSection.title),
      content: activeSection.lines.join("\n").trim(),
    });
    activeSection = null;
  };

  for (const line of lines) {
    const headingMatch = line.trim().match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level === headingLevel) {
        flushSection();
        activeSection = {
          title: headingMatch[2],
          lines: [],
        };
        continue;
      }

      if (activeSection && level <= headingLevel) {
        flushSection();
      }
    }

    if (activeSection) {
      activeSection.lines.push(line);
    }
  }

  flushSection();
  return sections;
}

function normalizeGuideSnippetLanguage(
  value: string | null | undefined,
): GuideSnippet["language"] {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (normalized === "html") {
    return "html";
  }
  if (normalized === "css") {
    return "css";
  }
  if (
    normalized === "sh" ||
    normalized === "shell" ||
    normalized === "bash" ||
    normalized === "zsh"
  ) {
    return "shell";
  }

  return "tsx";
}

function extractFencedCodeBlocks(
  content: string,
): Array<{ language: GuideSnippet["language"]; code: string }> {
  const blocks: Array<{ language: GuideSnippet["language"]; code: string }> =
    [];
  const regex = /```([\w-]+)?\r?\n([\s\S]*?)```/g;
  let match = regex.exec(content);

  while (match) {
    const code = match[2]?.trim();
    if (code) {
      blocks.push({
        language: normalizeGuideSnippetLanguage(match[1]),
        code,
      });
    }

    match = regex.exec(content);
  }

  return blocks;
}

function inferStatusFromPackage(name: string, version: string): SaltStatus {
  if (name === "@salt-ds/lab") {
    return "lab";
  }

  if (/deprecated/i.test(version)) {
    return "deprecated";
  }

  if (/(alpha|beta|rc)/i.test(version)) {
    return "beta";
  }

  return "stable";
}

function inferDocsRoot(packageName: string): string | null {
  if (packageName === "@salt-ds/theme") {
    return "/salt/themes";
  }

  if (
    packageName === "@salt-ds/core" ||
    packageName === "@salt-ds/lab" ||
    packageName === "@salt-ds/countries" ||
    packageName === "@salt-ds/data-grid" ||
    packageName === "@salt-ds/icons" ||
    packageName === "@salt-ds/ag-grid-theme" ||
    packageName === "@salt-ds/highcharts-theme" ||
    packageName === "@salt-ds/embla-carousel" ||
    packageName === "@salt-ds/react-resizable-panels-theme"
  ) {
    return "/salt/components";
  }

  return null;
}

function inferTokenType(tokenValue: string): string {
  if (/^#[a-f0-9]{3,8}$/i.test(tokenValue) || /^rgb/i.test(tokenValue)) {
    return "color";
  }
  if (/^-?\d+(\.\d+)?(px|rem|em|%)$/i.test(tokenValue)) {
    return "dimension";
  }
  if (/^(true|false)$/i.test(tokenValue)) {
    return "boolean";
  }
  if (/^-?\d+(\.\d+)?$/.test(tokenValue)) {
    return "number";
  }
  return "string";
}

function inferThemeFromTokenPath(cssPath: string): string[] {
  const normalized = toPosixPath(cssPath);
  const isNext = normalized.includes("/next/");
  const isLegacy = normalized.includes("/legacy/");

  if (isNext) {
    return ["next"];
  }
  if (isLegacy) {
    return ["salt"];
  }
  return ["salt", "next"];
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

function parseLivePreviewTags(
  mdx: string,
): Array<{ componentName: string; exampleName: string; title: string }> {
  const lines = mdx.split(/\r?\n/);
  const examples: Array<{
    componentName: string;
    exampleName: string;
    title: string;
  }> = [];
  let currentHeading = "";
  let livePreviewBuffer: string[] | null = null;

  const flushLivePreviewBuffer = (): void => {
    if (!livePreviewBuffer) {
      return;
    }

    const livePreviewTag = livePreviewBuffer.join(" ");
    livePreviewBuffer = null;

    const componentNameMatch = livePreviewTag.match(/componentName="([^"]+)"/);
    const exampleNameMatch = livePreviewTag.match(/exampleName="([^"]+)"/);
    if (!componentNameMatch || !exampleNameMatch) {
      return;
    }

    const displayNameMatch = livePreviewTag.match(/displayName="([^"]+)"/);
    examples.push({
      componentName: componentNameMatch[1],
      exampleName: exampleNameMatch[1],
      title: displayNameMatch?.[1] ?? (currentHeading || exampleNameMatch[1]),
    });
  };

  for (const line of lines) {
    const headingMatch = line.trim().match(/^#{2,4}\s+(.+)$/);
    if (headingMatch) {
      flushLivePreviewBuffer();
      currentHeading = cleanMarkdownText(headingMatch[1]);
      continue;
    }

    if (livePreviewBuffer) {
      livePreviewBuffer.push(line.trim());
      if (line.includes("/>")) {
        flushLivePreviewBuffer();
      }
      continue;
    }

    if (!line.includes("<LivePreview")) {
      continue;
    }

    livePreviewBuffer = [line.trim()];
    if (line.includes("/>")) {
      flushLivePreviewBuffer();
    }
  }

  flushLivePreviewBuffer();
  return examples;
}

async function readFileOrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

async function loadPropMetadata(repoRoot: string): Promise<PropMetadata> {
  const byPackage = new Map<string, Map<string, DocgenComponentShape[]>>();
  const propsDir = path.join(repoRoot, "site/src/props");

  for (const [fileName, packageName] of Object.entries(
    DOCGEN_PACKAGE_FILE_MAP,
  )) {
    const filePath = path.join(propsDir, fileName);
    const raw = await readFileOrNull(filePath);
    if (!raw) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    const packageEntries = byPackage.get(packageName) ?? new Map();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const docgen = entry as DocgenComponentShape;
      const displayName = asString(docgen.displayName);
      if (!displayName || displayName.startsWith("use")) {
        continue;
      }

      const key = toMatchKey(displayName);
      const current = packageEntries.get(key) ?? [];
      current.push(docgen);
      packageEntries.set(key, current);
    }

    byPackage.set(packageName, packageEntries);
  }

  return { byPackage };
}

function selectDocgenComponent(
  propMetadata: PropMetadata,
  packageName: string,
  componentName: string,
  aliases: string[],
  routeSuffix: string,
): DocgenSelection {
  const packageEntries = propMetadata.byPackage.get(packageName);
  if (!packageEntries) {
    return {
      candidate: null,
      inference: {
        candidate_count: 0,
        candidate_display_names: [],
        selected_display_name: null,
        selected_score: null,
      },
    };
  }

  const routeLeaf = routeSuffix.split("/").at(-1) ?? routeSuffix;
  const candidateNames = uniqueStrings([
    componentName,
    ...aliases,
    toPascalCase(componentName),
    toPascalCase(routeLeaf),
    componentName.replace(/\s+/g, ""),
  ]).map((name) => toMatchKey(name));

  const candidateSet = new Set<DocgenComponentShape>();
  for (const key of candidateNames) {
    const matches = packageEntries.get(key);
    if (matches) {
      for (const match of matches) {
        candidateSet.add(match);
      }
    }
  }

  const candidates = [...candidateSet];
  if (candidates.length === 0) {
    return {
      candidate: null,
      inference: {
        candidate_count: 0,
        candidate_display_names: [],
        selected_display_name: null,
        selected_score: null,
      },
    };
  }

  const scored = candidates
    .map((candidate) => {
      const displayName = asString(candidate.displayName) ?? "";
      const normalizedDisplayName = toMatchKey(displayName);
      const exactMatch = candidateNames.includes(normalizedDisplayName) ? 2 : 0;
      const propCount =
        candidate.props && typeof candidate.props === "object"
          ? Object.keys(candidate.props as Record<string, unknown>).length
          : 0;

      return {
        candidate,
        score: exactMatch + Math.min(propCount, 30) / 100,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected = scored[0];

  return {
    candidate: selected?.candidate ?? null,
    inference: {
      candidate_count: candidates.length,
      candidate_display_names: uniqueStrings(
        candidates
          .map((candidate) => asString(candidate.displayName))
          .filter((value): value is string => Boolean(value)),
      ).sort((left, right) => left.localeCompare(right)),
      selected_display_name: asString(selected?.candidate.displayName) ?? null,
      selected_score: selected?.score ?? null,
    },
  };
}

async function extractPackages(repoRoot: string): Promise<PackageRecord[]> {
  const packageManifestPaths = (
    await fg("packages/*/package.json", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));

  const packages: PackageRecord[] = [];

  for (const manifestPath of packageManifestPaths) {
    const manifestRaw = await readFileOrNull(manifestPath);
    if (!manifestRaw) {
      continue;
    }

    const manifest = JSON.parse(manifestRaw) as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
    };

    const packageName = asString(manifest.name);
    if (!packageName || !packageName.startsWith("@salt-ds/")) {
      continue;
    }
    if (EXCLUDED_REGISTRY_PACKAGES.has(packageName)) {
      continue;
    }

    const packageVersion = asString(manifest.version) ?? "0.0.0";
    const packageDir = path.dirname(manifestPath);
    const changelogPath = path.join(packageDir, "CHANGELOG.md");
    const hasChangelog = await readFileOrNull(changelogPath);

    packages.push({
      id: `package.${toKebabCase(packageName)}`,
      name: packageName,
      status: inferStatusFromPackage(packageName, packageVersion),
      version: packageVersion,
      summary:
        asString(manifest.description) ??
        `${packageName} package in Salt Design System.`,
      source_root: toPosixPath(path.relative(repoRoot, packageDir)),
      changelog_path: hasChangelog
        ? toPosixPath(path.relative(repoRoot, changelogPath))
        : null,
      docs_root: inferDocsRoot(packageName),
    });
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function isIconBaseNameMatch(baseName: string, figmaIconName: string): boolean {
  const normalizedFigmaName = figmaIconName.replace(/-/g, "");
  const matcher = new RegExp(`^${normalizedFigmaName}(Solid)?$`, "i");
  return matcher.test(baseName);
}

async function loadIconSynonymMetadata(
  repoRoot: string,
): Promise<IconSynonymMetadata[]> {
  const synonymPath = path.join(
    repoRoot,
    "site/src/components/icon-preview/salt-icon-synonym.json",
  );
  const raw = await readFileOrNull(synonymPath);
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((entry): entry is IconSynonymMetadata => {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.iconName === "string" &&
        Array.isArray(candidate.synonym) &&
        typeof candidate.category === "string"
      );
    })
    .map((entry) => ({
      iconName: entry.iconName,
      synonym: asStringArray(entry.synonym).map(cleanMarkdownText),
      category: cleanMarkdownText(entry.category),
    }));
}

function buildIconAliases(
  exportName: string,
  baseName: string,
  figmaName: string,
  label: string,
  synonyms: string[],
  variant: IconRecord["variant"],
): string[] {
  const sharedAliases = [exportName, baseName, figmaName, label, ...synonyms];
  const variantAliases =
    variant === "solid"
      ? [
          `${figmaName} solid`,
          `${figmaName}-solid`,
          `${label} solid`,
          `${label} solid icon`,
          ...synonyms.flatMap((synonym) => [`solid ${synonym}`]),
        ]
      : [`${figmaName} icon`, `${label} icon`];

  return uniqueStrings(
    [...sharedAliases, ...variantAliases]
      .map((value) => normalizeWhitespace(value))
      .filter((value) => value.length > 0),
  );
}

function buildIconSummary(
  label: string,
  variant: IconRecord["variant"],
  category: string,
  synonyms: string[],
  status: SaltStatus,
): string {
  const variantText = variant === "solid" ? "solid " : "";
  const synonymPreview = synonyms.slice(0, 3).join(", ");
  const deprecatedText =
    status === "deprecated"
      ? " Deprecated; use the linked replacement guidance."
      : "";

  if (synonymPreview.length > 0) {
    return `${label} ${variantText}icon for ${category} concepts such as ${synonymPreview}.${deprecatedText}`.trim();
  }

  return `${label} ${variantText}icon in Salt Design System.${deprecatedText}`.trim();
}

async function loadCountrySymbolMetadata(
  repoRoot: string,
): Promise<CountrySymbolMetadata[]> {
  const metadataPath = path.join(
    repoRoot,
    "packages/countries/src/countryMetaMap.ts",
  );
  const raw = await readFileOrNull(metadataPath);
  if (!raw) {
    return [];
  }

  const entries = [...raw.matchAll(
    /(?:"([^"]+)"|([A-Z]{2}(?:-[A-Z]{3})?))\s*:\s*\{\s*countryCode:\s*"([^"]+)"\s*,\s*countryName:\s*"([^"]+)"\s*,?\s*\}/gms,
  )].map((match) => ({
    countryCode: match[3] ?? match[1] ?? match[2] ?? "",
    countryName: match[4] ?? "",
  }));

  return entries
    .filter(
      (entry) =>
        entry.countryCode.trim().length > 0 &&
        entry.countryName.trim().length > 0,
    )
    .sort((left, right) =>
      left.countryCode.localeCompare(right.countryCode),
    );
}

function countryCodeToExportBase(countryCode: string): string {
  return countryCode.replace(/-/g, "_");
}

function buildCountrySymbolNameAliases(countryName: string): string[] {
  const aliases = [normalizeWhitespace(countryName)];
  const withoutBrackets = normalizeWhitespace(
    countryName.replace(/\s*\[[^\]]+\]/g, " "),
  );

  if (withoutBrackets) {
    aliases.push(withoutBrackets);
  }

  const parentheticalMatch = withoutBrackets.match(/^(.*?)\s+\(([^)]+)\)$/);
  if (parentheticalMatch) {
    const baseName = normalizeWhitespace(parentheticalMatch[1] ?? "");
    const qualifier = normalizeWhitespace(parentheticalMatch[2] ?? "");

    if (baseName) {
      aliases.push(baseName);
    }

    if (baseName && qualifier.toLowerCase() === "the") {
      aliases.push(`The ${baseName}`);
    } else if (baseName && qualifier) {
      aliases.push(`${qualifier.replace(/^the\s+/i, "")} ${baseName}`);
    }
  }

  const plainName = normalizeWhitespace(
    withoutBrackets.replace(/\s*\([^)]*\)/g, " "),
  );
  if (plainName) {
    aliases.push(plainName);
  }

  const prefixMatch = plainName.match(/^(.+?) of .+$/i);
  if (prefixMatch) {
    const prefix = normalizeWhitespace(prefixMatch[1] ?? "");
    if (prefix.split(/\s+/).length >= 2) {
      aliases.push(prefix);
    }
  }

  return uniqueStrings(
    aliases
      .map((value) => normalizeWhitespace(value))
      .filter((value) => value.length > 0),
  );
}

function buildCountrySymbolAliases(
  countryCode: string,
  countryName: string,
): string[] {
  const exportBase = countryCodeToExportBase(countryCode);
  return uniqueStrings(
    [
      countryCode,
      countryCode.replace(/-/g, "_"),
      countryCode.replace(/-/g, " "),
      exportBase,
      `${exportBase}_Sharp`,
      ...buildCountrySymbolNameAliases(countryName),
    ]
      .map((value) => normalizeWhitespace(value))
      .filter((value) => value.length > 0),
  );
}

function buildCountrySymbolSummary(
  countryName: string,
  status: SaltStatus,
): string {
  const deprecatedText =
    status === "deprecated"
      ? " Deprecated; use the linked replacement guidance."
      : "";

  return `Asset for ${countryName}; available in circle and sharp variants.${deprecatedText}`.trim();
}

function countrySymbolDeprecationMatches(
  countryCode: string,
  countryName: string,
  deprecation: DeprecationRecord,
): boolean {
  if (deprecation.package !== "@salt-ds/countries") {
    return false;
  }

  const exportBase = countryCodeToExportBase(countryCode);
  const countryKeys = new Set(
    buildCountrySymbolAliases(countryCode, countryName).map((value) =>
      toMatchKey(value),
    ),
  );
  countryKeys.add(toMatchKey(countryCode));
  countryKeys.add(toMatchKey(exportBase));
  countryKeys.add(toMatchKey(`${exportBase}_Sharp`));

  const deprecationKeys = [deprecation.name, deprecation.component]
    .filter((value): value is string => Boolean(value))
    .map((value) => toMatchKey(value));

  return deprecationKeys.some((key) => countryKeys.has(key));
}

function iconDeprecationMatches(
  exportName: string,
  baseName: string,
  figmaName: string,
  deprecation: DeprecationRecord,
): boolean {
  if (deprecation.package !== "@salt-ds/icons") {
    return false;
  }

  const iconKeys = new Set([
    toMatchKey(exportName),
    toMatchKey(baseName),
    toMatchKey(figmaName),
  ]);

  const deprecationKeys = [deprecation.name, deprecation.component]
    .filter((value): value is string => Boolean(value))
    .map((value) => toMatchKey(value));

  return deprecationKeys.some((key) => iconKeys.has(key));
}

async function extractIcons(
  repoRoot: string,
  packageByName: Map<string, PackageRecord>,
  deprecations: DeprecationRecord[],
  generatedAt: string,
): Promise<IconRecord[]> {
  const iconsPackage = packageByName.get("@salt-ds/icons");
  if (!iconsPackage) {
    return [];
  }

  const synonymMetadata = await loadIconSynonymMetadata(repoRoot);
  const iconPaths = (
    await fg("packages/icons/src/components/*.tsx", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  )
    .filter((filePath) => path.parse(filePath).name !== "index")
    .sort((left, right) => left.localeCompare(right));

  return iconPaths.map((iconPath) => {
    const sourcePath = toPosixPath(path.relative(repoRoot, iconPath));
    const baseName = path.parse(iconPath).name;
    const variant = baseName.endsWith("Solid") ? "solid" : "outline";
    const unqualifiedBaseName =
      variant === "solid" ? baseName.replace(/Solid$/, "") : baseName;
    const exportName = `${baseName}Icon`;
    const figmaName =
      synonymMetadata.find((entry) =>
        isIconBaseNameMatch(baseName, entry.iconName),
      )?.iconName ?? pascalToKebabCase(unqualifiedBaseName);
    const matchedMetadata =
      synonymMetadata.find((entry) => entry.iconName === figmaName) ?? null;
    const synonyms = uniqueStrings(
      (matchedMetadata?.synonym ?? []).map((synonym) =>
        cleanMarkdownText(synonym),
      ),
    );
    const matchedDeprecations = deprecations
      .filter((deprecation) =>
        iconDeprecationMatches(exportName, baseName, figmaName, deprecation),
      )
      .map((deprecation) => deprecation.id)
      .sort((left, right) => left.localeCompare(right));
    const status: SaltStatus =
      matchedDeprecations.length > 0 ? "deprecated" : iconsPackage.status;

    return {
      id: `icon.${pascalToKebabCase(exportName)}`,
      name: exportName,
      base_name: baseName,
      figma_name: figmaName,
      package: {
        name: iconsPackage.name,
        status: iconsPackage.status,
        since: null,
      },
      summary: buildIconSummary(
        pascalToLabel(unqualifiedBaseName),
        variant,
        matchedMetadata?.category ?? "uncategorized",
        synonyms,
        status,
      ),
      status,
      category: matchedMetadata?.category ?? "uncategorized",
      synonyms,
      aliases: buildIconAliases(
        exportName,
        baseName,
        figmaName,
        pascalToLabel(unqualifiedBaseName),
        synonyms,
        variant,
      ),
      variant,
      related_docs: {
        overview: "/salt/components/icon",
        examples: "/salt/components/icon/examples",
        foundation: "/salt/foundations/assets/index",
      },
      source: {
        repo_path: sourcePath,
        export_name: exportName,
      },
      deprecations: matchedDeprecations,
      last_verified_at: generatedAt,
    } satisfies IconRecord;
  });
}

async function extractCountrySymbols(
  repoRoot: string,
  packageByName: Map<string, PackageRecord>,
  deprecations: DeprecationRecord[],
  generatedAt: string,
): Promise<CountrySymbolRecord[]> {
  const countriesPackage = packageByName.get("@salt-ds/countries");
  if (!countriesPackage) {
    return [];
  }

  const countryMetadata = await loadCountrySymbolMetadata(repoRoot);

  return countryMetadata.map(({ countryCode, countryName }) => {
    const exportBase = countryCodeToExportBase(countryCode);
    const circleRepoPath = `packages/countries/src/components/${exportBase}.tsx`;
    const sharpRepoPath = `packages/countries/src/components/${exportBase}_Sharp.tsx`;
    const matchedDeprecations = deprecations
      .filter((deprecation) =>
        countrySymbolDeprecationMatches(countryCode, countryName, deprecation),
      )
      .map((deprecation) => deprecation.id)
      .sort((left, right) => left.localeCompare(right));
    const status: SaltStatus =
      matchedDeprecations.length > 0 ? "deprecated" : countriesPackage.status;

    return {
      id: `country_symbol.${toKebabCase(countryCode)}`,
      code: countryCode,
      name: countryName,
      package: {
        name: countriesPackage.name,
        status: countriesPackage.status,
        since: null,
      },
      summary: buildCountrySymbolSummary(countryName, status),
      status,
      aliases: buildCountrySymbolAliases(countryCode, countryName),
      variants: {
        circle: {
          export_name: exportBase,
          repo_path: circleRepoPath,
        },
        sharp: {
          export_name: `${exportBase}_Sharp`,
          repo_path: sharpRepoPath,
        },
      },
      related_docs: {
        overview: "/salt/components/country-symbol",
        usage: "/salt/components/country-symbol/usage",
        accessibility: "/salt/components/country-symbol/accessibility",
        examples: "/salt/components/country-symbol/examples",
        foundation: "/salt/foundations/assets/country-symbols",
      },
      deprecations: matchedDeprecations,
      last_verified_at: generatedAt,
    } satisfies CountrySymbolRecord;
  });
}

async function extractComponentExamples(
  repoRoot: string,
  componentRoute: string,
  examplesMdx: string | null,
  packageName: string,
  componentName: string,
): Promise<ExampleRecord[]> {
  if (!examplesMdx) {
    return [];
  }

  const previews = parseLivePreviewTags(examplesMdx);
  const examples: ExampleRecord[] = [];

  for (const preview of previews) {
    const examplePath = path.join(
      repoRoot,
      "site/src/examples",
      preview.componentName,
      `${preview.exampleName}.tsx`,
    );

    const sourceCode = await readFileOrNull(examplePath);
    examples.push({
      id: `${preview.componentName}.${toKebabCase(preview.exampleName)}`,
      title: preview.title,
      intent: [preview.title.toLowerCase()],
      complexity: "basic",
      code: sourceCode ?? "",
      source_url: `${componentRoute}/examples`,
      package: packageName,
      target_type: "component",
      target_name: componentName,
    });
  }

  return examples;
}

async function extractComponents(
  repoRoot: string,
  packageByName: Map<string, PackageRecord>,
  propMetadata: PropMetadata,
  verifiedAt: string,
): Promise<ComponentRecord[]> {
  const componentIndexPaths = (
    await fg("site/docs/components/**/index.mdx", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));

  const components: ComponentRecord[] = [];

  for (const componentIndexPath of componentIndexPaths) {
    const indexContent = await readFileOrNull(componentIndexPath);
    if (!indexContent) {
      continue;
    }

    const parsed = matter(indexContent);
    if (asString(parsed.data.layout) !== "DetailComponent") {
      continue;
    }

    const title = asString(parsed.data.title);
    if (!title) {
      continue;
    }

    const componentDir = path.dirname(componentIndexPath);
    const routeSuffix = toPosixPath(
      path.relative(path.join(repoRoot, "site/docs/components"), componentDir),
    );
    if (routeSuffix === "." || routeSuffix === "") {
      continue;
    }

    const data = parsed.data.data as Record<string, unknown> | undefined;
    const packageData = data?.package as Record<string, unknown> | undefined;
    const sourceCodeUrl = asString(data?.sourceCodeUrl);
    const sourceRepoPath = parseSourceRepoPath(sourceCodeUrl);
    const packageNameFromDocs = asString(packageData?.name);
    const packageNameFromSource = parsePackageNameFromRepoPath(sourceRepoPath);
    const packageName = packageNameFromDocs ?? packageNameFromSource;
    if (!packageName) {
      throw new Error(
        `Unable to determine package for component '${title}' at ${toPosixPath(path.relative(repoRoot, componentIndexPath))}. Add data.package.name or sourceCodeUrl.`,
      );
    }
    const packageRecord = packageByName.get(packageName);
    if (!packageRecord) {
      throw new Error(
        `Unknown package '${packageName}' for component '${title}'.`,
      );
    }
    const description =
      asString(data?.description) ?? extractFirstParagraph(parsed.content);

    const usageContent = await readFileOrNull(
      path.join(componentDir, "usage.mdx"),
    );
    const accessibilityContent = await readFileOrNull(
      path.join(componentDir, "accessibility.mdx"),
    );
    const examplesMdx = await readFileOrNull(
      path.join(componentDir, "examples.mdx"),
    );

    const componentRoute = `/salt/components/${routeSuffix}`;
    const aliases = asStringArray(data?.alsoKnownAs);

    const docgenSelection = selectDocgenComponent(
      propMetadata,
      packageName,
      title,
      aliases,
      routeSuffix,
    );
    const props = toComponentProps(docgenSelection.candidate?.props);

    const exampleRecords = await extractComponentExamples(
      repoRoot,
      componentRoute,
      examplesMdx,
      packageName,
      title,
    );

    const relatedPatterns = asStringArray(data?.relatedPatterns);
    const relatedComponents = Array.isArray(data?.relatedComponents)
      ? (data?.relatedComponents as Array<Record<string, unknown>>)
      : [];

    const alternatives = relatedComponents
      .map((component) => {
        const name = asString(component.name);
        const relationship = asString(component.relationship) ?? "related";
        if (!name) {
          return null;
        }
        return {
          use: name,
          reason: `Related component (${relationship}).`,
        };
      })
      .filter((item): item is { use: string; reason: string } => item !== null);

    const accessibilityRules: AccessibilityRule[] = parseSectionStatements(
      accessibilityContent,
      "Best practices",
    ).map((ruleText, index) => ({
      id: `${toKebabCase(title)}-a11y-${index + 1}`,
      severity: "warning",
      rule: ruleText,
    }));

    components.push({
      id: `component.${toKebabCase(title)}`,
      name: title,
      aliases,
      package: {
        name: packageName,
        status:
          packageRecord?.status ?? inferStatusFromPackage(packageName, "0.0.0"),
        since: packageRecord?.version ?? null,
      },
      summary: cleanMarkdownText(description),
      status:
        packageRecord?.status ?? inferStatusFromPackage(packageName, "0.0.0"),
      category: routeSuffix.includes("layouts") ? ["layout"] : ["component"],
      tags: uniqueStrings([
        ...aliases.map((alias) => alias.toLowerCase()),
        ...relatedPatterns.map((pattern) => pattern.toLowerCase()),
      ]),
      when_to_use: parseSectionStatements(usageContent, "When to use"),
      when_not_to_use: parseSectionStatements(usageContent, "When not to use"),
      alternatives,
      props,
      accessibility: {
        summary: parseSectionStatements(accessibilityContent, "Best practices"),
        rules: accessibilityRules,
      },
      tokens: [],
      patterns: relatedPatterns,
      examples: exampleRecords,
      related_docs: {
        overview: componentRoute,
        usage: usageContent ? `${componentRoute}/usage` : null,
        accessibility: accessibilityContent
          ? `${componentRoute}/accessibility`
          : null,
        examples: examplesMdx ? `${componentRoute}/examples` : null,
      },
      source: {
        repo_path: sourceRepoPath,
        export_name: title,
      },
      inference: {
        docgen: docgenSelection.inference,
      },
      deprecations: [],
      last_verified_at: verifiedAt,
    });
  }

  return components.sort((left, right) => left.name.localeCompare(right.name));
}

async function extractPatternExamplesFromStories(
  repoRoot: string,
  patternNameBySlug: Map<string, string>,
): Promise<ExampleRecord[]> {
  const storyPaths = (
    await fg("packages/*/stories/patterns/**/*.stories.tsx", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));

  const examples: ExampleRecord[] = [];
  for (const storyPath of storyPaths) {
    const source = await readFileOrNull(storyPath);
    if (!source) {
      continue;
    }

    const relativePath = toPosixPath(path.relative(repoRoot, storyPath));
    const packageSlug = relativePath.split("/")[1] ?? "";
    const packageName =
      packageSlug.length > 0 ? `@salt-ds/${packageSlug}` : null;
    const patternSlug = path.basename(path.dirname(storyPath));
    const patternName = patternNameBySlug.get(patternSlug) ?? patternSlug;
    const exportRegex = /export const (\w+)\s*=/g;
    let exportMatch = exportRegex.exec(source);
    while (exportMatch) {
      examples.push({
        id: `pattern-story.${toKebabCase(relativePath)}.${toKebabCase(exportMatch[1])}`,
        title: exportMatch[1],
        intent: ["pattern example"],
        complexity: "intermediate",
        code: `// See ${relativePath} (${exportMatch[1]})`,
        source_url: null,
        package: packageName,
        target_type: "pattern",
        target_name: patternName,
      });
      exportMatch = exportRegex.exec(source);
    }
  }

  return examples;
}

function getRouteSlug(route: string | null): string | null {
  if (!route) {
    return null;
  }

  const parts = route.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? null;
}

function createPatternNameBySlug(
  patterns: PatternRecord[],
): Map<string, string> {
  const patternNameBySlug = new Map<string, string>();

  for (const pattern of patterns) {
    patternNameBySlug.set(toKebabCase(pattern.name), pattern.name);

    const routeSlug = getRouteSlug(pattern.related_docs.overview);
    if (routeSlug) {
      patternNameBySlug.set(routeSlug, pattern.name);
    }
  }

  return patternNameBySlug;
}

async function extractPatterns(
  repoRoot: string,
  verifiedAt: string,
): Promise<PatternRecord[]> {
  const patternMdxPaths = (
    await fg("site/docs/patterns/**/*.mdx", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));

  const patterns: PatternRecord[] = [];
  for (const patternPath of patternMdxPaths) {
    const relativePatternPath = toPosixPath(
      path.relative(path.join(repoRoot, "site/docs/patterns"), patternPath),
    );

    if (
      relativePatternPath === "index.mdx" ||
      relativePatternPath.startsWith("fragments/")
    ) {
      continue;
    }

    const source = await readFileOrNull(patternPath);
    if (!source) {
      continue;
    }

    const parsed = matter(source);
    const title = asString(parsed.data.title);
    if (!title) {
      continue;
    }

    const data = parsed.data.data as Record<string, unknown> | undefined;
    const components = asStringArray(data?.components);
    const aliases = asStringArray(parsed.data.aliases);
    const relatedPatterns = asStringArray(data?.relatedPatterns);
    const resources = Array.isArray(data?.resources)
      ? (data?.resources as Array<Record<string, unknown>>)
      : [];

    const summary =
      asString(parsed.data.description) ??
      extractFirstParagraph(parsed.content);

    const route = `/salt/patterns/${relativePatternPath.replace(/\.mdx$/, "")}`;
    const examples: ExampleRecord[] = [];
    const resourceRecords: PatternRecord["resources"] = [];
    resources.forEach((resource, index) => {
      const href = asString(resource.href);
      const label = asString(resource.label) ?? `Resource ${index + 1}`;
      const internal = Boolean(resource.internal);
      if (!href) {
        return;
      }

      resourceRecords.push({
        label,
        href,
        internal,
      });
      examples.push({
        id: `pattern.${toKebabCase(title)}.resource.${index + 1}`,
        title: label,
        intent: ["pattern resource"],
        complexity: "basic",
        code: `// Linked resource: ${href}`,
        source_url: href,
        package: null,
        target_type: "pattern",
        target_name: title,
      });
    });

    patterns.push({
      id: `pattern.${toKebabCase(title)}`,
      name: title,
      aliases,
      summary: cleanMarkdownText(summary),
      status: "stable",
      when_to_use: parseSectionStatements(parsed.content, "When to use"),
      when_not_to_use: parseSectionStatements(
        parsed.content,
        "When not to use",
      ),
      composed_of: components.map((componentName) => ({
        component: componentName,
        role: null,
      })),
      related_patterns: relatedPatterns,
      how_to_build: parseSectionStatements(parsed.content, "How to build"),
      how_it_works: parseSectionStatements(parsed.content, "How it works"),
      accessibility: {
        summary: parseSectionStatements(parsed.content, "Accessibility"),
      },
      resources: resourceRecords,
      examples,
      related_docs: {
        overview: route,
      },
      last_verified_at: verifiedAt,
    });
  }

  return patterns.sort((left, right) => left.name.localeCompare(right.name));
}

function findMarkdownSection(
  sections: Array<{ title: string; content: string }>,
  matcher: (title: string) => boolean,
): string {
  return sections.find((section) => matcher(section.title))?.content ?? "";
}

function buildGuideStep(
  title: string,
  statements: string[],
  snippets: GuideSnippet[],
) {
  return {
    title,
    statements: uniqueStrings(
      statements
        .map((statement) => cleanMarkdownText(statement))
        .filter((statement) => statement.length > 0),
    ),
    snippets,
  };
}

function createGuideSnippet(
  title: string,
  language: GuideSnippet["language"],
  code: string | null | undefined,
): GuideSnippet | null {
  const normalizedCode = code?.trim();
  if (!normalizedCode) {
    return null;
  }

  return {
    title,
    language,
    code: normalizedCode,
  };
}

function normalizeSiteRoute(route: string): string {
  return route
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function createNormalizedSiteRouteKey(route: string): string {
  return normalizeSiteRoute(route).toLowerCase();
}

function createPageId(route: string): string {
  return `page.${normalizeSiteRoute(route)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase()}`;
}

function classifyPageKind(route: string): PageKind {
  const normalizedRoute = normalizeSiteRoute(route).toLowerCase();

  if (normalizedRoute === "salt/index" || normalizedRoute === "salt") {
    return "landing";
  }
  if (normalizedRoute.startsWith("salt/about/")) {
    return "about";
  }
  if (normalizedRoute.startsWith("salt/getting-started/")) {
    return "guide";
  }
  if (normalizedRoute.startsWith("salt/components/")) {
    return "component-doc";
  }
  if (normalizedRoute.startsWith("salt/patterns/")) {
    return "pattern-doc";
  }
  if (normalizedRoute.startsWith("salt/foundations/")) {
    return "foundation";
  }
  if (normalizedRoute.startsWith("salt/themes/")) {
    return "theme-doc";
  }
  if (normalizedRoute.startsWith("salt/support-and-contributions/")) {
    return "support";
  }
  if (normalizedRoute.startsWith("salt-github/")) {
    return "release-note";
  }

  return "other";
}

function mergePageContentBlocks(values: string[]): string[] {
  const cleanedValues = values
    .map((value) => cleanMarkdownText(value))
    .map((value) => normalizeWhitespace(value))
    .filter((value) => value.length > 1 && /[a-z0-9]/i.test(value));
  const blocks: string[] = [];
  let current = "";

  for (const value of cleanedValues) {
    current = current ? `${current} ${value}` : value;
    if (/[.!?]$/.test(value) || current.length >= 220) {
      blocks.push(current);
      current = "";
    }
  }

  if (current) {
    blocks.push(current);
  }

  return uniqueStrings(blocks);
}

function extractMarkdownPageMetadata(
  content: string,
  description: string | null,
): MarkdownPageMetadata {
  const summary = description ?? extractFirstParagraph(content);
  const section_headings = uniqueStrings(
    [2, 3, 4]
      .flatMap((level) =>
        parseMarkdownSections(content, level).map((section) =>
          cleanMarkdownText(section.title),
        ),
      )
      .filter((heading) => heading.length > 0),
  );

  return {
    summary,
    section_headings,
  };
}

function extractFallbackMarkdownLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) =>
      line.replace(/\{\s*[A-Za-z][^{}]*?\}\s*,?/g, " "),
    )
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("#"))
    .filter((line) => !line.startsWith("<"))
    .filter((line) => !line.startsWith("/>"))
    .filter((line) => !line.startsWith(":fragment"))
    .filter((line) => !/^[A-Za-z][\w-]*\s*=/.test(line))
    .filter((line) => !/^[A-Za-z][\w-]*:\s*["'{[]/.test(line))
    .filter((line) => !/^\|[\s:-]+\|?$/.test(line));
}

function extractRouteKeywords(route: string): string[] {
  const normalizedRoute = normalizeSiteRoute(route);
  return uniqueStrings([
    normalizedRoute,
    ...normalizedRoute
      .split("/")
      .filter((part) => part.length > 0)
      .flatMap((part) => [
        part,
        part.replace(/[-_.]+/g, " "),
        part.replace(/^@/, "").replace(/[-_.]+/g, " "),
      ])
      .map((part) => normalizeWhitespace(part))
      .filter((part) => part.length > 0),
  ]);
}

async function readPageSnapshotMetadata(
  repoRoot: string,
  route: string,
): Promise<{ summary: string | null; section_headings: string[] }> {
  const normalizedRoute = normalizeSiteRoute(route);
  if (!normalizedRoute.startsWith("salt/")) {
    return {
      summary: null,
      section_headings: [],
    };
  }

  const snapshotPath = path.join(
    repoRoot,
    "site",
    "snapshots",
    "latest",
    `${normalizedRoute}.mdx`,
  );
  const snapshotSource = await readFileOrNull(snapshotPath);
  if (!snapshotSource) {
    return {
      summary: null,
      section_headings: [],
    };
  }

  const parsed = matter(snapshotSource);
  return extractMarkdownPageMetadata(
    parsed.content,
    asString(parsed.data.description),
  );
}

async function buildSiteDocsRouteMap(
  repoRoot: string,
): Promise<Map<string, string>> {
  const docsRoot = path.join(repoRoot, "site", "docs");
  const docPaths = await fg("**/*.mdx", {
    absolute: true,
    cwd: docsRoot,
    onlyFiles: true,
  });
  const routeMap = new Map<string, string>();

  for (const docPath of docPaths) {
    const relativePath = toPosixPath(path.relative(docsRoot, docPath));
    const route =
      relativePath === "index.mdx"
        ? "salt/index"
        : `salt/${relativePath.replace(/\.mdx$/i, "")}`;
    routeMap.set(createNormalizedSiteRouteKey(route), docPath);

    if (/\/index$/i.test(route)) {
      routeMap.set(
        createNormalizedSiteRouteKey(route.replace(/\/index$/i, "")),
        docPath,
      );
    }
  }

  return routeMap;
}

function extractMarkdownContentBlocks(content: string): string[] {
  try {
    return mergePageContentBlocks(extractMdxTextBlocks(content));
  } catch {
    return mergePageContentBlocks(extractFallbackMarkdownLines(content));
  }
}

async function readSiteDocsPageSource(
  route: string,
  docsRouteMap: Map<string, string>,
): Promise<MarkdownPageSource | null> {
  const docPath = docsRouteMap.get(createNormalizedSiteRouteKey(route));
  if (!docPath) {
    return null;
  }

  const docSource = await readFileOrNull(docPath);
  if (!docSource) {
    return null;
  }

  const parsed = matter(docSource);
  const metadata = extractMarkdownPageMetadata(
    parsed.content,
    asString(parsed.data.description),
  );

  return {
    ...metadata,
    content: extractMarkdownContentBlocks(parsed.content),
  };
}

async function extractPages(
  repoRoot: string,
  verifiedAt: string,
): Promise<PageRecord[]> {
  const searchDataPath = path.join(repoRoot, "site", "public", "search-data.json");
  const searchDataSource = await readFileOrNull(searchDataPath);
  if (!searchDataSource) {
    return [];
  }

  let parsedSearchData: unknown;
  try {
    parsedSearchData = JSON.parse(searchDataSource);
  } catch {
    return [];
  }

  if (!Array.isArray(parsedSearchData)) {
    return [];
  }

  const docsRouteMap = await buildSiteDocsRouteMap(repoRoot);

  const pages = await Promise.all(
    parsedSearchData.map(async (entry): Promise<PageRecord | null> => {
      const page = entry as SiteSearchPageShape;
      const title = asString(page.title);
      const route = asString(page.route);
      if (!title || !route) {
        return null;
      }

      const fallbackContent = mergePageContentBlocks(asStringArray(page.content));
      const docsSource = await readSiteDocsPageSource(route, docsRouteMap);
      const snapshotMetadata = docsSource
        ? null
        : await readPageSnapshotMetadata(repoRoot, route);
      const summary =
        docsSource?.summary ??
        snapshotMetadata?.summary ??
        fallbackContent[0] ??
        cleanMarkdownText(title);

      return {
        id: createPageId(route),
        title: cleanMarkdownText(title),
        route,
        page_kind: classifyPageKind(route),
        summary,
        keywords: uniqueStrings([
          ...asStringArray(page.keywords).map((keyword) =>
            normalizeWhitespace(cleanMarkdownText(keyword)),
          ),
          ...extractRouteKeywords(route),
          title,
        ]).filter((keyword) => keyword.length > 0),
        content:
          docsSource && docsSource.content.length > 0
            ? docsSource.content
            : fallbackContent,
        section_headings:
          docsSource?.section_headings ?? snapshotMetadata?.section_headings ?? [],
        last_verified_at: verifiedAt,
      };
    }),
  );

  return pages
    .filter((page): page is PageRecord => page !== null)
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title) ||
        left.route.localeCompare(right.route),
    );
}

function toRelativeSourcePath(repoRoot: string, targetPath: string): string {
  const relativePath = path.relative(repoRoot, targetPath);
  return toPosixPath(relativePath.length > 0 ? relativePath : ".");
}

async function readDirectoryStats(rootPath: string): Promise<{
  file_count: number;
  newest_file_modified_at: string | null;
  sha256: string | null;
}> {
  const files = await fg("**/*", {
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
  });

  if (files.length === 0) {
    return {
      file_count: 0,
      newest_file_modified_at: null,
      sha256: null,
    };
  }

  const sortedFiles = files.sort((left, right) => left.localeCompare(right));
  const hash = crypto.createHash("sha256");
  let newestModifiedAt: string | null = null;

  for (const filePath of sortedFiles) {
    const fileStat = await fs.stat(filePath);
    const modifiedAt = fileStat.mtime.toISOString();
    if (!newestModifiedAt || modifiedAt > newestModifiedAt) {
      newestModifiedAt = modifiedAt;
    }
    hash.update(toPosixPath(path.relative(rootPath, filePath)));
    hash.update(String(fileStat.size));
    hash.update(String(fileStat.mtimeMs));
  }

  return {
    file_count: sortedFiles.length,
    newest_file_modified_at: newestModifiedAt,
    sha256: hash.digest("hex"),
  };
}

async function getSourceArtifactInfo(
  repoRoot: string,
  targetPath: string,
  kind: RegistrySourceArtifact["kind"],
): Promise<RegistrySourceArtifact> {
  try {
    const stat = await fs.stat(targetPath);
    if (kind === "file") {
      const fileContents = await fs.readFile(targetPath);
      return {
        path: toRelativeSourcePath(repoRoot, targetPath),
        kind,
        exists: true,
        sha256: crypto.createHash("sha256").update(fileContents).digest("hex"),
        last_modified_at: stat.mtime.toISOString(),
        file_count: 1,
        newest_file_modified_at: stat.mtime.toISOString(),
      };
    }

    const directoryStats = await readDirectoryStats(targetPath);
    return {
      path: toRelativeSourcePath(repoRoot, targetPath),
      kind,
      exists: true,
      sha256: directoryStats.sha256,
      last_modified_at: stat.mtime.toISOString(),
      file_count: directoryStats.file_count,
      newest_file_modified_at: directoryStats.newest_file_modified_at,
    };
  } catch {
    return {
      path: toRelativeSourcePath(repoRoot, targetPath),
      kind,
      exists: false,
      sha256: null,
      last_modified_at: null,
      file_count: null,
      newest_file_modified_at: null,
    };
  }
}

async function buildRegistryBuildInfo(
  repoRoot: string,
): Promise<RegistryBuildInfo> {
  const docsRoot = path.join(repoRoot, "site", "docs");
  const searchDataPath = path.join(repoRoot, "site", "public", "search-data.json");
  const snapshotRoot = path.join(repoRoot, "site", "snapshots", "latest", "salt");

  return {
    source_root: toPosixPath(repoRoot),
    source_artifacts: {
      docs_root: await getSourceArtifactInfo(repoRoot, docsRoot, "directory"),
      search_data: await getSourceArtifactInfo(repoRoot, searchDataPath, "file"),
      snapshot_root: await getSourceArtifactInfo(
        repoRoot,
        snapshotRoot,
        "directory",
      ),
    },
  };
}

async function extractGuides(
  repoRoot: string,
  verifiedAt: string,
): Promise<GuideRecord[]> {
  const guides: GuideRecord[] = [];

  const developingPath = path.join(
    repoRoot,
    "site/docs/getting-started/developing.mdx",
  );
  const developingSource = await readFileOrNull(developingPath);
  if (developingSource) {
    const parsed = matter(developingSource);
    const sections = parseMarkdownSections(parsed.content, 3);
    const installSection = findMarkdownSection(
      sections,
      (title) => title.includes("Install the Salt packages"),
    );
    const fontsSection = findMarkdownSection(
      sections,
      (title) => title.includes("Add required web fonts"),
    );
    const integrateSection = findMarkdownSection(
      sections,
      (title) => title.includes("Integrate Salt into your app"),
    );
    const importSection = findMarkdownSection(
      sections,
      (title) => title.includes("Import components"),
    );
    const labSection = findMarkdownSection(
      sections,
      (title) => title.includes("Play with lab components"),
    );

    const installBlocks = extractFencedCodeBlocks(installSection);
    const fontBlocks = extractFencedCodeBlocks(fontsSection);
    const integrateBlocks = extractFencedCodeBlocks(integrateSection);
    const importBlocks = extractFencedCodeBlocks(importSection);

    const steps = [
      buildGuideStep(
        "Install core packages",
        [
          "`@salt-ds/core` contains production-ready UI components.",
          "`@salt-ds/theme` contains CSS files that apply Salt's default theme.",
          "`@salt-ds/icons` contains SVG-based icons.",
        ],
        [
          createGuideSnippet(
            "Install Salt packages",
            installBlocks[0]?.language ?? "shell",
            installBlocks[0]?.code,
          ),
        ].filter((snippet): snippet is GuideSnippet => snippet !== null),
      ),
      buildGuideStep(
        "Add required web fonts",
        [
          "Salt’s default theme requires the Open Sans and PT Mono web fonts.",
          "You can load them from Google Fonts or self-host them with Fontsource.",
        ],
        [
          createGuideSnippet(
            "Google Fonts",
            fontBlocks[0]?.language ?? "html",
            fontBlocks[0]?.code,
          ),
          createGuideSnippet(
            "Install Fontsource packages",
            fontBlocks[1]?.language ?? "shell",
            fontBlocks[1]?.code,
          ),
          createGuideSnippet(
            "Import Fontsource styles",
            fontBlocks[2]?.language ?? "tsx",
            fontBlocks[2]?.code,
          ),
        ].filter((snippet): snippet is GuideSnippet => snippet !== null),
      ),
      buildGuideStep(
        "Bootstrap Salt in your app",
        [
          "Import the Salt theme CSS and wrap your application in `SaltProvider`.",
          ...extractStatementsFromSection(integrateSection),
        ],
        [
          createGuideSnippet(
            "Bootstrap with SaltProvider",
            integrateBlocks[0]?.language ?? "tsx",
            integrateBlocks[0]?.code,
          ),
        ].filter((snippet): snippet is GuideSnippet => snippet !== null),
      ),
      buildGuideStep(
        "Import components",
        extractStatementsFromSection(importSection),
        [
          createGuideSnippet(
            "Import and render a Button",
            importBlocks[0]?.language ?? "tsx",
            importBlocks[0]?.code,
          ),
        ].filter((snippet): snippet is GuideSnippet => snippet !== null),
      ),
      buildGuideStep(
        "Adopt lab components intentionally",
        extractStatementsFromSection(labSection),
        [],
      ),
    ];

    guides.push({
      id: "guide.developing-with-salt",
      name: "Developing with Salt",
      aliases: ["getting started", "setup", "bootstrap", "developing"],
      kind: "getting-started",
      summary:
        asString(parsed.data.description) ??
        extractFirstParagraph(parsed.content),
      packages: ["@salt-ds/core", "@salt-ds/theme", "@salt-ds/icons"],
      steps,
      related_docs: {
        overview: "/salt/getting-started/developing",
        related_components: ["SaltProvider", "Button"],
        related_packages: ["@salt-ds/core", "@salt-ds/theme", "@salt-ds/icons"],
      },
      last_verified_at: verifiedAt,
    });
  }

  const themesPath = path.join(repoRoot, "site/docs/themes/index.mdx");
  const themesSource = await readFileOrNull(themesPath);
  if (themesSource) {
    const parsed = matter(themesSource);
    const sections = parseMarkdownSections(parsed.content, 3);
    const jpmBrandSection = findMarkdownSection(
      sections,
      (title) => title.includes("JPM Brand theme"),
    );
    const legacySection = findMarkdownSection(
      sections,
      (title) => title.includes("Legacy (UITK) theme"),
    );

    const jpmBrandBlocks = extractFencedCodeBlocks(jpmBrandSection);
    const legacyBlocks = extractFencedCodeBlocks(legacySection);

    guides.push({
      id: "guide.themes",
      name: "Themes",
      aliases: ["theme", "theming", "jpm brand", "legacy", "uitk"],
      kind: "theming",
      summary:
        asString(parsed.data.description) ??
        extractFirstParagraph(parsed.content),
      packages: ["@salt-ds/core", "@salt-ds/theme"],
      steps: [
        buildGuideStep(
          "Choose a Salt theme",
          [
            "Salt offers the default JPM Brand theme for new work and a Legacy theme for UITK migration paths.",
            "Salt recommends the JPM Brand theme for accessibility and long-term brand alignment.",
          ],
          [],
        ),
        buildGuideStep(
          "Apply the JPM Brand theme",
          extractStatementsFromSection(jpmBrandSection),
          [
            createGuideSnippet(
              "JPM Brand theme",
              jpmBrandBlocks[0]?.language ?? "tsx",
              jpmBrandBlocks[0]?.code,
            ),
            createGuideSnippet(
              "Amplitude font-face declarations",
              jpmBrandBlocks[1]?.language ?? "css",
              jpmBrandBlocks[1]?.code,
            ),
          ].filter((snippet): snippet is GuideSnippet => snippet !== null),
        ),
        buildGuideStep(
          "Apply the Legacy theme",
          extractStatementsFromSection(legacySection),
          [
            createGuideSnippet(
              "Legacy theme",
              legacyBlocks[0]?.language ?? "tsx",
              legacyBlocks[0]?.code,
            ),
          ].filter((snippet): snippet is GuideSnippet => snippet !== null),
        ),
      ],
      related_docs: {
        overview: "/salt/themes",
        related_components: ["SaltProvider", "SaltProviderNext"],
        related_packages: ["@salt-ds/core", "@salt-ds/theme"],
      },
      last_verified_at: verifiedAt,
    });
  }

  return guides.sort((left, right) => left.name.localeCompare(right.name));
}

async function extractTokenDescriptions(
  repoRoot: string,
): Promise<Map<string, string>> {
  const descriptionsPath = path.join(
    repoRoot,
    "site/src/components/css-display/descriptions.ts",
  );
  const source = await readFileOrNull(descriptionsPath);
  if (!source) {
    return new Map<string, string>();
  }

  const descriptionMap = new Map<string, string>();
  const pairRegex = /^\s*(\w+):\s*"([^"]+)"[, ]*$/gm;
  let match = pairRegex.exec(source);
  while (match) {
    descriptionMap.set(match[1], cleanMarkdownText(match[2]));
    match = pairRegex.exec(source);
  }

  return descriptionMap;
}

async function extractTokens(
  repoRoot: string,
  verifiedAt: string,
): Promise<TokenRecord[]> {
  const tokenDescriptions = await extractTokenDescriptions(repoRoot);
  const cssPaths = (
    await fg("packages/theme/css/**/*.css", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));

  const tokenMap = new Map<
    string,
    TokenRecord & { themeSet: Set<string>; guidanceSet: Set<string> }
  >();

  for (const cssPath of cssPaths) {
    const content = await readFileOrNull(cssPath);
    if (!content) {
      continue;
    }

    const declarationRegex = /(--salt-[\w-]+)\s*:\s*([^;]+);/g;
    let declarationMatch = declarationRegex.exec(content);
    while (declarationMatch) {
      const tokenName = declarationMatch[1];
      const tokenValue = normalizeWhitespace(declarationMatch[2]);
      const tokenCategory =
        tokenName.replace("--salt-", "").split("-")[0] ?? "misc";
      const semanticIntent = tokenDescriptions.get(tokenCategory) ?? null;
      const tokenThemes = inferThemeFromTokenPath(cssPath);
      const isDeprecated = toPosixPath(cssPath).includes("/deprecated/");

      const existing = tokenMap.get(tokenName);
      if (!existing) {
        tokenMap.set(tokenName, {
          name: tokenName,
          category: tokenCategory,
          type: inferTokenType(tokenValue),
          value: tokenValue,
          semantic_intent: semanticIntent,
          themes: [],
          themeSet: new Set(tokenThemes),
          densities: [],
          applies_to: [],
          guidance: semanticIntent ? [semanticIntent] : [],
          guidanceSet: semanticIntent
            ? new Set([semanticIntent])
            : new Set<string>(),
          aliases: [],
          deprecated: isDeprecated,
          last_verified_at: verifiedAt,
        });
      } else {
        for (const themeName of tokenThemes) {
          existing.themeSet.add(themeName);
        }
        if (semanticIntent) {
          existing.guidanceSet.add(semanticIntent);
        }
        existing.deprecated = existing.deprecated || isDeprecated;
      }

      declarationMatch = declarationRegex.exec(content);
    }
  }

  const tokens = [...tokenMap.values()].map((token) => ({
    name: token.name,
    category: token.category,
    type: token.type,
    value: token.value,
    semantic_intent: token.semantic_intent,
    themes: [...token.themeSet].sort(),
    densities: token.densities,
    applies_to: token.applies_to,
    guidance: [...token.guidanceSet],
    aliases: token.aliases,
    deprecated: token.deprecated,
    last_verified_at: token.last_verified_at,
  }));

  return tokens.sort((left, right) => left.name.localeCompare(right.name));
}

function extractDeprecatedSymbolsFromLine(line: string): string[] {
  const symbols = new Set<string>();
  const normalizedLine = line.trim();

  for (const match of normalizedLine.matchAll(
    /`([^`]+)`(?:\s+[A-Za-z]+){0,4}\s+(?:has been|is now|being)?\s*deprecated\b/gi,
  )) {
    const symbol = match[1]?.trim();
    if (symbol) {
      symbols.add(symbol);
    }
  }

  const deprecatedClauseMatch = normalizedLine.match(/\bDeprecated\b\s+(.+)/i);
  if (!deprecatedClauseMatch) {
    return [...symbols];
  }

  const clause = deprecatedClauseMatch[1]
    .split(/(?<=\.)\s|:\s|;\s|\s+should\b/i)[0]
    ?.trim();
  if (!clause) {
    return [...symbols];
  }

  const codeSymbols = [...clause.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (codeSymbols.length > 0) {
    for (const symbol of codeSymbols) {
      symbols.add(symbol);
    }
    return [...symbols];
  }

  for (const match of clause.matchAll(/\b[A-Z][A-Za-z0-9_]+\b/g)) {
    const symbol = match[0]?.trim();
    if (symbol) {
      symbols.add(symbol);
    }
  }

  return [...symbols];
}

function parsePackageChangelogMetadata(
  content: string,
): PackageChangelogMetadata {
  const deprecatedBySymbol = new Map<string, string>();
  let currentVersion: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const versionMatch = line.match(/^##\s+([0-9][^\s]*)\s*$/);
    if (versionMatch) {
      currentVersion = normalizeVersion(versionMatch[1]);
      continue;
    }

    if (!currentVersion || !/deprecated/i.test(line)) {
      continue;
    }

    const symbols = extractDeprecatedSymbolsFromLine(line);
    for (const symbol of symbols) {
      const key = toMatchKey(symbol);
      if (!key) {
        continue;
      }

      deprecatedBySymbol.set(
        key,
        preferEarlierVersion(deprecatedBySymbol.get(key), currentVersion) ??
          currentVersion,
      );
    }
  }

  return { deprecatedBySymbol };
}

async function loadPackageChangelogMetadata(
  repoRoot: string,
  packages: PackageRecord[],
): Promise<Map<string, PackageChangelogMetadata>> {
  const metadataByPackage = new Map<string, PackageChangelogMetadata>();

  for (const pkg of packages) {
    if (!pkg.changelog_path) {
      continue;
    }
    const changelogPath = pkg.changelog_path;

    const changelog = await readFileOrNull(
      path.join(repoRoot, changelogPath),
    );
    if (!changelog) {
      continue;
    }

    metadataByPackage.set(pkg.name, parsePackageChangelogMetadata(changelog));
  }

  return metadataByPackage;
}

async function extractChanges(
  repoRoot: string,
  packages: PackageRecord[],
  components: ComponentRecord[],
  generatedAt: string,
): Promise<ChangeRecord[]> {
  const componentsByPackage = new Map(
    packages.map((pkg) => [
      pkg.name,
      components.filter((component) => component.package.name === pkg.name),
    ] as const),
  );
  const changes: ChangeRecord[] = [];

  for (const pkg of packages) {
    if (!pkg.changelog_path) {
      continue;
    }
    const changelogPath = pkg.changelog_path;

    const changelog = await readFileOrNull(
      path.join(repoRoot, changelogPath),
    );
    if (!changelog) {
      continue;
    }

    const changelogItems = parseChangelogItems(changelog);
    const packageComponents = componentsByPackage.get(pkg.name) ?? [];

    changelogItems.forEach((item, index) => {
      const summary = summarizeChangeText(item.text);
      const details = stripLeadingCommitHash(item.text);
      const kind = classifyChangeKind(item.text);
      const matchedComponents = findMatchedComponentsForChange(
        item.text,
        packageComponents,
      );

      if (matchedComponents.length === 0) {
        changes.push({
          id: buildChangeId(pkg.name, item.version, "package", pkg.name, index),
          package: pkg.name,
          target_type: "package",
          target_name: pkg.name,
          version: item.version,
          release_type: item.release_type,
          kind,
          summary,
          details,
          source_urls: [changelogPath],
          inference: {
            matched_by: "package_default",
            confidence: "low",
          },
          last_verified_at: generatedAt,
        });
        return;
      }

      for (const match of matchedComponents) {
        changes.push({
          id: buildChangeId(
            pkg.name,
            item.version,
            "component",
            match.component.name,
            index,
          ),
          package: pkg.name,
          target_type: "component",
          target_name: match.component.name,
          version: item.version,
          release_type: item.release_type,
          kind,
          summary,
          details,
          source_urls: [changelogPath],
          inference: match.inference,
          last_verified_at: generatedAt,
        });
      }
    });
  }

  return changes.sort((left, right) => {
    if (left.package !== right.package) {
      return left.package.localeCompare(right.package);
    }

    const versionCompare = semver.rcompare(left.version, right.version);
    if (versionCompare !== 0) {
      return versionCompare;
    }

    if (left.target_type !== right.target_type) {
      return left.target_type.localeCompare(right.target_type);
    }

    if (left.target_name !== right.target_name) {
      return left.target_name.localeCompare(right.target_name);
    }

    return left.summary.localeCompare(right.summary);
  });
}

function inferDeprecatedVersionFromNote(note: string): string | null {
  const match =
    note.match(
      /\bdeprecated(?:\s+(?:in|since))?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i,
    ) ?? note.match(/\bsince\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i);

  return normalizeVersion(match?.[1] ?? null);
}

function inferRemovedVersionFromNote(note: string): string | null {
  const match = note.match(
    /\bremoved(?:\s+in)?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i,
  );

  return normalizeVersion(match?.[1] ?? null);
}

function extractDeprecationGuidance(note: string): string {
  const normalized = cleanMarkdownText(note);
  if (!normalized) {
    return "";
  }

  const withoutLeadingSince = normalized.replace(
    /^(?:deprecated\s+)?since\s+v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:[.?!:;]\s*|\s+)/i,
    "",
  );

  return withoutLeadingSince.trim() || normalized;
}

function summarizeDeprecationNote(note: string): string {
  const guidance = extractDeprecationGuidance(note);
  if (!guidance) {
    return "";
  }

  const firstSentence = guidance.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  if (firstSentence) {
    return firstSentence;
  }

  return guidance.split(/\s+\|\s+/)[0]?.trim() ?? guidance;
}

function normalizeReplacementSymbol(symbol: string | null): string | null {
  if (!symbol) {
    return null;
  }

  return symbol.replace(/[.,;:]+$/g, "") || null;
}

async function extractDeprecations(
  repoRoot: string,
  packages: PackageRecord[],
): Promise<DeprecationRecord[]> {
  const changelogMetadataByPackage = await loadPackageChangelogMetadata(
    repoRoot,
    packages,
  );
  const sourcePaths = (
    await fg("packages/*/src/**/*.{ts,tsx}", {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));

  const deprecations: DeprecationRecord[] = [];
  for (const sourcePath of sourcePaths) {
    const source = await readFileOrNull(sourcePath);
    if (!source || !source.includes("@deprecated")) {
      continue;
    }

    const normalizedPath = toPosixPath(path.relative(repoRoot, sourcePath));
    const packageSlug = normalizedPath.split("/")[1];
    const packageName = `@salt-ds/${packageSlug}`;
    if (EXCLUDED_REGISTRY_PACKAGES.has(packageName)) {
      continue;
    }

    const scriptKind = sourcePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      normalizedPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    deprecations.push(
      ...collectDeprecationsFromSourceFile(
        sourceFile,
        packageName,
        normalizedPath,
        changelogMetadataByPackage.get(packageName),
      ),
    );
  }

  return deprecations.sort((left, right) => left.id.localeCompare(right.id));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function componentMatchKey(value: string | null): string {
  if (!value) {
    return "";
  }
  return toMatchKey(value.replace(/props$/i, ""));
}

function deprecationMatchesComponent(
  component: ComponentRecord,
  deprecation: DeprecationRecord,
): boolean {
  if (component.package.name !== deprecation.package) {
    return false;
  }

  const componentKey = componentMatchKey(component.name);
  const deprecationComponentKey = componentMatchKey(deprecation.component);
  const deprecationNameKey = componentMatchKey(deprecation.name);

  if (
    deprecationComponentKey.length > 0 &&
    deprecationComponentKey === componentKey
  ) {
    return true;
  }

  if (deprecationNameKey.length > 0 && deprecationNameKey === componentKey) {
    return true;
  }

  const sourcePath = deprecation.source_urls.find((entry) =>
    entry.startsWith("packages/"),
  );
  if (sourcePath && component.source.repo_path) {
    const normalizedSourcePath = toPosixPath(sourcePath);
    const normalizedComponentPath = toPosixPath(component.source.repo_path);
    if (
      normalizedSourcePath.startsWith(`${normalizedComponentPath}/`) ||
      normalizedSourcePath === normalizedComponentPath
    ) {
      return true;
    }
  }

  return false;
}

function linkDeprecationsToComponents(
  components: ComponentRecord[],
  deprecations: DeprecationRecord[],
): {
  components: ComponentRecord[];
  deprecations: DeprecationRecord[];
} {
  const componentDeprecationIds = new Map<string, string[]>();
  const componentDeprecationInference = new Map<
    string,
    ComponentDeprecationInference
  >();
  const defaultDeprecationInference = (): ComponentDeprecationInference => ({
    matched_count: 0,
    inferred_component_count: 0,
    ambiguous_match_count: 0,
  });
  const incrementComponentDeprecationInference = (
    componentId: string,
    update: Partial<ComponentDeprecationInference>,
  ) => {
    const existing =
      componentDeprecationInference.get(componentId) ??
      defaultDeprecationInference();
    componentDeprecationInference.set(componentId, {
      matched_count: existing.matched_count + (update.matched_count ?? 0),
      inferred_component_count:
        existing.inferred_component_count +
        (update.inferred_component_count ?? 0),
      ambiguous_match_count:
        existing.ambiguous_match_count + (update.ambiguous_match_count ?? 0),
    });
  };
  const updatedDeprecations: DeprecationRecord[] = deprecations.map(
    (deprecation) => {
      const matched = components.filter((component) =>
        deprecationMatchesComponent(component, deprecation),
      );
      const matchedComponentNames = matched
        .map((component) => component.name)
        .sort((left, right) => left.localeCompare(right));
      const componentInferred = !deprecation.component && matched.length === 1;
      const ambiguousComponentMatch = matched.length > 1;
      const inference = {
        matched_component_names: matchedComponentNames,
        component_inferred: componentInferred,
        ambiguous_component_match: ambiguousComponentMatch,
      };

      if (matched.length === 1) {
        const [component] = matched;
        const depIds = componentDeprecationIds.get(component.id) ?? [];
        depIds.push(deprecation.id);
        componentDeprecationIds.set(component.id, depIds);
        incrementComponentDeprecationInference(component.id, {
          matched_count: 1,
          inferred_component_count: componentInferred ? 1 : 0,
        });

        return {
          ...deprecation,
          component: componentInferred ? component.name : deprecation.component,
          inference,
        };
      }

      if (matched.length > 1) {
        for (const component of matched) {
          const depIds = componentDeprecationIds.get(component.id) ?? [];
          depIds.push(deprecation.id);
          componentDeprecationIds.set(component.id, depIds);
          incrementComponentDeprecationInference(component.id, {
            matched_count: 1,
            ambiguous_match_count: 1,
          });
        }
      }

      return {
        ...deprecation,
        inference,
      };
    },
  );

  const updatedComponents = components.map((component) => ({
    ...component,
    deprecations: uniqueStrings(
      componentDeprecationIds.get(component.id) ?? [],
    ).sort((left, right) => left.localeCompare(right)),
    inference: {
      ...component.inference,
      deprecations:
        componentDeprecationInference.get(component.id) ??
        defaultDeprecationInference(),
    },
  }));

  return { components: updatedComponents, deprecations: updatedDeprecations };
}

async function extractTokenCountsForSource(
  repoRoot: string,
  sourcePath: string,
  tokenNameSet: Set<string>,
  cache: Map<string, Map<string, number>>,
): Promise<Map<string, number>> {
  const cacheKey = toPosixPath(sourcePath);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const absolutePath = path.resolve(repoRoot, sourcePath);
  if (!(await pathExists(absolutePath))) {
    const empty = new Map<string, number>();
    cache.set(cacheKey, empty);
    return empty;
  }

  const stats = await fs.stat(absolutePath);
  const globPattern = stats.isDirectory()
    ? `${toPosixPath(path.relative(repoRoot, absolutePath))}/**/*.{ts,tsx,css,scss}`
    : toPosixPath(path.relative(repoRoot, absolutePath));

  const filePaths = (
    await fg(globPattern, {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    })
  ).sort((left, right) => left.localeCompare(right));
  const tokenCounts = new Map<string, number>();

  for (const filePath of filePaths) {
    const content = await readFileOrNull(filePath);
    if (!content) {
      continue;
    }

    const matches = content.match(/--salt-[\w-]+/g) ?? [];
    for (const tokenName of matches) {
      if (tokenNameSet.has(tokenName)) {
        tokenCounts.set(tokenName, (tokenCounts.get(tokenName) ?? 0) + 1);
      }
    }
  }

  cache.set(cacheKey, tokenCounts);
  return tokenCounts;
}
function extractJsDocTagComment(comment: ts.JSDocTag["comment"]): string {
  if (!comment) {
    return "";
  }
  if (typeof comment === "string") {
    return comment;
  }

  return comment
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if ("text" in part) {
        return String(part.text ?? "");
      }
      return "";
    })
    .join("");
}

function inferDeprecationKindFromNode(
  node: ts.Node,
): DeprecationRecord["kind"] {
  if (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isParameter(node)
  ) {
    return "prop";
  }

  if (
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isImportDeclaration(node)
  ) {
    return "import";
  }

  if (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  ) {
    return "type";
  }

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return "component";
  }

  return "other";
}

function inferSymbolNameFromNode(node: ts.Node): string | null {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) {
      return declaration.name.text;
    }
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if (ts.isImportSpecifier(node)) {
    return node.name.text;
  }

  if (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isParameter(node)
  ) {
    if (node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (node.name && ts.isStringLiteral(node.name)) {
      return node.name.text;
    }
  }

  if ("name" in node) {
    const named = node as ts.NamedDeclaration;
    if (named.name && ts.isIdentifier(named.name)) {
      return named.name.text;
    }
  }

  return null;
}

function inferComponentFromNode(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      const name = current.name?.text ?? null;
      if (!name) {
        current = current.parent;
        continue;
      }
      if (name.endsWith("Props")) {
        return name.replace(/Props$/, "");
      }
      if (/^[A-Z]/.test(name)) {
        return name;
      }
    }

    current = current.parent;
  }

  return null;
}

function buildDeprecationId(
  packageName: string,
  symbolName: string,
  kind: DeprecationRecord["kind"],
  normalizedPath: string,
  line: number,
): string {
  const relativeSourceId = normalizedPath
    .replace(/^packages\/[^/]+\/src\//, "")
    .replace(/\.[^.]+$/, "");

  return `dep.${toKebabCase(packageName)}.${toKebabCase(relativeSourceId)}.${toKebabCase(symbolName)}.${kind}.${line}`;
}

function deprecationKindRank(kind: DeprecationRecord["kind"]): number {
  switch (kind) {
    case "prop":
      return 0;
    case "component":
      return 1;
    case "import":
      return 2;
    case "type":
      return 3;
    case "token":
      return 4;
    default:
      return 5;
  }
}

function mergeDeprecationRecords(
  current: DeprecationRecord,
  candidate: DeprecationRecord,
): DeprecationRecord {
  const preferred =
    deprecationKindRank(candidate.kind) < deprecationKindRank(current.kind)
      ? candidate
      : current;
  const secondary = preferred === current ? candidate : current;

  return {
    ...preferred,
    deprecated_in: preferEarlierVersion(
      preferred.deprecated_in,
      secondary.deprecated_in,
    ),
    removed_in: preferred.removed_in ?? secondary.removed_in,
    replacement: {
      type: preferred.replacement.type ?? secondary.replacement.type,
      name: preferred.replacement.name ?? secondary.replacement.name,
      notes: preferred.replacement.notes ?? secondary.replacement.notes,
    },
    migration:
      preferred.migration.details.length > 0
        ? preferred.migration
        : secondary.migration,
    source_urls: uniqueStrings([
      ...preferred.source_urls,
      ...secondary.source_urls,
    ]).sort((left, right) => left.localeCompare(right)),
  };
}

function collectDeprecationsFromSourceFile(
  sourceFile: ts.SourceFile,
  packageName: string,
  normalizedPath: string,
  changelogMetadata?: PackageChangelogMetadata,
): DeprecationRecord[] {
  const deprecationsByIdentity = new Map<string, DeprecationRecord>();

  const visit = (node: ts.Node): void => {
    const tags = ts
      .getJSDocTags(node)
      .filter((tag) => tag.tagName.getText(sourceFile) === "deprecated");
    if (tags.length > 0) {
      const symbolName = inferSymbolNameFromNode(node);
      if (!symbolName) {
        ts.forEachChild(node, visit);
        return;
      }
      const componentName = inferComponentFromNode(node);
      const kind = inferDeprecationKindFromNode(node);
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1;

      for (const tag of tags) {
        const rawNote = extractJsDocTagComment(tag.comment);
        const guidanceNote = extractDeprecationGuidance(rawNote);
        const note = summarizeDeprecationNote(rawNote);
        const replacementMatch = guidanceNote.match(
          /use\s+`?([A-Za-z0-9_.-]+)`?/i,
        );
        const replacementName = normalizeReplacementSymbol(
          replacementMatch ? replacementMatch[1] : null,
        );
        const deprecatedIn =
          inferDeprecatedVersionFromNote(rawNote) ??
          changelogMetadata?.deprecatedBySymbol.get(toMatchKey(symbolName)) ??
          null;
        const deprecation = {
          id: buildDeprecationId(
            packageName,
            symbolName,
            kind,
            normalizedPath,
            line,
          ),
          package: packageName,
          component:
            componentName ??
            (symbolName.endsWith("Props")
              ? symbolName.replace(/Props$/, "")
              : null),
          kind,
          name: symbolName,
          deprecated_in: deprecatedIn,
          removed_in: inferRemovedVersionFromNote(rawNote),
          replacement: {
            type: replacementName ? "symbol" : null,
            name: replacementName,
            notes: note || null,
          },
          migration: {
            strategy: replacementName ? "replace" : "manual",
            details: replacementName
              ? [
                  {
                    from: symbolName,
                    to: replacementName,
                  },
                ]
              : [],
          },
          source_urls: [normalizedPath],
        } satisfies DeprecationRecord;
        const identityKey = `${normalizedPath}:${symbolName}:${line}`;
        const current = deprecationsByIdentity.get(identityKey);
        deprecationsByIdentity.set(
          identityKey,
          current ? mergeDeprecationRecords(current, deprecation) : deprecation,
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...deprecationsByIdentity.values()];
}

async function linkTokensToComponents(
  repoRoot: string,
  components: ComponentRecord[],
  tokens: TokenRecord[],
): Promise<{
  components: ComponentRecord[];
  tokens: TokenRecord[];
}> {
  const tokenByName = new Map(tokens.map((token) => [token.name, token]));
  const tokenNameSet = new Set(tokens.map((token) => token.name));
  const componentNamesByToken = new Map<string, Set<string>>();
  const tokenScanCache = new Map<string, Map<string, number>>();

  const updatedComponents: ComponentRecord[] = [];
  for (const component of components) {
    if (!component.source.repo_path) {
      const tokenInference: ComponentTokenInference = {
        source: "none",
        discovered_count: 0,
        returned_count: 0,
        max_returned: MAX_COMPONENT_TOKENS,
        truncated: false,
      };
      updatedComponents.push({
        ...component,
        tokens: [],
        inference: {
          ...component.inference,
          tokens: tokenInference,
        },
      });
      continue;
    }

    const tokenCounts = await extractTokenCountsForSource(
      repoRoot,
      component.source.repo_path,
      tokenNameSet,
      tokenScanCache,
    );
    const tokenNames = [...tokenCounts.entries()]
      .sort((left, right) => {
        if (left[1] !== right[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, MAX_COMPONENT_TOKENS)
      .map(([tokenName]) => tokenName);

    const componentTokens = tokenNames
      .map((tokenName) => tokenByName.get(tokenName))
      .filter((token): token is TokenRecord => token != null)
      .map((token) => ({
        name: token.name,
        category: token.category,
        semantic_intent: token.semantic_intent,
      }));

    const tokenInference: ComponentTokenInference = {
      source: "repo_scan",
      discovered_count: tokenCounts.size,
      returned_count: componentTokens.length,
      max_returned: MAX_COMPONENT_TOKENS,
      truncated: tokenCounts.size > MAX_COMPONENT_TOKENS,
    };

    for (const tokenName of tokenNames) {
      const names = componentNamesByToken.get(tokenName) ?? new Set<string>();
      names.add(component.name);
      componentNamesByToken.set(tokenName, names);
    }

    updatedComponents.push({
      ...component,
      tokens: componentTokens,
      inference: {
        ...component.inference,
        tokens: tokenInference,
      },
    });
  }

  const updatedTokens = tokens.map((token) => ({
    ...token,
    applies_to: [
      ...(componentNamesByToken.get(token.name) ?? new Set<string>()),
    ].sort((left, right) => left.localeCompare(right)),
  }));

  return { components: updatedComponents, tokens: updatedTokens };
}

function buildSearchIndex(
  registry: Omit<SaltRegistry, "search_index">,
): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];

  for (const pkg of registry.packages) {
    entries.push({
      id: pkg.id,
      type: "package",
      name: pkg.name,
      package: pkg.name,
      status: pkg.status,
      summary: pkg.summary,
      source_url: pkg.docs_root,
      keywords: [pkg.name, pkg.status, pkg.version],
    });
  }

  for (const component of registry.components) {
    entries.push({
      id: component.id,
      type: "component",
      name: component.name,
      package: component.package.name,
      status: component.status,
      summary: component.summary,
      source_url: component.related_docs.overview,
      keywords: uniqueStrings([
        component.name,
        ...component.aliases,
        ...component.tags,
        ...component.when_to_use,
      ]),
    });
  }

  for (const icon of registry.icons) {
    entries.push({
      id: icon.id,
      type: "icon",
      name: icon.name,
      package: icon.package.name,
      status: icon.status,
      summary: icon.summary,
      source_url: icon.related_docs.overview,
      keywords: uniqueStrings([
        icon.name,
        icon.base_name,
        icon.figma_name,
        icon.category,
        icon.variant,
        ...icon.synonyms,
        ...icon.aliases,
      ]),
    });
  }

  for (const countrySymbol of registry.country_symbols) {
    entries.push({
      id: countrySymbol.id,
      type: "country_symbol",
      name: countrySymbol.name,
      package: countrySymbol.package.name,
      status: countrySymbol.status,
      summary: countrySymbol.summary,
      source_url:
        countrySymbol.related_docs.foundation ??
        countrySymbol.related_docs.overview,
      keywords: uniqueStrings([
        countrySymbol.code,
        countrySymbol.name,
        ...countrySymbol.aliases,
        countrySymbol.variants.circle.export_name,
        countrySymbol.variants.sharp.export_name,
      ]),
    });
  }

  for (const page of registry.pages) {
    entries.push({
      id: page.id,
      type: "page",
      name: page.title,
      package: null,
      status: "stable",
      summary: page.summary,
      source_url: page.route,
      keywords: uniqueStrings([
        page.title,
        page.page_kind,
        ...page.keywords,
        ...page.section_headings,
      ]),
    });
  }

  for (const pattern of registry.patterns) {
    entries.push({
      id: pattern.id,
      type: "pattern",
      name: pattern.name,
      package: null,
      status: pattern.status,
      summary: pattern.summary,
      source_url: pattern.related_docs.overview,
      keywords: uniqueStrings([
        pattern.name,
        ...pattern.aliases,
        ...pattern.when_to_use,
        ...pattern.related_patterns,
        ...pattern.composed_of.map((item) => item.component),
        ...pattern.how_to_build,
        ...pattern.how_it_works,
      ]),
    });
  }

  for (const guide of registry.guides) {
    entries.push({
      id: guide.id,
      type: "guide",
      name: guide.name,
      package: null,
      status: "stable",
      summary: guide.summary,
      source_url: guide.related_docs.overview,
      keywords: uniqueStrings([
        guide.name,
        ...guide.aliases,
        ...guide.packages,
        ...guide.related_docs.related_components,
        ...guide.related_docs.related_packages,
        ...guide.steps.flatMap((step) => [
          step.title,
          ...step.statements,
          ...step.snippets.map((snippet) => snippet.title),
        ]),
      ]),
    });
  }

  for (const token of registry.tokens) {
    entries.push({
      id: `token.${toKebabCase(token.name)}`,
      type: "token",
      name: token.name,
      package: "@salt-ds/theme",
      status: token.deprecated ? "deprecated" : "stable",
      summary: token.semantic_intent ?? `${token.category} token`,
      source_url: "/salt/themes/design-tokens/index",
      keywords: uniqueStrings([
        token.name,
        token.category,
        ...(token.semantic_intent ? [token.semantic_intent] : []),
      ]),
    });
  }

  for (const example of registry.examples) {
    entries.push({
      id: `example.${example.id}`,
      type: "example",
      name: example.title,
      package: example.package,
      status: null,
      summary: `Example for ${example.target_type} ${example.target_name}`,
      source_url: example.source_url,
      keywords: uniqueStrings([
        example.title,
        example.target_name,
        ...example.intent,
      ]),
    });
  }

  for (const change of registry.changes) {
    const packageStatus =
      registry.packages.find((pkg) => pkg.name === change.package)?.status ??
      null;
    entries.push({
      id: change.id,
      type: "change",
      name: `${change.target_name} ${change.version}`,
      package: change.package,
      status: packageStatus,
      summary: change.summary,
      source_url: change.source_urls[0] ?? null,
      keywords: uniqueStrings([
        change.target_name,
        change.package,
        change.version,
        change.kind,
        change.release_type,
        change.summary,
        change.details,
      ]),
    });
  }

  return entries;
}

export async function buildRegistry(
  options: BuildRegistryOptions = {},
): Promise<SaltRegistry> {
  const packageRoot = getPackageRoot(import.meta.url);
  const requestedSourceRoot = options.sourceRoot
    ? path.resolve(options.sourceRoot)
    : null;
  const sourceRoot =
    requestedSourceRoot ??
    (await findSaltRepoRoot(process.cwd())) ??
    process.cwd();
  const outputDir =
    options.outputDir != null
      ? path.resolve(options.outputDir)
      : path.join(packageRoot, "generated");
  const generatedAt = options.timestamp ?? new Date().toISOString();
  const version = options.version ?? REGISTRY_VERSION;
  const buildInfo = await buildRegistryBuildInfo(sourceRoot);

  const packages = await extractPackages(sourceRoot);
  const propMetadata = await loadPropMetadata(sourceRoot);
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const components = await extractComponents(
    sourceRoot,
    packageByName,
    propMetadata,
    generatedAt,
  );
  const [patterns, guides, rawTokens, rawDeprecations, changes] =
    await Promise.all([
    extractPatterns(sourceRoot, generatedAt),
    extractGuides(sourceRoot, generatedAt),
    extractTokens(sourceRoot, generatedAt),
    extractDeprecations(sourceRoot, packages),
    extractChanges(sourceRoot, packages, components, generatedAt),
  ]);
  const pages = await extractPages(sourceRoot, generatedAt);
  const patternStoryExamples = await extractPatternExamplesFromStories(
    sourceRoot,
    createPatternNameBySlug(patterns),
  );
  const enrichedPatternMap = new Map(
    patterns.map((pattern) => [pattern.name, pattern] as const),
  );
  for (const example of patternStoryExamples) {
    const pattern = enrichedPatternMap.get(example.target_name);
    if (!pattern) {
      continue;
    }

    pattern.examples = [...pattern.examples, example].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }
  const enrichedPatterns = [...enrichedPatternMap.values()];
  const linkedTokens = await linkTokensToComponents(
    sourceRoot,
    components,
    rawTokens,
  );
  const linkedDeprecations = linkDeprecationsToComponents(
    linkedTokens.components,
    rawDeprecations,
  );
  const enrichedComponents = linkedDeprecations.components;
  const icons = await extractIcons(
    sourceRoot,
    packageByName,
    linkedDeprecations.deprecations,
    generatedAt,
  );
  const country_symbols = await extractCountrySymbols(
    sourceRoot,
    packageByName,
    linkedDeprecations.deprecations,
    generatedAt,
  );
  const tokens = linkedTokens.tokens;
  const deprecations = linkedDeprecations.deprecations;

  const componentExamples = enrichedComponents.flatMap(
    (component) => component.examples,
  );
  const patternExamples = enrichedPatterns.flatMap((pattern) => pattern.examples);
  const examples = [
    ...componentExamples,
    ...patternExamples,
  ].sort((left, right) => left.id.localeCompare(right.id));
  const registryArrays: RegistryArrayCollections = {
    packages,
    components: enrichedComponents,
    icons,
    country_symbols,
    pages,
    patterns: enrichedPatterns,
    guides,
    tokens,
    deprecations,
    examples,
    changes,
  };

  const baseRegistry = {
    generated_at: generatedAt,
    version,
    build_info: buildInfo,
    ...registryArrays,
  };

  const search_index = buildSearchIndex(baseRegistry);
  const page_search_index = buildSerializedPageSearchIndex(pages);
  const registry: SaltRegistry = {
    ...baseRegistry,
    search_index,
  };

  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all([
    ...REGISTRY_ARRAY_ARTIFACTS.map((definition) =>
      writeJsonFile(path.join(outputDir, definition.file_name), {
        generated_at: generatedAt,
        version,
        [definition.key]: registryArrays[definition.key],
      }),
    ),
    writeJsonFile(path.join(outputDir, REGISTRY_METADATA_ARTIFACT.file_name), {
      generated_at: generatedAt,
      version,
      [REGISTRY_METADATA_ARTIFACT.key]: buildInfo,
    }),
    writeJsonFile(
      path.join(outputDir, REGISTRY_PAGE_SEARCH_INDEX_ARTIFACT.file_name),
      {
        generated_at: generatedAt,
        version,
        [REGISTRY_PAGE_SEARCH_INDEX_ARTIFACT.key]: page_search_index,
      },
    ),
    fs.writeFile(
      path.join(outputDir, REGISTRY_SEARCH_INDEX_ARTIFACT.file_name),
      serializeJsonLines(search_index),
      "utf8",
    ),
  ]);

  return registry;
}
