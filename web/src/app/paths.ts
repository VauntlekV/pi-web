/** Last path segment of a directory path ("/" stays "/"). */
export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}
