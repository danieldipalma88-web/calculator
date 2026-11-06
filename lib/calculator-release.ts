export function calculatorReleaseVersion(): string | null {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  return revision && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null;
}
