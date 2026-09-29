export const validateVersionSyntax = (version) => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return {
      ok: false,
      reason: 'version must be strict semver x.y.z',
      version,
    };
  }

  const patch = Number.parseInt(match[3], 10);
  if (patch > 9) {
    return {
      ok: false,
      reason: 'patch version must stay within 0-9; bump minor instead',
      version,
    };
  }

  return { ok: true, version };
};

export const validateReleaseVersionPolicy = (version, latestVersion) => {
  const versionPolicy = validateVersionSyntax(version);
  if (!versionPolicy.ok) return versionPolicy;

  if (!latestVersion) {
    return {
      ok: false,
      reason: 'cannot verify release version: npm latest version is unavailable',
      version,
    };
  }

  const latestMatch = latestVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!latestMatch) {
    return {
      ok: false,
      reason: `invalid npm latest version: ${latestVersion}`,
      version,
    };
  }

  const latestMajor = Number.parseInt(latestMatch[1], 10);
  const latestMinor = Number.parseInt(latestMatch[2], 10);
  const latestPatch = Number.parseInt(latestMatch[3], 10);
  if (latestPatch > 9) {
    return {
      ok: false,
      reason: `invalid npm latest version: patch must stay within 0-9 (${latestVersion})`,
      version,
    };
  }

  const expected =
    latestPatch < 9
      ? `${latestMajor}.${latestMinor}.${latestPatch + 1}`
      : latestMinor < 9
        ? `${latestMajor}.${latestMinor + 1}.0`
        : `${latestMajor + 1}.0.0`;

  if (version !== expected) {
    return {
      ok: false,
      reason: `release version must be exactly one valid step after ${latestVersion}: expected ${expected}, got ${version}`,
      version,
    };
  }

  return {
    ok: true,
    mode: 'release',
    version,
  };
};
