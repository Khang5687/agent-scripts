export function issueToken(u: string) { return u + ":tok"; }
export function verify(t: string) { return t.endsWith(":tok"); }
