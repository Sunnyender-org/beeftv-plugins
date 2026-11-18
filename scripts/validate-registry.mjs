import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const RESERVED_PRESET_IDS = new Set(["compatible", "openai", "gemini", "ark", "beeftv"]);

export function parseStrictPartnerBoundMs(raw, endOfDay = false) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Invalid empty date value: ${JSON.stringify(raw)}`);
  }
  const value = raw.trim();
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day
    ) {
      throw new Error(`Out-of-range calendar date: ${value}`);
    }
    const baseCstMs = Date.UTC(year, month - 1, day) - 8 * 3600 * 1000;
    return endOfDay ? baseCstMs + 24 * 3600 * 1000 : baseCstMs;
  }
  const rfc = RFC3339_RE.exec(value);
  if (!rfc) {
    throw new Error(`Timestamp must be RFC3339 with timezone or YYYY-MM-DD: ${value}`);
  }
  const year = Number(rfc[1]);
  const month = Number(rfc[2]);
  const day = Number(rfc[3]);
  const hour = Number(rfc[4]);
  const minute = Number(rfc[5]);
  const second = Number(rfc[6]);
  const calCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calCheck.getUTCFullYear() !== year ||
    calCheck.getUTCMonth() + 1 !== month ||
    calCheck.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`Out-of-range RFC3339 timestamp: ${value}`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unparseable RFC3339 timestamp: ${value}`);
  }
  return parsed;
}

export function validateStrictHTTPSUrl(raw, label) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(raw)}`);
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be credential-free, fragment-free HTTPS URL: ${raw}`);
  }
  return parsed.toString();
}

export async function validateCatalogRepository(rootDir = repoRoot) {
  const reg = JSON.parse(readFileSync(join(rootDir, "registry.json"), "utf8"));
  assert.ok(Array.isArray(reg.plugins) && reg.plugins.length > 0, "registry.json must contain non-empty plugins array");
  assert.ok(Array.isArray(reg.builtins) && reg.builtins.length > 0, "registry.json must contain non-empty builtins array");

  const allEntries = [...reg.plugins, ...reg.builtins];
  const seenPresetIds = new Set();

  for (const entry of allEntries) {
    assert.ok(entry.id && entry.packageName && entry.version && entry.sha256 && entry.tarball, `Incomplete entry: ${entry.id}`);
    const pkgPath = join(rootDir, "plugins", entry.packageName, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    assert.equal(pkg.beeftv?.id, undefined, `${pkgPath} must not set beeftv.id`);
    assert.equal(pkg.name, entry.packageName);
    assert.equal(pkg.name, entry.id);
    assert.equal(pkg.version, entry.version, `Version mismatch for ${entry.id}`);

    const tgzPath = join(rootDir, "dist", `${entry.packageName}-${entry.version}.tgz`);
    assert.equal(existsSync(tgzPath), true, `Missing tarball ${tgzPath}`);
    const sha = createHash("sha256").update(readFileSync(tgzPath)).digest("hex");
    assert.equal(sha, entry.sha256, `SHA-256 mismatch for ${tgzPath}`);

    for (const urlField of ["keysUrl", "websiteUrl", "iconUrl"]) {
      if (entry[urlField] !== undefined) {
        validateStrictHTTPSUrl(entry[urlField], `${entry.id}.${urlField}`);
      }
    }

    let fromMs = null;
    let untilMs = null;
    if (entry.from !== undefined) {
      fromMs = parseStrictPartnerBoundMs(entry.from, false);
    }
    if (entry.until !== undefined) {
      untilMs = parseStrictPartnerBoundMs(entry.until, true);
    }
    if (fromMs !== null && untilMs !== null) {
      assert.ok(fromMs < untilMs, `${entry.id} has inverted partner window: ${entry.from} >= ${entry.until}`);
    }

    if (entry.partner) {
      assert.equal(entry.category, "channel", `${entry.id} partner must set category=channel`);
      assert.ok(typeof entry.presetId === "string" && PRESET_ID_RE.test(entry.presetId), `${entry.id} invalid presetId`);
      assert.equal(RESERVED_PRESET_IDS.has(entry.presetId), false, `${entry.id} uses reserved presetId ${entry.presetId}`);
      assert.equal(seenPresetIds.has(entry.presetId), false, `Duplicate partner presetId: ${entry.presetId}`);
      seenPresetIds.add(entry.presetId);
      validateStrictHTTPSUrl(entry.keysUrl, `${entry.id}.keysUrl`);

      assert.ok(typeof pkg.beeftv?.client === "string" && pkg.beeftv.client.trim(), `${entry.id} partner must declare beeftv.client`);
      const clientPath = join(rootDir, "plugins", entry.packageName, pkg.beeftv.client);
      const mod = await import(pathToFileURL(clientPath).href);
      const preset = mod.BUILTIN_SERVICE_PRESET || mod.default?.BUILTIN_SERVICE_PRESET;
      assert.ok(preset && typeof preset === "object", `${entry.id} must export BUILTIN_SERVICE_PRESET`);
      assert.equal(preset.id, entry.presetId, `${entry.id} BUILTIN_SERVICE_PRESET.id mismatch`);
      assert.equal(preset.partner, true, `${entry.id} BUILTIN_SERVICE_PRESET.partner must be true`);
      assert.ok(typeof preset.baseUrl === "string" && preset.baseUrl.trim(), `${entry.id} BUILTIN_SERVICE_PRESET.baseUrl missing`);
      assert.ok(Array.isArray(preset.models) && preset.models.length > 0, `${entry.id} BUILTIN_SERVICE_PRESET.models must be non-empty`);
      assert.equal(typeof preset.buildChannel, "function", `${entry.id} BUILTIN_SERVICE_PRESET.buildChannel must be a function`);
      assert.equal(typeof preset.upgradeProfile, "function", `${entry.id} BUILTIN_SERVICE_PRESET.upgradeProfile must be a function`);
      assert.equal(preset.keysUrl, entry.keysUrl, `${entry.id} BUILTIN_SERVICE_PRESET.keysUrl mismatch`);
      if (preset.websiteUrl !== undefined) {
        validateStrictHTTPSUrl(preset.websiteUrl, `${entry.id} BUILTIN_SERVICE_PRESET.websiteUrl`);
      }
      if (entry.websiteUrl) {
        assert.equal(preset.websiteUrl, entry.websiteUrl, `${entry.id} BUILTIN_SERVICE_PRESET.websiteUrl mismatch`);
      }
    }
  }

  const marketRegPath = join(rootDir, "plugins", "beeftv-plugin-market", "registry.json");
  const marketReg = JSON.parse(readFileSync(marketRegPath, "utf8"));
  assert.equal(marketReg.updatedAt, reg.updatedAt, "market registry updatedAt must match root registry");
  assert.deepEqual(marketReg.plugins, reg.plugins, "market registry plugins must match root registry");
  assert.deepEqual(
    marketReg.builtins,
    reg.builtins.filter((item) => item.id !== "beeftv-plugin-market"),
    "market registry builtins must match root non-market builtins",
  );

  return { count: allEntries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { count } = await validateCatalogRepository();
  console.log(`Validated ${count} curated & builtin plugin(s), partner metadata, and dist tarballs.`);
}
