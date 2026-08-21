export default function releaseCheck(input) {
  if (!input || typeof input.candidate !== "string" || !Array.isArray(input.requiredTerms)) {
    throw new Error("release-check requires candidate text and requiredTerms");
  }

  const candidate = input.candidate.toLocaleLowerCase();
  const requiredTerms = input.requiredTerms.filter((term) => typeof term === "string" && term.trim());
  if (requiredTerms.length === 0) throw new Error("release-check requires at least one non-empty term");

  const matched = requiredTerms.filter((term) => candidate.includes(term.toLocaleLowerCase()));
  const missing = requiredTerms.filter((term) => !candidate.includes(term.toLocaleLowerCase()));
  const score = matched.length / requiredTerms.length;

  return {
    passed: missing.length === 0,
    matched,
    missing,
    score,
    recommendation: missing.length === 0
      ? "All required terms are present."
      : `Add the missing terms: ${missing.join(", ")}.`,
  };
}
