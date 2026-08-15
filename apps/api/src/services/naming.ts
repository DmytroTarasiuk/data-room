export type NameKind = "file" | "folder";

function splitFileName(name: string) {
  const trimmed = normalizeName(name);
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) {
    return { base: trimmed, ext: "" };
  }
  return {
    base: trimmed.slice(0, dot),
    ext: trimmed.slice(dot)
  };
}

export function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

export async function resolveUniqueName(
  desiredName: string,
  kind: NameKind,
  exists: (candidate: string) => Promise<boolean>
) {
  const clean = normalizeName(desiredName);
  if (!clean) {
    throw new Error("Name cannot be empty");
  }

  if (!(await exists(clean))) {
    return { name: clean, conflictResolved: false };
  }

  const parts = kind === "file" ? splitFileName(clean) : { base: clean, ext: "" };
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${parts.base} (${index})${parts.ext}`;
    if (!(await exists(candidate))) {
      return { name: candidate, conflictResolved: true };
    }
  }

  throw new Error("Could not resolve a unique name");
}
