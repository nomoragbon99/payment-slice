// Prevents an open redirect: `next` must be a path on THIS site, never a link to somewhere else.
// Allowed only if it starts with "/" and its second character is neither "/" nor "\".
//
// "//evil.example" is protocol-relative -- browsers treat two leading slashes as "same scheme,
// different host", so it goes to evil.example, not a local path.
// "/\evil.example" exploits the same thing a different way: browsers normalize a leading
// backslash to a forward slash BEFORE parsing the URL, so "/\evil.example" becomes
// "//evil.example" and is just as much an open redirect as the double-slash form -- checking
// only for "//" would miss it.
export function getSafeRedirectPath(next: string | null | undefined, fallback: string): string {
  if (!next) return fallback;
  if (next[0] !== "/") return fallback;
  if (next[1] === "/" || next[1] === "\\") return fallback;
  return next;
}
