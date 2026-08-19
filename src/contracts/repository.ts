/** `owner/repo` out of any remote URL git will accept. */
export function parseRepo(remote: string): string | null {
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}
